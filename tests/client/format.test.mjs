/**
 * Unit tests for the shared formatting helpers and the state store.
 *
 * Format helpers are pure. Store behavior is exercised against a mocked
 * `globalThis.fetch` and a fresh module instance per test (the store is a
 * singleton, so each test imports it through a unique URL query).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as format from '../../src/client/format.js';
import { coreDicts, interpolate } from '../../src/client/dicts-core.js';

/** Translate function over one core dictionary (mirrors the locale service). */
function makeT(locale = 'en') {
  const dict = coreDicts[locale];
  return (key, params) => interpolate(dict[key] === undefined ? key : dict[key], params);
}

const DAY = 86_400_000;

test('formatPercent formats, clamps, and tolerates missing values', () => {
  assert.equal(format.formatPercent(72.4), '72%');
  assert.equal(format.formatPercent(72.45, 1), '72.5%');
  assert.equal(format.formatPercent(72.45, 'zh', 1), '72.5%');
  assert.equal(format.formatPercent(140), '100%');
  assert.equal(format.formatPercent(-3), '0%');
  assert.equal(format.formatPercent(null), '');
  assert.equal(format.formatPercent('nope'), '');
  assert.equal(format.formatPercent(8, 'zh'), '8%');
});

test('formatUsd renders two fraction digits with the dollar sign', () => {
  assert.equal(format.formatUsd(12.3), '$12.30');
  assert.equal(format.formatUsd(12.345), '$12.35');
  assert.equal(format.formatUsd(0, 'en'), '$0.00');
  assert.equal(format.formatUsd(1234567.89, 'en'), '$1,234,567.89');
  assert.equal(format.formatUsd(null), '');
  assert.equal(format.formatUsd('nope'), '');
});

test('number helpers use Intl grouping and compact notation', () => {
  assert.equal(format.formatNumber(1234), '1,234');
  assert.equal(format.formatNumber(1234, 'en'), '1,234');
  assert.equal(format.formatNumber(null), '');
  assert.equal(format.formatCompact(1500, 'en'), '1.5K');
  assert.match(format.formatCompact(15000, 'zh'), /1\.5万/);
  assert.equal(format.formatCompact(null), '');
});

test('formatDateTime/formatDate/formatResetAt format valid timestamps only', () => {
  assert.equal(format.formatDateTime(null), '');
  assert.equal(format.formatDateTime('not-a-date'), '');
  const fixed = new Date(2026, 4, 21, 15, 30, 0).getTime();
  assert.match(format.formatDateTime(fixed, 'en'), /2026/);
  assert.match(format.formatDateTime(fixed, 'zh'), /2026/);
  assert.match(format.formatDate(fixed, 'en'), /2026/);
  assert.equal(format.formatDate(null, 'en'), '');

  const sameDay = new Date(2026, 4, 21, 9, 5, 0).getTime();
  const now = new Date(2026, 4, 21, 8, 0, 0).getTime();
  assert.equal(format.formatResetAt(sameDay, 'en', now), '09:05');
  assert.match(format.formatResetAt(sameDay + DAY, 'en', now), /May/);
  assert.equal(format.formatResetAt(null, 'en', now), '');
});

test('countdown localizes remaining time from a timestamp or a duration', () => {
  const t = makeT('en');
  const now = 1_700_000_000_000;
  assert.equal(format.countdown(now + (2 * 60 + 30) * 60_000, t, now), '2 hr 30 min');
  assert.equal(format.countdown(2 * 60 * 60_000, t, now), '2 hr');
  assert.equal(format.countdown(now + (2 * DAY + 3 * 60 * 60_000), t, now), '2 d 3 hr');
  assert.equal(format.countdown(now - 1000, t, now), 'Resetting now');
  assert.equal(format.countdown(30_000, t, now), '1 min');
  assert.equal(format.countdown(null, t, now), '');
  assert.equal(format.countdown(2 * 60 * 60_000, makeT('zh'), now), '2 小时');
});

test('durationMinutes, formatRelative, and formatLocaleId', () => {
  assert.equal(format.durationMinutes(90_000), 2);
  assert.equal(format.durationMinutes(0), 0);
  assert.equal(format.durationMinutes(-5), 0);
  assert.equal(format.durationMinutes(undefined), 0);

  const t = makeT('en');
  const now = 1_700_000_000_000;
  assert.equal(format.formatRelative(now - 5_000, t, now), 'Just now');
  assert.equal(format.formatRelative(now - 5 * 60_000, t, now), '5 min ago');
  assert.equal(format.formatRelative(now - 3 * 3_600_000, t, now), '3 hr ago');
  assert.equal(format.formatRelative(now - 2 * DAY, t, now), '2 d ago');
  assert.equal(format.formatRelative(null, t, now), '');

  assert.equal(format.formatLocaleId('zh'), 'zh');
  assert.equal(format.formatLocaleId('zh-CN'), 'zh');
  assert.equal(format.formatLocaleId('en-US'), 'en');
  assert.equal(format.formatLocaleId(undefined), 'en');
});

