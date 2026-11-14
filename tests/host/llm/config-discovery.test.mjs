/**
 * Profile resolution defaults (built-in catalog, auth-mode base URLs, retry
 * widening) and offline model discovery over GET /models.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { discoverModels, resolveProfiles } from '../../../lib/host/llm/index.js';

describe('Grok profile resolution', () => {
  it('defaults the baseURL per auth mode', () => {
    const subscription = resolveProfiles({ grok: { authMode: 'grok-subscription' } }).get('grok');
    const apiKey = resolveProfiles({ grok: {} }).get('grok');
    assert.equal(subscription.authMode, 'grok-subscription');
    assert.equal(subscription.baseURL, 'https://cli-chat-proxy.grok.com/v1');
    assert.equal(subscription.apiKeyEnv, undefined);
    assert.equal(apiKey.authMode, 'api-key');
    assert.equal(apiKey.baseURL, 'https://api.x.ai/v1');
    assert.equal(String(apiKey.apiKeyEnv), 'XAI_API_KEY');
    assert.equal(subscription.displayName, 'Grok');
    assert.equal(subscription.reasoning, 'high');
  });

  it('ships grok-4.6 and grok-4.5 in the built-in catalog', () => {
    const profile = resolveProfiles({ grok: { authMode: 'grok-subscription' } }).get('grok');
    assert.deepEqual(profile.models.map((model) => [model.id, model.name, model.contextWindow]), [
      ['grok-4.6', 'Grok 4.6', 500_000],
      ['grok-4.5', 'Grok 4.5', 500_000],
    ]);
    const grok46 = profile.models[0];
    assert.deepEqual([...grok46.reasoningEfforts], ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual([...grok46.input], ['text', 'image']);
    assert.equal(grok46.reasoningSummary, 'concise');
  });

  it('keeps a declared model table and rejects duplicate ids', () => {
    const profile = resolveProfiles({
      grok: { models: [{ id: 'grok-custom', contextWindow: 128_000 }] },
    }).get('grok');
    assert.deepEqual(profile.models.map((model) => model.id), ['grok-custom']);
    assert.equal(profile.models[0].contextWindow, 128_000);
    assert.deepEqual([...profile.models[0].reasoningEfforts], ['low', 'medium', 'high', 'xhigh']);
    assert.throws(() => resolveProfiles({
      grok: { models: [{ id: 'dup' }, { id: 'dup' }] },
    }), /duplicate model id "dup"/);
  });

  it('owns only the grok route and refuses mixed auth fields', () => {
    assert.throws(() => resolveProfiles({ openai: {} }), /owns only "grok"/);
    assert.throws(() => resolveProfiles({
      grok: { authMode: 'grok-subscription', apiKeyEnv: 'XAI_API_KEY' },
    }), /must not set apiKeyEnv/);
    assert.throws(() => resolveProfiles({ grok: { baseURL: 'ftp://example.test' } }), /must use HTTP or HTTPS/);
  });

  it('widens the default retry policy with STREAM_CLOSED but keeps explicit codes', () => {
    const widened = resolveProfiles({ grok: {} }).get('grok').retryPolicy;
    assert.equal(widened.mode, 'normal');
    assert.ok(widened.retryableCodes.includes('STREAM_CLOSED'));

    const explicit = resolveProfiles({
      grok: { retryPolicy: { mode: 'normal', retryableCodes: ['SERVER'] } },
    }).get('grok').retryPolicy;
    assert.deepEqual([...explicit.retryableCodes], ['SERVER']);
  });
});

describe('Grok model discovery', () => {
  it('answers the owned grok route from the built-in catalog without a network call', async () => {
    const models = await discoverModels({ provider: 'grok' }, undefined, 'test', () => {
      throw new Error('the built-in catalog must not reach the network');
    });
    assert.deepEqual(models, [
      { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500_000 },
      { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500_000 },
    ]);
  });

  it('interrogates a draft endpoint through the OpenAI-compatible listing', async () => {
    const seen = [];
    const { fetch } = {
      fetch: (url, init) => {
        seen.push({ url, init });
        return Promise.resolve(new Response(JSON.stringify({
          data: [
            { id: 'grok-4.6', display_name: 'Grok 4.6', context_length: 500_000, max_output_tokens: 100_000 },
            { id: '', name: 'skipped' },
            { name: 'no id either' },
          ],
        }), { headers: { 'content-type': 'application/json' } }));
      },
    };
    const models = await discoverModels(
      { baseURL: 'https://gateway.example/openai/v1/', apiKey: 'probe-key' },
      undefined,
      'test',
      fetch,
    );
    assert.equal(seen[0].url, 'https://gateway.example/openai/v1/models');
    assert.equal(seen[0].init.headers.authorization, 'Bearer probe-key');
    assert.match(seen[0].init.headers['user-agent'], /^deepseek-harness\//);
    assert.deepEqual(models, [
      { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500_000, maxTokens: 100_000 },
    ]);
  });

  it('falls back to the stored route credential only when the draft carries none', async () => {
    const auth = [];
    const fetch = (url, init) => {
      auth.push(init.headers.authorization);
      return Promise.resolve(new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }));
    };
    await discoverModels({ baseURL: 'https://gateway.example/v1' }, async () => 'stored-key', 'test', fetch);
    await discoverModels({ baseURL: 'https://gateway.example/v1', apiKey: 'draft-key' }, async () => 'stored-key', 'test', fetch);
    assert.deepEqual(auth, ['Bearer stored-key', 'Bearer draft-key']);
  });

  it('reports unreadable protocols and failed interrogations', async () => {
    await assert.rejects(
      discoverModels({ baseURL: 'https://gateway.example/v1', api: 'anthropic' }, undefined, 'test', async () => new Response()),
      { code: 'DISCOVERY_UNSUPPORTED' },
    );
    await assert.rejects(
      discoverModels({ baseURL: 'https://gateway.example/v1' }, undefined, 'test', async () => new Response('nope', { status: 401 })),
      { code: 'DISCOVERY_FAILED' },
    );
    await assert.rejects(
      discoverModels({ baseURL: 'https://gateway.example/v1' }, undefined, 'test',
        async () => new Response('{"not_data":1}', { headers: { 'content-type': 'application/json' } })),
      { code: 'DISCOVERY_FAILED' },
    );
    await assert.rejects(
      discoverModels({}, undefined, 'test', async () => new Response()),
      { code: 'DISCOVERY_FAILED' },
    );
  });
});
