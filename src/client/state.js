/**
 * Singleton client store for the Grok account plugin.
 *
 * Owns every same-origin request to the plugin's Host routes, the device-code
 * login polling loop, the cached overview payload, and the single error
 * surface components read. The snapshot is immutable between changes so
 * `useSyncExternalStore` can compare references; `subscribe` returns the
 * disposer React calls on unmount and `dispose()` tears down timers, requests,
 * and listeners when the plugin unloads. No React import, no top-level DOM
 * access: this module is importable from a plain Node process.
 *
 * Host contract (prefix `/grok-balance/api`, success `{ data }`, failure
 * non-2xx `{ error: { code, message } }`):
 * - `GET  /status`        → `{ config, loggedIn, login, pending }`
 * - `POST /login`         → device flow `{ flowId, status, userCode, verificationUri, …, expiresAt }`
 * - `GET  /login/poll?flowId=` → flow status (`pending` | `complete` | `error`)
 * - `POST /logout`        → `{ ok: true }`
 * - `POST /config`        → the sanitized config
 * - `GET  /overview?force=1` → `{ user, billing, topup, stale, generatedAt }` or `{ error, … }`
 */
import { coreDicts, interpolate } from './dicts-core.js';

const ROUTE_PREFIX = '/grok-balance';
const API_BASE = `${ROUTE_PREFIX}/api`;
const DEFAULT_REFRESH_MINUTES = 30;
const OVERVIEW_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 25_000;
const POLL_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 15_000;
/** Login flow states the client tracks; `complete` is a transient success flash. */
const FLOW_STATES = new Set(['idle', 'starting', 'pending', 'complete', 'error']);
const EMPTY_FLOW = Object.freeze({
  state: 'idle',
  flowId: null,
  userCode: null,
  verificationUri: null,
  verificationUriComplete: null,
  expiresAt: null,
  error: null,
});
const EMPTY_LOADING = Object.freeze({ overview: false, login: false, config: false });

/** Typed store failure; Host error codes pass through unchanged. */
class ClientError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Snapshot shape:
 * `config / loggedIn / loginExpired / login / overview / flow / loading / error / lastUpdated`.
 */
function initialSnapshot() {
  return {
    config: null,
    loggedIn: false,
    loginExpired: false,
    login: null,
    overview: null,
    flow: { ...EMPTY_FLOW },
    loading: { ...EMPTY_LOADING },
    error: null,
    lastUpdated: null,
  };
}

let snapshot = initialSnapshot();
const listeners = new Set();
const inflight = new Map();
const lastAttempt = new Map();
const controllers = new Set();
let translateFn = null;
let errorScope = null;
let bootstrapped = false;
let disposed = false;
let pollTimer = null;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

/** Replace the snapshot reference and notify subscribers (one failing listener cannot strand the rest). */
function set(changes) {
  if (disposed) return;
  snapshot = { ...snapshot, ...changes };
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('grok-balance: state listener failed', error);
    }
  }
}

/** Update one loading flag without rebuilding the whole snapshot. */
function setLoading(scope, value) {
  if (snapshot.loading[scope] === value) return;
  set({ loading: { ...snapshot.loading, [scope]: value === true } });
}

/** Merge a device-flow progress patch. */
function setFlow(patch) {
  set({ flow: { ...snapshot.flow, ...patch } });
}

/**
 * Bind the dictionary translate function after locale registration.
 * @param fn - `(key, params) => string`; null falls back to the English core copy.
 */
export function setTranslate(fn) {
  translateFn = typeof fn === 'function' ? fn : null;
}

/** Translate a key with the bound function, else the English core dictionary. */
function translate(key, params) {
  if (translateFn !== null) {
    const value = translateFn(key, params);
    if (typeof value === 'string' && value !== '' && value !== key) return value;
  }
  const template = coreDicts.en[key];
  return interpolate(template === undefined ? key : template, params);
}

