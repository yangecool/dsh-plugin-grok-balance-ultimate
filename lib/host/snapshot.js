/**
 * Cached aggregations behind the plugin's Host routes.
 *
 * The Client never talks to xAI directly: it asks these methods for a
 * normalized snapshot and this module owns login state, the memory TTLs,
 * single-flight de-duplication, and stale-last-good fallback.
 *
 * Login state has one source, the shared grok auth store (`store.readLogin()`).
 * The overview aggregates `/user`, `/billing`, and `/auto-topup-rule`; its
 * pieces fail independently — a failing top-up rule never blanks the page —
 * and a total failure keeps the last good snapshot marked `stale` instead of
 * throwing, so one flaky upstream cannot blank an otherwise usable page.
 */
import { OVERVIEW_TTL_MS } from './constants.js';

/** Freshness of the cached overview document. */
const SNAPSHOT_TTL_MS = OVERVIEW_TTL_MS;

/**
 * Build the snapshot aggregator bound to one plugin instance.
 * @param options - store, OAuth controller, upstream client, and logger.
 * @returns status/loginStatus/overview/logout with TTL caching.
 */
export function createSnapshot({ store, oauth, upstream, logger, now = () => Date.now() }) {
  /** Last good overview payload (without the stale marker). */
  let cached = null;
  /** Wall time of the last successful overview build. */
  let generatedAt = 0;
  /** In-flight overview build shared by concurrent callers. */
  let inflight = null;
  /** Login generation: a new login invalidates every cache. */
  let loginGeneration = 0;
  let observedGeneration = -1;

  /** Public login view: identity and expiry only, never the tokens. */
  function loginView() {
    const login = store.readLogin();
    if (login === null) return null;
    return {
      email: login.email,
      userId: login.userId,
      expiresAt: login.expiresAt,
      loggedInAt: login.loggedInAt,
    };
  }

  /** Invalidate caches after login state changed. */
  function invalidate(reason) {
    loginGeneration += 1;
    cached = null;
    generatedAt = 0;
    logger?.debug?.(`grok snapshot invalidated (${reason})`);
  }

  /** Build one overview payload from the three upstream surfaces. */
  async function buildOverview() {
    const [user, billing, topup] = await Promise.all([
      upstream.user().catch((error) => ({ error: errorView(error) })),
      upstream.billing().catch((error) => ({ error: errorView(error) })),
      upstream.topup().catch(() => null),
    ]);
    return { user, billing, topup };
  }

  /** Stable error view of one failed surface. */
  function errorView(error) {
    return {
      code: error?.code ?? 'upstream_failed',
      message: error?.message ?? 'The Grok service request failed',
    };
  }

  /** True when the whole overview build failed (every priced surface errored). */
  function totalFailure(payload) {
    return payload.user?.error !== undefined && payload.billing?.error !== undefined;
  }

  return {
    /**
     * Full status document of the plugin.
     * @returns config, login state, and a pending-flow marker.
     */
    async status() {
      const login = store.readLogin();
      return {
        config: store.readConfig(),
        loggedIn: login !== null,
        login: loginView(),
        // A pending device flow is observable through startLogin/pollLogin;
        // the status route only reports whether one is running.
        pending: false,
      };
    },

    /**
     * Start (or reuse) the device login flow.
     * @returns the public flow view for the login UI.
     */
    async startLogin() {
      const flow = await oauth.start();
      return flow;
    },

    /**
     * Read one flow's state.
     * @param flowId - flow id from {@link startLogin}; the latest flow when omitted.
     * @returns the flow view, or undefined for an unknown id.
     */
    async loginStatus(flowId) {
      return oauth.status(flowId);
    },

    /** Cancel pending device flows and remove the login. */
    async logout() {
      await oauth.logout();
      invalidate('logout');
    },

    /**
     * Aggregated account overview with TTL caching.
     * @param options - `force` bypasses the cache.
     * @returns the overview payload; a total failure returns the last good
     *   snapshot marked `stale` (or an error document when none exists).
     */
    async overview({ force = false } = {}) {
      const loggedIn = store.readLogin() !== null;
      if (!loggedIn) {
        invalidate('signed-out');
        return { error: { code: 'login_required', message: 'Sign in to Grok first' }, stale: false, generatedAt: null };
      }
      if (observedGeneration !== loginGeneration) {
        observedGeneration = loginGeneration;
        cached = null;
        generatedAt = 0;
      }
      const fresh = cached !== null && now() - generatedAt < SNAPSHOT_TTL_MS;
      if (!force && fresh) return { ...cached, stale: false, generatedAt };
      if (inflight !== null) return inflight;
      inflight = (async () => {
        try {
          const payload = await buildOverview();
          if (totalFailure(payload)) {
            if (cached !== null) {
              return { ...cached, stale: true, generatedAt };
            }
            return { error: payload.billing.error, stale: false, generatedAt: null };
          }
          cached = payload;
          generatedAt = now();
          return { ...payload, stale: false, generatedAt };
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    /** Drop cached data (used when config or login state changed). */
    invalidate,
  };
}
