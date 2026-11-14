/**
 * Pure formatting helpers shared by the usage page and the composer widget.
 *
 * Locale arguments accept a dictionary locale id (`'zh'` | `'en'`), a BCP 47
 * tag (`'zh-CN'`), or nothing (English). Helpers never embed UI copy: numeric
 * helpers return `''` for missing values, and the time helpers only add
 * translated fragments supplied by the caller's `t`.
 */

/** Maximum number of fraction digits `formatPercent` accepts. */
const MAX_PERCENT_DIGITS = 3;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/**
 * Values at or above this threshold are absolute epoch milliseconds rather
 * than a direct duration: 1e12 ms is 2001-09-09, older than any real timestamp
 * this plugin handles and larger than any countdown it renders.
 */
const EPOCH_MS_THRESHOLD = 1e12;
const LOCALE_TAGS = Object.freeze({ zh: 'zh-CN', en: 'en-US' });
const numberFormats = new Map();

/** Map a dictionary locale id or BCP 47 tag to an Intl locale tag. */
function localeTag(locale) {
  if (typeof locale === 'string' && locale !== '') {
    const lower = locale.toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-')) return LOCALE_TAGS.zh;
    if (lower === 'en' || lower.startsWith('en-')) return LOCALE_TAGS.en;
    return locale;
  }
  return LOCALE_TAGS.en;
}

/** Read the dictionary locale id a formatter output is intended for. */
function dictionaryLocale(locale) {
  return localeTag(locale) === LOCALE_TAGS.zh ? 'zh' : 'en';
}

/** Cached Intl.NumberFormat factory; the option key bounds the cache. */
function numberFormat(locale, options) {
  const tag = localeTag(locale);
  const key = `${tag}:${options.notation ?? 'standard'}:${options.minimumFractionDigits ?? 0}:${options.maximumFractionDigits ?? 0}`;
  let format = numberFormats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(tag, options);
    numberFormats.set(key, format);
  }
  return format;
}

/** Coerce a number or numeric string to a finite number, or null. */
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

/** Clamp a number into [min, max]; non-finite input maps to min. */
function clamp(value, min, max) {
  const numeric = finiteNumber(value);
  if (numeric === null) return min;
  return Math.max(min, Math.min(max, numeric));
}

/** Resolve `ms` (epoch ms, Date, or date string) to a valid Date, or null. */
function toDate(ms) {
  if (ms instanceof Date) return Number.isNaN(ms.getTime()) ? null : ms;
  const numeric = finiteNumber(ms);
  if (numeric === null) return null;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Normalize the overloaded `formatPercent(value, locale|digits, digits|locale)`
 * call forms so callers can pass a locale, a digit count, or both in either
 * order without crashing.
 * @returns resolved locale and fraction digits.
 */
function percentArguments(localeOrDigits, digitsOrLocale) {
  let locale = 'en';
  let digits = 0;
  if (localeOrDigits !== null && typeof localeOrDigits === 'object') {
    locale = typeof localeOrDigits.locale === 'string' ? localeOrDigits.locale : locale;
    digits = finiteNumber(localeOrDigits.digits) ?? 0;
    return { locale, digits };
  }
  if (typeof localeOrDigits === 'number') {
    digits = localeOrDigits;
    if (typeof digitsOrLocale === 'string') locale = digitsOrLocale;
    return { locale, digits };
  }
  if (typeof localeOrDigits === 'string') locale = localeOrDigits;
  if (typeof digitsOrLocale === 'number') digits = digitsOrLocale;
  else if (digitsOrLocale !== null && typeof digitsOrLocale === 'object') digits = finiteNumber(digitsOrLocale.digits) ?? 0;
  return { locale, digits };
}

/**
 * Format a percentage in the 0..100 range.
 * @param value - percentage value; out-of-range values clamp, non-finite values render as ''.
 * @param localeOrDefault - locale id/tag, a fraction-digit count, or `{ locale, digits }`.
 * @param digitsOrLocale - the other operand of the overloaded call form.
 * @returns e.g. `'72%'` / `'72.5%'`; `''` when the value is not finite.
 */
export function formatPercent(value, localeOrDefault = 'en', digitsOrLocale = 0) {
  const numeric = finiteNumber(value);
  if (numeric === null) return '';
  const { locale, digits } = percentArguments(localeOrDefault, digitsOrLocale);
  const fractionDigits = Math.round(clamp(digits, 0, MAX_PERCENT_DIGITS));
  return `${numberFormat(locale, { maximumFractionDigits: fractionDigits }).format(clamp(numeric, 0, 100))}%`;
}

/**
 * Format an integer count with locale grouping.
 * @param value - number; non-finite values render as ''.
 * @param locale - locale id/tag.
 * @returns e.g. `'1,234'`.
 */
export function formatNumber(value, locale = 'en') {
  const numeric = finiteNumber(value);
  if (numeric === null) return '';
  return numberFormat(locale, { maximumFractionDigits: 0 }).format(numeric);
}

/**
 * Format a count with Intl compact notation.
 * @param value - number; non-finite values render as ''.
 * @param locale - locale id/tag.
 * @returns e.g. `'1.2K'` (en) or `'1.2万'` (zh).
 */
export function formatCompact(value, locale = 'en') {
  const numeric = finiteNumber(value);
  if (numeric === null) return '';
  return numberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(numeric);
}

/**
 * Format a USD amount with the `$` sign and exactly two fraction digits.
 * @param value - USD amount; non-finite values render as ''.
 * @param locale - locale id/tag.
 * @returns e.g. `'$12.35'`; `''` when the value is not finite.
 */
export function formatUsd(value, locale = 'en') {
  const numeric = finiteNumber(value);
  if (numeric === null) return '';
  const body = numberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric);
  return `$${body}`;
}