test('core dictionaries stay bilingual with matching placeholders', () => {
  const zhKeys = Object.keys(coreDicts.zh);
  const enKeys = Object.keys(coreDicts.en);
  assert.deepEqual(zhKeys.sort(), enKeys.sort());
  const required = [
    'state.error', 'state.networkError', 'state.justNow',
    'state.minutesAgo', 'state.hoursAgo', 'state.daysAgo',
    'auth.loginFailed', 'auth.loginCodeExpired',
    'app.nav',
    'time.resetDue', 'time.lessThanMinute', 'time.hoursShort',
    'time.minutesShort', 'time.daysShort',
  ];
  for (const key of required) {
    assert.ok(zhKeys.includes(key), `zh dictionary is missing ${key}`);
    assert.ok(enKeys.includes(key), `en dictionary is missing ${key}`);
  }
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of zhKeys) {
    assert.deepEqual(placeholders(coreDicts.zh[key]), placeholders(coreDicts.en[key]), `placeholder mismatch for ${key}`);
  }
  // English copy is sentence case: it starts uppercase and is not shouting.
  for (const key of enKeys) {
    const value = coreDicts.en[key];
    assert.notEqual(value, '', `${key} must have English copy`);
    if (/^[A-Za-z]/.test(value)) {
      assert.match(value, /^[A-Z]/, `English copy for ${key} must start uppercase`);
      assert.ok(!/\b[A-Z]{3,}\b/.test(value.replace(/\{\w+\}/g, '')), `English copy for ${key} is shouting`);
    }
  }
  assert.equal(interpolate('{n} min', { n: 3 }), '3 min');
  assert.equal(interpolate('{n} min', {}), '{n} min');
});

// ---------------------------------------------------------------------------
// State store: singleton behavior against a mocked same-origin fetch.
// ---------------------------------------------------------------------------

const STATE_URL = new URL('../../src/client/state.js', import.meta.url).href;
let stateImportCount = 0;

/** Import a fresh store instance (the store is a per-module singleton). */
async function freshState() {
  stateImportCount += 1;
  return import(`${STATE_URL}?case=${stateImportCount}`);
}

/** JSON envelope helpers for the mocked Host routes. */
const ok = (data) => ({ status: 200, body: { data } });
const hostError = (status, code, message = 'host failure') => ({ status, body: { error: { code, message } } });

/**
 * Install a route-table fetch mock.
 * @param routes - map of `"METHOD /path"` (or `"METHOD /path?query"`) to a
 *   result object, a function of `{ url, init }`, or an Error to throw.
 * @returns captured calls and a restore function.
 */
function installFetch(routes) {
  const calls = [];
  const hadFetch = 'fetch' in globalThis;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const text = String(url);
    const parsed = new URL(text, 'http://localhost');
    const method = init.method ?? 'GET';
    calls.push({ url: text, method, body: init.body, path: parsed.pathname, search: parsed.search });
    const handler = routes[`${method} ${parsed.pathname}${parsed.search}`]
      ?? routes[`${method} ${parsed.pathname}`]
      ?? routes[`GET ${parsed.pathname}`];
    if (handler === undefined) throw new Error(`unexpected fetch: ${method} ${parsed.pathname}${parsed.search}`);
    const result = typeof handler === 'function' ? handler({ url: parsed, init }) : handler;
    if (result instanceof Error) throw result;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    };
  };
  return {
    calls,
    restore() {
      if (hadFetch) globalThis.fetch = original;
      else delete globalThis.fetch;
    },
  };
}

const baseConfig = {
  refreshMinutes: 30,
  showIndicatorWhenLoggedOut: false,
  webSearchEnabled: true,
  searchModel: 'grok-4.6',
};
const loginView = {
  email: 'tester@grok.com',
  userId: 'user-1',
  expiresAt: 1_800_000_000_000,
  loggedInAt: 1_700_000_000_000,
};
const billingView = {
  creditUsagePercent: 25,
  currentPeriod: {
    type: 'USAGE_PERIOD_TYPE_WEEKLY',
    start: 1_700_000_000_000,
    end: 1_700_601_200_000,
  },
  prepaidBalanceUsd: 12.5,
  isUnifiedBillingUser: false,
  subscriptionTier: 'supergrok_heavy',
  onDemandEnabled: true,
  history: [{ billingCycle: '2026-W45', includedUsedUsd: 3.2, onDemandUsedUsd: 0, totalUsedUsd: 3.2 }],
};
const overviewPayload = () => ok({
  user: { userId: 'user-1', email: 'tester@grok.com', name: 'Tester', subscriptionTier: 'supergrok_heavy' },
  billing: billingView,
  topup: null,
  stale: false,
  generatedAt: 1_700_000_100_000,
});
const statusPayload = (overrides = {}) => ok({
  config: baseConfig,
  loggedIn: true,
  login: loginView,
  pending: false,
  ...overrides,
});
const flowStartPayload = (overrides = {}) => ok({
  flowId: 'flow-1',
  status: 'pending',
  userCode: 'ABCD-1234',
  verificationUri: 'https://auth.x.ai/device',
  verificationUriComplete: 'https://auth.x.ai/device?code=ABCD-1234',
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  ...overrides,
});

