/**
 * Host upstream tests: the Grok account-surface loaders, the normalizers
 * over grok-build's documented reply shapes, and the subscription web-search
 * provider. Every upstream call is mocked through `createHttp({ fetchImpl })`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttp, HostError } from '../../lib/host/http.js';
import {
  AUTO_TOPUP_PATH,
  BILLING_PATH,
  CLIENT_VERSION,
  PROXY_BASE_URL,
  USER_PATH,
} from '../../lib/host/constants.js';
import {
  collectCitations,
  createWebSearch,
  GROK_SEARCH_PROVIDER_ID,
} from '../../lib/host/websearch.js';
import {
  createUpstream,
  normalizeBilling,
  normalizeTopup,
  normalizeUser,
  subscriptionHeaders,
} from '../../lib/host/upstream.js';

const BILLING_URL = `${PROXY_BASE_URL}${BILLING_PATH}?format=credits`;
const USER_URL = `${PROXY_BASE_URL}${USER_PATH}?include=subscription`;
const TOPUP_URL = `${PROXY_BASE_URL}${AUTO_TOPUP_PATH}`;
const RESPONSES_URL = `${PROXY_BASE_URL}/responses`;
const NOW = 1_783_000_000_000;

/** Logger that records lines so tests can assert that no secret is written. */
function createLogger() {
  const lines = [];
  const record = (level) => (...args) => lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, info: record('info'), warn: record('warn'), debug: record('debug'), error: record('error') };
}

/** Queryable fetch double keyed by URL. */
function createFetch() {
  const routes = new Map();
  const calls = [];
  const respond = (url, handler) => routes.set(url, handler);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = routes.get(String(url));
    if (handler === undefined) return new Response('not found', { status: 404 });
    return handler(init);
  };
  return { calls, respond, fetchImpl };
}

/** Store double with one fixed login. */
function loginStore(overrides = {}) {
  return {
    readLogin: () => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: NOW + 3_600_000,
      loggedInAt: NOW,
      userId: 'user-1',
      email: 'dev@example.test',
      principalType: null,
      principalId: null,
      ...overrides,
    }),
    readConfig: () => ({ refreshMinutes: 30, showIndicatorWhenLoggedOut: false, webSearchEnabled: true, searchModel: 'grok-4.6' }),
  };
}

/** OAuth double resolving one fixed bearer. */
function tokenOAuth(bearer = 'access-token') {
  return { resolveAccessToken: async () => bearer };
}