/**
 * Format a full date and time.
 * @param ms - epoch milliseconds (or Date).
 * @param locale - locale id/tag.
 * @returns a locale date + time string; `''` when the value is not a date.
 */
export function formatDateTime(ms, locale = 'en') {
  const date = toDate(ms);
  if (date === null) return '';
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

/**
 * Format a date only (no time of day).
 * @param ms - epoch milliseconds (or Date).
 * @param locale - locale id/tag.
 * @returns a locale date string; `''` when the value is not a date.
 */
export function formatDate(ms, locale = 'en') {
  const date = toDate(ms);
  if (date === null) return '';
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric', month: 'short', day: 'numeric',
  }).format(date);
}

/**
 * Format a reset moment.
 * Same-day resets render as time only (`HH:mm`); other days add the date, and
 * a different year adds the year.
 * @param ms - epoch milliseconds (or Date) of the reset.
 * @param locale - locale id/tag.
 * @param now - reference time in epoch milliseconds (defaults to `Date.now()`).
 * @returns a locale date/time string; `''` when the value is not a date.
 */
export function formatResetAt(ms, locale = 'en', now = Date.now()) {
  const date = toDate(ms);
  if (date === null) return '';
  const reference = toDate(now) ?? new Date();
  const sameDay = date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat(localeTag(locale), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  }
  const options = {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  };
  if (date.getFullYear() !== reference.getFullYear()) options.year = 'numeric';
  return new Intl.DateTimeFormat(localeTag(locale), options).format(date);
}

/**
 * Format the time until a moment.
 * Accepts either an absolute timestamp or a remaining duration in
 * milliseconds; values below {@link EPOCH_MS_THRESHOLD} are read as durations.
 * The caller supplies `t` so every fragment is localized.
 * @param target - absolute epoch ms or remaining duration ms.
 * @param t - translate function returning `time.*` fragments.
 * @param now - reference time in epoch milliseconds (defaults to `Date.now()`).
 * @returns e.g. `'2 hr 30 min'`, or the `time.resetDue` fragment when due.
 */
export function countdown(target, t, now = Date.now()) {
  const translate = typeof t === 'function' ? t : (key) => key;
  const numeric = finiteNumber(target);
  if (numeric === null) return '';
  const reference = finiteNumber(now) ?? Date.now();
  const remaining = numeric >= EPOCH_MS_THRESHOLD ? numeric - reference : numeric;
  if (remaining <= 0) return translate('time.resetDue');
  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
  const minutes = Math.ceil((remaining % HOUR_MS) / MINUTE_MS);
  if (days > 0) {
    const parts = [translate('time.daysShort', { n: days })];
    if (hours > 0) parts.push(translate('time.hoursShort', { n: hours }));
    return parts.join(' ');
  }
  if (hours > 0) {
    const parts = [translate('time.hoursShort', { n: hours })];
    const rest = Math.min(minutes, 59);
    if (rest > 0) parts.push(translate('time.minutesShort', { n: rest }));
    return parts.join(' ');
  }
  return translate('time.minutesShort', { n: Math.max(1, minutes) });
}

/**
 * Convert a millisecond duration to whole minutes.
 * @param ms - duration in milliseconds.
 * @returns rounded-up minutes; 0 for non-positive or non-finite input.
 */
export function durationMinutes(ms) {
  const numeric = finiteNumber(ms);
  if (numeric === null || numeric <= 0) return 0;
  return Math.max(1, Math.round(numeric / MINUTE_MS));
}

/**
 * Format how long ago a moment was.
 * @param ms - past epoch milliseconds (or Date).
 * @param t - translate function covering `state.justNow`/`state.*Ago`.
 * @param now - reference time in epoch milliseconds (defaults to `Date.now()`).
 * @returns a localized relative string; `''` when the input is not a date.
 */
export function formatRelative(ms, t, now = Date.now()) {
  const date = toDate(ms);
  const translate = typeof t === 'function' ? t : (key) => key;
  if (date === null) return '';
  const reference = finiteNumber(now) ?? Date.now();
  const elapsed = Math.max(0, reference - date.getTime());
  if (elapsed < MINUTE_MS) return translate('state.justNow');
  const minutes = Math.round(elapsed / MINUTE_MS);
  if (minutes < 60) return translate('state.minutesAgo', { n: minutes });
  const hours = Math.round(elapsed / HOUR_MS);
  if (hours < 24) return translate('state.hoursAgo', { n: hours });
  return translate('state.daysAgo', { n: Math.max(1, Math.round(elapsed / DAY_MS)) });
}

/**
 * Dictionary locale id a formatter should use for a given locale argument.
 * @param locale - locale id/tag or nothing.
 * @returns `'zh'` or `'en'`.
 */
export function formatLocaleId(locale) {
  return dictionaryLocale(locale);
}
