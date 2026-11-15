/**
 * Fixed protocol constants for the Grok LLM adapter module.
 *
 * These are external-service contracts (the grok-build subscription proxy, the
 * public xAI API, and the native Responses wire vocabulary), not deployment
 * tunables; user-facing choices live in the module Config schema. The base
 * URLs are owned by the plugin's shared constants module and re-exported here
 * so every Grok surface (inference, billing, web search) speaks one origin.
 */
import { API_KEY_BASE_URL, PROXY_BASE_URL } from '../constants.js';

/** grok-build subscription endpoint receiving native Responses model calls. */
export const SUBSCRIPTION_BASE_URL = PROXY_BASE_URL;

/** Public xAI API endpoint used in API-key mode. */
export const API_BASE_URL = API_KEY_BASE_URL;

/** Host of the subscription proxy; `x-authenticateresponse` is sent only to it. */
export const SUBSCRIPTION_PROXY_HOST = new URL(PROXY_BASE_URL).hostname;

/**
 * grok-build release reported on subscription model calls. Re-exported from
 * the shared host constants so the OAuth flow and the model transport cannot
 * drift apart.
 */
export { CLIENT_VERSION as GROK_BUILD_CLIENT_VERSION } from '../constants.js';

/** grok-build client identifier sent on subscription model calls. */
export const GROK_CLIENT_IDENTIFIER = 'grok-shell';

/** Token-auth marker naming the CLI grant type on subscription calls. */
export const GROK_TOKEN_AUTH = 'xai-grok-cli';

/** Authentication-response marker accepted only by the subscription proxy. */
export const GROK_AUTHENTICATE_RESPONSE = 'authenticate-response';

/** Default maximum silence between provider stream events. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Combined context capacity advertised for the built-in Grok catalog. */
export const DEFAULT_CONTEXT_WINDOW = 500_000;

/** Output-capability fallback advertised when a model entry omits one. */
export const DEFAULT_MAX_TOKENS = 500_000;

/** Credential reference used when API-key mode omits one. */
export const DEFAULT_API_KEY_ENV = 'XAI_API_KEY';

/** Reasoning efforts accepted by the native Grok Responses endpoint. */
export const GROK_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

/** Responses reasoning-summary modes accepted by Grok Build model entries. */
export const GROK_REASONING_SUMMARIES = Object.freeze(['none', 'auto', 'concise', 'detailed']);

/** Request modalities supported by the native Grok route. */
export const GROK_MODALITIES = Object.freeze(['text', 'image']);

/**
 * Models advertised before any configuration arrives. The subscription catalog
 * serves `grok-4.7` (current frontier default), `grok-4.7-build-fast` (the fast
 * build variant), `grok-4.6`, and `grok-4.5`; each accepts the reasoning effort
 * vocabulary (route default `high`) and provider-hosted web search on the
 * first-party route. The four share the 500 000-token context capacity the
 * native catalog advertises.
 */
export const BUILT_IN_MODELS = Object.freeze([
  Object.freeze({
    id: 'grok-4.7',
    name: 'Grok 4.7',
    description: 'The latest frontier model',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    input: Object.freeze([...GROK_MODALITIES]),
    reasoningEfforts: Object.freeze({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }),
  }),
  Object.freeze({
    id: 'grok-4.7-build-fast',
    name: 'Grok 4.7 Fast',
    description: 'Fast variant of Grok 4.7',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    input: Object.freeze([...GROK_MODALITIES]),
    reasoningEfforts: Object.freeze({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }),
  }),
  Object.freeze({
    id: 'grok-4.6',
    name: 'Grok 4.6',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    input: Object.freeze([...GROK_MODALITIES]),
    reasoningEfforts: Object.freeze({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }),
  }),
  Object.freeze({
    id: 'grok-4.5',
    name: 'Grok 4.5',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    input: Object.freeze([...GROK_MODALITIES]),
  }),
]);

/**
 * Model ids whose native request carries the `no_inline_citations` include.
 * These are the first-party catalog entries with provider-hosted backend
 * search; the Responses body rejects the include on models without it.
 */
export const BACKEND_SEARCH_MODELS = Object.freeze(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']);
