/**
 * Host entry of dsh-plugin-grok-balance-ultimate.
 *
 * Wires the plugin's storage, HTTP, OAuth (xAI device flow), account-surface
 * upstream, and snapshot modules into the Web server's same-origin routes,
 * registers the Grok subscription web-search provider on the web seam, and
 * mounts the Grok LLM adapter (subscription or API-key inference). The Client
 * half (`./client`) renders the sidebar usage page and the composer popover.
 */
import { createHttp, createProxyFetch } from './host/http.js';
import { createOAuth } from './host/oauth.js';
import { registerRoutes } from './host/routes.js';
import { createSnapshot } from './host/snapshot.js';
import { createStore } from './host/store.js';
import { createUpstream } from './host/upstream.js';
import { createWebSearch } from './host/websearch.js';
import { Config as LlmConfig, createLlmModule } from './host/llm/index.js';

/** The plugin cannot serve its browser routes without the Web server. */
export const inject = ['webServer'];

/** Plugin configuration: the Grok provider profiles of the LLM module. */
export const Config = LlmConfig;

/**
 * Activate the Host half.
 * @param ctx - Host Cordis context with the `webServer` service.
 * @param config - resolved plugin configuration (provider profiles).
 */
export function apply(ctx, config) {
  const logger = {
    info: (message) => ctx.logger?.info?.(`grok-balance: ${message}`),
    warn: (message) => ctx.logger?.warn?.(`grok-balance: ${message}`),
    debug: (message) => ctx.logger?.debug?.(`grok-balance: ${message}`),
  };
  const now = () => Date.now();
  const store = createStore({ logger });
  // xAI egress is proxy-aware: a configured `proxyUrl` routes OAuth, account,
  // search, and inference traffic through one dispatcher; the empty default
  // honors the proxy environment (undici EnvHttpProxyAgent).
  const egress = createProxyFetch({ resolveProxy: () => store.readConfig().proxyUrl, logger });
  const http = createHttp({ fetchImpl: egress.fetch, logger });
  const oauth = createOAuth({ http, store, logger, now });
  const upstream = createUpstream({ http, oauth, store, logger, now });
  const snapshot = createSnapshot({ store, oauth, upstream, logger, now });

  ctx.effect(
    () => registerRoutes({
      webServer: ctx.webServer,
      store,
      snapshot,
      logger,
      // Optional: the Web profile provides it; without it the routes serve
      // composition that no browser reaches.
      connection: () => ctx.get('connection'),
    }),
    'grok-balance: host routes',
  );

  // Grok subscription web search: registered once while the web seam exists;
  // the config gate lives in `available()` (consulted per search), so a
  // settings save applies to the next search without re-registration.
  // `ownsSessionProvider` ties the provider to Grok-model sessions under
  // session-aware provider selection.
  const webSearch = createWebSearch({ http, oauth, store, logger, now });
  ctx.inject(['web'], (webCtx) => {
    webCtx.effect(() => webCtx.web.registerSearchProvider(webSearch.provider({
      searchModel: store.readConfig().searchModel,
      enabled: () => store.readConfig().webSearchEnabled !== false,
    })), 'grok-balance: web search provider');
  });

  // Grok inference: the LLM adapter serves the `grok` route with the
  // subscription bearer (or `XAI_API_KEY` in API-key mode). The module owns
  // its registrations as effects of the injected fiber and shares the
  // proxy-aware fetch.
  const llm = createLlmModule({ oauth, logger, fetch: egress.fetch });
  ctx.inject(['llm'], (llmCtx) => {
    llmCtx.effect(() => {
      llm.apply(llmCtx, config);
      return () => llm.handle.dispose();
    }, 'grok-balance: llm adapter');
  });

  ctx.effect(() => () => { void egress.close(); }, 'grok-balance: proxy dispatchers');
}