test('subscriptionHeaders carries the grok-shell identity set', () => {
  const headers = subscriptionHeaders('bearer-value', loginStore().readLogin());
  assert.equal(headers.authorization, 'Bearer bearer-value');
  assert.equal(headers['x-xai-token-auth'], 'xai-grok-cli');
  assert.equal(headers['x-authenticateresponse'], 'authenticate-response');
  assert.equal(headers['x-grok-client-version'], CLIENT_VERSION);
  assert.equal(headers['x-grok-client-identifier'], 'grok-shell');
  assert.equal(headers['x-grok-client-mode'], 'interactive');
  assert.match(headers['user-agent'], /^grok-shell\/[\d.]+ \(/u);
  assert.equal(headers['x-userid'], 'user-1');
  const anonymous = subscriptionHeaders('bearer-value', { userId: null });
  assert.equal(anonymous['x-userid'], undefined);
});

test('normalizeBilling reads percent, period, balances, and history', () => {
  const billing = normalizeBilling({
    config: {
      creditUsagePercent: 42,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-09T00:00:00Z', end: '2026-11-15T00:00:00Z' },
      prepaidBalance: { val: 1250 },
      isUnifiedBillingUser: true,
      history: [
        { billingCycle: '2026-10', includedUsed: { val: 300 }, onDemandUsed: { val: 50 }, totalUsed: { val: 350 } },
        'garbage',
      ],
    },
    onDemandEnabled: true,
    subscriptionTier: 'SUPERGROK_HEAVY',
  });
  assert.equal(billing.creditUsagePercent, 42);
  assert.equal(billing.currentPeriod.type, 'USAGE_PERIOD_TYPE_WEEKLY');
  assert.equal(billing.currentPeriod.start, Date.parse('2026-11-09T00:00:00Z'));
  assert.equal(billing.prepaidBalanceUsd, 12.5);
  assert.equal(billing.isUnifiedBillingUser, true);
  assert.equal(billing.subscriptionTier, 'SUPERGROK_HEAVY');
  assert.equal(billing.onDemandEnabled, true);
  assert.equal(billing.history.length, 1);
  assert.deepEqual(billing.history[0], {
    billingCycle: '2026-10',
    includedUsedUsd: 3,
    onDemandUsedUsd: 0.5,
    totalUsedUsd: 3.5,
  });
  // Defensive: a non-envelope reply normalizes to nulls, not a throw.
  const empty = normalizeBilling({});
  assert.equal(empty.creditUsagePercent, null);
  assert.deepEqual(empty.history, []);
});

test('normalizeUser and normalizeTopup read identity and the rule', () => {
  const user = normalizeUser({ user: { id: 'user-1', email: 'dev@example.test', name: 'Dev', subscriptionTier: 'SUPERGROK' } });
  assert.equal(user.userId, 'user-1');
  assert.equal(user.email, 'dev@example.test');
  assert.equal(user.name, 'Dev');
  assert.equal(user.subscriptionTier, 'SUPERGROK');
  assert.equal(normalizeUser({ user: { subscription: { tier: 'HEAVY' } } }).subscriptionTier, 'HEAVY');
  const topup = normalizeTopup({ rule: { enabled: true, minBeforeHittingSl: { val: 500 }, topupAmount: { val: 1000 }, maxAmountPerMonth: { val: 5000 } } });
  assert.equal(topup.enabled, true);
  assert.equal(topup.minBeforeHittingSlUsd, 5);
  assert.equal(topup.topupAmountUsd, 10);
  assert.equal(topup.maxAmountPerMonthUsd, 50);
  assert.equal(normalizeTopup({}), null);
});

test('the upstream loaders authorize every surface with the subscription', async () => {
  const fetcher = createFetch();
  fetcher.respond(BILLING_URL, () => Response.json({ config: { creditUsagePercent: 7 } }));
  fetcher.respond(USER_URL, () => Response.json({ user: { id: 'user-1', email: 'dev@example.test' } }));
  fetcher.respond(TOPUP_URL, () => Response.json({ rule: { enabled: false } }));
  const logger = createLogger();
  const upstream = createUpstream({
    http: createHttp({ fetchImpl: fetcher.fetchImpl }),
    oauth: tokenOAuth(),
    store: loginStore(),
    logger,
    now: () => NOW,
  });
  const billing = await upstream.billing();
  assert.equal(billing.creditUsagePercent, 7);
  const user = await upstream.user();
  assert.equal(user.email, 'dev@example.test');
  const topup = await upstream.topup();
  assert.equal(topup.enabled, false);
  const headers = fetcher.calls.find((call) => call.url === BILLING_URL).init.headers;
  assert.equal(headers.authorization, 'Bearer access-token');
  for (const line of logger.lines) {
    assert.ok(!line.includes('access-token'), line);
  }
});

test('upstream surfaces map auth, exhaustion, and transport failures', async () => {
  const cases = [
    { status: 401, expected: 'login_expired' },
    { status: 429, body: { error: 'subscription:free-usage-exhausted' }, expected: 'free_usage_exhausted' },
    { status: 429, expected: 'rate_limited' },
    { status: 500, expected: 'upstream_failed' },
  ];
  for (const item of cases) {
    const fetcher = createFetch();
    fetcher.respond(BILLING_URL, () => Response.json(item.body ?? {}, { status: item.status }));
    const upstream = createUpstream({
      http: createHttp({ fetchImpl: fetcher.fetchImpl }),
      oauth: tokenOAuth(),
      store: loginStore(),
      now: () => NOW,
    });
    await assert.rejects(() => upstream.billing(), (error) => error instanceof HostError && error.code === item.expected);
  }
});

test('a missing login rejects before any network traffic', async () => {
  const fetcher = createFetch();
  const store = { readLogin: () => null, readConfig: () => ({}) };
  const upstream = createUpstream({
    http: createHttp({ fetchImpl: fetcher.fetchImpl }),
    oauth: tokenOAuth(undefined),
    store,
    now: () => NOW,
  });
  await assert.rejects(() => upstream.billing(), (error) => error.code === 'login_required');
  assert.equal(fetcher.calls.length, 0);
});

test('collectCitations reads url_citation annotations and deduplicates', () => {
  const sources = collectCitations({
    output: [
      { content: [{ type: 'output_text', text: 'answer', annotations: [
        { type: 'url_citation', url: 'https://a.example/1', title: 'A' },
        { type: 'url_citation', url: 'https://a.example/1', title: 'A duplicate' },
        { type: 'other' },
      ] }] },
      { content: 'not-blocks' },
      { content: [{ type: 'output_text', annotations: [{ type: 'url_citation', url: 'https://b.example/2' }] }] },
    ],
  });
  assert.deepEqual(sources, [
    { url: 'https://a.example/1', title: 'A' },
    { url: 'https://b.example/2' },
  ]);
  assert.deepEqual(collectCitations({}), []);
});

test('the search provider serves, owns the grok route, and maps failures', async () => {
  const fetcher = createFetch();
  fetcher.respond(RESPONSES_URL, () => Response.json({
    output: [{ content: [{ type: 'output_text', text: 'ignored prose', annotations: [
      { type: 'url_citation', url: 'https://a.example/1', title: 'A' },
    ] }] }],
  }));
  const logger = createLogger();
  const webSearch = createWebSearch({
    http: createHttp({ fetchImpl: fetcher.fetchImpl }),
    oauth: tokenOAuth(),
    store: loginStore(),
    logger,
    now: () => NOW,
  });
  const provider = webSearch.provider({ searchModel: 'grok-4.6' });
  assert.equal(provider.id, GROK_SEARCH_PROVIDER_ID);
  assert.equal(provider.available(), true);
  assert.equal(provider.ownsSessionProvider('grok'), true);
  assert.equal(provider.ownsSessionProvider('zai-coding-cn'), false);
  assert.equal(provider.ownsSessionProvider('deepseek-account'), false);
  const result = await provider.search({ query: 'xAI Grok Code subscription' });
  assert.deepEqual(result.sources, [{ url: 'https://a.example/1', title: 'A' }]);
  const call = fetcher.calls[0];
  const requestBody = JSON.parse(call.init.body);
  assert.equal(requestBody.model, 'grok-4.6');
  assert.deepEqual(requestBody.tools, [{ type: 'web_search' }]);
  assert.equal(requestBody.store, false);
  assert.equal(call.init.headers.authorization, 'Bearer access-token');

  fetcher.respond(RESPONSES_URL, () => Response.json({}, { status: 429 }));
  await assert.rejects(() => provider.search({ query: 'again' }), (error) => error.code === 'rate_limited');
  fetcher.respond(RESPONSES_URL, () => Response.json({ output: [] }));
  await assert.rejects(() => provider.search({ query: 'again' }), (error) => error.code === 'grok_search_no_results');
  await assert.rejects(() => provider.search({ query: '  ' }), (error) => error.code === 'grok_search_invalid_query');

  const signedOut = createWebSearch({
    http: createHttp({ fetchImpl: fetcher.fetchImpl }),
    oauth: tokenOAuth(undefined),
    store: { readLogin: () => null, readConfig: () => ({ webSearchEnabled: true }) },
    now: () => NOW,
  }).provider();
  assert.equal(signedOut.available(), false);
  await assert.rejects(() => signedOut.search({ query: 'x' }), (error) => error.code === 'login_required');
  // A disabled config keeps the provider unusable at selection time, so a
  // settings save applies to the next search without re-registration.
  const disabled = createWebSearch({
    http: createHttp({ fetchImpl: fetcher.fetchImpl }),
    oauth: tokenOAuth(),
    store: loginStore(),
    now: () => NOW,
  }).provider({ enabled: () => false });
  assert.equal(disabled.available(), false);
  for (const line of logger.lines) {
    assert.ok(!line.includes('access-token'), line);
  }
});