/** Map an arbitrary thrown value to the snapshot's `{ code, message }` shape. */
function normalizeError(error) {
  if (error instanceof ClientError) return { code: error.code, message: error.message };
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'internal_error';
  const raw = typeof error?.message === 'string' ? error.message.trim() : '';
  return { code, message: raw === '' ? translate('state.error') : raw };
}

/** Clear the top-level error only when it belongs to the settling scope. */
function clearScopeError(scope) {
  if (errorScope !== scope) return;
  errorScope = null;
  if (snapshot.error !== null) set({ error: null });
}

/** Epoch milliseconds of an ISO/epoch value, else null. */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Map the `/api/status` login block to the snapshot fields. */
function loginFromStatus(login) {
  if (login === null || typeof login !== 'object') return null;
  return {
    email: typeof login.email === 'string' && login.email !== '' ? login.email : null,
    userId: typeof login.userId === 'string' && login.userId !== '' ? login.userId : null,
    expiresAt: toMs(login.expiresAt),
    loggedInAt: toMs(login.loggedInAt),
  };
}

/** Map a device-flow payload (start reply or poll reply) to snapshot flow fields. */
function flowFromPayload(data) {
  if (data === null || typeof data !== 'object') return { state: 'idle' };
  const state = FLOW_STATES.has(data.status) && data.status !== 'complete'
    ? data.status
    : data.status === 'complete' ? 'complete' : 'idle';
  return {
    state,
    flowId: typeof data.flowId === 'string' && data.flowId !== '' ? data.flowId : null,
    userCode: typeof data.userCode === 'string' && data.userCode !== '' ? data.userCode : null,
    verificationUri: typeof data.verificationUri === 'string' && data.verificationUri !== ''
      ? data.verificationUri
      : null,
    verificationUriComplete: typeof data.verificationUriComplete === 'string'
      && data.verificationUriComplete !== ''
      ? data.verificationUriComplete
      : null,
    expiresAt: toMs(data.expiresAt),
    error: typeof data.error === 'string' && data.error !== '' ? data.error : null,
  };
}

/** Same-origin URL for one Host API route. */
function routeUrl(path, query) {
  const search = query === undefined ? '' : new URLSearchParams(query).toString();
  return `${API_BASE}${path}${search === '' ? '' : `?${search}`}`;
}

/**
 * Call one Host route and unwrap `{ data }`.
 * @param path - route path after `/api`.
 * @param options - `method`, JSON `body`, `query` params, `timeoutMs`.
 * @returns the unwrapped data payload.
 * @throws {ClientError} with the Host code for HTTP failures, `network_error` /
 *   `upstream_timeout` for transport failures.
 */
