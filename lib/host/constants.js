/**
 * Fixed protocol constants for the Grok subscription plugin.
 *
 * These are external-service contracts (the xAI OAuth2 device flow, the
 * grok-build auth.json format, and the xAI inference API) rather than
 * deployment tunables; user-facing choices live in the plugin's own config
 * file and settings UI.
 */

/** Same-origin prefix every Host route of this plugin mounts under. */
export const ROUTE_PREFIX = '/grok-balance';

/** Package id: the Client bundle registration id and the Host plugin name. */
export const PACKAGE_ID = 'dsh-plugin-grok-balance-ultimate';

/** Sidebar panel key shared by the `main` panel and its `sidebar.panellist` icon. */
export const PANEL_ID = 'grok-usage';

/** Client locale namespace used by dictionaries and slot `locale` options. */
export const LOCALE_NS = 'grok-balance';

/** xAI OIDC issuer; discovery and the device endpoints live under it. */
export const OAUTH_ISSUER = 'https://auth.x.ai';

/** RFC 8414 discovery document path. */
export const OAUTH_DISCOVERY_PATH = '/.well-known/openid-configuration';

/** RFC 8628 device-authorization endpoint. */
export const OAUTH_DEVICE_PATH = '/oauth2/device/code';

/** RFC 8628 token endpoint (also serves the refresh_token grant). */
export const OAUTH_TOKEN_PATH = '/oauth2/token';

/** Public OAuth client id grok-build ships; it is not a secret. */
export const OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/** Scopes the subscription session requests (grok-build default set). */
export const OAUTH_SCOPES = Object.freeze([
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
  'conversations:read',
  'conversations:write',
  'workspaces:read',
  'workspaces:write',
]);

/** Referrer label grok-build sends to the device-code endpoint. */
export const OAUTH_REFERRER = 'grok-build';

/** grok-build release the plugin reports on OAuth endpoints. */
export const CLIENT_VERSION = '1.0.45';

/** Low-cardinality client-surface hint for device-flow metrics. */
export const CLIENT_SURFACE = 'ui';

/** Upper bound for one OAuth HTTP request. */
export const OAUTH_TIMEOUT_MS = 15_000;

/** Refresh a bearer inside this remaining lifetime (grok-build's final minute). */
export const REFRESH_MARGIN_MS = 60_000;

/** grok-build's minimum device-code deadline fallback. */
export const MIN_DEVICE_CODE_EXPIRY_SECONDS = 600;

/** RFC 8628 `slow_down` increment added to the polling interval. */
export const DEVICE_SLOW_DOWN_INCREMENT_MS = 5_000;

/** Floor for the device polling interval. */
export const DEVICE_POLL_FLOOR_MS = 1_000;

/**
 * Subscription proxy every grok-build client uses for inference and account
 * surfaces (PRODUCTION_ENDPOINTS cli_chat_proxy).
 */
export const PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';

/** xAI OpenAI-compatible API base for API-key deployments. */
export const API_KEY_BASE_URL = 'https://api.x.ai/v1';

/** Account and usage surfaces on the subscription proxy. */
export const BILLING_PATH = '/billing';
export const AUTO_TOPUP_PATH = '/auto-topup-rule';
export const USER_PATH = '/user';
export const MODELS_PATH = '/models';

/** `X-XAI-Token-Auth` value marking a user (subscription) token. */
export const TOKEN_AUTH_VALUE = 'xai-grok-cli';

/** Subscription-proxy handshake header value (grok-build constant). */
export const AUTHENTICATE_RESPONSE = 'authenticate-response';

/** Client identifier reported on every grok request. */
export const CLIENT_IDENTIFIER = 'grok-shell';

/** Default model of the shipped catalog and of the web-search tool call. */
export const DEFAULT_MODEL = 'grok-4.6';

/** Upper bound for one account-surface request. */
export const UPSTREAM_TIMEOUT_MS = 20_000;

/** Freshness of a cached overview document. */
export const OVERVIEW_TTL_MS = 60_000;


/**
 * Auth scope key inside the shared auth.json: `<issuer>::<client_id>`, the
 * exact format grok-build writes, so both clients share one login.
 * @param issuer - OIDC issuer base.
 * @param clientId - OAuth client id.
 * @returns the auth.json scope key.
 */
export function authScopeKey(issuer = OAUTH_ISSUER, clientId = OAUTH_CLIENT_ID) {
  return `${issuer.replace(/\/+$/, '')}::${clientId}`;
}

export const DEFAULT_CONFIG = Object.freeze({
  refreshMinutes: 30,
  showIndicatorWhenLoggedOut: false,
  webSearchEnabled: true,
  searchModel: DEFAULT_MODEL,
  proxyUrl: '',
});

/** Upper bound for the plugin config document. */
export const MAX_CONFIG_BYTES = 64 * 1024;
