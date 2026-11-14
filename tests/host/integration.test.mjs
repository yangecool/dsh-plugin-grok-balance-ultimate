/**
 * Integration tests for the plugin's Host wiring.
 *
 * These exercise the real route table over the real store/OAuth/upstream/
 * snapshot modules with only the network replaced, which catches interface
 * drift between the modules that unit tests mock away.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

import {
  AUTO_TOPUP_PATH,
  BILLING_PATH,
  OAUTH_DEVICE_PATH,
  OAUTH_DISCOVERY_PATH,
  OAUTH_ISSUER,
  PROXY_BASE_URL,
  ROUTE_PREFIX,
  USER_PATH,
} from '../../lib/host/constants.js';
import { createHttp } from '../../lib/host/http.js';
import { createOAuth } from '../../lib/host/oauth.js';
import { registerRoutes } from '../../lib/host/routes.js';
import { createSnapshot } from '../../lib/host/snapshot.js';
import { createStore } from '../../lib/host/store.js';
import { createUpstream } from '../../lib/host/upstream.js';

const DISCOVERY_URL = `${OAUTH_ISSUER}${OAUTH_DISCOVERY_PATH}`;
const DEVICE_URL = `${OAUTH_ISSUER}${OAUTH_DEVICE_PATH}`;
const TOKEN_URL = `${OAUTH_ISSUER}/oauth2/token`;
const BILLING_URL = `${PROXY_BASE_URL}${BILLING_PATH}?format=credits`;
const USER_URL = `${PROXY_BASE_URL}${USER_PATH}?include=subscription`;
const TOPUP_URL = `${PROXY_BASE_URL}${AUTO_TOPUP_PATH}`;
const NOW = 1_783_000_000_000;

const homes = [];
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** One temporary Harness home per test. */
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'grk-host-test-'));
  homes.push(home);
  return home;
}

/** JSON response body of a fake upstream. */
function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

/** Upstream double routing the OAuth issuer and the subscription proxy. */
function grokUpstream({ tokenResult } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === DISCOVERY_URL) return jsonResponse({ token_endpoint: TOKEN_URL });
    if (String(url) === DEVICE_URL) {
      return jsonResponse({
        device_code: 'dev-integr',
        user_code: 'GROK-INT',
        verification_uri: 'https://auth.x.ai/device',
        verification_uri_complete: 'https://auth.x.ai/device?code=GROK-INT',
        expires_in: 900,
        interval: 1,
      });
    }
    if (String(url) === TOKEN_URL) {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ sub: 'user-integr', email: 'integr@example.test' })).toString('base64url');
      return tokenResult === undefined
        ? jsonResponse({
          access_token: 'integr-access',
          refresh_token: 'integr-refresh',
          expires_in: 3600,
          id_token: `${header}.${claims}.test-signature`,
        })
        : tokenResult;
    }
    if (String(url) === BILLING_URL) {
      return jsonResponse({ config: { creditUsagePercent: 33, prepaidBalance: { val: 250 } }, subscriptionTier: 'SUPERGROK' });
    }
    if (String(url) === USER_URL) {
      return jsonResponse({ user: { id: 'user-integr', email: 'integr@example.test', subscriptionTier: 'SUPERGROK' } });
    }
    if (String(url) === TOPUP_URL) return jsonResponse({ rule: { enabled: true } });
    return jsonResponse({ error: 'not found' }, 404);
  };
  return { calls, fetchImpl };
}

/** Build the real route table over fake I/O. */
function harness({ fetchImpl, connection } = {}) {
  const logger = { info() {}, warn() {}, debug() {} };
  const store = createStore({ logger, configPath: join(tempHome(), 'config.json'), authPath: join(tempHome(), 'auth.json') });
  const http = createHttp({ fetchImpl, logger });
  const oauth = createOAuth({ http, store, logger, now: () => NOW, sleep: async () => {} });
  const upstream = createUpstream({ http, oauth, store, logger, now: () => NOW });
  const snapshot = createSnapshot({ store, oauth, upstream, logger, now: () => NOW });
  const routes = new Map();
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
  const dispose = registerRoutes({ webServer, store, snapshot, connection, logger });
  return { routes, store, oauth, dispose, fetchImpl };
}

/** Incoming request whose body is the given JSON value. */
function jsonRequest(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  stream.method = method;
  stream.url = url;
  return stream;
}

/** Response recorder resolving to status, headers, and parsed body. */
function responseRecorder() {
  let resolve;
  const done = new Promise((settle) => { resolve = settle; });
  const response = {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(body) {
      this.body = body === undefined ? undefined : String(body);
      resolve(this);
    },
    done,
  };
  return response;
}

/** Run one registered route and resolve its recorded response. */
async function call(harnessRef, path, { method = 'GET', body, url } = {}) {
  const routePath = `${ROUTE_PREFIX}${path.split('?')[0]}`;
  const handler = harnessRef.routes.get(routePath);
  assert.ok(handler, `route ${path} is registered`);
  const request = jsonRequest(method, url ?? `${ROUTE_PREFIX}${path}`, body);
  const response = responseRecorder();
  await handler(request, response);
  const recorded = await response.done;
  return { status: recorded.status, headers: recorded.headers, body: recorded.body };
}

/** Parse one JSON route response. */
function payload(result) {
  return JSON.parse(result.body);
}