async function request(path, options = {}) {
  const { method = 'GET', body, query, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller !== null) controllers.add(controller);
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await globalThis.fetch(routeUrl(path, query), {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller === null ? undefined : controller.signal,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const hostError = payload !== null && typeof payload === 'object' ? payload.error : undefined;
    if (hostError !== null && typeof hostError === 'object') {
      throw new ClientError(
        typeof hostError.code === 'string' && hostError.code !== '' ? hostError.code : 'internal_error',
        typeof hostError.message === 'string' ? hostError.message : '',
        response.status,
      );
    }
    if (response.ok !== true) throw new ClientError('internal_error', translate('state.error'), response.status);
    if (payload === null || typeof payload !== 'object' || !('data' in payload)) {
      throw new ClientError('internal_error', translate('state.error'), response.status);
    }
    return payload.data;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    const aborted = controller !== null && controller.signal.aborted === true;
    throw new ClientError(aborted ? 'upstream_timeout' : 'network_error', translate('state.networkError'));
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (controller !== null) controllers.delete(controller);
  }
}

/** Share one in-flight promise per cache key. */
function runOnce(key, task) {
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;
  const promise = Promise.resolve().then(task).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** Kick the one-time config + status load without blocking the caller. */
function ensureBootstrap() {
  if (bootstrapped || disposed || inflight.has('bootstrap')) return;
  void bootstrap();
}

/** Apply one `/api/status` payload to the snapshot. */
function applyStatus(data) {
  const config = data?.config !== null && typeof data?.config === 'object' ? data.config : null;
  const login = loginFromStatus(data?.login);
  const loggedIn = data?.loggedIn === true;
  set({
    config,
    loggedIn,
    // A working login clears a stale expired marker; a signed-out status
    // keeps it so the login card still explains why the session ended.
    loginExpired: loggedIn === true ? false : snapshot.loginExpired,
    login,
  });
  bootstrapped = true;
}

/** Force the logged-out/expired login state; cached payloads stay for display. */
function applyExpiredAuth() {
  stopLoginPolling();
  set({
    loggedIn: false,
    loginExpired: true,
  });
}

/** Record a failure for one scope; a `login_expired` code clears the login state. */
function recordError(scope, error) {
  const normalized = normalizeError(error);
  errorScope = scope;
  if (normalized.code === 'login_expired') applyExpiredAuth();
  set({ error: normalized });
  return normalized;
}

/** Normalize the login poll interval into a safe timer delay. */
function normalizePollInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, numeric));
}

/** Schedule the next login poll; at most one timer exists at a time. */
function scheduleLoginPoll() {
  stopLoginPolling();
  if (disposed) return;
  const { expiresAt } = snapshot.flow;
  const delay = expiresAt !== null ? Math.min(pollIntervalMs, Math.max(0, expiresAt - Date.now())) : pollIntervalMs;
  if (delay <= 0) {
    expireFlow();
    return;
  }
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollLogin();
  }, delay);
  if (typeof pollTimer?.unref === 'function') pollTimer.unref();
}

/** Cancel a scheduled login poll. */
function stopLoginPolling() {
  if (pollTimer === null) return;
  clearTimeout(pollTimer);
  pollTimer = null;
}

/** Mark the pending flow as errored once its device code has expired. */
function expireFlow() {
  if (snapshot.flow.state !== 'pending') return;
  stopLoginPolling();
  setFlow({ state: 'error', error: translate('auth.loginCodeExpired') });
}

/** Whether the current document is hidden (`tick` pauses auto-refresh then). */
function isHidden() {
  return globalThis.document !== undefined && globalThis.document.visibilityState === 'hidden';
}

/** Configured auto-refresh interval in milliseconds. */
function refreshIntervalMs() {
  const minutes = Number(snapshot.config?.refreshMinutes);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_REFRESH_MINUTES;
  return safe * 60_000;
}

/**
 * Load config + login status once; failures surface through `error`.
 * @returns the snapshot after the attempt.
 */
export function bootstrap() {
  if (bootstrapped) return Promise.resolve(snapshot);
  return runOnce('bootstrap', async () => {
    try {
      const data = await request('/status', { timeoutMs: STATUS_TIMEOUT_MS });
      applyStatus(data);
      clearScopeError('bootstrap');
    } catch (error) {
      recordError('bootstrap', error);
    }
    return snapshot;
  });
}

/**
 * Refresh the aggregated account overview.
 * @param options - `force` bypasses the freshness window.
 * @returns the overview payload, or null on failure.
 */
