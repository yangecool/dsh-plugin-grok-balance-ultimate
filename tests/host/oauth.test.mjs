/**
 * Host OAuth tests: the xAI device-flow state machine and the shared
 * grok auth store.
 *
 * Every upstream call is mocked through `createHttp({ fetchImpl })`; the
 * clock and sleep are injected so poll intervals, flow expiry, and token
 * refresh are deterministic. The store tests run against a real temporary
 * directory because the shared auth.json semantics are filesystem behavior.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHttp } from '../../lib/host/http.js';
import {
  CLIENT_SURFACE,
  CLIENT_VERSION,
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_PATH,
  OAUTH_DISCOVERY_PATH,
  OAUTH_ISSUER,
  OAUTH_REFERRER,
  OAUTH_SCOPES,
  authScopeKey,
} from '../../lib/host/constants.js';
import { createOAuth } from '../../lib/host/oauth.js';
import { createStore, resolveGrokAuthPath, sanitizeLogin } from '../../lib/host/store.js';

const DISCOVERY_URL = `${OAUTH_ISSUER}${OAUTH_DISCOVERY_PATH}`;
const DEVICE_URL = `${OAUTH_ISSUER}${OAUTH_DEVICE_PATH}`;
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const NOW = 1_783_000_000_000;
const SCOPE = authScopeKey();
const OTHER_SCOPE = 'https://accounts.x.ai/sign-in';

/** Build a deterministic JWT-shaped token with the given claims. */
function encodeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

/** Logger that records lines so tests can assert that no secret is written. */
function createLogger() {
  const lines = [];
  const record = (level) => (...args) => lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, info: record('info'), warn: record('warn'), debug: record('debug'), error: record('error') };
}

/** Queryable fetch double for the three OAuth endpoints. */
function createOAuthFetch() {
  const calls = [];
  const routes = new Map();
  const respond = (url, handler) => routes.set(url, handler);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = routes.get(String(url));
    if (handler === undefined) return new Response('not found', { status: 404 });
    return handler(init);
  };
  return { calls, respond, fetchImpl };
}

/** Default discovery + device handlers of one successful login. */
function primeHappyPath(oauthFetch, overrides = {}) {
  oauthFetch.respond(DISCOVERY_URL, () => Response.json({ token_endpoint: TOKEN_URL }));
  oauthFetch.respond(DEVICE_URL, () => Response.json({
    device_code: 'dev-1234',
    user_code: 'GROK-7AX',
    verification_uri: 'https://auth.x.ai/device',
    verification_uri_complete: 'https://auth.x.ai/device?code=GROK-7AX',
    expires_in: 900,
    interval: 5,
  }));
  let polls = 0;
  oauthFetch.respond(TOKEN_URL, () => {
    polls += 1;
    if (polls === 1) {
      return Response.json({ error: 'authorization_pending' }, { status: 400 });
    }
    return Response.json({
      access_token: 'access-first',
      refresh_token: 'refresh-first',
      expires_in: 3600,
      id_token: encodeJwt({ sub: 'user-1', email: 'dev@example.test' }),
    });
  });
  return { polls: () => polls, ...overrides };
}

/** Create a store over a fresh temporary directory. */
function createTempStore(logger) {
  const dir = mkdtempSync(join(tmpdir(), 'grok-balance-test-'));
  const store = createStore({ logger, configPath: join(dir, 'config.json'), authPath: join(dir, 'auth.json') });
  return { dir, store };
}

