/**
 * Live model catalog tests: listing normalization, TTL caching, single-flight
 * loading, credential failure handling, and teardown.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createRemoteCatalog, readListing } from '../../../lib/host/llm/catalog.js';
import { CLIENT_VERSION } from '../../../lib/host/constants.js';

/** One subscription profile the catalog can fetch for. */
const PROFILE = Object.freeze({
  baseURL: 'https://cli-chat-proxy.grok.com/v1',
  authMode: 'grok-subscription',
});

/** Build a fetch double that answers `/models` with the given body. */
function listingFetch(body, init = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (init.hang === true) {
      await new Promise(() => {});
    }
    if (init.fail === true) throw new Error('network down');
    return {
      ok: init.status === undefined ? true : init.status < 400,
      status: init.status ?? 200,
      text: async () => JSON.stringify(body),
    };
  };
  return { calls, fetch };
}

/** A fresh catalog over the given fetch. */
function catalogOf(fetch, extra = {}) {
  return createRemoteCatalog({
    fetch,
    resolveBearer: async () => 'subscription-access',
    logger: { warn() {}, debug() {} },
    now: () => 1_000,
    ...extra,
  });
}

describe('readListing', () => {
  it('normalizes ids, names, context, and output limits', () => {
    assert.deepEqual(readListing({
      data: [
        { id: 'grok-4.7', name: 'Grok 4.7', description: 'latest', context_window: 512_000, max_output_tokens: 128_000 },
        { model: 'grok-4.8', display_name: 'Grok 4.8', context_windows: [256_000, 512_000] },
        { id: 'grok-4.7' },
        { name: 'no id' },
        'junk',
      ],
    }), [
      { id: 'grok-4.7', name: 'Grok 4.7', description: 'latest', contextWindow: 512_000, maxTokens: 128_000 },
      { id: 'grok-4.8', name: 'Grok 4.8', contextWindow: 256_000 },
    ]);
  });

  it('treats a non-listing reply as an empty catalog', () => {
    assert.deepEqual(readListing({}), []);
    assert.deepEqual(readListing(null), []);
    assert.deepEqual(readListing({ data: 'nope' }), []);
  });
});

describe('createRemoteCatalog', () => {
  it('fetches with the subscription identity headers', async () => {
    const { calls, fetch } = listingFetch({ data: [{ id: 'grok-4.8' }] });
    const listing = await catalogOf(fetch).list('grok', PROFILE);
    assert.deepEqual(listing, [{ id: 'grok-4.8' }]);
    assert.equal(calls[0].url, 'https://cli-chat-proxy.grok.com/v1/models');
    assert.equal(calls[0].options.headers.authorization, 'Bearer subscription-access');
    assert.equal(calls[0].options.headers['x-xai-token-auth'], 'xai-grok-cli');
    assert.equal(calls[0].options.headers['x-grok-client-version'], CLIENT_VERSION);
  });

  it('sends no subscription handshake headers for an API-key profile', async () => {
    const { calls, fetch } = listingFetch({ data: [{ id: 'grok-4.8' }] });
    await catalogOf(fetch).list('grok', { baseURL: 'https://api.x.ai/v1', authMode: 'api-key' });
    assert.equal(calls[0].options.headers.authorization, 'Bearer subscription-access');
    assert.equal(calls[0].options.headers['x-xai-token-auth'], undefined);
  });

  it('serves the cached listing inside the TTL and refetches after it', async () => {
    const { calls, fetch } = listingFetch({ data: [{ id: 'grok-4.8' }] });
    let clock = 1_000;
    const catalog = catalogOf(fetch, { now: () => clock, ttlMs: 1_000 });
    await catalog.list('grok', PROFILE);
    await catalog.list('grok', PROFILE);
    assert.equal(calls.length, 1);
    clock = 2_500;
    await catalog.list('grok', PROFILE);
    assert.equal(calls.length, 2);
  });

  it('single-flights concurrent loads', async () => {
    const { calls, fetch } = listingFetch({ data: [{ id: 'grok-4.8' }] });
    const catalog = catalogOf(fetch);
    const [left, right] = await Promise.all([
      catalog.list('grok', PROFILE),
      catalog.list('grok', PROFILE),
    ]);
    assert.deepEqual(left, right);
    assert.equal(calls.length, 1);
  });

  it('keeps the last good listing when a later fetch fails', async () => {
    let fail = false;
    const { fetch: base } = listingFetch({ data: [{ id: 'grok-4.8' }] });
    const fetch = async (url, options) => {
      if (fail) throw new Error('network down');
      return base(url, options);
    };
    let clock = 1_000;
    const catalog = catalogOf(fetch, { now: () => clock, ttlMs: 1_000 });
    await catalog.list('grok', PROFILE);
    clock = 5_000;
    fail = true;
    assert.deepEqual(await catalog.list('grok', PROFILE), [{ id: 'grok-4.8' }]);
  });

  it('yields an empty listing without a resolvable credential', async () => {
    const { calls, fetch } = listingFetch({ data: [{ id: 'grok-4.8' }] });
    const catalog = createRemoteCatalog({
      fetch,
      resolveBearer: async () => undefined,
      logger: { warn() {}, debug() {} },
      now: () => 1_000,
    });
    assert.deepEqual(await catalog.list('grok', PROFILE), []);
    assert.equal(calls.length, 0);
  });

  it('refuses to load after close and keeps the cached listing', async () => {
    const { calls, fetch } = listingFetch({ data: [{ id: 'grok-4.8' }] });
    let clock = 1_000;
    const catalog = catalogOf(fetch, { now: () => clock, ttlMs: 1_000 });
    await catalog.list('grok', PROFILE);
    catalog.close();
    clock = 9_000;
    assert.deepEqual(await catalog.list('grok', PROFILE), [{ id: 'grok-4.8' }]);
    assert.equal(calls.length, 1);
    catalog.close();
  });
});
