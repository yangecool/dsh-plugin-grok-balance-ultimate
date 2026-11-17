/**
 * Gateway error classification for the Grok Responses adapter: status/error
 * mapping, Retry-After parsing, x-should-retry vetoes, and how the adapter
 * plumbs them onto the typed LlmError. All cases are offline.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createGrokAdapter, grokHttpErrorCode, providerRetryAfterMs, resolveProfiles } from '../../../lib/host/llm/index.js';
import { completedText, recordingFetch, rejectedStream, sseResponse, userMessage } from './helpers.mjs';

describe('Grok gateway error-code mapping', () => {
  it('labels auth, version-gate and quota failures explicitly', () => {
    assert.equal(grokHttpErrorCode(401), 'AUTH');
    assert.equal(grokHttpErrorCode(403), 'AUTH');
    assert.equal(grokHttpErrorCode(426), 'CLIENT_VERSION_REQUIRED');
    assert.equal(grokHttpErrorCode(402, { message: 'You exceeded your quota' }), 'QUOTA');
    assert.equal(grokHttpErrorCode(429, { type: 'rate_limit_exceeded' }), 'RATE_LIMIT');
  });

  it('preserves the provider invalid-image signal for request-local recovery', () => {
    assert.equal(grokHttpErrorCode(400, { code: 'invalid_image' }, true), 'INVALID_IMAGE');
    assert.equal(grokHttpErrorCode(500, { message: 'Could not process image' }, true), 'INVALID_IMAGE');
    assert.equal(grokHttpErrorCode(400, { message: 'bad .image.source.url field' }, true), 'INVALID_IMAGE');
    assert.equal(grokHttpErrorCode(400, { code: 'invalid_image' }), 'INVALID_REQUEST');
  });

  it('strips images for 413 but leaves an already-stripped attempt terminal', () => {
    assert.equal(grokHttpErrorCode(413, undefined, true), 'IMAGE_PAYLOAD_TOO_LARGE');
    assert.equal(grokHttpErrorCode(413), 'HTTP_413');
  });

  it('honors retry vetoes and keeps Cloudflare origin TLS errors terminal', () => {
    assert.equal(grokHttpErrorCode(503, undefined, false, true), 'RETRY_VETOED');
    assert.equal(grokHttpErrorCode(429, undefined, false, true), 'RETRY_VETOED');
    assert.equal(grokHttpErrorCode(525), 'HTTP_525');
    assert.equal(grokHttpErrorCode(526), 'HTTP_526');
    assert.equal(grokHttpErrorCode(500), 'SERVER');
  });
});

describe('Grok Retry-After parsing', () => {
  it('accepts delta seconds and ignores zero, malformed, and past values', () => {
    assert.equal(providerRetryAfterMs(null), undefined);
    assert.equal(providerRetryAfterMs('0'), undefined);
    assert.equal(providerRetryAfterMs('not-a-date'), undefined);
    assert.equal(providerRetryAfterMs(new Date(Date.now() - 60_000).toUTCString()), undefined);
    assert.equal(providerRetryAfterMs('7'), 7_000);
    const dated = providerRetryAfterMs(new Date(Date.now() + 8_000).toUTCString());
    assert.ok(dated > 0 && dated <= 8_000, `dated delay ${dated}`);
  });
});

describe('Grok adapter error plumbing', () => {
  /** Build an adapter over one API-key route pointing at the given fetch. */
  function adapterWith(reply, extraProfile = {}) {
    const { fetch, calls } = recordingFetch(reply);
    const adapter = createGrokAdapter({
      profiles: () => resolveProfiles({ grok: { baseURL: 'https://example.test/v1', ...extraProfile } }),
      resolveApiKey: async () => 'fixture-key',
      resolveAgentId: () => 'agent-fixture',
      requestFetch: fetch,
    });
    return { adapter, calls };
  }

  const request = {
    provider: 'grok',
    model: 'grok-4.6',
    messages: [userMessage('fixture prompt')],
    sessionId: 'sess-errors',
  };

  it('maps 429 with Retry-After onto RATE_LIMIT with providerRetryAfterMs', async () => {
    const { adapter } = adapterWith(sseResponse([], {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '7', 'x-request-id': 'req_1' },
    }));
    // The stub body is an SSE stream; the adapter reads it as text and falls
    // back to the status when it does not parse as a JSON error envelope.
    const error = await rejectedStream(adapter, request);
    assert.equal(error.code, 'RATE_LIMIT');
    assert.equal(error.failure.status, 429);
    assert.equal(error.failure.providerRetryAfterMs, 7_000);
    assert.equal(error.failure.requestId, 'req_1');
  });

  it('maps x-should-retry: false onto RETRY_VETOED for 429 and 5xx', async () => {
    for (const status of [429, 503]) {
      const { adapter } = adapterWith(new Response(JSON.stringify({ error: { message: 'vetoed' } }), {
        status,
        headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
      }));
      const error = await rejectedStream(adapter, request);
      assert.equal(error.code, 'RETRY_VETOED');
    }
  });

  it('falls back to the status line message when the body is not a JSON envelope', async () => {
    const { adapter } = adapterWith(new Response('<html>gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }));
    const error = await rejectedStream(adapter, request);
    assert.equal(error.code, 'SERVER');
    assert.equal(error.message, 'Grok API error (HTTP 502)');
  });

  it('rejects a non-SSE success content type as a protocol failure', async () => {
    const { adapter } = adapterWith(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
    const error = await rejectedStream(adapter, request);
    assert.equal(error.code, 'PROTOCOL');
    assert.match(error.message, /instead of text\/event-stream/);
  });

  it('classifies quota envelopes on a 200-family path only via stream events or status', async () => {
    const { adapter } = adapterWith(new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your quota' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }));
    const error = await rejectedStream(adapter, request);
    assert.equal(error.code, 'QUOTA');
  });

  it('keeps a successful stream flowing after a classified error-free response', async () => {
    const { adapter, calls } = adapterWith(sseResponse(completedText('fine')));
    const chunks = [];
    for await (const chunk of adapter.stream(request)) chunks.push(chunk);
    assert.equal(calls[0].url, 'https://example.test/v1/responses');
    assert.equal(chunks.at(-1).type, 'finish');
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
  });

  it('rejects the unsupported stop option and unsupported image input', async () => {
    const textOnly = createGrokAdapter({
      profiles: () => resolveProfiles({
        grok: { baseURL: 'https://example.test/v1', models: [{ id: 'grok-4.6', input: ['text'] }] },
      }),
      resolveApiKey: async () => 'fixture-key',
      resolveAgentId: () => 'agent-fixture',
    });
    const error = await rejectedStream(textOnly, { ...request, stop: ['END'] });
    assert.equal(error.code, 'UNSUPPORTED_OPTION');

    const withImage = await rejectedStream(textOnly, {
      ...request,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { ref: {} } }] }],
    });
    assert.equal(withImage.code, 'UNSUPPORTED_CONTENT');
    assert.match(withImage.message, /does not support image input/);
  });

  it('requires the attachment service when an image-capable model receives images', async () => {
    const adapter = createGrokAdapter({
      profiles: () => resolveProfiles({ grok: { baseURL: 'https://example.test/v1' } }),
      resolveApiKey: async () => 'fixture-key',
      resolveAgentId: () => 'agent-fixture',
    });
    const error = await rejectedStream(adapter, {
      ...request,
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { ref: {} } }] }],
    });
    assert.equal(error.code, 'UNSUPPORTED_CONTENT');
    assert.match(error.message, /requires the attachment service/);
  });
});