test('the shared auth path honors overrides in grok-build order', () => {
  const explicit = resolveGrokAuthPath('/tmp/custom-auth.json');
  assert.equal(explicit, '/tmp/custom-auth.json');
  const previousHome = process.env.GROK_HOME;
  const previousPath = process.env.GROK_AUTH_PATH;
  try {
    delete process.env.GROK_AUTH_PATH;
    process.env.GROK_HOME = '/tmp/grok-home';
    assert.equal(resolveGrokAuthPath(), join('/tmp/grok-home', 'auth.json'));
    delete process.env.GROK_HOME;
    assert.match(resolveGrokAuthPath(), /\.grok[/\\]auth\.json$/u);
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
    if (previousPath === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousPath;
  }
});

test('sanitizeLogin reads expiry, principals, and the 30-day fallback', () => {
  assert.equal(sanitizeLogin(undefined), null);
  assert.equal(sanitizeLogin({}), null);
  const login = sanitizeLogin({
    key: 'token',
    refresh_token: 'r',
    expires_at: '2026-11-15T08:00:00.000Z',
    create_time: '2026-11-15T07:00:00.000Z',
    user_id: 'user-1',
    email: 'dev@example.test',
    principal_type: 'team',
    principal_id: 'team-9',
    oidc_issuer: OAUTH_ISSUER,
    oidc_client_id: OAUTH_CLIENT_ID,
  });
  assert.equal(login.accessToken, 'token');
  assert.equal(login.refreshToken, 'r');
  assert.equal(login.expiresAt, Date.parse('2026-11-15T08:00:00.000Z'));
  assert.equal(login.userId, 'user-1');
  assert.equal(login.email, 'dev@example.test');
  assert.equal(login.principalType, 'team');
  assert.equal(login.principalId, 'team-9');
  const fallback = sanitizeLogin({ key: 'token', create_time: 1_700_000_000_000 });
  assert.equal(fallback.expiresAt, 1_700_000_000_000 + 30 * 24 * 60 * 60 * 1000);
});

test('the store preserves foreign scopes and clears only its own', () => {
  const logger = createLogger();
  const { dir, store } = createTempStore(logger);
  try {
    writeFileSync(join(dir, 'auth.json'), `${JSON.stringify({
      [OTHER_SCOPE]: { key: 'native-token', auth_mode: 'oidc' },
      [SCOPE]: { key: 'stale', create_time: 1 },
    }, null, 2)}\n`);
    const login = store.writeLoginRecord({ key: 'fresh', auth_mode: 'oidc' });
    assert.equal(login.accessToken, 'fresh');
    const raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    assert.equal(raw[OTHER_SCOPE].key, 'native-token');
    assert.equal(raw[SCOPE].key, 'fresh');
    assert.equal(store.clearLogin(), true);
    const after = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    assert.equal(after[SCOPE], undefined);
    assert.equal(after[OTHER_SCOPE].key, 'native-token');
    assert.equal(store.clearLogin(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store tolerates a corrupt auth.json without touching other scopes', () => {
  const logger = createLogger();
  const { dir, store } = createTempStore(logger);
  try {
    writeFileSync(join(dir, 'auth.json'), 'not-json{');
    assert.equal(store.readLogin(), null);
    store.writeLoginRecord({ key: 'fresh', auth_mode: 'oidc' });
    const raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    assert.equal(raw[SCOPE].key, 'fresh');
    assert.ok(logger.lines.some((line) => line.includes('not valid JSON')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a login round trip persists the grok-build record shape', async () => {
  const logger = createLogger();
  const { dir, store } = createTempStore(logger);
  try {
    const oauthFetch = createOAuthFetch();
    primeHappyPath(oauthFetch);
    const clock = { value: NOW };
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      logger,
      now: () => clock.value,
      sleep: async () => {},
    });
    const start = await oauth.start();
    assert.equal(start.userCode, 'GROK-7AX');
    assert.equal(start.verificationUri, 'https://auth.x.ai/device');
    assert.equal(start.verificationUriComplete, 'https://auth.x.ai/device?code=GROK-7AX');
    assert.equal(start.status, 'pending');
    for (let index = 0; index < 10 && oauth.status(start.flowId).status === 'pending'; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(oauth.status(start.flowId).status, 'complete');
    const raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    const record = raw[SCOPE];
    assert.equal(record.key, 'access-first');
    assert.equal(record.auth_mode, 'oidc');
    assert.equal(record.user_id, 'user-1');
    assert.equal(record.email, 'dev@example.test');
    assert.equal(record.refresh_token, 'refresh-first');
    assert.equal(record.create_time, new Date(NOW).toISOString());
    assert.equal(record.expires_at, new Date(NOW + 3600 * 1000).toISOString());
    assert.equal(record.oidc_issuer, OAUTH_ISSUER);
    assert.equal(record.oidc_client_id, OAUTH_CLIENT_ID);
    // Request shape: form fields, referrer, and the client headers.
    const deviceCall = oauthFetch.calls.find((call) => call.url === DEVICE_URL);
    const deviceBody = new URLSearchParams(deviceCall.init.body);
    assert.equal(deviceBody.get('client_id'), OAUTH_CLIENT_ID);
    assert.equal(deviceBody.get('scope'), OAUTH_SCOPES.join(' '));
    assert.equal(deviceBody.get('referrer'), OAUTH_REFERRER);
    assert.equal(deviceCall.init.headers['x-grok-client-version'], CLIENT_VERSION);
    assert.equal(deviceCall.init.headers['x-grok-client-surface'], CLIENT_SURFACE);
    // No token material ever reaches a log line.
    for (const line of logger.lines) {
      assert.ok(!line.includes('access-first') && !line.includes('refresh-first'), line);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start reuses the pending flow and does not mint a second device code', async () => {
  const { dir, store } = createTempStore(createLogger());
  try {
    const oauthFetch = createOAuthFetch();
    primeHappyPath(oauthFetch);
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      now: () => NOW,
      sleep: () => new Promise(() => {}),
    });
    const first = await oauth.start();
    const second = await oauth.start();
    assert.equal(second.flowId, first.flowId);
    assert.equal(oauthFetch.calls.filter((call) => call.url === DEVICE_URL).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('access_denied and malformed device replies map to terminal states', async () => {
  const { dir, store } = createTempStore(createLogger());
  try {
    const oauthFetch = createOAuthFetch();
    oauthFetch.respond(DISCOVERY_URL, () => Response.json({ token_endpoint: TOKEN_URL }));
    oauthFetch.respond(DEVICE_URL, () => Response.json({
      device_code: 'dev-1234',
      user_code: 'GROK-7AX',
      verification_uri: 'https://auth.x.ai/device',
      expires_in: 900,
      interval: 1,
    }));
    let polls = 0;
    oauthFetch.respond(TOKEN_URL, () => {
      polls += 1;
      return Response.json({ error: 'access_denied' }, { status: 400 });
    });
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      now: () => NOW,
      sleep: async () => {},
    });
    const start = await oauth.start();
    for (let index = 0; index < 10 && oauth.status(start.flowId).status === 'pending'; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const denied = oauth.status(start.flowId);
    assert.equal(denied.status, 'error');
    assert.equal(denied.error, 'authorization denied');
    assert.equal(polls, 1);

    oauthFetch.respond(DEVICE_URL, () => Response.json({ device_code: 'dev', user_code: 'bad code!' }));
    await assert.rejects(() => oauth.start(), (error) => error.code === 'oauth_invalid_response');
    oauthFetch.respond(DEVICE_URL, () => Response.json({
      device_code: 'dev',
      user_code: 'GROK-7AX',
      verification_uri: 'ftp://auth.x.ai/device',
      expires_in: 900,
    }));
    await assert.rejects(() => oauth.start(), (error) => error.code === 'oauth_invalid_response');
    // A failing discovery surfaces as an unavailable service, not a crash.
    oauthFetch.respond(DEVICE_URL, () => Response.json({
      device_code: 'dev',
      user_code: 'GROK-7AX',
      verification_uri: 'https://auth.x.ai/device',
      expires_in: 900,
    }));
    // A fresh controller has no cached discovery: a failing discovery
    // surfaces as an unavailable flow error, not a crash.
    oauthFetch.respond(DISCOVERY_URL, () => new Response('boom', { status: 500 }));
    const failing = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      now: () => NOW,
      sleep: async () => {},
    });
    const terminal = await failing.start();
    for (let index = 0; index < 10 && failing.status(terminal.flowId).status === 'pending'; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(failing.status(terminal.flowId).status, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancel and logout stop polling and remove only this scope', async () => {
  const logger = createLogger();
  const { dir, store } = createTempStore(logger);
  try {
    const oauthFetch = createOAuthFetch();
    primeHappyPath(oauthFetch);
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      now: () => NOW,
      sleep: () => new Promise(() => {}),
    });
    const start = await oauth.start();
    assert.equal(oauth.cancel(start.flowId), true);
    assert.equal(oauth.status(start.flowId).status, 'error');
    assert.equal(oauth.status(start.flowId).error, 'cancelled');
    assert.equal(oauth.cancel(start.flowId), false);
    store.writeLoginRecord({ key: 'fresh', auth_mode: 'oidc' });
    await oauth.logout();
    assert.equal(store.readLogin(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAccessToken refreshes inside the margin and single-flights', async () => {
  const logger = createLogger();
  const { dir, store } = createTempStore(logger);
  try {
    const oauthFetch = createOAuthFetch();
    oauthFetch.respond(DISCOVERY_URL, () => Response.json({ token_endpoint: TOKEN_URL }));
    let refreshes = 0;
    oauthFetch.respond(TOKEN_URL, () => {
      refreshes += 1;
      return Response.json({ access_token: 'access-second', refresh_token: 'refresh-second', expires_in: 3600 });
    });
    const clock = { value: NOW };
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      logger,
      now: () => clock.value,
      sleep: async () => {},
    });
    // No login at all.
    assert.equal(await oauth.resolveAccessToken(), undefined);
    // A login without a refresh token serves until it expires.
    store.writeLoginRecord({ key: 'bare', auth_mode: 'oidc', expires_at: new Date(NOW + 60_000).toISOString() });
    assert.equal(await oauth.resolveAccessToken(), 'bare');
    clock.value = NOW + 61_000;
    assert.equal(await oauth.resolveAccessToken(), undefined);
    // A fresh login resolves without any network traffic.
    store.writeLoginRecord({
      key: 'access-first',
      refresh_token: 'refresh-first',
      expires_at: new Date(NOW + 3_600_000).toISOString(),
    });
    assert.equal(await oauth.resolveAccessToken(), 'access-first');
    // Inside the margin the refresh grant rotates the record once.
    clock.value = NOW + 3_560_000;
    const [a, b] = await Promise.all([oauth.resolveAccessToken(), oauth.resolveAccessToken()]);
    assert.equal(a, 'access-second');
    assert.equal(b, 'access-second');
    assert.equal(refreshes, 1);
    const login = store.readLogin();
    assert.equal(login.accessToken, 'access-second');
    assert.equal(login.refreshToken, 'refresh-second');
    // The refresh request replays principal fields from the record.
    const refreshCall = oauthFetch.calls.filter((call) => call.url === TOKEN_URL).at(-1);
    const body = new URLSearchParams(refreshCall.init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('client_id'), OAUTH_CLIENT_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed refresh falls back to a still-valid stored bearer', async () => {
  const logger = createLogger();
  const { dir, store } = createTempStore(logger);
  try {
    const oauthFetch = createOAuthFetch();
    oauthFetch.respond(DISCOVERY_URL, () => Response.json({ token_endpoint: TOKEN_URL }));
    oauthFetch.respond(TOKEN_URL, () => new Response('boom', { status: 500 }));
    const clock = { value: NOW };
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      logger,
      now: () => clock.value,
      sleep: async () => {},
    });
    store.writeLoginRecord({
      key: 'stale-but-valid',
      refresh_token: 'refresh-first',
      expires_at: new Date(NOW + 10_000).toISOString(),
    });
    clock.value = NOW + 5_000;
    assert.equal(await oauth.resolveAccessToken(), 'stale-but-valid');
    clock.value = NOW + 60_000;
    assert.equal(await oauth.resolveAccessToken(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a flow whose deadline passes while sleeping ends as expired', async () => {
  const logger = createLogger();
  const { dir, store } = createTempStore(logger);
  try {
    const oauthFetch = createOAuthFetch();
    primeHappyPath(oauthFetch);
    const clock = { value: NOW };
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      now: () => clock.value,
      sleep: async (ms) => {
        // Jump far past the flow deadline: the first authorization_pending
        // continue re-checks the clock and must end the flow as expired
        // instead of polling again.
        clock.value += Math.max(ms, 2_000_000);
      },
    });
    const start = await oauth.start();
    for (let index = 0; index < 10 && oauth.status(start.flowId).status === 'pending'; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const state = oauth.status(start.flowId);
    assert.equal(state.status, 'error');
    assert.equal(state.error, 'device code expired');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizeConfig clamps fields and validates identifiers', async () => {
  const { sanitizeConfig } = await import('../../lib/host/store.js');
  const defaults = sanitizeConfig(undefined);
  assert.equal(defaults.refreshMinutes, 30);
  assert.equal(defaults.webSearchEnabled, true);
  assert.equal(defaults.searchModel, 'grok-4.6');
  assert.equal(defaults.showIndicatorWhenLoggedOut, false);
  const clamped = sanitizeConfig({ refreshMinutes: 9_999, searchModel: 'bad model!' });
  assert.equal(clamped.refreshMinutes, 1440);
  assert.equal(clamped.searchModel, 'grok-4.6');
  const custom = sanitizeConfig({ webSearchEnabled: false, searchModel: 'grok-4.5' });
  assert.equal(custom.webSearchEnabled, false);
  assert.equal(custom.searchModel, 'grok-4.5');
});

test('close() stops an in-flight poll from writing a login', async () => {
  const logger = createLogger();
  const { dir, store } = createTempStore(logger);
  try {
    const oauthFetch = createOAuthFetch();
    oauthFetch.respond(DISCOVERY_URL, () => Response.json({ token_endpoint: TOKEN_URL }));
    oauthFetch.respond(DEVICE_URL, () => Response.json({
      device_code: 'dev-close',
      user_code: 'GROK-CLS',
      verification_uri: 'https://auth.x.ai/device',
      expires_in: 900,
      interval: 1,
    }));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    oauthFetch.respond(TOKEN_URL, async () => {
      await gate;
      return Response.json({
        access_token: 'late-access',
        refresh_token: 'late-refresh',
        expires_in: 3600,
        id_token: encodeJwt({ sub: 'user-late', email: 'late@example.test' }),
      });
    });
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      logger,
      now: () => NOW,
      sleep: async () => {},
    });
    const flow = await oauth.start();
    // Let the detached poll reach the in-flight token request.
    for (let index = 0; index < 10 && !oauthFetch.calls.some((call) => call.url === TOKEN_URL); index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    oauth.close();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.readLogin(), null, 'a closed controller must not persist the late login');
    assert.equal(oauth.status(flow.flowId).status, 'error');
    assert.equal(oauth.status(flow.flowId).error, 'cancelled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close() drops an in-flight token rotation', async () => {
  const logger = createLogger();
  const { dir, store } = createTempStore(logger);
  try {
    const oauthFetch = createOAuthFetch();
    oauthFetch.respond(DISCOVERY_URL, () => Response.json({ token_endpoint: TOKEN_URL }));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    oauthFetch.respond(TOKEN_URL, async () => {
      await gate;
      return Response.json({ access_token: 'rotated-late', refresh_token: 'rotated-refresh', expires_in: 3600 });
    });
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: oauthFetch.fetchImpl }),
      store,
      logger,
      now: () => NOW,
      sleep: async () => {},
    });
    store.writeLoginRecord({
      key: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: new Date(NOW + 10_000).toISOString(),
    });
    const resolving = oauth.resolveAccessToken();
    for (let index = 0; index < 10 && !oauthFetch.calls.some((call) => call.url === TOKEN_URL); index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    oauth.close();
    release();
    assert.equal(await resolving, undefined);
    assert.equal(store.readLogin().accessToken, 'old-access');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start() refuses once the controller is closed', async () => {
  const { dir, store } = createTempStore(createLogger());
  try {
    const oauth = createOAuth({
      http: createHttp({ fetchImpl: async () => new Response('') }),
      store,
      now: () => NOW,
      sleep: async () => {},
    });
    oauth.close();
    await assert.rejects(() => oauth.start(), (error) => error.code === 'oauth_closed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
