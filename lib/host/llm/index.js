/**
 * Grok LLM adapter module tree for dsh-plugin-grok-balance-ultimate.
 *
 * Ported from grok-harness `@grok-harness/model` (adapter, stream, sse,
 * serialize, config, discovery, plugin wiring) as plain ESM JavaScript.
 *
 * Not ported, with reasons:
 * - replay.ts (encrypted-reasoning replay) and the `finish.replayState`
 *   envelope — fork-private adapter replay seam; assistant reasoning blocks
 *   serialize to nothing instead.
 * - GrokLoopAttemptControl / doom-loop injection — fork-private Grok loop
 *   service seam; detector frames are still swallowed safely at the SSE layer.
 * - promptCache projection (`prompt_cache_key`) — fork-private routing seam.
 * - `purpose: 'permission-auto'` branch — the target checkout's purpose union
 *   has no such value.
 * - proxy.ts undici dispatcher — not in the plugin's dependency set; requests
 *   go through the injectable `fetch` (default global fetch).
 *
 * @module ./llm/index.js
 */

export {
  API_BASE_URL,
  BUILT_IN_MODELS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  GROK_AUTHENTICATE_RESPONSE,
  GROK_BUILD_CLIENT_VERSION,
  GROK_CLIENT_IDENTIFIER,
  GROK_MODALITIES,
  GROK_REASONING_EFFORTS,
  GROK_REASONING_SUMMARIES,
  GROK_TOKEN_AUTH,
  SUBSCRIPTION_BASE_URL,
  SUBSCRIPTION_PROXY_HOST,
} from './constants.js';
export { createGrokAdapter, grokHttpErrorCode, providerRetryAfterMs } from './adapter.js';
export { createRemoteCatalog, readListing } from './catalog.js';
export { Config, assertServiceable, resolveProfiles } from './config.js';
export { discoverModels } from './discovery.js';
export { createLlmModule } from './module.js';
export { resolveGrokReasoningEffort, serializeGrokRequest } from './serialize.js';
export { GROK_DONE, GROK_DOOM_LOOP_EVENT, parseGrokSse } from './sse.js';
export { mapGrokUsage, translateGrokResponses } from './stream.js';
