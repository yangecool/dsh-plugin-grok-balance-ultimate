/**
 * Header injection differences between subscription and API-key auth modes,
 * exercised end to end through the adapter with an injected offline fetch.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createGrokAdapter,
  resolveProfiles,
  SUBSCRIPTION_BASE_URL,
} from '../../../lib/host/llm/index.js';
import { completedText, recordingFetch, sseResponse, userMessage } from './helpers.mjs';

const UUID_RE = /^[0-9a-f-]{36}$/;
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

/** Build one adapter over the given profile and fetch stub. */
function adapterWithProfile(profile, reply) {
  const { fetch, calls } = recordingFetch(reply);
  const adapter = createGrokAdapter({
    profiles: () => resolveProfiles({ grok: profile }),
    resolveApiKey: async () => profile.authMode === 'grok-subscription' ? 'subscription-access' : 'fixture-key',
    resolveAgentId: () => '6adb6dc4-cb5b-5f91-ae7e-cb1bcac89e61',
    requestFetch: fetch,
  });
  return { adapter, calls };
}

const baseRequest = {
  provider: 'grok',
  model: 'grok-4.6',
  messages: [userMessage('fixture prompt')],
  sessionId: 'subscription-session',
};

async function headersOf(adapter, request = baseRequest) {
  const chunks = [];
  for await (const chunk of adapter.stream(request)) chunks.push(chunk);
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  return chunks;
}

describe('Grok subscription header injection', () => {
  it('sends the full grok-build identity, call and agent headers to the proxy URL', async () => {
    const { adapter, calls } = adapterWithProfile(
      { authMode: 'grok-subscription' },
      sseResponse(completedText('ok')),
    );
    await headersOf(adapter);
    const headers = calls[0].init.headers;

    assert.equal(headers.authorization, 'Bearer subscription-access');
    assert.equal(headers['x-xai-token-auth'], 'xai-grok-cli');
    assert.equal(headers['x-authenticateresponse'], 'authenticate-response');
    assert.equal(headers['x-grok-client-identifier'], 'grok-shell');
    assert.equal(headers['x-grok-client-version'], '1.0.45');
    assert.equal(headers['x-grok-client-mode'], 'interactive');
    assert.match(headers['user-agent'], /^grok-shell\/1\.0\.45 \(.+; .+\)$/);
    assert.equal(headers['x-grok-conv-id'], 'subscription-session');
    assert.equal(headers['x-grok-session-id'], 'subscription-session');
    assert.equal(headers['x-grok-agent-id'], '6adb6dc4-cb5b-5f91-ae7e-cb1bcac89e61');
    assert.equal(headers['x-grok-model-override'], 'grok-4.6');
    assert.equal(headers['x-grok-turn-idx'], '1');
    assert.match(headers['x-grok-req-id'], UUID_RE);
    assert.match(headers.traceparent, TRACEPARENT_RE);
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers.accept, 'text/event-stream');
    assert.equal(headers['accept-encoding'], 'gzip, br, deflate');
    assert.equal(calls[0].url, `${SUBSCRIPTION_BASE_URL}/responses`);
    // grok-4.6 on a first-party endpoint also requests native no-inline citations.
    assert.deepEqual(JSON.parse(calls[0].init.body).include,
      ['reasoning.encrypted_content', 'no_inline_citations']);
  });

  it('omits x-authenticateresponse when the subscription baseURL is not the proxy', async () => {
    const { adapter, calls } = adapterWithProfile(
      { authMode: 'grok-subscription', baseURL: 'https://grok.example.test/v1' },
      sseResponse(completedText('ok')),
    );
    await headersOf(adapter);
    const headers = calls[0].init.headers;
    assert.equal(headers['x-authenticateresponse'], undefined);
    assert.equal(headers['x-xai-token-auth'], 'xai-grok-cli');
    assert.equal(calls[0].url, 'https://grok.example.test/v1/responses');
  });

  it('namespaces compaction and session-title call ids off the parent conversation', async () => {
    const { adapter, calls } = adapterWithProfile(
      { authMode: 'grok-subscription' },
      () => sseResponse(completedText('ok')),
    );
    await headersOf(adapter, { ...baseRequest, purpose: 'compaction' });
    await headersOf(adapter, { ...baseRequest, purpose: 'session-title' });

    assert.match(calls[0].init.headers['x-grok-req-id'], /^xai-compact-[0-9a-f-]{36}$/);
    assert.equal(calls[0].init.headers['x-grok-conv-id'], 'subscription-session');
    assert.equal(calls[0].init.headers['x-grok-turn-idx'], undefined);
    assert.match(calls[1].init.headers['x-grok-conv-id'], /^title-refresh-[0-9a-f-]{36}$/);
    assert.match(calls[1].init.headers['x-grok-req-id'], /^xai-title-refresh-[0-9a-f-]{36}$/);
    assert.equal(calls[1].init.headers['x-grok-turn-idx'], undefined);
  });

  it('honors the GROK_CLIENT_VERSION override', async () => {
    const previous = process.env.GROK_CLIENT_VERSION;
    process.env.GROK_CLIENT_VERSION = '9.9.9';
    try {
      const { adapter, calls } = adapterWithProfile(
        { authMode: 'grok-subscription' },
        sseResponse(completedText('ok')),
      );
      await headersOf(adapter);
      assert.equal(calls[0].init.headers['x-grok-client-version'], '9.9.9');
      assert.match(calls[0].init.headers['user-agent'], /^grok-shell\/9\.9\.9 \(.+; .+\)$/);
    } finally {
      if (previous === undefined) delete process.env.GROK_CLIENT_VERSION;
      else process.env.GROK_CLIENT_VERSION = previous;
    }
  });

  it('does not let profile headers overwrite protocol identity', async () => {
    const { adapter, calls } = adapterWithProfile(
      {
        authMode: 'grok-subscription',
        headers: {
          authorization: 'Bearer attacker',
          'x-grok-agent-id': 'spoofed',
          'x-deployment-fact': 'kept',
        },
      },
      sseResponse(completedText('ok')),
    );
    await headersOf(adapter);
    const headers = calls[0].init.headers;
    assert.equal(headers.authorization, 'Bearer subscription-access');
    assert.equal(headers['x-grok-agent-id'], '6adb6dc4-cb5b-5f91-ae7e-cb1bcac89e61');
    assert.equal(headers['x-deployment-fact'], 'kept');
  });
});

describe('Grok API-key header injection', () => {
  it('sends only the bearer plus attribution headers', async () => {
    const { adapter, calls } = adapterWithProfile({}, sseResponse(completedText('ok')));
    await headersOf(adapter);
    const headers = calls[0].init.headers;

    assert.equal(headers.authorization, 'Bearer fixture-key');
    assert.match(headers['user-agent'], /^deepseek-harness\//);
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers.accept, 'text/event-stream');
    for (const name of Object.keys(headers)) {
      assert.ok(!name.startsWith('x-grok-'), `unexpected x-grok header ${name}`);
      assert.ok(!name.startsWith('x-xai-'), `unexpected x-xai header ${name}`);
      assert.ok(name !== 'traceparent' && name !== 'x-authenticateresponse');
    }
    assert.equal(calls[0].url, 'https://api.x.ai/v1/responses');
  });
});
