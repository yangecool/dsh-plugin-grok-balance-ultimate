/**
 * Lifecycle wiring for the direct Grok Build-compatible adapter.
 *
 * The model transport, profile resolver, model discovery, and registrations
 * all live in this module tree. Subscription authentication is delegated to
 * the plugin's shared `createOAuth` controller; API-key authentication resolves
 * through the credentials service with the launch environment as fallback.
 *
 * Not ported from the fork: the grokLoop service seam (doom-loop staging and
 * attempt control) and the grokHostedTools service resolver — owned hosted
 * tools arrive as an explicit module option instead.
 */

import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm';
import { getOrCreateGrokAgentId } from '../agent-id.js';
import { createGrokAdapter } from './adapter.js';
import { assertServiceable, resolveProfiles } from './config.js';
import { discoverModels } from './discovery.js';

/** Stable JSON-equality check for registration-fact memoization. */
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Build the Grok LLM module bound to its lifecycle dependencies.
 * @param {object} options - module wiring options.
 * @param {object} [options.oauth] - shared `createOAuth` controller; required for `grok-subscription` auth.
 * @param {object} [options.logger] - optional `{info,warn,debug}` logger.
 * @param {typeof globalThis.fetch} [options.fetch] - request transport; defaults to global fetch (the fork's undici proxy dispatcher was not ported).
 * @param {readonly import('./serialize.js').GrokHostedToolSpec[] | (() => readonly import('./serialize.js').GrokHostedToolSpec[])} [options.hostedTools] - owned hosted tools; defaults to provider-hosted `web_search` (backend search for grok-4.6).
 * @param {() => string} [options.agentId] - stable agent id resolver; defaults to `getOrCreateGrokAgentId`.
 * @param {string} [options.settingsNs] - user-settings namespace owning the route; defaults to `llm-grok`.
 * @param {string} [options.provider] - owned provider route id; only `grok` is valid.
 * @param {string} [options.name] - plugin and diagnostic label.
 * @returns {{apply(ctx: import('@deepseek-ai/cordis').Context, config: object): void, handle: {replace(config: object): void, dispose(): void}}} the module with its registration handle.
 */
export function createLlmModule({
  oauth,
  logger,
  fetch: requestFetch,
  hostedTools,
  agentId = getOrCreateGrokAgentId,
  settingsNs = 'llm-grok',
  provider = 'grok',
  name = 'grok-llm',
} = {}) {
  if (provider !== 'grok') {
    throw new Error(`${name}: this module owns only the "grok" provider route`);
  }
  const resolveHostedTools = typeof hostedTools === 'function'
    ? hostedTools
    : () => hostedTools ?? [{ wireName: 'web_search' }];
  /** @type {import('@deepseek-ai/cordis').Context | undefined} */
  let ctx;
  /** @type {{providers: {get(): object}} | undefined} */
  let config;
  let lastRaw;
  let memoized;
  let directory;
  let directoryFacts;
  let registration;
  let registeredFacts;
  let disposeDiscovery;
  let disposed = false;

  const warn = (message, error) => {
    logger?.warn?.(message);
    if (error !== undefined) logger?.warn?.(error);
  };

  /** Resolve (and memoize by raw identity) the immutable profile map. */
  function profiles() {
    const raw = config.providers.get();
    if (raw === lastRaw && memoized !== undefined) return memoized;
    const next = resolveProfiles(structuredClone(raw), name);
    lastRaw = raw;
    memoized = next;
    return next;
  }

  /**
   * Resolve the bearer for one profile: the shared subscription login, or the
   * configured credential reference resolved through the credentials service
   * with the launch environment as fallback.
   * @param {string} route - provider route id.
   * @param {object} profile - resolved provider profile.
   * @returns the usable bearer/API key.
   * @throws {import('@deepseek-ai/dsh-llm').LlmError} `MISSING_CREDENTIAL` when no usable credential exists.
   */
  async function resolveApiKey(route, profile) {
    if (profile.authMode === 'grok-subscription') {
      if (oauth === undefined) {
        throw new LlmError(
          `${name}: provider route "${route}" requests grok-subscription auth, but the oauth controller is not wired`,
          'MISSING_CREDENTIAL',
        );
      }
      const token = await oauth.resolveAccessToken();
      if (token !== undefined && token.length > 0) return token;
      throw new LlmError(
        `${name}: no Grok subscription session is available; sign in through the Grok Account settings row first`,
        'MISSING_CREDENTIAL',
      );
    }
    const ref = profile.apiKeyEnv;
    if (ref === undefined) {
      throw new LlmError(`${name}: API-key profile has no credential reference`, 'MISSING_CREDENTIAL');
    }
    const credentials = ctx.get('credentials');
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : launchEnvironmentOf(ctx).get(ref)?.value;
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, name, ref);
    throw new LlmError(
      `${name}: no credential for provider route "${route}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it`
      + ` before launch`,
      'MISSING_CREDENTIAL',
    );
  }

  /** Directory entries keeping the built-in route visible before any credential arrives. */
  function directoryEntries() {
    const profile = profiles().get(provider);
    return [{
      provider,
      displayName: profile?.displayName ?? 'Grok',
      settingsNs,
      settingsPath: ['providers', provider],
      declared: false,
    }];
  }

  function ensureDirectory() {
    const entries = directoryEntries();
    if (sameJson(entries, directoryFacts)) return;
    if (directory === undefined) directory = ctx.get('llm').registerConfigurableProviders(entries);
    else directory.replace(entries);
    directoryFacts = entries;
  }

  function ensureRegistrationFacts() {
    const facts = [...profiles().entries()]
      .map(([route, profile]) => ({
        provider: route,
        displayName: profile.displayName,
        retryPolicy: profile.retryPolicy,
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider));
    if (sameJson(facts, registeredFacts)) return;
    const routes = [...profiles().keys()];
    if (registration === undefined) {
      if (routes.length === 0) {
        registeredFacts = facts;
        return;
      }
      registration = ctx.get('llm').registerAdapter(routes, adapter);
    } else {
      registration.replace(routes);
    }
    registeredFacts = facts;
  }

  /** Resolve and swap registrations against the current config, keeping the previous set on a refused update. */
  function refresh() {
    try {
      assertServiceable(config, name);
      ensureRegistrationFacts();
    } catch (error) {
      warn(`${name}: keeping the previously registered routes after a refused update`, error);
    }
    try {
      ensureDirectory();
    } catch (error) {
      warn(`${name}: keeping the previous configurable-provider directory after a refused update`, error);
    }
  }

  const adapter = createGrokAdapter({
    profiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
    resolveHostedTools,
    resolveAgentId: agentId,
    ...(requestFetch === undefined ? {} : { requestFetch }),
  });

  /** The stored credential for one configured route, asked for only when a discovery draft carries none. */
  const storedApiKey = async (route) => {
    if (route === undefined) return undefined;
    const profile = profiles().get(route);
    if (profile === undefined) return undefined;
    return resolveApiKey(route, profile);
  };

  return {
    /**
     * Register the adapter, its settings-namespace directory entry, and model
     * discovery on one plugin context. Every registration is owned by a cordis
     * effect and dies with the plugin fiber; {@link handle} additionally
     * supports manual hot replacement and disposal.
     * @param {import('@deepseek-ai/cordis').Context} pluginCtx - plugin context owning the registrations.
     * @param {{providers: {get(): object}}} pluginConfig - resolved plugin configuration.
     */
    apply(pluginCtx, pluginConfig) {
      if (disposed) throw new Error(`${name}: this module instance was disposed`);
      if (ctx !== undefined) throw new Error(`${name}: this module instance is already applied`);
      if (pluginCtx.get('llm') === undefined) {
        throw new Error(`${name}: the llm service is not mounted; inject 'llm' before applying this module`);
      }
      ctx = pluginCtx;
      config = pluginConfig;
      profiles();

      ensureDirectory();
      const llm = pluginCtx.get('llm');
      disposeDiscovery = llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels(
        { ...request, ...(signal === undefined ? {} : { signal }) },
        () => storedApiKey(request.provider),
        name,
        requestFetch ?? globalThis.fetch,
      ));
      ensureRegistrationFacts();

      pluginCtx.on('loader/volatile-update', refresh);
    },

    handle: {
      /**
       * Hot-swap to a new plugin configuration: re-resolve profiles and swap
       * the adapter routes and directory entry atomically. A refused update
       * keeps the previously registered set and logs the reason.
       * @param {{providers: {get(): object}}} nextConfig - replacement configuration.
       */
      replace(nextConfig) {
        if (disposed) {
          throw new LlmError(`${name}: a disposed module cannot replace its configuration`, 'REGISTRATION_DISPOSED');
        }
        if (ctx === undefined) throw new Error(`${name}: apply() must run before replace()`);
        config = nextConfig;
        refresh();
      },

      /** Withdraw the directory entry, model discovery, and adapter routes. */
      dispose() {
        if (disposed) return;
        disposed = true;
        directory?.();
        disposeDiscovery?.();
        registration?.();
      },
    },
  };
}
