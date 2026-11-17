/**
 * Translate native OpenAI Responses SSE events into Harness stream chunks.
 *
 * A completed response carries its replay envelope on `finish.replayState`,
 * aligned with the emitted blocks. The doom-loop detector control and its
 * recovery staging are not ported; detector frames are swallowed.
 */

import * as dshLlm from '@deepseek-ai/dsh-llm';
import { grokReplayEnvelope } from './replay.js';
import { GROK_DONE, GROK_DOOM_LOOP_EVENT } from './sse.js';

const { LlmError } = dshLlm;

/**
 * Brand a provider-issued tool-call id. The published `@deepseek-ai/dsh-llm`
 * line names the identity brand `CallId` while newer checkouts rename it to
 * `ToolCallId`; both are runtime identities, so resolve whichever is exported.
 */
const ToolCallId = dshLlm.ToolCallId ?? dshLlm.CallId ?? ((id) => id);

/** @typedef {'text'|'reasoning'|'tool-call'|'hosted'} SlotKind */
/** @typedef {Record<string, unknown>} JsonObject */

const INCOMPLETE_CONTENT_FILTER = 'content_filter';
const INCOMPLETE_MAX_OUTPUT_TOKENS = 'max_output_tokens';
const INCOMPLETE_MAX_PROMPT_TOKENS = 'max_prompt_tokens';

/** Narrow an unknown value to a non-array object. */
function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/** Narrow an unknown value to a string. */
function string(value) {
  return typeof value === 'string' ? value : undefined;
}

