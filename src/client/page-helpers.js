/**
 * Pure defensive helpers for the dedicated Grok usage page.
 *
 * Every Host payload field can be missing or malformed while caches are being
 * filled, so this module never throws on adversarial values: it coerces to
 * `null` instead. It has no imports and no side effects, which also makes it
 * directly unit-testable under plain Node.
 */

/** Epoch-millisecond lower bound used to tell seconds from milliseconds apart. */
const MS_THRESHOLD = 100_000_000_000; // ~1973 in milliseconds, ~5138 in seconds

/**
 * Whether a value is a usable finite number.
 * @param value - candidate.
 * @returns true when `value` is a finite number.
 */
export function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Coerce a value to a finite number.
 * @param value - number-like candidate (numbers only; strings are ignored so a
 *   locale-formatted text never becomes a number).
 * @returns the finite number, else null.
 */
export function num(value) {
  return isNumber(value) ? value : null;
}

/**
 * Coerce an upstream timestamp to epoch milliseconds.
 *
 * Host normalizers emit milliseconds, but raw payloads may carry seconds or an
 * ISO string; the threshold heuristic keeps both readable.
 * @param value - epoch seconds/milliseconds, Date, or ISO date string.
 * @returns epoch milliseconds, else null.
 */
export function toMs(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!isNumber(value) || value <= 0) {
    return null;
  }
  return value < MS_THRESHOLD ? value * 1000 : value;
}

/**
 * Clamp a percentage into 0..100.
 * @param value - numeric percentage candidate.
 * @returns clamped percentage, else null.
 */
export function clampPercent(value) {
  if (!isNumber(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, value));
}

/**
 * Run a producer, returning a fallback instead of throwing.
 * @param producer - zero-argument function.
 * @param fallback - value returned when the producer throws.
 * @returns the produced value or the fallback.
 */
export function attempt(producer, fallback = null) {
  try {
    return producer();
  } catch {
    // Render-path helpers must not blank the whole page; a bad field degrades to fallback.
    return fallback;
  }
}

/**
 * Text of a translated key, tolerating a broken or missing translator.
 * @param t - translator from slot props (may be absent).
 * @param key - dictionary key.
 * @param params - placeholder values.
 * @returns translated text, a placeholder-free translation, or the key itself.
 */
export function tr(t, key, params) {
  if (typeof t !== 'function') {
    return key;
  }
  const translated = attempt(() => t(key, params), null);
  if (typeof translated === 'string' && translated.length > 0) {
    return translated;
  }
  const bare = attempt(() => t(key), null);
  return typeof bare === 'string' && bare.length > 0 ? bare : key;
}

/**
 * Class-name joiner that drops empty entries.
 * @param names - class names, may be falsy.
 * @returns the space-joined class string.
 */
export function cls(...names) {
  return names.filter((name) => typeof name === 'string' && name.length > 0).join(' ');
}

/**
 * Remaining percentage derived from the billing `creditUsagePercent` (used).
 * @param billing - billing block of the overview.
 * @returns remaining percentage 0..100, else null when the used value is unknown.
 */
export function remainingPercentOf(billing) {
  if (billing === null || typeof billing !== 'object') return null;
  return clampPercent(100 - clampPercent(billing.creditUsagePercent));
}

/**
 * Validate the refresh-interval field.
 * @param text - input value.
 * @returns `{ ok, value }` with minutes 1..1440 when valid.
 */
export function parseRefreshMinutes(text) {
  const raw = typeof text === 'number' ? String(text) : text;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, value: null };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, value: null };
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    return { ok: false, value: null };
  }
  return { ok: true, value };
}

/**
 * Map a Host error code to a page dictionary key.
 * @param code - stable Host error code.
 * @returns dictionary key.
 */
export function errorDictKey(code) {
  switch (code) {
    case 'login_required':
    case 'not_logged_in':
      return 'page.errorNotLoggedIn';
    case 'login_expired':
      return 'page.errorLoginExpired';
    case 'free_usage_exhausted':
      return 'page.errorExhausted';
    case 'rate_limited':
      return 'page.errorRateLimited';
    case 'oauth_unavailable':
    case 'oauth_invalid_response':
      return 'page.errorAuth';
    case 'upstream_failed':
      return 'page.errorUpstream';
    case 'upstream_timeout':
      return 'page.errorTimeout';
    case 'network_error':
      return 'page.errorNetwork';
    default:
      return 'page.errorUnknown';
  }
}

/**
 * Error code of a rejected store action.
 * @param error - thrown value.
 * @returns stable code string, else ''.
 */
export function errorCodeOf(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return error.code;
  }
  return '';
}

/**
 * Format an error payload for a Notice body.
 * @param error - `{ code, message }` style payload.
 * @param t - translator.
 * @returns localized message.
 */
export function errorTextOf(error, t) {
  const code = errorCodeOf(error) || (error && typeof error === 'object' ? error.code : '');
  return tr(t, code ? errorDictKey(code) : 'page.errorUnknown');
}
