/**
 * Standards-compliant SSE framing for the direct Grok Responses transport.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';

/** Native Responses stream terminator. */
export const GROK_DONE = '[DONE]';

/**
 * Non-standard Grok detector frame reported outside the typed Responses
 * vocabulary. The doom-loop consumer itself is fork-private and was not
 * ported; the frame is still normalized here so a provider that emits it
 * cannot poison an otherwise valid model stream.
 */
export const GROK_DOOM_LOOP_EVENT = 'response.doom_loop_check';

/**
 * Preserve the detector payload while making an SSE-name-only frame safe for
 * the semantic translator. The upstream parser treats the SSE `event:` name as
 * authoritative: even malformed detector data is swallowed instead of failing
 * the stream.
 * @param data - raw SSE data payload of the named detector frame.
 * @returns a JSON payload whose `type` names the detector frame.
 */
function normalizeNamedDoomLoopFrame(data) {
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    return JSON.stringify({ type: GROK_DOOM_LOOP_EVENT });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return JSON.stringify({ type: GROK_DOOM_LOOP_EVENT });
  }
  return JSON.stringify({ ...value, type: GROK_DOOM_LOOP_EVENT });
}

/**
 * Yield every Responses data payload and normalize a clean EOF to the same
 * boundary as the optional native `[DONE]` terminator. The semantic translator
 * still requires a preceding `response.completed` or `response.incomplete`, so
 * a transport truncated before its terminal event fails closed.
 * @param stream - HTTP response body carrying SSE frames.
 * @param onComment - optional activity callback for SSE comment frames.
 * @returns an async iterator of raw data payloads ending in `[DONE]`.
 */
export async function* parseGrokSse(stream, onComment) {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment: () => { onComment?.(); } }));
  for await (const { data, event } of events) {
    yield event === GROK_DOOM_LOOP_EVENT && data !== GROK_DONE
      ? normalizeNamedDoomLoopFrame(data)
      : data;
    if (data === GROK_DONE) return;
  }
  yield GROK_DONE;
}
