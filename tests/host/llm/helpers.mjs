/**
 * Shared offline fixtures for the Grok adapter host tests: SSE responses and
 * an injected fetch transport that records requests.
 */

/** Build one SSE Response from a list of data payloads. */
export function sseResponse(events, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

/** One terminal completed-message event set. */
export function completedText(text) {
  return [{
    type: 'response.completed',
    response: {
      id: 'resp_fixture',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    },
  }, '[DONE]'];
}

/**
 * A fetch stub that records `(url, init)` pairs and answers from a queue.
 * @param {Response | ((url: string, init: object) => Response)} reply
 * @returns {{fetch: typeof globalThis.fetch, calls: {url: string, init: object}[]}}
 */
export function recordingFetch(reply) {
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(typeof reply === 'function' ? reply(url, init) : reply);
  };
  return { fetch, calls };
}

/**
 * Run one adapter stream to exhaustion and return its chunks.
 * @param {object} adapter - adapter instance.
 * @param {object} options - GenerateOptions-compatible request.
 */
export async function collectStream(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

/**
 * Run one adapter stream expected to reject and return the thrown error.
 * @param {object} adapter - adapter instance.
 * @param {object} options - GenerateOptions-compatible request.
 */
export async function rejectedStream(adapter, options) {
  try {
    for await (const _chunk of adapter.stream(options)) {
      // expected to reject before exhaustion
    }
  } catch (error) {
    return error;
  }
  throw new Error('expected the adapter stream to reject');
}

/** A user message fixture. */
export const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