test('state.bootstrap loads config and login once and notifies subscribers', async () => {
  const { state } = await freshState();
  const mock = installFetch({ 'GET /grok-balance/api/status': statusPayload() });
  try {
    let notifications = 0;
    const unsubscribe = state.subscribe(() => {
      notifications += 1;
    });
    const before = state.getSnapshot();
    assert.equal(before.login, null, 'login starts null');
    const snapshot = await state.bootstrap();
    assert.equal(snapshot.config.refreshMinutes, 30);
    assert.equal(snapshot.config.webSearchEnabled, true);
    assert.equal(snapshot.loggedIn, true);
    assert.equal(snapshot.login.email, 'tester@grok.com');
    assert.equal(snapshot.login.expiresAt, 1_800_000_000_000);
    assert.notEqual(state.getSnapshot(), before);
    assert.ok(notifications > 0, 'subscribers are notified');
    await state.bootstrap();
    assert.equal(mock.calls.length, 1, 'bootstrap is a one-time load');
    unsubscribe();
    const settled = notifications;
    state.dismissError();
    assert.equal(notifications, settled, 'unsubscribed listeners stop receiving changes');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state maps transport failures to a typed network error', async () => {
  const { state, setTranslate } = await freshState();
  setTranslate(makeT('en'));
  const mock = installFetch({
    'GET /grok-balance/api/status': () => new Error('offline'),
  });
  try {
    await state.bootstrap();
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.error.code, 'network_error');
    assert.equal(snapshot.error.message, 'Network error');
    assert.equal(snapshot.config, null);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state maps host error envelopes and a 401 login_expired clears the login', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload(),
    'GET /grok-balance/api/overview': hostError(401, 'login_expired', 'no longer authorized'),
  });
  try {
    await state.bootstrap();
    assert.equal(state.getSnapshot().loggedIn, true);
    await state.refreshOverview({ force: true });
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.loggedIn, false);
    assert.equal(snapshot.loginExpired, true);
    assert.equal(snapshot.error.code, 'login_expired');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state refreshOverview caches per TTL, records lastUpdated, and shares one flight', async () => {
  const { state } = await freshState();
  let overviews = 0;
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload(),
    'GET /grok-balance/api/overview': () => {
      overviews += 1;
      return overviewPayload();
    },
  });
  try {
    await state.bootstrap();
    const [first, second] = await Promise.all([state.refreshOverview(), state.refreshOverview()]);
    assert.equal(first, second, 'in-flight requests share one promise');
    const cached = await state.refreshOverview();
    assert.equal(overviews, 1, 'the TTL window keeps the cached payload');
    assert.equal(cached.billing.creditUsagePercent, 25);
    assert.equal(state.getSnapshot().lastUpdated, 1_700_000_100_000);
    await state.refreshOverview({ force: true });
    assert.equal(overviews, 2, 'force bypasses the cache');
    // Force requests carry the force query flag.
    const forcedCall = mock.calls.find((call) => call.path === '/grok-balance/api/overview' && call.search === '?force=1');
    assert.ok(forcedCall !== undefined, 'force refresh sends ?force=1');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state treats a login_required overview as signed-out, not as an error', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload({ loggedIn: true, login: loginView }),
    'GET /grok-balance/api/overview': ok({
      error: { code: 'login_required', message: 'Sign in to Grok first' },
      stale: false,
      generatedAt: null,
    }),
  });
  try {
    await state.bootstrap();
    const payload = await state.refreshOverview({ force: true });
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.loggedIn, false);
    assert.equal(snapshot.error, null, 'login_required clears the login without raising an error');
    assert.equal(payload.error.code, 'login_required');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state records per-surface overview errors without dropping the payload', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload(),
    'GET /grok-balance/api/overview': ok({
      user: { userId: 'user-1', email: 'tester@grok.com', name: null, subscriptionTier: null },
      billing: { error: { code: 'upstream_failed', message: 'billing is down' } },
      topup: null,
      stale: false,
      generatedAt: 1_700_000_100_000,
    }),
  });
  try {
    await state.bootstrap();
    const payload = await state.refreshOverview({ force: true });
    assert.equal(payload.billing.error.code, 'upstream_failed');
    assert.equal(state.getSnapshot().overview.billing.error.code, 'upstream_failed');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state startLogin stores the device flow and pollLogin completes it', async () => {
  const { state } = await freshState();
  const polls = [];
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload(),
    'POST /grok-balance/api/login': flowStartPayload(),
    'GET /grok-balance/api/login/poll': ({ url }) => {
      polls.push(url.searchParams.get('flowId'));
      return flowStartPayload({ status: 'complete' });
    },
    'GET /grok-balance/api/overview': overviewPayload(),
  });
  try {
    await state.bootstrap();
    const flow = await state.startLogin();
    assert.equal(flow.state, 'pending');
    assert.equal(flow.userCode, 'ABCD-1234');
    assert.equal(flow.verificationUriComplete, 'https://auth.x.ai/device?code=ABCD-1234');
    const settled = await state.pollLogin();
    assert.deepEqual(polls, ['flow-1'], 'the poll carries the flowId query');
    assert.equal(settled.state, 'idle', 'a completed flow settles back to idle');
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.loggedIn, true);
    assert.equal(snapshot.overview.billing.creditUsagePercent, 25);
    assert.equal(snapshot.error, null);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state maps a failed device flow onto the error state', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload(),
    'POST /grok-balance/api/login': flowStartPayload(),
    'GET /grok-balance/api/login/poll': flowStartPayload({ status: 'error', error: 'authorization denied' }),
  });
  try {
    await state.bootstrap();
    await state.startLogin();
    const settled = await state.pollLogin();
    assert.equal(settled.state, 'error');
    assert.equal(settled.error, 'authorization denied');
    assert.equal(state.getSnapshot().error.code, 'login_failed');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state startLogin failures surface an error flow block', async () => {
  const { state, setTranslate } = await freshState();
  setTranslate(makeT('en'));
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload(),
    'POST /grok-balance/api/login': hostError(502, 'oauth_unavailable', 'issuer down'),
  });
  try {
    await state.bootstrap();
    await assert.rejects(() => state.startLogin(), (error) => error.code === 'oauth_unavailable');
    const flow = state.getSnapshot().flow;
    assert.equal(flow.state, 'error');
    assert.equal(flow.error, 'issuer down');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state cancelLogin clears the pending flow without touching login', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload(),
    'POST /grok-balance/api/login': flowStartPayload(),
    'GET /grok-balance/api/login/poll': ok(flowStartPayload({ status: 'pending' })),
  });
  try {
    await state.bootstrap();
    await state.startLogin();
    await state.pollLogin();
    state.cancelLogin();
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.flow.state, 'idle');
    assert.equal(snapshot.flow.flowId, null);
    assert.equal(snapshot.loggedIn, true, 'a local cancel keeps the stored login');
    const again = await state.pollLogin();
    assert.equal(again.state, 'idle', 'no further polls run after cancel');
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state saveConfig applies the returned config and logout clears account data', async () => {
  const { state } = await freshState();
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload(),
    'GET /grok-balance/api/overview': overviewPayload(),
    'POST /grok-balance/api/config': ok({ ...baseConfig, refreshMinutes: 5 }),
    'POST /grok-balance/api/logout': ok({ ok: true }),
  });
  try {
    await state.bootstrap();
    const saved = await state.saveConfig({ refreshMinutes: 5 });
    assert.equal(saved.ok, true);
    assert.equal(saved.config.refreshMinutes, 5);
    assert.equal(state.getSnapshot().config.refreshMinutes, 5);

    const result = await state.logout();
    assert.equal(result.ok, true);
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.loggedIn, false);
    assert.equal(snapshot.login, null);
    assert.equal(snapshot.overview, null);
    assert.equal(snapshot.lastUpdated, null);
  } finally {
    mock.restore();
    state.dispose();
  }
});

test('state.tick refreshes stale overviews and skips hidden documents', async () => {
  const { state } = await freshState();
  let overviews = 0;
  const mock = installFetch({
    'GET /grok-balance/api/status': statusPayload(),
    'GET /grok-balance/api/overview': () => {
      overviews += 1;
      return overviewPayload();
    },
  });
  try {
    await state.bootstrap();
    await state.tick();
    assert.equal(overviews, 1, 'a cold overview refreshes on tick');
    // Hide the document: ticks pause.
    const originalHidden = Object.getOwnPropertyDescriptor(globalThis, 'document');
    globalThis.document = { visibilityState: 'hidden' };
    try {
      await state.tick();
    } finally {
      if (originalHidden === undefined) delete globalThis.document;
      else Object.defineProperty(globalThis, 'document', originalHidden);
    }
    assert.equal(overviews, 1, 'hidden documents pause auto-refresh');
  } finally {
    mock.restore();
    state.dispose();
  }
});
