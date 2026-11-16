/**
 * Serialize Harness history directly into grok-build's native Responses shape.
 *
 * Not ported from the fork: encrypted-reasoning replay (replay.ts — the
 * adapter-private replayState seam) and the prompt_cache_key projection; both
 * depend on fork-private seams the external plugin does not own. Assistant
 * reasoning blocks therefore serialize to nothing and no cache key is sent.
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm';

/**
 * One hosted tool the deployment may send on the Responses `tools` array.
 * @typedef {object} GrokHostedToolSpec
 * @property {string} wireName - Responses tool type / colliding function name, for example `web_search`.
 * @property {Record<string, unknown>} [entry] - fully validated raw hosted entry supplied by the owner resolver.
 */

/**
 * @typedef {'low'|'medium'|'high'|'xhigh'} GrokReasoningEffort
 * @typedef {'none'|'auto'|'concise'|'detailed'} GrokReasoningSummary
 */

/** Concatenate the text blocks of one content array. */
function textOf(blocks) {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** Pass through valid JSON argument text; replace anything else with `{}`. */
function validArguments(raw) {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return '{}';
  }
}

/**
 * Serialize one message's content blocks into a Responses content value.
 * @param blocks - content blocks of one message.
 * @param attachments - optional durable attachment reader for image inputs.
 * @returns plain text, or a structured array when the message carries images.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} `UNSUPPORTED_CONTENT` when
 *   images appear without the attachment service.
 */
