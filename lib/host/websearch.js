/**
 * Grok subscription web search as a DSH web-seam provider.
 *
 * The search rides the same auxiliary path grok-build's own `web_search` tool
 * uses: one `/responses` request with the server-side `web_search` tool, the
 * subscription bearer, and the grok-shell identity headers. Citations are read
 * from `url_citation` annotations; the model's prose answer is discarded —
 * the seam's contract is citeable sources, not an answer.
 *
 * `ownsSessionProvider` ties the provider to Grok-model sessions for the
 * harness web seam's session-aware selection: a conversation on the `grok`
 * route searches through the Grok subscription instead of failing on a
 * missing DeepSeek API key.
 */
import {
  DEFAULT_MODEL,
  PROXY_BASE_URL,
  UPSTREAM_TIMEOUT_MS,
} from './constants.js';
import { subscriptionHeaders } from './upstream.js';
import { HostError } from './http.js';

/** Stable id this provider registers under. */
export const GROK_SEARCH_PROVIDER_ID = 'grok';

/** Search endpoint path on the subscription proxy. */
const RESPONSES_PATH = '/responses';

/** True for a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collect citeable sources from one Responses API reply.
 *
 * Citations live on message content annotations (`type: "url_citation"`);
 * grok-build's client reads the very same fields.
 * @param body - parsed `/responses` reply.
 * @returns deduplicated sources in reply order.
 */
export function collectCitations(body) {
  const output = isRecord(body) && Array.isArray(body.output) ? body.output : [];
  const seen = new Set();
  const sources = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!isRecord(block) || !Array.isArray(block.annotations)) continue;
      for (const annotation of block.annotations) {
        if (!isRecord(annotation) || annotation.type !== 'url_citation') continue;
        const url = typeof annotation.url === 'string' && annotation.url !== '' ? annotation.url : undefined;
        if (url === undefined || seen.has(url)) continue;
        seen.add(url);
        sources.push({
          url,
          ...typeof annotation.title === 'string' && annotation.title !== '' ? { title: annotation.title } : {},
        });
      }
    }
  }
  return sources;
}

/**
 * Build the web-search module bound to one plugin instance.
 * @param options - HTTP client, OAuth resolver, login store, logger, and clock.
 * @returns a factory of the DSH `WebSearchProvider` implementation.
 */
export function createWebSearch({ http, oauth, store, logger, now = () => Date.now() }) {
  /**
   * Create the provider for the current config.
   * @param options - `searchModel` overrides the default search model;
   *   `enabled` is consulted at selection time, so a settings save applies to
   *   the next search without re-registration.
   * @returns the DSH web-seam search provider.
   */
  function provider(options = {}) {
    const searchModel = typeof options.searchModel === 'string' && options.searchModel !== ''
      ? options.searchModel
      : DEFAULT_MODEL;
    const enabled = typeof options.enabled === 'function'
      ? options.enabled
      : () => true;

    return {
      id: GROK_SEARCH_PROVIDER_ID,

      /** Cheap local usability check: enabled by config and signed in. */
      available() {
        return enabled() && store.readLogin() !== null;
      },

      /**
       * Session ownership: the `grok` LLM route's conversations search here.
       * @param routeId - provider route id of the requesting session.
       * @returns true for the Grok route.
       */
      ownsSessionProvider(routeId) {
        return routeId === 'grok';
      },

      /**
       * Run one search through the subscription proxy.
       * @param request - the seam's query and optional result limit.
       * @param signal - optional cancellation signal.
       * @returns citeable sources.
       * @throws {HostError} typed failure with a stable code.
       */
      async search(request, signal) {
        const query = typeof request?.query === 'string' ? request.query.trim() : '';
        if (query === '') {
          throw new HostError('grok_search_invalid_query', 'The search query is empty', { status: 400 });
        }
        const login = store.readLogin();
        const bearer = await oauth.resolveAccessToken();
        if (bearer === undefined || login === null) {
          throw new HostError('login_required', 'Sign in to Grok first', { status: 401 });
        }
        let result;
        try {
          result = await http.request(`${PROXY_BASE_URL}${RESPONSES_PATH}`, {
            method: 'POST',
            headers: subscriptionHeaders(bearer, login),
            json: {
              model: searchModel,
              input: query,
              tools: [{ type: 'web_search' }],
              store: false,
              temperature: 0.1,
              top_p: 0.95,
              max_output_tokens: 8192,
            },
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            signal,
          });
        } catch (error) {
          if (error instanceof HostError) throw error;
          throw new HostError('grok_search_failed', 'The Grok search request failed', { status: 502, detail: String(error?.message ?? error) });
        }
        if (result.status === 401 || result.status === 403) {
          throw new HostError('login_expired', 'The Grok session is no longer authorized', { status: 401 });
        }
        if (result.status === 429) {
          throw new HostError('rate_limited', 'The Grok service rate-limited the search', { status: 429 });
        }
        if (!result.ok || !isRecord(result.body)) {
          logger?.warn?.(`grok web search failed: ${result.status}`);
          throw new HostError('grok_search_failed', 'The Grok search request failed', { status: 502 });
        }
        const sources = collectCitations(result.body);
        if (sources.length === 0) {
          throw new HostError('grok_search_no_results', 'The Grok search returned no citeable sources', { status: 502 });
        }
        return { sources, truncated: false };
      },
    };
  }

  return { provider };
}
