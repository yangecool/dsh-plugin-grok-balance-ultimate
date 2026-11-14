/**
 * Grok subscription upstream requests and response normalizers.
 *
 * The account surfaces live on the subscription proxy grok-build itself uses:
 *  - `GET /billing?format=credits` — credit usage percent, current period,
 *    prepaid balance, and per-cycle history.
 *  - `GET /user?include=subscription` — identity and the active tier.
 *  - `GET /auto-topup-rule` — the account's automatic top-up rule.
 *
 * Every request is authorized with the subscription bearer plus the
 * grok-build identity headers (`X-XAI-Token-Auth`, client version, ...), so
 * the upstream sees a grok-shell client. Tokens never enter a log line.
 */
import { platform, arch } from 'node:os';
import {
  AUTHENTICATE_RESPONSE,
  AUTO_TOPUP_PATH,
  BILLING_PATH,
  CLIENT_IDENTIFIER,
  CLIENT_VERSION,
  PROXY_BASE_URL,
  TOKEN_AUTH_VALUE,
  UPSTREAM_TIMEOUT_MS,
  USER_PATH,
} from './constants.js';
import { HostError } from './http.js';

/** Read a non-empty trimmed string. */
function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** True for a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a finite number, or undefined. */
function readNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a cent-amount field: either a bare number or grok-build's `{val}` form.
 * @returns US dollars as a finite number, or undefined.
 */
function readUsd(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value / 100;
  if (isRecord(value)) {
    const cents = readNumber(value.val);
    if (cents !== undefined) return cents / 100;
  }
  return undefined;
}

/** Read an epoch-millisecond date from a number or ISO string. */
function readTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Identity headers every subscription-proxy request carries.
 * @param bearer - subscription access token.
 * @param login - login view supplying the optional `x-userid`.
 * @returns the header map for one upstream request.
 */
export function subscriptionHeaders(bearer, login = null) {
  const headers = {
    authorization: `Bearer ${bearer}`,
    accept: 'application/json',
    'x-xai-token-auth': TOKEN_AUTH_VALUE,
    'x-authenticateresponse': AUTHENTICATE_RESPONSE,
    'x-grok-client-version': CLIENT_VERSION,
    'x-grok-client-identifier': CLIENT_IDENTIFIER,
    'x-grok-client-mode': 'interactive',
    'user-agent': `grok-shell/${CLIENT_VERSION} (${platform()}; ${arch()})`,
  };
  if (login?.userId !== null && login?.userId !== undefined) headers['x-userid'] = login.userId;
  return headers;
}

/**
 * Normalize one `/billing?format=credits` reply.
 * @param body - parsed JSON reply (may be any shape).
 * @returns the billing view served to the client.
 */
export function normalizeBilling(body) {
  const config = isRecord(body) && isRecord(body.config) ? body.config : {};
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const history = Array.isArray(config.history)
    ? config.history.filter(isRecord).map((entry) => ({
      billingCycle: readString(entry.billingCycle) ?? null,
      includedUsedUsd: readUsd(entry.includedUsed) ?? null,
      onDemandUsedUsd: readUsd(entry.onDemandUsed) ?? null,
      totalUsedUsd: readUsd(entry.totalUsed) ?? null,
    }))
    : [];
  return {
    creditUsagePercent: readNumber(config.creditUsagePercent) ?? null,
    currentPeriod: {
      type: readString(period.type) ?? null,
      start: readTime(period.start) ?? null,
      end: readTime(period.end) ?? null,
    },
    prepaidBalanceUsd: readUsd(config.prepaidBalance) ?? null,
    isUnifiedBillingUser: config.isUnifiedBillingUser === true,
    subscriptionTier: readString(body?.subscriptionTier) ?? readString(config.subscriptionTier) ?? null,
    onDemandEnabled: body?.onDemandEnabled === true,
    history,
  };
}

/**
 * Normalize one `/user?include=subscription` reply.
 * @param body - parsed JSON reply.
 * @returns the account view served to the client.
 */
export function normalizeUser(body) {
  const user = isRecord(body) && isRecord(body.user) ? body.user : (isRecord(body) ? body : {});
  return {
    userId: readString(user.id) ?? readString(user.userId) ?? null,
    email: readString(user.email) ?? null,
    name: readString(user.name) ?? readString(user.fullName) ?? null,
    subscriptionTier: readString(user.subscriptionTier)
      ?? readString(isRecord(user.subscription) ? user.subscription.tier : undefined)
      ?? null,
  };
}

/**
 * Normalize one `/auto-topup-rule` reply.
 * @param body - parsed JSON reply.
 * @returns the top-up rule view; a missing rule is null.
 */
export function normalizeTopup(body) {
  const rule = isRecord(body) && isRecord(body.rule) ? body.rule : null;
  if (rule === null) return null;
  return {
    enabled: rule.enabled === true,
    minBeforeHittingSlUsd: readUsd(rule.minBeforeHittingSl) ?? null,
    topupAmountUsd: readUsd(rule.topupAmount) ?? null,
    maxAmountPerMonthUsd: readUsd(rule.maxAmountPerMonth) ?? null,
  };
}

/** Map one upstream response to a typed failure. */
function upstreamError(result) {
  const text = typeof result.text === 'string' ? result.text : '';
  if (result.status === 401 || result.status === 403) {
    return new HostError('login_expired', 'The Grok session is no longer authorized', { status: 401 });
  }
  if (result.status === 429) {
    if (text.includes('subscription:free-usage-exhausted')) {
      return new HostError('free_usage_exhausted', 'The subscription free usage is exhausted', { status: 429, detail: text.slice(0, 200) });
    }
    return new HostError('rate_limited', 'The Grok service rate-limited the request', { status: 429 });
  }
  return new HostError('upstream_failed', 'The Grok service rejected the request', { status: 502, detail: `${result.status} ${text.slice(0, 200)}` });
}

/**
 * Build the upstream client bound to one plugin instance.
 * @param options - HTTP client, OAuth resolver, login store, logger, and clock.
 * @returns billing/user/top-up loaders with normalized views.
 */
export function createUpstream({ http, oauth, store, logger, now = () => Date.now() }) {
  /**
   * Perform one authorized GET on the subscription proxy.
   * @param path - endpoint path with optional query string.
   * @returns the parsed JSON body.
   * @throws {HostError} typed upstream failure.
   */
  async function getJson(path) {
    const login = store.readLogin();
    const bearer = await oauth.resolveAccessToken();
    if (bearer === undefined || login === null) {
      throw new HostError('login_required', 'Sign in to Grok first', { status: 401 });
    }
    const result = await http.request(`${PROXY_BASE_URL}${path}`, {
      headers: subscriptionHeaders(bearer, login),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (!result.ok) {
      logger?.warn?.(`grok upstream ${path} failed: ${result.status}`);
      throw upstreamError(result);
    }
    if (!isRecord(result.body)) {
      throw new HostError('upstream_failed', 'The Grok service returned an unexpected response', { status: 502 });
    }
    return result.body;
  }

  return {
    /** @returns the normalized billing view. */
    async billing() {
      return normalizeBilling(await getJson(`${BILLING_PATH}?format=credits`));
    },
    /** @returns the normalized account view. */
    async user() {
      return normalizeUser(await getJson(`${USER_PATH}?include=subscription`));
    },
    /** @returns the normalized top-up rule (null when none exists). */
    async topup() {
      return normalizeTopup(await getJson(AUTO_TOPUP_PATH));
    },
  };
}
