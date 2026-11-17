/**
 * Encrypted-reasoning replay for the Grok Responses route.
 *
 * The Harness carries adapter-private replay metadata on the public
 * `finish.replayState` envelope. The envelope's `blocks` half holds one entry
 * per emitted durable block; the assembler prunes those entries in step with
 * the blocks it keeps, so stored metadata cannot disagree with stored content.
 * The `response` half holds response-level metadata only.
 *
 * Provider-hosted calls produce no durable block, so each block entry records
 * the hosted calls that immediately surround it. Replaying a turn emits them
 * around that block in provider order.
 */

import { LlmError } from '@deepseek-ai/dsh-llm';

/** Replay kind written by this adapter. */
export const GROK_REPLAY_KIND = 'grok-build-responses';

/** Replay document version this adapter reads and writes. */
const GROK_REPLAY_VERSION = 1;

/** Provider item types that record a hosted call instead of assistant text. */
const HOSTED_ITEM_TYPES = new Set(['web_search_call', 'custom_tool_call', 'code_interpreter_call']);

/**
 * @typedef {{ type: string, item?: Record<string, unknown>, hostedBefore?: Record<string, unknown>[], hostedAfter?: Record<string, unknown>[] }} GrokReplayBlock
 */

/**
 * @param {string} message - what the stored state violates.
 * @returns {never}
 */
function invalid(message) {
  throw new LlmError(`invalid grok replay state: ${message}`, 'INVALID_REPLAY_STATE');
}

/**
 * Narrow one stored value to a plain object.
 * @param {unknown} value - candidate value.
 * @param {string} message - failure description.
 * @returns {Record<string, unknown>} the value as an object.
 */
function itemObject(value, message) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(message);
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * A stored hosted call with its response-only `status` removed.
 * @param {unknown} value - candidate item.
 * @param {string} position - where the item sits, for the failure message.
 * @returns {Record<string, unknown>} the item safe to send back as input.
 */
function hostedCallItem(value, position) {
  const item = itemObject(value, `${position} must be an object`);
  if (!HOSTED_ITEM_TYPES.has(String(item['type']))) return invalid(`${position} is not a supported hosted call`);
  const { status: _status, ...inputItem } = item;
  return structuredClone(inputItem);
}

/**
 * A stored reasoning item with its response-only `status` removed.
 * @param {unknown} value - candidate item.
 * @param {number} index - block position, for the failure message.
 * @returns {Record<string, unknown>} the item safe to send back as input.
 */
function reasoningItem(value, index) {
  const item = itemObject(value, `reasoning block ${index} item must be an object`);
  if (item['type'] !== 'reasoning') return invalid(`reasoning block ${index} has a non-reasoning item`);
  const { status: _status, ...inputItem } = item;
  return structuredClone(inputItem);
}

/**
 * Read the optional hosted calls recorded on one side of a block entry.
 * @param {Record<string, unknown>} block - stored block entry.
 * @param {number} index - block position, for the failure message.
 * @param {'hostedBefore' | 'hostedAfter'} side - which side to read.
 * @returns {Record<string, unknown>[]} validated hosted call items.
 */
function hostedItems(block, index, side) {
  const raw = block[side];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return invalid(`block ${index} ${side} must be an array`);
  return raw.map((value, offset) => hostedCallItem(value, `${side} item ${offset} of block ${index}`));
}

/**
 * Read this adapter's replay state from one assistant message.
 *
 * State owned by another provider, or a message without replay metadata,
 * returns undefined and the caller falls back to plain text. State that claims
 * this adapter's kind but does not match the message is refused.
 * @param {object} message - assistant message from the Harness history.
 * @param {string} provider - provider route of the request being serialized.
 * @param {string} model - model id of the request being serialized.
 * @returns the validated state, or undefined when this adapter does not own it.
 */
export function readGrokReplayState(message, provider, model) {
  const source = message?.source;
  if (source?.kind !== 'model' || source.replayState === undefined) return undefined;
  if (source.provider !== provider || source.model !== model) return undefined;
  const envelope = itemObject(source.replayState, 'expected an object');
  const meta = itemObject(envelope['response'], 'response metadata must be an object');
  if (meta['kind'] !== GROK_REPLAY_KIND) return undefined;
  if (meta['version'] !== GROK_REPLAY_VERSION) return invalid(`unsupported version ${String(meta['version'])}`);
  if (meta['responseId'] !== undefined && typeof meta['responseId'] !== 'string') {
    return invalid('responseId must be a string');
  }
  const rawBlocks = envelope['blocks'];
  if (!Array.isArray(rawBlocks)) return invalid('blocks must be an array');
  const content = Array.isArray(message.content) ? message.content : [];
  if (rawBlocks.length !== content.length) return invalid('block count does not match assistant content');
  /** @type {GrokReplayBlock[]} */
  const blocks = rawBlocks.map((rawBlock, index) => {
    const block = itemObject(rawBlock, `block ${index} must be an object`);
    const durable = content[index];
    if (durable === undefined || block['type'] !== durable.type) {
      return invalid(`block ${index} does not match assistant content`);
    }
    const hostedBefore = hostedItems(block, index, 'hostedBefore');
    const hostedAfter = hostedItems(block, index, 'hostedAfter');
    /** @type {GrokReplayBlock} */
    const replay = { type: /** @type {string} */ (block['type']) };
    if (hostedBefore.length > 0) replay.hostedBefore = hostedBefore;
    if (hostedAfter.length > 0) replay.hostedAfter = hostedAfter;
    if (block['type'] === 'reasoning') replay.item = reasoningItem(block['item'], index);
    else if (block['type'] !== 'text' && block['type'] !== 'tool-call') {
      return invalid(`block ${index} has an unsupported type`);
    }
    return replay;
  });
  return {
    kind: GROK_REPLAY_KIND,
    version: GROK_REPLAY_VERSION,
    blocks,
    ...(meta['responseId'] === undefined ? {} : { responseId: meta['responseId'] }),
  };
}

/**
 * Build the replay envelope for one completed response.
 *
 * `blocks` stays aligned with the emitted blocks; `response` carries the
 * per-response identity the assembler leaves untouched.
 * @param {GrokReplayBlock[]} blocks - replay entries aligned with the emitted blocks.
 * @param {string} [responseId] - terminal provider response id.
 * @returns the `{ response, blocks }` envelope for the `finish` chunk.
 */
export function grokReplayEnvelope(blocks, responseId) {
  return {
    response: {
      kind: GROK_REPLAY_KIND,
      version: GROK_REPLAY_VERSION,
      ...(responseId === undefined ? {} : { responseId }),
    },
    blocks: structuredClone(blocks),
  };
}