async function inputContent(blocks, attachments) {
  if (!contentHasImage(blocks)) return textOf(blocks);
  if (attachments === undefined) {
    throw new LlmError('grok-model image input requires the attachment service', 'UNSUPPORTED_CONTENT');
  }
  const content = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'input_text', text: block.text });
    } else if (block.type === 'image') {
      const image = await attachments.readImage(block.attachment);
      content.push({
        type: 'input_image',
        detail: 'auto',
        image_url: `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
      });
    }
  }
  return content;
}

/**
 * Serialize one tool-result message into a `function_call_output` item.
 * @param message - tool-role message carrying the provider-issued call id.
 * @param attachments - optional durable attachment reader for image outputs.
 * @returns the Responses input item.
 */
async function toolOutput(message, attachments) {
  const output = await inputContent(message.content, attachments);
  return {
    type: 'function_call_output',
    call_id: String(message.toolCallId),
    output: typeof output === 'string' ? output || '(no output)' : output,
  };
}

/**
 * Serialize one user message.
 * @param message - user-role request message.
 * @param attachments - optional durable attachment reader for image inputs.
 * @returns the Responses input items for the message.
 */
async function serializeUser(message, attachments) {
  const content = await inputContent(message.content, attachments);
  return [{ type: 'message', role: 'user', content }];
}

/**
 * Serialize one assistant message without replay metadata: text blocks become
 * assistant messages, tool-call blocks become `function_call` items, and
 * reasoning blocks are dropped (encrypted replay was not ported).
 * @param message - assistant-role message.
 * @returns the Responses input items for the message.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} `UNSUPPORTED_CONTENT` for
 *   assistant image output.
 */
function serializeAssistant(message) {
  const items = [];
  for (const block of message.content) {
    if (block.type === 'reasoning') {
      continue;
    } else if (block.type === 'text') {
      if (block.text.length > 0) items.push({ type: 'message', role: 'assistant', content: block.text });
    } else if (block.type === 'tool-call') {
      items.push({
        type: 'function_call',
        call_id: String(block.id),
        name: block.name,
        arguments: validArguments(block.arguments),
      });
    } else if (block.type === 'image') {
      throw new LlmError('grok-model cannot replay assistant image output', 'UNSUPPORTED_CONTENT');
    }
  }
  return items;
}

/**
 * Serialize the full request history into Responses input items.
 * @param options - provider-neutral request assembled by the Harness.
 * @param attachments - optional durable attachment reader for image inputs.
 * @returns the ordered Responses `input` array.
 */
async function serializeMessages(options, attachments) {
  const input = [];
  if (options.system !== undefined) input.push({ type: 'message', role: 'system', content: options.system });
  for (const message of options.messages) {
    if (message.role === 'system') {
      input.push({ type: 'message', role: 'system', content: textOf(message.content) });
    } else if (message.role === 'assistant') {
      input.push(...serializeAssistant(message));
    } else if (message.role === 'tool') {
      input.push(await toolOutput(message, attachments));
    } else {
      input.push(...(await serializeUser(message, attachments)));
    }
  }
  return input;
}

/**
 * Resolve and validate the model-visible reasoning effort.
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions['reasoningEffort']} requested - per-request effort, when supplied by the caller.
 * @param {GrokReasoningEffort} fallback - route effort used when the request omits one.
 * @returns a native Grok reasoning effort.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} `UNSUPPORTED_REASONING_EFFORT` for any other value.
 */
export function resolveGrokReasoningEffort(requested, fallback) {
  const value = requested === undefined ? fallback : String(requested);
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  throw new LlmError(`this model does not support reasoning effort "${value}"`, 'UNSUPPORTED_REASONING_EFFORT');
}

/**
 * Validate and serialize one owned hosted tool entry.
 * @param {GrokHostedToolSpec} spec - hosted tool declaration.
 * @returns the Responses `tools` entry.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} `UNSUPPORTED_TOOL` for an
 *   invalid or mismatched entry; `UNSUPPORTED_HOSTED_TOOL` for an unknown name.
 */
function hostedWireTool(spec) {
  const entry = spec.entry ?? { type: spec.wireName };
  if (spec.wireName === 'web_search' && entry['type'] === 'web_search') {
    const keys = Object.keys(entry);
    if (keys.some((key) => key !== 'type' && key !== 'filters')) throw invalidHostedEntry(spec.wireName);
    const filters = entry['filters'];
    if (filters === undefined) return { type: 'web_search' };
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
      throw invalidHostedEntry(spec.wireName);
    }
    const record = filters;
    if (Object.keys(record).some((key) => key !== 'allowed_domains' && key !== 'excluded_domains')) {
      throw invalidHostedEntry(spec.wireName);
    }
    const allowed = hostedDomains(record['allowed_domains'], spec.wireName);
    const excluded = hostedDomains(record['excluded_domains'], spec.wireName);
    if (allowed !== undefined && excluded !== undefined) throw invalidHostedEntry(spec.wireName);
    return {
      type: 'web_search',
      ...(allowed === undefined && excluded === undefined ? {} : {
        filters: {
          ...(allowed === undefined ? {} : { allowed_domains: allowed }),
          ...(excluded === undefined ? {} : { excluded_domains: excluded }),
        },
      }),
    };
  }
  if (spec.wireName === 'x_search' && entry['type'] === 'x_search') {
    if (Object.keys(entry).some((key) => key !== 'type' && key !== 'from_date' && key !== 'to_date')) {
      throw invalidHostedEntry(spec.wireName);
    }
    const fromDate = hostedDate(entry['from_date'], spec.wireName);
    const toDate = hostedDate(entry['to_date'], spec.wireName);
    if (fromDate !== undefined && toDate !== undefined && fromDate > toDate) {
      throw invalidHostedEntry(spec.wireName);
    }
    return {
      type: 'x_search',
      ...(fromDate === undefined ? {} : { from_date: fromDate }),
      ...(toDate === undefined ? {} : { to_date: toDate }),
    };
  }
  if (spec.wireName === 'web_search' || spec.wireName === 'x_search') {
    throw new LlmError(
      `grok-model hosted tool ${JSON.stringify(spec.wireName)} has a mismatched wire entry`,
      'UNSUPPORTED_TOOL',
    );
  }
  throw new LlmError(
    `grok-model does not serialize hosted tool "${spec.wireName}"`,
    'UNSUPPORTED_HOSTED_TOOL',
  );
}

/** Typed failure for an invalid hosted-tool entry. */
function invalidHostedEntry(wireName) {
  return new LlmError(
    `grok-model hosted tool ${JSON.stringify(wireName)} has an invalid wire entry`,
    'UNSUPPORTED_TOOL',
  );
}

/** Validate one 1-5 entry domain list, or `undefined` when absent. */
function hostedDomains(value, wireName) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidHostedEntry(wireName);
  const domains = value;
  if (domains.length === 0 || domains.length > 5
    || domains.some((domain) => typeof domain !== 'string' || domain.length === 0)) {
    throw invalidHostedEntry(wireName);
  }
  return domains.map((domain) => {
    if (typeof domain !== 'string') throw invalidHostedEntry(wireName);
    return domain;
  });
}

/** Validate one `YYYY-MM-DD` date field, or `undefined` when absent. */
function hostedDate(value, wireName) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw invalidHostedEntry(wireName);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw invalidHostedEntry(wireName);
  return value;
}

/**
 * Serialize the request's tool declarations. Session-title generation is an
 * auxiliary text-only request, so deployment-owned hosted tools must not turn
 * it into a tool-capable request or collide with the main conversation.
 * @param options - provider-neutral request assembled by the Harness.
 * @param {readonly GrokHostedToolSpec[]} hostedTools - hosted tools this deployment owns.
 * @returns the Responses `tools` array, or undefined when the request is text-only.
 */
function serializeTools(options, hostedTools) {
  if (options.purpose === 'session-title') return undefined;
  const hosted = hostedTools.map(hostedWireTool);
  const hostedNames = new Set(hosted.map((tool) => tool.type));
  const functions = (options.tools ?? [])
    .filter((tool) => !hostedNames.has(tool.name))
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  const tools = [...functions, ...hosted];
  return tools.length === 0 ? undefined : tools;
}

/**
 * Build one native Responses body without any SDK defaults or fingerprints.
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options - provider-neutral request assembled by the Harness.
 * @param {GrokReasoningEffort} fallbackEffort - route effort used when the request omits one.
 * @param {import('@deepseek-ai/dsh-attachment').AttachmentStore} [attachments] - optional durable attachment reader for image inputs.
 * @param {readonly GrokHostedToolSpec[]} [hostedTools] - hosted tools this deployment owns for agent and compaction requests.
 * @param {GrokReasoningSummary} [reasoningSummary] - per-model summary mode; `none` omits the field.
 * @returns the exact JSON body sent to the Grok Responses endpoint.
 */
export async function serializeGrokRequest(
  options,
  fallbackEffort,
  attachments,
  hostedTools = [],
  reasoningSummary = 'concise',
) {
  if (typeof options.continueResponseId === 'string' && options.continueResponseId.length > 0) {
    return {
      model: options.model,
      previous_response_id: options.continueResponseId,
      input: [{
        type: 'message',
        role: 'user',
        content: 'Use the search results above and answer the original request now.',
      }],
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: {
        effort: resolveGrokReasoningEffort(options.reasoningEffort, fallbackEffort),
        ...(reasoningSummary === 'none' ? {} : { summary: reasoningSummary }),
      },
    };
  }
  const tools = serializeTools(options, hostedTools);
  return {
    model: options.model,
    input: await serializeMessages(options, attachments),
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: {
      effort: resolveGrokReasoningEffort(options.reasoningEffort, fallbackEffort),
      ...(reasoningSummary === 'none' ? {} : { summary: reasoningSummary }),
    },
    ...(tools === undefined ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
  };
}
