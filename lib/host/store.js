/**
 * Plugin persistence: a private config file plus the shared grok login.
 *
 * Two stores live here:
 *  - `$DSH_HOME/grok-balance.json` — plugin configuration (non-secret).
 *  - The grok-build auth store (`~/.grok/auth.json` by default; the
 *    `GROK_AUTH_PATH`/`GROK_HOME` variables relocate it) — a scope-keyed map
 *    the native CLI also reads and writes. The plugin owns exactly one scope
 *    (`<issuer>::<client_id>`), preserves every other scope byte-for-byte on
 *    write, and follows grok-build's field format so both clients share one
 *    login.
 *
 * Tokens never enter the Harness settings document or a session log.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { authScopeKey, DEFAULT_CONFIG, MAX_CONFIG_BYTES, OAUTH_CLIENT_ID, OAUTH_ISSUER } from './constants.js';
import { clampInteger } from './http.js';

const CONFIG_FILE = 'grok-balance.json';

/** Resolve the Harness home the same way the rest of the Host does. */
function resolveHarnessHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh');
}

/** Read one environment variable's non-empty trimmed value. */
function environmentValue(name) {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Resolve the shared grok auth.json path the way grok-build does. */
export function resolveGrokAuthPath(override) {
  const explicit = override ?? environmentValue('GROK_AUTH_PATH');
  if (explicit !== undefined) return resolve(explicit);
  const home = environmentValue('GROK_HOME');
  if (home !== undefined) return join(resolve(home), 'auth.json');
  return join(homedir(), '.grok', 'auth.json');
}

/** True for a plain non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a non-empty trimmed string field. */
function readString(record, key) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Read a finite number field; ISO date strings are accepted and parsed. */
function readNumber(record, key) {
  const value = record?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Model id: a short alphanumeric identifier the proxy accepts. */
function sanitizeModel(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate) ? candidate : DEFAULT_CONFIG.searchModel;
}

/** HTTP(S) proxy URL for xAI egress, or '' for direct/env-proxy access. */
function sanitizeProxyUrl(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (candidate === '') return '';
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : '';
  } catch {
    return '';
  }
}

/** Validate one user-config document, falling back per field. */
export function sanitizeConfig(raw) {
  const source = isRecord(raw) ? raw : {};
  return {
    refreshMinutes: clampInteger(source.refreshMinutes, 1, 1440, DEFAULT_CONFIG.refreshMinutes),
    showIndicatorWhenLoggedOut: source.showIndicatorWhenLoggedOut === true,
    webSearchEnabled: source.webSearchEnabled !== false,
    searchModel: sanitizeModel(source.searchModel),
    proxyUrl: sanitizeProxyUrl(source.proxyUrl),
  };
}

/**
 * Normalize the plugin's scope record of the shared auth store.
 * @param raw - the raw scope record (may be undefined).
 * @param issuer - OIDC issuer the record must name.
 * @param clientId - OAuth client id the record must name.
 * @returns the login view used by the routes and the inference module, or null.
 */
export function sanitizeLogin(raw, issuer = OAUTH_ISSUER, clientId = OAUTH_CLIENT_ID) {
  if (!isRecord(raw)) return null;
  const accessToken = readString(raw, 'key');
  if (accessToken === undefined) return null;
  const explicitExpiry = readNumber(raw, 'expires_at');
  const created = readNumber(raw, 'create_time');
  // grok-build treats a record without expires_at as a 30-day session.
  const expiresAt = explicitExpiry !== undefined
    ? explicitExpiry
    : created !== undefined ? created + 30 * 24 * 60 * 60 * 1000 : null;
  return {
    accessToken,
    refreshToken: readString(raw, 'refresh_token'),
    expiresAt,
    loggedInAt: created ?? null,
    userId: readString(raw, 'user_id') ?? null,
    email: readString(raw, 'email') ?? null,
    principalType: readString(raw, 'principal_type') ?? null,
    principalId: readString(raw, 'principal_id') ?? null,
    oidcIssuer: readString(raw, 'oidc_issuer') ?? issuer,
    oidcClientId: readString(raw, 'oidc_client_id') ?? clientId,
  };
}

/** Write one file atomically with a restrictive mode. */
function writeAtomic(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { encoding: 'utf8', mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

/** Read one JSON file; undefined when it is missing or unreadable. */
function readJson(path, logger, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`${label}: could not be read (${error?.code ?? 'unknown'})`);
    return undefined;
  }
  if (text.length > MAX_CONFIG_BYTES) {
    logger?.warn?.(`${label}: ignored because it exceeds the size limit`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    logger?.warn?.(`${label}: ignored because it is not valid JSON`);
    return undefined;
  }
}

/**
 * Build the store bound to one plugin instance.
 * @param options - optional logger, Harness home, config path, and auth path override.
 * @returns config helpers plus shared-auth scope read/write helpers.
 */
export function createStore(options = {}) {
  const logger = options.logger;
  const configPath = options.configPath ?? join(options.homeDir ?? resolveHarnessHome(), CONFIG_FILE);
  const authPath = resolveGrokAuthPath(options.authPath);
  const scope = authScopeKey();

  /** Read the raw shared auth store; an empty object when absent or invalid. */
  function readAuthStore() {
    const raw = readJson(authPath, logger, 'auth.json');
    if (raw === undefined) return {};
    if (!isRecord(raw)) {
      logger?.warn?.('auth.json: ignored because it is not a scope-keyed object');
      return {};
    }
    return raw;
  }

  /**
   * Rewrite the shared store with one scope replaced, preserving other scopes.
   * The file is re-read inside the write so a concurrent grok-build write of
   * another scope is merged rather than clobbered.
   */
  function writeAuthStore(update) {
    const store = readAuthStore();
    update(store);
    writeAtomic(authPath, `${JSON.stringify(store, null, 2)}\n`, 0o600);
  }

  return {
    /** @returns absolute path of the non-secret config file. */
    configPath: () => configPath,
    /** @returns absolute path of the shared grok auth store. */
    authPath: () => authPath,
    /** @returns the auth.json scope key this plugin owns. */
    authScope: () => scope,

    /** Read the user config, applying defaults for missing or invalid fields. */
    readConfig() {
      return sanitizeConfig(readJson(configPath, logger, CONFIG_FILE));
    },

    /**
     * Merge a partial config patch and persist it.
     * @param patch - subset of the config document from the settings UI.
     * @returns the persisted, sanitized config.
     */
    writeConfig(patch) {
      const next = sanitizeConfig({ ...this.readConfig(), ...patch });
      writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
      return next;
    },

    /** Read the current login of this plugin's scope; null when signed out. */
    readLogin() {
      return sanitizeLogin(readAuthStore()[scope]);
    },

    /**
     * Persist the raw scope record (already in grok-build's field format).
     * @param record - the scope record to write.
     * @returns the sanitized login view of the stored record.
     */
    writeLoginRecord(record) {
      writeAuthStore((store) => {
        const previous = isRecord(store[scope]) ? store[scope] : {};
        // principal fields survive from the previous record when the token
        // response omits them: the refresh grant replays them.
        store[scope] = {
          ...previous,
          ...record,
          principal_type: record.principal_type ?? previous.principal_type,
          principal_id: record.principal_id ?? previous.principal_id,
        };
      });
      return this.readLogin();
    },

    /** Remove this plugin's scope; other scopes stay. @returns whether a record was removed. */
    clearLogin() {
      const store = readAuthStore();
      if (store[scope] === undefined) return false;
      delete store[scope];
      writeAtomic(authPath, `${JSON.stringify(store, null, 2)}\n`, 0o600);
      return true;
    },
  };
}
