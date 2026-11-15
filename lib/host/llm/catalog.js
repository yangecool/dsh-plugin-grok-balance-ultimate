/**
 * Live model catalog of the configured Grok route.
 *
 * The account's `/models` listing is the authoritative catalog (grok-build
 * reads the same endpoint), so a model the service starts serving — or stops
 * serving — reaches the picker without a plugin release. The listing is cached
 * per route for a short TTL and de-duplicated across concurrent callers; any
 * failure keeps the last good listing (or yields none) so selection degrades to
 * the built-in table instead of failing.
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import {
  AUTHENTICATE_RESPONSE,
  CLIENT_IDENTIFIER,
  CLIENT_VERSION,
  TOKEN_AUTH_VALUE,
  UPSTREAM_TIMEOUT_MS,
} from '../constants.js';

/** How long one route's listing stays fresh before a refetch. */
const DEFAULT_TTL_MS = 5 * 60_000;

/** A listing reply larger than this is refused; a truncated listing is not parseable. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** A positive integer field of a listing entry, or undefined when absent or unusable. */
function positive(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return undefined;
}

/** A non-empty string field of a listing entry, or undefined. */
function text(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Read one listing reply into normalized model entries. Entries without a
 * usable id are skipped rather than failing the whole listing.
 * @param {unknown} body - parsed listing reply.
 * @returns normalized entries in endpoint order.
 */
export function readListing(body) {
  const data = body?.data;
  if (!Array.isArray(data)) return [];
  const models = [];
  const seen = new Set();
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object') continue;
    const id = text(raw.id, raw.model, raw.modelId);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const name = text(raw.name, raw.display_name);
    const description = text(raw.description);
    const contextWindow = positive(raw.context_window, raw.context_length)
      ?? (Array.isArray(raw.context_windows) ? positive(...raw.context_windows) : undefined);
    const maxTokens = positive(raw.max_output_tokens, raw.max_tokens);
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  }
  return models;
}

/**
 * Build the live catalog bound to one module instance.
 * @param {object} options - wiring options.
 * @param {typeof globalThis.fetch} options.fetch - transport shared with inference.
 * @param {(profile: object) => Promise<string | undefined>} options.resolveBearer - current bearer/API key for one resolved profile.
 * @param {{warn?: Function, debug?: Function}} [options.logger] - diagnostics sink.
 * @param {() => number} [options.now] - clock used for the TTL.
 * @param {number} [options.ttlMs] - freshness window; defaults to five minutes.
 * @returns {{list(route: string, profile: object, signal?: AbortSignal): Promise<readonly object[]>, close(): void}} the catalog.
 */
export function createRemoteCatalog({ fetch, resolveBearer, logger, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  /** Last good listing per route key. */
  const cached = new Map();
  /** In-flight loads per route key. */
  const inflight = new Map();
  let closed = false;

  /** @param {object} profile - resolved provider profile. */
  function keyOf(profile) {
    return `${profile.baseURL}|${profile.authMode}`;
  }

  /**
   * Fetch and normalize one route's listing; failures keep the previous list.
   * @param {string} route - provider route id.
   * @param {object} profile - resolved provider profile.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns the listing, or the last good one, or an empty array.
   */
  async function load(route, profile, signal) {
    const previous = cached.get(keyOf(profile))?.entries ?? [];
    if (closed) return previous;
    let bearer;
    try {
      bearer = await resolveBearer(profile);
    } catch (error) {
      logger?.debug?.(`grok catalog: no credential for "${route}" (${String(error?.message ?? error)})`);
      return previous;
    }
    if (bearer === undefined || bearer.length === 0 || closed) return previous;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    try {
      const response = await fetch(`${profile.baseURL.replace(/\/+$/, '')}/models`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${bearer}`,
          ...(profile.authMode === 'grok-subscription'
            ? {
              'x-xai-token-auth': TOKEN_AUTH_VALUE,
              'x-authenticateresponse': AUTHENTICATE_RESPONSE,
              'x-grok-client-version': CLIENT_VERSION,
              'x-grok-client-identifier': CLIENT_IDENTIFIER,
              'x-grok-client-mode': 'interactive',
            }
            : {}),
          ...attributionHeaders(),
        },
        signal: combined,
      });
      if (!response.ok) {
        logger?.debug?.(`grok catalog: "${route}" listing answered ${response.status}`);
        return previous;
      }
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BYTES) {
        logger?.warn?.(`grok catalog: "${route}" listing exceeds ${MAX_RESPONSE_BYTES} bytes; keeping the previous list`);
        return previous;
      }
      const entries = readListing(JSON.parse(body));
      if (entries.length === 0) return previous;
      if (closed) return previous;
      cached.set(keyOf(profile), { at: now(), entries });
      return entries;
    } catch (error) {
      logger?.debug?.(`grok catalog: "${route}" listing failed (${String(error?.message ?? error)})`);
      return previous;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Listing of one route, refetched when fresh data is due.
     * @param {string} route - provider route id.
     * @param {object} profile - resolved provider profile.
     * @param {AbortSignal} [signal] - caller cancellation.
     * @returns normalized entries, never throws.
     */
    async list(route, profile, signal) {
      if (closed) return cached.get(keyOf(profile))?.entries ?? [];
      const key = keyOf(profile);
      const hit = cached.get(key);
      if (hit !== undefined && now() - hit.at < ttlMs) return hit.entries;
      const pending = inflight.get(key);
      if (pending !== undefined) return pending;
      const operation = load(route, profile, signal)
        .catch(() => cached.get(key)?.entries ?? [])
        .finally(() => { inflight.delete(key); });
      inflight.set(key, operation);
      return operation;
    },

    /** Stop accepting loads; in-flight results are dropped. */
    close() {
      closed = true;
    },
  };
}
