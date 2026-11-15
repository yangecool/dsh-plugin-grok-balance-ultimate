/**
 * xAI OAuth2 device flow (RFC 8628) behind the plugin's login button.
 *
 * The flow mirrors grok-build's CLI login: one device code is minted at the
 * issuer, the user approves it in the browser, and the Host polls the token
 * endpoint until the grant completes. Tokens are persisted into the shared
 * grok auth store through the store module, never logged, and never included
 * in an error message. One flow is pending per plugin instance.
 */
import { randomUUID } from 'node:crypto';
import {
  CLIENT_SURFACE,
  CLIENT_VERSION,
  DEVICE_POLL_FLOOR_MS,
  DEVICE_SLOW_DOWN_INCREMENT_MS,
  MIN_DEVICE_CODE_EXPIRY_SECONDS,
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_PATH,
  OAUTH_DISCOVERY_PATH,
  OAUTH_ISSUER,
  OAUTH_REFERRER,
  OAUTH_SCOPES,
  OAUTH_TIMEOUT_MS,
  OAUTH_TOKEN_PATH,
  REFRESH_MARGIN_MS,
} from './constants.js';
import { HostError, describeUrl } from './http.js';

const INVALID_RESPONSE_MESSAGE = 'The xAI authorization service returned an unexpected response';
const UNAVAILABLE_MESSAGE = 'The xAI authorization service is unavailable';

/** Read a non-empty trimmed string. */
function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** True for a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Typed failure for an unreachable or failing OAuth endpoint. */
function unavailable() {
  return new HostError('oauth_unavailable', UNAVAILABLE_MESSAGE, { status: 502 });
}

/** Typed failure for a reply that cannot be the documented envelope. */
function invalidResponse() {
  return new HostError('oauth_invalid_response', INVALID_RESPONSE_MESSAGE, { status: 502 });
}

/** Decode the payload claims of a JWT without verifying it. */
function jwtClaims(token) {
  if (typeof token !== 'string') return {};
  const payload = token.split('.', 3)[1];
  if (payload === undefined) return {};
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/** Reject a verification URI that is not HTTP(S) or carries control characters. */
function validVerificationUri(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('verification URI must be HTTP(S)');
  }
  for (const character of value) {
    if (character.charCodeAt(0) < 0x20) throw new Error('verification URI has control characters');
  }
  return value;
}

/**
 * Build the OAuth controller bound to one plugin instance.
 * @param options - HTTP client, store, logger, clock, and sleep injection.
 * @returns start, status, cancel, logout, and token resolution with refresh.
 */