/** Await a flow's completion by polling the controller's status. */
async function waitForFlow(oauth, flowId) {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (oauth.status(flowId).status !== 'pending') break;
  }
  return oauth.status(flowId);
}

test('status reports the logged-out document', async () => {
  const upstreamDouble = grokUpstream();
  const harnessRef = harness({ fetchImpl: upstreamDouble.fetchImpl });
  const result = await call(harnessRef, '/api/status');
  assert.equal(result.status, 200);
  const data = payload(result).data;
  assert.equal(data.loggedIn, false);
  assert.equal(data.login, null);
  assert.equal(data.config.refreshMinutes, 30);
  assert.equal(data.config.webSearchEnabled, true);
  harnessRef.dispose();
});

test('routes answer 401 through the connection gate', async () => {
  const harnessRef = harness({
    fetchImpl: grokUpstream().fetchImpl,
    connection: () => ({ requestRejection: () => 401 }),
  });
  const result = await call(harnessRef, '/api/status');
  assert.equal(result.status, 401);
  assert.equal(result.body, 'unauthorized\n');
  harnessRef.dispose();
});

test('a device login round trip lands in the shared store and the overview serves', async () => {
  const upstreamDouble = grokUpstream();
  const harnessRef = harness({ fetchImpl: upstreamDouble.fetchImpl });
  const start = await call(harnessRef, '/api/login', { method: 'POST' });
  assert.equal(start.status, 200);
  const flow = payload(start).data;
  assert.equal(flow.userCode, 'GROK-INT');
  assert.equal(flow.status, 'pending');
  const flowState = await waitForFlow(harnessRef.oauth, flow.flowId);
  assert.equal(flowState.status, 'complete');
  const polled = await call(harnessRef, `/api/login/poll?flowId=${flow.flowId}`);
  assert.equal(payload(polled).data.status, 'complete');
  const status = await call(harnessRef, '/api/status');
  assert.equal(payload(status).data.loggedIn, true);
  assert.equal(payload(status).data.login.email, 'integr@example.test');

  const overview = await call(harnessRef, '/api/overview');
  assert.equal(overview.status, 200);
  const data = payload(overview).data;
  assert.equal(data.user.email, 'integr@example.test');
  assert.equal(data.billing.creditUsagePercent, 33);
  assert.equal(data.billing.prepaidBalanceUsd, 2.5);
  assert.equal(data.topup.enabled, true);
  assert.equal(data.stale, false);
  // The overview's requests carried the subscription identity set.
  const billingCall = upstreamDouble.calls.find((entry) => entry.url === BILLING_URL);
  assert.equal(billingCall.init.headers.authorization, 'Bearer integr-access');
  assert.equal(billingCall.init.headers['x-xai-token-auth'], 'xai-grok-cli');
  // No token material appears in any route response.
  const scanned = [status.body, overview.body, start.body, polled.body].join('\n');
  assert.ok(!scanned.includes('integr-access') && !scanned.includes('integr-refresh'), 'tokens leaked into a route response');
  harnessRef.dispose();
});

test('an unknown flow id answers 404 and bad methods answer 405', async () => {
  const harnessRef = harness({ fetchImpl: grokUpstream().fetchImpl });
  const missing = await call(harnessRef, '/api/login/poll?flowId=nope');
  assert.equal(missing.status, 404);
  assert.equal(payload(missing).error.code, 'unknown_flow');
  const wrongMethod = await call(harnessRef, '/api/status', { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  harnessRef.dispose();
});

test('config writes round-trip through the store', async () => {
  const harnessRef = harness({ fetchImpl: grokUpstream().fetchImpl });
  const saved = await call(harnessRef, '/api/config', {
    method: 'POST',
    body: { refreshMinutes: 5, webSearchEnabled: false, searchModel: 'grok-4.5' },
  });
  assert.equal(saved.status, 200);
  const config = payload(saved).data;
  assert.equal(config.refreshMinutes, 5);
  assert.equal(config.webSearchEnabled, false);
  assert.equal(config.searchModel, 'grok-4.5');
  assert.deepEqual(harnessRef.store.readConfig(), config);
  harnessRef.dispose();
});

test('the signed-out overview reports login_required without network traffic', async () => {
  const upstreamDouble = grokUpstream();
  const harnessRef = harness({ fetchImpl: upstreamDouble.fetchImpl });
  const overview = await call(harnessRef, '/api/overview');
  assert.equal(overview.status, 200);
  assert.equal(payload(overview).data.error.code, 'login_required');
  assert.equal(upstreamDouble.calls.filter((entry) => entry.url.startsWith(PROXY_BASE_URL)).length, 0);
  harnessRef.dispose();
});

test('an oversized body answers 413 instead of resetting the connection', async () => {
  const harnessRef = harness({ fetchImpl: grokUpstream().fetchImpl });
  const routePath = `${ROUTE_PREFIX}/api/config`;
  const handler = harnessRef.routes.get(routePath);
  const stream = Readable.from([Buffer.alloc(128 * 1024, 0x61)]);
  stream.method = 'POST';
  stream.url = routePath;
  const response = responseRecorder();
  await handler(stream, response);
  const recorded = await response.done;
  assert.equal(recorded.status, 413);
  harnessRef.dispose();
});