export function refreshOverview(options) {
  ensureBootstrap();
  const force = options?.force === true;
  const cached = snapshot.overview;
  if (!force && cached !== null && Date.now() - (lastAttempt.get('overview') ?? 0) < OVERVIEW_TTL_MS) {
    return Promise.resolve(cached);
  }
  return runOnce('overview', async () => {
    setLoading('overview', true);
    try {
      const data = await request('/overview', { query: force ? { force: '1' } : undefined });
      if (data === null || typeof data !== 'object') return null;
      set({
        overview: data,
        lastUpdated: toMs(data.generatedAt) ?? Date.now(),
      });
      const hostError = data.error;
      if (hostError !== null && typeof hostError === 'object') {
        if (hostError.code === 'login_required') {
          set({ loggedIn: false });
          clearScopeError('overview');
        } else {
          recordError('overview', new ClientError(
            typeof hostError.code === 'string' && hostError.code !== '' ? hostError.code : 'upstream_failed',
            typeof hostError.message === 'string' ? hostError.message : '',
          ));
        }
      } else {
        clearScopeError('overview');
      }
      return data;
    } catch (error) {
      recordError('overview', error);
      return null;
    } finally {
      lastAttempt.set('overview', Date.now());
      setLoading('overview', false);
    }
  });
}

/** Re-read `/api/status` after a state-changing action; errors stay quiet. */
async function refreshStatusQuiet() {
  try {
    const data = await request('/status', { timeoutMs: STATUS_TIMEOUT_MS });
    applyStatus(data);
  } catch {
    // A failed status refresh never undoes a completed device flow.
  }
}

/**
 * Start the Grok device-code login flow and begin polling.
 * @returns the flow view (`{ userCode, verificationUri, … }`) for the caller
 *   to render and open.
 * @throws {ClientError} with the normalized code/message on failure (the flow
 *   block also records it).
 */
export function startLogin() {
  setFlow({ state: 'starting', error: null });
  setLoading('login', true);
  errorScope = null;
  if (snapshot.error !== null) set({ error: null });
  return runOnce('login-start', async () => {
    try {
      const data = await request('/login', { method: 'POST', body: {}, timeoutMs: LOGIN_TIMEOUT_MS });
      const flow = flowFromPayload(data);
      if (flow.state !== 'pending' || flow.userCode === null || flow.verificationUri === null) {
        throw new ClientError('oauth_invalid_response', translate('auth.loginFailed'));
      }
      setFlow({ ...flow, error: null });
      scheduleLoginPoll();
      clearScopeError('login');
      return snapshot.flow;
    } catch (error) {
      const normalized = error instanceof ClientError ? error : new ClientError('network_error', translate('auth.loginFailed'));
      recordError('login', normalized);
      setFlow({ state: 'error', error: normalized.message });
      throw normalized;
    } finally {
      setLoading('login', false);
    }
  });
}

/** Stop local login polling and clear the pending login block. */
export function cancelLogin() {
  stopLoginPolling();
  setFlow({ ...EMPTY_FLOW });
  setLoading('login', false);
}

/**
 * Poll the Host login flow once; the loop reschedules itself while pending.
 * @returns the snapshot flow block after the attempt.
 */
export async function pollLogin() {
  if (snapshot.flow.state !== 'pending' && snapshot.flow.state !== 'starting') return snapshot.flow;
  return runOnce('login-poll', pollLoginOnce);
}

/** One poll response, mapped onto the flow block. */
async function pollLoginOnce() {
  const { flowId, expiresAt } = snapshot.flow;
  if (expiresAt !== null && Date.now() >= expiresAt) {
    expireFlow();
    return snapshot.flow;
  }
  let data;
  try {
    data = await request('/login/poll', {
      query: flowId === null ? undefined : { flowId },
      timeoutMs: POLL_TIMEOUT_MS,
    });
  } catch {
    // Transport hiccups keep the flow alive; the next scheduled poll retries.
    scheduleLoginPoll();
    return snapshot.flow;
  }
  const state = typeof data?.status === 'string' ? data.status : 'pending';
  if (state === 'pending') {
    scheduleLoginPoll();
    return snapshot.flow;
  }
  stopLoginPolling();
  if (state === 'complete') {
    setFlow({ state: 'complete', error: null });
    setLoading('login', false);
    await refreshStatusQuiet();
    await refreshOverview({ force: true });
    setFlow({ ...EMPTY_FLOW });
    return snapshot.flow;
  }
  const message = typeof data?.error === 'string' && data.error !== ''
    ? data.error
    : translate('auth.loginFailed');
  setFlow({ state: 'error', error: message });
  recordError('login', new ClientError('login_failed', message));
  setLoading('login', false);
  return snapshot.flow;
}