export function createOAuth({ http, store, logger, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  /** Pending or completed flows of this process, by flow id. */
  const flows = new Map();
  /** Cached discovery token endpoint. */
  let tokenEndpoint;
  /** Single-flight refresh: concurrent resolvers share one rotation. */
  let refreshPromise;
  /**
   * Set by {@link close}: a unloading plugin must not refresh, mint flows, or
   * persist a login after its fiber is gone.
   */
  let closed = false;

  /** Common headers for OAuth endpoint calls. */
  function oauthHeaders(surface) {
    const headers = {
      accept: 'application/json',
      'x-grok-client-version': CLIENT_VERSION,
    };
    if (surface !== undefined) headers['x-grok-client-surface'] = surface;
    return headers;
  }

  /**
   * POST a form-encoded OAuth request and parse the JSON reply.
   * @param url - absolute endpoint URL.
   * @param body - URLSearchParams payload.
   * @param surface - client-surface hint for metrics.
   * @returns the parsed JSON object.
   * @throws {HostError} `oauth_unavailable` or `oauth_invalid_response`; OAuth
   *   protocol errors carry `code`/`status` on a raised {@link OAuthError}.
   */
  async function postForm(url, body, surface) {
    let result;
    try {
      result = await http.request(url, {
        method: 'POST',
        headers: {
          ...oauthHeaders(surface),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        timeoutMs: OAUTH_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof HostError) throw unavailable();
      throw error;
    }
    if (!isRecord(result.body)) throw invalidResponse();
    if (!result.ok) {
      const error = result.body.error;
      throw new OAuthError(
        readString(result.body.error_description) ?? `HTTP ${result.status} from the xAI authorization service`,
        typeof error === 'string' ? error : undefined,
        result.status,
      );
    }
    return result.body;
  }

  /** Resolve the token endpoint through issuer discovery (cached). */
  async function resolveTokenEndpoint() {
    if (tokenEndpoint !== undefined) return tokenEndpoint;
    let discovery;
    try {
      discovery = await http.request(`${OAUTH_ISSUER}${OAUTH_DISCOVERY_PATH}`, {
        headers: oauthHeaders(),
        timeoutMs: OAUTH_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof HostError) throw unavailable();
      throw error;
    }
    const endpoint = isRecord(discovery.body) ? readString(discovery.body.token_endpoint) : undefined;
    if (endpoint === undefined) throw invalidResponse();
    tokenEndpoint = endpoint;
    return tokenEndpoint;
  }

  /** Build the grok-build scope record from one token response. */
  function scopeRecord(tokens, previous) {
    const accessToken = readString(tokens.access_token);
    if (accessToken === undefined) throw invalidResponse();
    const claims = jwtClaims(typeof tokens.id_token === 'string' ? tokens.id_token : '');
    const createdAt = now();
    const refreshToken = readString(tokens.refresh_token) ?? previous?.refreshToken;
    const email = typeof claims.email === 'string' && claims.email !== '' ? claims.email : previous?.email;
    const expiresIn = typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) ? tokens.expires_in : undefined;
    return {
      key: accessToken,
      auth_mode: 'oidc',
      create_time: new Date(createdAt).toISOString(),
      user_id: typeof claims.sub === 'string' ? claims.sub : (previous?.userId ?? ''),
      ...(email !== undefined ? { email } : {}),
      ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
      ...(expiresIn !== undefined ? { expires_at: new Date(createdAt + expiresIn * 1000).toISOString() } : {}),
      oidc_issuer: OAUTH_ISSUER,
      oidc_client_id: OAUTH_CLIENT_ID,
    };
  }

  /** Public view of one flow; never contains the device code. */
  function publicFlow(flow) {
    return {
      flowId: flow.flowId,
      status: flow.status,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      ...(flow.verificationUriComplete === undefined ? {} : { verificationUriComplete: flow.verificationUriComplete }),
      expiresAt: new Date(flow.expiresAt).toISOString(),
      ...(flow.error === undefined ? {} : { error: flow.error }),
    };
  }

  /** Poll one flow to completion; runs detached and never throws. */
  async function pollFlow(flowId) {
    const flow = flows.get(flowId);
    if (flow === undefined) return;
    let intervalMs = flow.intervalMs;
    while (!closed && flow.status === 'pending' && now() < flow.expiresAt) {
      await sleep(intervalMs);
      // The plugin may have unloaded while the interval ran: a closed
      // controller stops polling instead of finishing against a dead fiber.
      if (closed) return;
      const current = flows.get(flowId);
      if (current === undefined || current.status !== 'pending') return;
      try {
        const tokens = await postForm(await resolveTokenEndpoint(), new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: current.deviceCode,
          client_id: OAUTH_CLIENT_ID,
        }), CLIENT_SURFACE);
        // Disposal can land while the token request is in flight; the login
        // file must not gain a session the unloading plugin can no longer own.
        if (closed) return;
        store.writeLoginRecord(scopeRecord(tokens, store.readLogin() ?? undefined));
        current.status = 'complete';
        return;
      } catch (error) {
        if (error instanceof OAuthError) {
          if (error.code === 'authorization_pending') continue;
          if (error.code === 'slow_down') {
            intervalMs += DEVICE_SLOW_DOWN_INCREMENT_MS;
            continue;
          }
          current.error = error.code === 'access_denied'
            ? 'authorization denied'
            : error.code === 'expired_token' ? 'device code expired' : error.message;
          current.status = 'error';
          return;
        }
        current.error = error instanceof Error ? error.message : String(error);
        current.status = 'error';
        logger?.warn?.(`grok oauth flow failed: ${String(current.error)}`);
        return;
      }
    }
    if (!closed && flow.status === 'pending') {
      flow.status = 'error';
      flow.error = 'device code expired';
    } else if (closed) {
      flow.status = 'error';
      flow.error = 'cancelled';
    }
  }

  /** Mint one device code at the issuer. */
  async function requestDevice() {
    const response = await postForm(`${OAUTH_ISSUER}${OAUTH_DEVICE_PATH}`, new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      scope: OAUTH_SCOPES.join(' '),
      referrer: OAUTH_REFERRER,
    }), CLIENT_SURFACE);
    const deviceCode = readString(response.device_code);
    const userCode = readString(response.user_code);
    const verificationUri = readString(response.verification_uri);
    const expiresIn = response.expires_in;
    if (deviceCode === undefined || userCode === undefined || !/^[A-Za-z0-9-]+$/.test(userCode)
      || verificationUri === undefined || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw invalidResponse();
    }
    let verificationUriComplete;
    try {
      const complete = readString(response.verification_uri_complete);
      verificationUriComplete = complete === undefined ? undefined : validVerificationUri(complete);
      validVerificationUri(verificationUri);
    } catch (error) {
      logger?.warn?.(`grok oauth device response rejected: ${String(error?.message ?? error)}`);
      throw invalidResponse();
    }
    return {
      deviceCode,
      userCode,
      verificationUri,
      ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
      expiresAt: now() + Math.max(MIN_DEVICE_CODE_EXPIRY_SECONDS, expiresIn) * 1000,
      intervalMs: Math.max(DEVICE_POLL_FLOOR_MS, typeof response.interval === 'number' && Number.isFinite(response.interval)
        ? response.interval * 1000
        : 5_000),
    };
  }

  return {
    /**
     * Start (or reuse) the browser device-login flow.
     * @returns the public flow view for the login UI.
     * @throws {HostError} when the device endpoint is unreachable or malformed.
     */
    async start() {
      if (closed) {
        throw new HostError('oauth_closed', 'The Grok login controller is shutting down', { status: 503 });
      }
      const pending = [...flows.values()].find((flow) => flow.status === 'pending');
      if (pending !== undefined) return publicFlow(pending);
      const requested = await requestDevice();
      const flow = { flowId: randomUUID(), status: 'pending', ...requested };
      flows.set(flow.flowId, flow);
      if (flows.size > 8) {
        for (const [id, entry] of flows) {
          if (entry.status !== 'pending') flows.delete(id);
          if (flows.size <= 8) break;
        }
      }
      void pollFlow(flow.flowId);
      return publicFlow(flow);
    },

    /**
     * Read one flow's public state.
     * @param flowId - flow id from {@link start}.
     * @returns the flow view, or undefined for an unknown id.
     */
    status(flowId) {
      const flow = flows.get(typeof flowId === 'string' ? flowId : '');
      return flow === undefined ? undefined : publicFlow(flow);
    },

    /**
     * Mark one pending flow cancelled; the poll loop observes the change.
     * @param flowId - flow id from {@link start}.
     * @returns whether a pending flow was cancelled.
     */
    cancel(flowId) {
      const flow = flows.get(typeof flowId === 'string' ? flowId : '');
      if (flow === undefined || flow.status !== 'pending') return false;
      flow.status = 'error';
      flow.error = 'cancelled';
      return true;
    },

    /** Cancel pending flows and remove this plugin's login from the shared store. */
    async logout() {
      for (const flow of flows.values()) {
        if (flow.status === 'pending') {
          flow.status = 'error';
          flow.error = 'cancelled';
        }
      }
      store.clearLogin();
    },

    /**
     * Resolve a usable subscription bearer, refreshing inside one flight.
     * @returns the bearer, or undefined when no login exists or it cannot refresh.
     */
    async resolveAccessToken() {
      if (closed) return undefined;
      const login = store.readLogin();
      if (login === null) return undefined;
      if (login.refreshToken === undefined) {
        return login.expiresAt !== null && login.expiresAt > now() ? login.accessToken : undefined;
      }
      if (login.expiresAt === null || login.expiresAt - now() > REFRESH_MARGIN_MS) return login.accessToken;
      if (refreshPromise !== undefined) return refreshPromise;
      refreshPromise = this.rotateToken(login).finally(() => {
        refreshPromise = undefined;
      });
      return refreshPromise;
    },

    /**
     * Rotate the refresh token once; a concurrent rotation's result is reused.
     * @param login - the stale login view the rotation started from.
     * @returns the new bearer, or undefined when the rotation failed.
     */
    async rotateToken(login) {
      try {
        const endpoint = await resolveTokenEndpoint();
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: login.refreshToken,
          client_id: OAUTH_CLIENT_ID,
        });
        if (login.principalType !== null) body.set('principal_type', login.principalType);
        if (login.principalId !== null) body.set('principal_id', login.principalId);
        const tokens = await postForm(endpoint, body);
        // A teardown that landed mid-refresh must not persist the rotation:
        // the shared auth file stays exactly as the last live owner wrote it.
        if (closed) return undefined;
        const record = scopeRecord(tokens, login);
        return store.writeLoginRecord(record)?.accessToken ?? record.key;
      } catch (error) {
        logger?.warn?.(`grok token refresh failed: ${describeUrl(OAUTH_ISSUER)} (${String(error?.message ?? error)})`);
        // A still-server-valid stale bearer beats a hard failure during an
        // IdP outage; an actually expired one has nothing to fall back to.
        const current = store.readLogin();
        if (current !== null && current.accessToken === login.accessToken
          && (current.expiresAt === null || current.expiresAt > now())) {
          return current.accessToken;
        }
        return undefined;
      }
    },

    /**
     * Stop the controller: cancel pending device flows, refuse new work, and
     * make in-flight polls/refreshes drop their results instead of writing.
     * Called from the plugin's teardown effect; safe to call repeatedly.
     */
    close() {
      if (closed) return;
      closed = true;
      for (const flow of flows.values()) {
        if (flow.status === 'pending') {
          flow.status = 'error';
          flow.error = 'cancelled';
        }
      }
      tokenEndpoint = undefined;
    },
  };
}

/** OAuth protocol failure carrying the RFC 8628 error code. */
export class OAuthError extends Error {
  /**
   * @param message - short English diagnostic (never contains credentials).
   * @param code - OAuth error code (`authorization_pending`, `slow_down`, ...).
   * @param status - HTTP status of the failed response.
   */
  constructor(message, code, status) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}