/** Narrow an unknown value to a non-negative integer. */
function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Coerce a usage counter: non-finite or negative values count as zero. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Whether an object carries its own `key` property. */
function hasOwn(value, key) {
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Convert cumulative Responses usage into the Harness's disjoint counters.
 * @param {JsonObject} response - terminal provider response containing optional usage data.
 * @returns disjoint token counters, or undefined when the provider omitted usage.
 */
export function mapGrokUsage(response) {
  const usage = object(response['usage']);
  if (usage === undefined) return undefined;
  const inputDetails = object(usage['input_tokens_details']);
  const outputDetails = object(usage['output_tokens_details']);
  const inputTotal = count(usage['input_tokens']);
  const cacheRead = count(inputDetails?.['cached_tokens']);
  const cacheWrite = count(inputDetails?.['cache_write_tokens'] ?? inputDetails?.['cache_creation_tokens']);
  const reasoning = count(outputDetails?.['reasoning_tokens']);
  return {
    inputTokens: Math.max(0, inputTotal - cacheRead - cacheWrite),
    outputTokens: count(usage['output_tokens']),
    ...(hasOwn(inputDetails, 'cached_tokens') ? { cacheReadTokens: cacheRead } : {}),
    ...(hasOwn(inputDetails, 'cache_write_tokens') || hasOwn(inputDetails, 'cache_creation_tokens')
      ? { cacheWriteTokens: cacheWrite }
      : {}),
    ...(hasOwn(outputDetails, 'reasoning_tokens') ? { reasoningTokens: reasoning } : {}),
  };
}

/** Classify one terminal Responses output item into a slot kind. */
function responseItemKind(item) {
  const type = string(item['type']);
  if (type === 'reasoning') return 'reasoning';
  if (type === 'message') return 'text';
  if (type === 'function_call') return 'tool-call';
  // A provider-hosted search or interpreter call is bookkeeping. Its trace is
  // not part of the answer, and rendering it displaced the assistant text.
  if (type === 'web_search_call' || type === 'custom_tool_call' || type === 'code_interpreter_call') return 'hosted';
  return undefined;
}

/** Concatenate the summary and content text of one reasoning item. */
function reasoningText(item) {
  const parts = [];
  for (const raw of Array.isArray(item['summary']) ? item['summary'] : []) {
    const text = string(object(raw)?.['text']);
    if (text !== undefined) parts.push(text);
  }
  for (const raw of Array.isArray(item['content']) ? item['content'] : []) {
    const text = string(object(raw)?.['text']);
    if (text !== undefined) parts.push(text);
  }
  return parts.join('\n');
}

/**
 * Citeable pages named by one message item.
 *
 * The request asks for `no_inline_citations`, so the provider keeps these off
 * the prose. They are appended once, after the answer, in annotation order.
 * @param {JsonObject} item - one Responses message item.
 * @returns deduplicated sources.
 */
function messageCitations(item) {
  /** @type {{url: string, title?: string}[]} */
  const sources = [];
  const seen = new Set();
  for (const raw of Array.isArray(item['content']) ? item['content'] : []) {
    const part = object(raw);
    for (const annotation of Array.isArray(part?.['annotations']) ? part['annotations'] : []) {
      const entry = object(annotation);
      if (string(entry?.['type']) !== 'url_citation') continue;
      const url = string(entry?.['url']);
      if (url === undefined || url.length === 0 || seen.has(url)) continue;
      seen.add(url);
      const title = string(entry?.['title']);
      sources.push({ url, ...(title === undefined || title.length === 0 ? {} : { title }) });
    }
  }
  return sources;
}

/**
 * Append a message item's citations after its prose.
 * @param {string} text - assembled assistant prose.
 * @param {JsonObject | undefined} item - terminal message item, when one arrived.
 * @returns the prose plus one source line per new citation.
 */
function appendCitations(text, item) {
  if (item === undefined) return text;
  const lines = messageCitations(item)
    .filter((source) => !text.includes(source.url))
    .map((source) => (source.title === undefined ? source.url : `${source.title} ${source.url}`));
  if (lines.length === 0) return text;
  const body = text.length > 0 && !text.endsWith('\n') ? `${text}\n` : text;
  return `${body}${lines.join('\n')}`;
}

/** Concatenate the output text (and refusal) parts of one message item. */
function messageText(item) {
  const parts = [];
  for (const raw of Array.isArray(item['content']) ? item['content'] : []) {
    const part = object(raw);
    const type = string(part?.['type']);
    if (type !== 'output_text' && type !== 'refusal') continue;
    const text = string(part?.[type === 'refusal' ? 'refusal' : 'text']);
    if (text !== undefined) parts.push(text);
  }
  return parts.join('\n');
}

/** Read `incomplete_details.reason` from one terminal response. */
function terminalIncompleteReason(response) {
  return string(object(response['incomplete_details'])?.['reason']);
}

/** Whether every accumulated tool-call argument string parses as JSON. */
function completeToolArguments(slots) {
  return [...slots.values()].filter((slot) => slot.kind === 'tool-call').every((slot) => {
    if (slot.arguments.trim().length === 0) return true;
    try {
      JSON.parse(slot.arguments);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Resolve the terminal finish reason. Completing tool calls is the Grok Build
 * default; the batch is all-or-nothing, so one malformed argument string turns
 * the whole incomplete response into a max-token stop before any call can
 * dispatch.
 * @param terminal - terminal event type and response.
 * @param slots - accumulated output slots.
 * @returns the Harness finish reason.
 */
function terminalFinishReason(terminal, slots) {
  const hasToolCalls = [...slots.values()].some((slot) => slot.kind === 'tool-call');
  if (terminal.eventType === 'response.completed') {
    return hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' };
  }
  const reason = terminalIncompleteReason(terminal.response);
  if (reason === INCOMPLETE_CONTENT_FILTER) {
    return { kind: 'content-filter' };
  }
  if (hasToolCalls && completeToolArguments(slots)) return { kind: 'tool-calls' };
  if (reason === INCOMPLETE_MAX_PROMPT_TOKENS) {
    return { kind: 'max-tokens', rawReason: 'model_context_window_exceeded' };
  }
  if (reason === INCOMPLETE_MAX_OUTPUT_TOKENS) {
    return { kind: 'max-tokens', rawReason: 'max_tokens' };
  }
  return { kind: 'max-tokens' };
}

/**
 * Map one streamed error event to a typed failure.
 * @param event - streamed error event.
 * @param fallback - message used when the event carries none.
 * @param requestHasImages - whether this exact attempt has images a retry can remove.
 * @returns the typed failure.
 */
function eventFailure(event, fallback, requestHasImages) {
  const response = object(event['response']);
  const error = object(response?.['error']) ?? object(event['error']) ?? event;
  const code = string(error['code']);
  const message = string(error['message']) ?? fallback;
  const failureCode = requestHasImages && code === 'invalid_image' ? 'INVALID_IMAGE' : 'SERVER';
  return new LlmError(code === undefined ? message : `${code}: ${message}`, failureCode);
}

/**
 * Parse one Responses data payload into a typed event object.
 * @param payload - raw SSE data payload.
 * @returns the parsed event with a string `type`.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} `PROTOCOL` on invalid JSON or a missing type.
 */
function parseEvent(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new LlmError('Grok Responses stream contained invalid JSON', 'PROTOCOL', { cause: error });
  }
  const event = object(parsed);
  if (event === undefined || typeof event['type'] !== 'string') {
    throw new LlmError('Grok Responses stream event has no type', 'PROTOCOL');
  }
  return event;
}

/**
 * Options for one translated Responses stream.
 * @typedef {object} GrokResponseStreamOptions
 * @property {boolean} [requestHasImages] - whether this attempt can safely recover an invalid-image stream error by stripping images.
 */

/**
 * Translate one complete Responses event stream.
 *
 * Deltas in the contiguous provider output prefix pass through immediately. A
 * later index waits until every preceding index is known, keeping durable
 * block order aligned with native output order. Block closure, usage and the
 * successful finish wait for the normalized terminal boundary; a stream that
 * closes before a terminal response object still fails closed.
 * @param {AsyncIterable<string>} payloads - raw Responses data payloads including the normalized final boundary.
 * @param {GrokResponseStreamOptions} [options] - attempt-local policy.
 * @returns Harness stream chunks in durable block order.
 */
export async function* translateGrokResponses(payloads, options = {}) {
  /** @typedef {{index: number, kind: SlotKind, started: boolean, pending: object[], text: string, id: string, name: string, arguments: string, item?: JsonObject}} OutputSlot */
  const slots = new Map();
  let nextStartIndex = 0;
  /** @typedef {{eventType: 'response.completed'|'response.incomplete', response: JsonObject}} TerminalResponse */
  let terminal;

  const ensure = (index, kind) => {
    const current = slots.get(index);
    if (current !== undefined) {
      if (current.kind !== kind) {
        throw new LlmError(
          `Grok Responses output index ${index} changed from ${current.kind} to ${kind}`,
          'PROTOCOL',
        );
      }
      return current;
    }
    const created = { index, kind, started: false, pending: [], text: '', id: '', name: '', arguments: '' };
    slots.set(index, created);
    return created;
  };

  const start = (slot) => {
    if (slot.started) return [];
    slot.started = true;
    const chunks = [{ type: 'block-start', index: slot.index, blockType: slot.kind }, ...slot.pending];
    slot.pending.length = 0;
    return chunks;
  };

  const flushContiguous = () => {
    const chunks = [];
    for (;;) {
      const slot = slots.get(nextStartIndex);
      if (slot === undefined) return chunks;
      // A hosted call occupies a provider output index but is not a durable
      // block. Skipping it lets a later tool call or message start immediately.
      if (slot.kind !== 'hosted') chunks.push(...start(slot));
      nextStartIndex += 1;
    }
  };

  const stage = (slot, ...chunks) => {
    if (slot.started) return chunks;
    slot.pending.push(...chunks);
    return flushContiguous();
  };

  for await (const payload of payloads) {
    if (payload === GROK_DONE) {
      if (terminal === undefined) {
        throw new LlmError('Grok Responses stream ended without a completed or incomplete response', 'STREAM_CLOSED');
      }

      const rawOutput = terminal.response['output'];
      if (rawOutput !== undefined && !Array.isArray(rawOutput)) {
        throw new LlmError('Grok terminal response output is not an array', 'PROTOCOL');
      }
      const output = Array.isArray(rawOutput) ? rawOutput : [];
      for (const [index, rawItem] of output.entries()) {
        const item = object(rawItem);
        if (item === undefined) throw new LlmError(`Grok output item ${index} is not an object`, 'PROTOCOL');
        const kind = responseItemKind(item);
        if (kind === undefined) {
          throw new LlmError(
            `Grok returned unsupported Responses output item "${String(item['type'])}"; refusing lossy replay`,
            'UNSUPPORTED_RESPONSE_ITEM',
          );
        }
        const slot = ensure(index, kind);
        slot.item = structuredClone(item);
        if (kind === 'reasoning') {
          const finalText = reasoningText(item);
          if (slot.text.length === 0 && finalText.length > 0) {
            for (const chunk of stage(slot, { type: 'reasoning-delta', index, text: finalText })) yield chunk;
          } else if (finalText.startsWith(slot.text) && finalText.length > slot.text.length) {
            for (const chunk of stage(slot, {
              type: 'reasoning-delta',
              index,
              text: finalText.slice(slot.text.length),
            })) yield chunk;
          }
          slot.text = finalText || slot.text;
        } else if (kind === 'text') {
          const finalText = messageText(item);
          if (slot.text.length === 0 && finalText.length > 0) {
            for (const chunk of stage(slot, { type: 'text-delta', index, text: finalText })) yield chunk;
          } else if (finalText.startsWith(slot.text) && finalText.length > slot.text.length) {
            for (const chunk of stage(slot, {
              type: 'text-delta',
              index,
              text: finalText.slice(slot.text.length),
            })) yield chunk;
          }
          slot.text = finalText || slot.text;
        } else {
          const id = string(item['call_id']) ?? slot.id;
          const name = string(item['name']) ?? slot.name;
          const finalArguments = string(item['arguments']) ?? slot.arguments;
          const chunks = [];
          if (slot.id.length === 0 || slot.name.length === 0) {
            chunks.push({
              type: 'tool-call-delta',
              index,
              id: ToolCallId(id || `call-${index}`),
              ...(name.length === 0 ? {} : { name }),
              argumentsDelta: '',
            });
          }
          if (finalArguments.startsWith(slot.arguments) && finalArguments.length > slot.arguments.length) {
            chunks.push({
              type: 'tool-call-delta',
              index,
              id: ToolCallId(id || `call-${index}`),
              argumentsDelta: finalArguments.slice(slot.arguments.length),
            });
          }
          for (const chunk of stage(slot, ...chunks)) yield chunk;
          slot.id = id;
          slot.name = name;
          slot.arguments = finalArguments;
        }
      }

      const order = [...slots.keys()].sort((left, right) => left - right);
      /** @typedef {{type: string, item?: JsonObject, hostedBefore?: JsonObject[], hostedAfter?: JsonObject[]}} ReplayBlock */
      /** @type {ReplayBlock[]} */
      const replayBlocks = [];
      /** @type {JsonObject[]} */
      let pendingHosted = [];
      let hasUserVisibleResult = false;
      let hostedOnly = false;
      /**
       * Record one durable block and the hosted calls that preceded it.
       * @param {ReplayBlock} block - replay entry for the block.
       */
      const appendBlock = (block) => {
        if (pendingHosted.length > 0) {
          block.hostedBefore = pendingHosted;
          pendingHosted = [];
        }
        replayBlocks.push(block);
      };
      for (const index of order) {
        const slot = slots.get(index);
        if (slot === undefined) continue;
        if (slot.kind === 'hosted') {
          // The hosted call has no durable block. Hold it for the next block so
          // the next request replays the provider item in its native order.
          hostedOnly = true;
          if (slot.item !== undefined) pendingHosted.push(slot.item);
          continue;
        }
        for (const chunk of start(slot)) yield chunk;
        if (slot.kind === 'reasoning') {
          yield { type: 'block-end', index, block: { type: 'reasoning', text: slot.text } };
          appendBlock({
            type: 'reasoning',
            item: slot.item ?? {
              type: 'reasoning',
              id: `reasoning-${index}`,
              summary: slot.text.length === 0 ? [] : [{ type: 'summary_text', text: slot.text }],
            },
          });
        } else if (slot.kind === 'text') {
          const text = appendCitations(slot.text, slot.item);
          yield { type: 'block-end', index, block: { type: 'text', text } };
          appendBlock({ type: 'text' });
          if (text.length > 0) hasUserVisibleResult = true;
        } else {
          yield {
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: ToolCallId(slot.id || `call-${index}`), name: slot.name, arguments: slot.arguments },
          };
          appendBlock({ type: 'tool-call' });
          hasUserVisibleResult = true;
        }
      }
      const lastBlock = replayBlocks.at(-1);
      if (lastBlock !== undefined && pendingHosted.length > 0) lastBlock.hostedAfter = pendingHosted;

      if (terminal.eventType === 'response.completed' && hostedOnly && !hasUserVisibleResult) {
        const responseId = string(terminal.response['id']);
        if (responseId !== undefined) {
          yield { type: 'continue-response', responseId };
          return;
        }
      }
      if (terminal.eventType === 'response.completed' && !hasUserVisibleResult) {
        throw new LlmError('Grok completed without assistant text or a tool call', 'EMPTY_RESPONSE');
      }
      const usage = mapGrokUsage(terminal.response);
      if (usage !== undefined) yield { type: 'usage', usage };
      const responseId = string(terminal.response['id']);
      yield {
        type: 'finish',
        reason: terminalFinishReason(terminal, slots),
        replayState: grokReplayEnvelope(replayBlocks, responseId),
      };
      return;
    }

    const event = parseEvent(payload);
    const type = string(event['type']);
    // Non-standard detector frames are transport noise for this port: record
    // nothing, abort nothing, and keep translating the model stream.
    if (type === GROK_DOOM_LOOP_EVENT) {
      continue;
    }
    if (type === 'response.failed') {
      throw eventFailure(event, 'Grok response failed', options.requestHasImages === true);
    }
    if (type === 'error' || type === 'response.error') {
      throw eventFailure(event, 'Grok stream failed', options.requestHasImages === true);
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = object(event['response']);
      if (response === undefined) throw new LlmError(`${type} has no response object`, 'PROTOCOL');
      terminal = { eventType: type, response };
      continue;
    }

    const index = nonNegativeInteger(event['output_index']);
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (index === undefined) throw new LlmError(`${type} has no output_index`, 'PROTOCOL');
      const item = object(event['item']);
      if (item === undefined) throw new LlmError(`${type} has no item`, 'PROTOCOL');
      const kind = responseItemKind(item);
      if (kind === undefined) continue;
      if (kind === 'hosted') {
        // Record the index so a later function call is not held for a block
        // that will never be rendered. Starting earlier slots here would emit
        // their block-starts ahead of their content; the next staged delta
        // flushes them in order instead.
        ensure(index, 'hosted');
        continue;
      }
      const slot = ensure(index, kind);
      slot.item = structuredClone(item);
      if (kind === 'tool-call') {
        slot.id = string(item['call_id']) ?? string(event['item_id']) ?? slot.id;
        slot.name = string(item['name']) ?? slot.name;
        if (type === 'response.output_item.added') {
          const argumentsDelta = string(item['arguments']) ?? '';
          slot.arguments = argumentsDelta;
          for (const chunk of stage(slot, {
            type: 'tool-call-delta',
            index,
            id: ToolCallId(slot.id || `call-${index}`),
            ...(slot.name.length === 0 ? {} : { name: slot.name }),
            argumentsDelta,
          })) yield chunk;
        } else {
          slot.arguments = string(item['arguments']) ?? slot.arguments;
        }
      }
      continue;
    }

    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (index === undefined) throw new LlmError(`${type} has no output_index`, 'PROTOCOL');
      const delta = string(event['delta']) ?? '';
      if (delta.length === 0) continue;
      const slot = ensure(index, 'reasoning');
      slot.text += delta;
      for (const chunk of stage(slot, { type: 'reasoning-delta', index, text: delta })) yield chunk;
      continue;
    }

    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (index === undefined) throw new LlmError(`${type} has no output_index`, 'PROTOCOL');
      const delta = string(event['delta']) ?? '';
      if (delta.length === 0) continue;
      const slot = ensure(index, 'text');
      slot.text += delta;
      for (const chunk of stage(slot, { type: 'text-delta', index, text: delta })) yield chunk;
      continue;
    }

    if (type === 'response.function_call_arguments.delta') {
      if (index === undefined) throw new LlmError(`${type} has no output_index`, 'PROTOCOL');
      const slot = ensure(index, 'tool-call');
      slot.id ||= string(event['call_id']) ?? string(event['item_id']) ?? `call-${index}`;
      const delta = string(event['delta']) ?? '';
      slot.arguments += delta;
      for (const chunk of stage(slot, {
        type: 'tool-call-delta',
        index,
        id: ToolCallId(slot.id),
        argumentsDelta: delta,
      })) yield chunk;
      continue;
    }

    if (type === 'response.function_call_arguments.done') {
      if (index === undefined) throw new LlmError(`${type} has no output_index`, 'PROTOCOL');
      const slot = ensure(index, 'tool-call');
      slot.id ||= string(event['call_id']) ?? string(event['item_id']) ?? `call-${index}`;
      slot.name = string(event['name']) ?? slot.name;
      slot.arguments = string(event['arguments']) ?? slot.arguments;
    }
  }

  throw new LlmError('Grok Responses stream ended without a terminal boundary', 'STREAM_CLOSED');
}