/**
 * Sign out and clear cached account data.
 * @returns `{ ok: true }` or `{ ok: false, error }`; never rejects.
 */
export function logout() {
  return runOnce('logout', async () => {
    stopLoginPolling();
    try {
      await request('/logout', { method: 'POST' });
    } catch (error) {
      return { ok: false, error: recordError('auth', error) };
    }
    set({
      loggedIn: false,
      loginExpired: false,
      login: null,
      overview: null,
      flow: { ...EMPTY_FLOW },
      lastUpdated: null,
    });
    lastAttempt.clear();
    errorScope = null;
    if (snapshot.error !== null) set({ error: null });
    return { ok: true };
  });
}

/**
 * Persist a partial config patch and apply the sanitized config immediately.
 * A signed-in store refreshes the overview in the background afterward, so a
 * refresh-interval change is reflected without a reload.
 * @param patch - subset of the plugin config.
 * @returns `{ ok: true, config }` or `{ ok: false, error }`; never rejects.
 */
export function saveConfig(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return Promise.resolve({ ok: false, error: { code: 'invalid_request', message: translate('state.error') } });
  }
  return runOnce('config-save', async () => {
    setLoading('config', true);
    try {
      const data = await request('/config', { method: 'POST', body: patch });
      const config = data !== null && typeof data === 'object' ? data : null;
      if (config !== null) set({ config });
      clearScopeError('config');
      if (snapshot.loggedIn === true) void refreshOverview({ force: true });
      return { ok: true, config };
    } catch (error) {
      return { ok: false, error: recordError('config', error) };
    } finally {
      setLoading('config', false);
    }
  });
}

/** Clear the shared error notice. */
export function dismissError() {
  errorScope = null;
  if (snapshot.error !== null) set({ error: null });
}

/**
 * Auto-refresh entry point, called by the entry's 30 s ticker.
 * Honors `config.refreshMinutes`, pauses in hidden documents, resumes a
 * pending login poll, and bootstraps a store that was never started.
 * @returns a promise settling after the triggered requests finish.
 */
export function tick() {
  if (disposed || isHidden()) return Promise.resolve();
  if (!bootstrapped) return bootstrap().then(() => undefined);
  const tasks = [];
  if (snapshot.flow.state === 'pending') tasks.push(pollLogin());
  if (snapshot.loggedIn === true && snapshot.config !== null) {
    if (Date.now() - (lastAttempt.get('overview') ?? 0) >= refreshIntervalMs()) {
      tasks.push(refreshOverview());
    }
  }
  return tasks.length === 0 ? Promise.resolve() : Promise.all(tasks).then(() => undefined);
}

/** Detach every timer, request, and subscriber; called when the plugin unloads. */
export function dispose() {
  disposed = true;
  stopLoginPolling();
  for (const controller of controllers) {
    try {
      controller.abort();
    } catch {
      // Aborting a request that already settled never throws.
    }
  }
  controllers.clear();
  listeners.clear();
  inflight.clear();
}

/** Subscribe to snapshot changes; returns the disposer React calls on unmount. */
function subscribe(listener) {
  if (typeof listener !== 'function' || disposed) return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** @returns the current immutable snapshot (stable until the next change). */
function getSnapshot() {
  return snapshot;
}

/**
 * Store singleton shared by every client module and component.
 * @type {{ subscribe: (fn: () => void) => () => void, getSnapshot: () => object }}
 */
export const state = Object.freeze({
  subscribe,
  getSnapshot,
  bootstrap,
  refreshOverview,
  startLogin,
  pollLogin,
  cancelLogin,
  logout,
  saveConfig,
  tick,
  dismissError,
  translate,
  dispose,
});
