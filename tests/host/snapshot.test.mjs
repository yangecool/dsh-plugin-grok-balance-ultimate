/**
 * Snapshot aggregation tests: TTL caching, single-flight de-duplication,
 * stale-last-good fallback, and login-state invalidation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../../lib/host/http.js';
import { createSnapshot } from '../../lib/host/snapshot.js';

const NOW = 1_783_000_000_000;

/** Writable clock handed to the snapshot as `now`. */
function createClock(start) {
  let current = start;
  return {
    now: () => current,
    advance(milliseconds) {
      current += milliseconds;
    },
  };
}

/** Upstream double with scripted per-surface results. */
function createUpstreamDouble(overrides = {}) {
  const calls = [];
  const upstream = {
    user: overrides.user ?? (async () => ({ userId: 'user-1', email: 'dev@example.test', name: 'Dev', subscriptionTier: 'SUPERGROK' })),
    billing: overrides.billing ?? (async () => ({ creditUsagePercent: 12, history: [] })),
    topup: overrides.topup ?? (async () => null),
  };
  for (const [name, impl] of Object.entries(upstream)) {
    upstream[name] = async (...args) => {
      calls.push(name);
      return impl(...args);
    };
  }
  return { upstream, calls };
}

/** Store double holding one login. */
function loginStore(loggedIn = true) {
  let login = loggedIn
    ? { accessToken: 'token', refreshToken: 'r', expiresAt: NOW + 3_600_000, loggedInAt: NOW, userId: 'user-1', email: 'dev@example.test' }
    : null;
  return {
    readLogin: () => login,
    readConfig: () => ({ refreshMinutes: 30, showIndicatorWhenLoggedOut: false, webSearchEnabled: true, searchModel: 'grok-4.6' }),
    writeLoginRecord: (record) => {
      login = { ...record };
      return login;
    },
    clearLogin: () => {
      const had = login !== null;
      login = null;
      return had;
    },
  };
}

/** OAuth double. */
function oauthDouble() {
  return { start: async () => ({ flowId: 'f1', status: 'pending', userCode: 'GROK-7AX', verificationUri: 'https://auth.x.ai/device', expiresAt: new Date(NOW + 600_000).toISOString() }), status: (id) => (id === 'f1' ? { flowId: 'f1', status: 'pending' } : undefined), logout: async () => {} };
}

test('status reports config, login state, and no tokens', async () => {
  const store = loginStore();
  const { upstream } = createUpstreamDouble();
  const snapshot = createSnapshot({ store, oauth: oauthDouble(), upstream, now: () => NOW });
  const status = await snapshot.status();
  assert.equal(status.loggedIn, true);
  assert.equal(status.login.email, 'dev@example.test');
  assert.equal(status.login.expiresAt, NOW + 3_600_000);
  assert.equal(JSON.stringify(status).includes('token'), false);
  const signedOut = createSnapshot({ store: loginStore(false), oauth: oauthDouble(), upstream: createUpstreamDouble().upstream, now: () => NOW });
  assert.equal((await signedOut.status()).loggedIn, false);
});

test('overview caches within the TTL and single-flights concurrent reads', async () => {
  const clock = createClock(NOW);
  let releases = 0;
  const { upstream, calls } = createUpstreamDouble({
    billing: async () => {
      releases += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { creditUsagePercent: releases * 10, history: [] };
    },
  });
  const snapshot = createSnapshot({ store: loginStore(), oauth: oauthDouble(), upstream, now: clock.now });
  const [first, second] = await Promise.all([snapshot.overview(), snapshot.overview()]);
  assert.equal(first.billing.creditUsagePercent, 10);
  assert.equal(second.billing.creditUsagePercent, 10);
  assert.equal(calls.filter((name) => name === 'billing').length, 1);
  clock.advance(61_000);
  const third = await snapshot.overview();
  assert.equal(third.billing.creditUsagePercent, 20);
  const forced = await snapshot.overview({ force: true });
  assert.equal(forced.billing.creditUsagePercent, 30);
});

test('a total upstream failure keeps the last good snapshot as stale', async () => {
  const clock = createClock(NOW);
  let failing = false;
  const { upstream } = createUpstreamDouble({
    user: async () => {
      if (failing) throw new HostError('upstream_failed', 'boom');
      return { userId: 'user-1', email: 'dev@example.test', name: 'Dev', subscriptionTier: 'SUPERGROK' };
    },
    billing: async () => {
      if (failing) throw new HostError('upstream_failed', 'boom');
      return { creditUsagePercent: 55, history: [] };
    },
  });
  const snapshot = createSnapshot({ store: loginStore(), oauth: oauthDouble(), upstream, now: clock.now });
  const good = await snapshot.overview();
  assert.equal(good.stale, false);
  failing = true;
  clock.advance(61_000);
  const stale = await snapshot.overview();
  assert.equal(stale.stale, true);
  assert.equal(stale.billing.creditUsagePercent, 55);
  // With no cache at all, the failure surfaces as an error document.
  const fresh = createSnapshot({ store: loginStore(), oauth: oauthDouble(), upstream, now: clock.now });
  const errored = await fresh.overview();
  assert.equal(errored.error.code, 'upstream_failed');
  assert.equal(errored.stale, false);
});

test('a partial failure keeps serving the healthy surfaces', async () => {
  const { upstream } = createUpstreamDouble({
    topup: async () => {
      throw new HostError('upstream_failed', 'boom');
    },
  });
  const snapshot = createSnapshot({ store: loginStore(), oauth: oauthDouble(), upstream, now: () => NOW });
  const overview = await snapshot.overview();
  assert.equal(overview.error, undefined);
  assert.equal(overview.user.email, 'dev@example.test');
  assert.equal(overview.billing.creditUsagePercent, 12);
  assert.equal(overview.topup, null);
});

test('a signed-out overview reports login_required and caches nothing', async () => {
  const { upstream, calls } = createUpstreamDouble();
  const snapshot = createSnapshot({ store: loginStore(false), oauth: oauthDouble(), upstream, now: () => NOW });
  const overview = await snapshot.overview();
  assert.equal(overview.error.code, 'login_required');
  assert.equal(calls.length, 0);
});

test('login and logout delegate to the OAuth controller and invalidate caches', async () => {
  const store = loginStore();
  const { upstream, calls } = createUpstreamDouble();
  const oauth = oauthDouble();
  let loggedOut = false;
  oauth.logout = async () => {
    loggedOut = true;
    store.clearLogin();
  };
  const snapshot = createSnapshot({ store, oauth, upstream, now: () => NOW });
  const flow = await snapshot.startLogin();
  assert.equal(flow.userCode, 'GROK-7AX');
  assert.deepEqual(await snapshot.loginStatus('f1'), { flowId: 'f1', status: 'pending' });
  await snapshot.overview();
  assert.ok(calls.length > 0);
  await snapshot.logout();
  assert.equal(loggedOut, true);
  const after = await snapshot.overview();
  assert.equal(after.error.code, 'login_required');
});
