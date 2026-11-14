/**
 * Formatting adapter for the dedicated Grok usage page.
 *
 * The page renders numbers, times, and countdowns exclusively through the
 * shared `format.js` helpers when they are present; each call is guarded so a
 * malformed payload or a helper mismatch degrades to a local Intl fallback
 * instead of throwing during render.
 */
import * as fmt from './format.js';
import { attempt, clampPercent, isNumber, num, toMs, tr } from './page-helpers.js';

/** BCP 47 tags used by the Intl fallbacks. */
const LOCALE_TAGS = { zh: 'zh-CN', en: 'en-US' };

/** Known `currentPeriod.type` spellings mapped to dictionary keys. */
const PERIOD_TYPE_KEYS = Object.freeze({
  USAGE_PERIOD_TYPE_WEEKLY: 'page.periodWeekly',
  USAGE_PERIOD_TYPE_MONTHLY: 'page.periodMonthly',
});

/** Known `subscriptionTier` spellings mapped to dictionary keys (case-insensitive). */
const TIER_KEYS = Object.freeze({
  supergrok_heavy: 'page.tierSupergrokHeavy',
  supergrok_light: 'page.tierSupergrokLight',
  supergrok: 'page.tierSupergrok',
  heavy: 'page.tierHeavy',
  light: 'page.tierLight',
});

/**
 * BCP 47 tag of a plugin locale id.
 * @param locale - 'zh' | 'en' | other.
 * @returns BCP 47 tag.
 */
export function localeTag(locale) {
  return LOCALE_TAGS[locale] === 'zh' ? LOCALE_TAGS.zh : LOCALE_TAGS.en;
}

/**
 * Call one shared formatter, keeping extra arguments harmless.
 * @param name - format.js export name.
 * @param args - arguments passed to the helper.
 * @returns helper result, else null.
 */
function shared(name, ...args) {
  return attempt(() => {
    const helper = fmt[name];
    return typeof helper === 'function' ? helper(...args) : null;
  }, null);
}

/**
 * Format a number with grouping.
 * @param value - number or null.
 * @param locale - plugin locale id.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatNumber(value, locale) {
  const numeric = num(value);
  if (numeric === null) {
    return '—';
  }
  const result = shared('formatNumber', numeric, locale);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return attempt(() => new Intl.NumberFormat(localeTag(locale)).format(numeric), '—');
}

/**
 * Format a number compactly (1.2K / 3.4M).
 * @param value - number or null.
 * @param locale - plugin locale id.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatCompact(value, locale) {
  const numeric = num(value);
  if (numeric === null) {
    return '—';
  }
  const result = shared('formatCompact', numeric, locale);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return attempt(
    () =>
      new Intl.NumberFormat(localeTag(locale), {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(numeric),
    '—',
  );
}

/**
 * Format a USD amount (`$12.35`).
 * @param value - USD amount or null.
 * @param locale - plugin locale id.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatUsd(value, locale) {
  const numeric = num(value);
  if (numeric === null) {
    return '—';
  }
  const result = shared('formatUsd', numeric, locale);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return attempt(
    () => `$${new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric)}`,
    '—',
  );
}

/**
 * Format an absolute date-time.
 * @param value - epoch milliseconds (or seconds/ISO string).
 * @param locale - plugin locale id.
 * @param options - `{ dateOnly }` to drop the time.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatDateTime(value, locale, options = {}) {
  const ms = toMs(value);
  if (ms === null) {
    return '—';
  }
  const helper = options.dateOnly ? 'formatDate' : 'formatDateTime';
  const result = shared(helper, ms, locale);
  if (typeof result === 'string' && result.length > 0 && !options.dateOnly) {
    return result;
  }
  const intlOptions = options.dateOnly
    ? { month: '2-digit', day: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
  return attempt(
    () => new Intl.DateTimeFormat(localeTag(locale), intlOptions).format(new Date(ms)),
    '—',
  );
}

/**
 * Format a reset timestamp.
 * @param value - epoch milliseconds.
 * @param locale - plugin locale id.
 * @param now - current epoch milliseconds.
 * @returns formatted text, else an em dash placeholder.
 */
export function formatResetAt(value, locale, now) {
  const ms = toMs(value);
  if (ms === null) {
    return '—';
  }
  const result = shared('formatResetAt', ms, locale, now);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return formatDateTime(ms, locale);
}

/**
 * Countdown text for a duration in milliseconds.
 * @param msRemaining - milliseconds left.
 * @param t - translator.
 * @returns localized countdown, else an em dash placeholder.
 */
export function formatCountdown(msRemaining, t) {
  if (!isNumber(msRemaining)) {
    return '—';
  }
  const clamped = Math.max(0, msRemaining);
  const result = shared('countdown', clamped, t);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  const minutes = Math.floor(clamped / 60_000);
  if (minutes < 1) {
    return tr(t, 'time.lessThanMinute');
  }
  if (minutes < 60) {
    return tr(t, 'time.minutesShort', { n: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return tr(t, 'time.hoursShort', { n: hours });
  }
  return tr(t, 'time.daysShort', { n: Math.floor(hours / 24) });
}

/**
 * Percentage text such as `72%`.
 * @param percent - percentage 0..100 or null.
 * @param locale - plugin locale id.
 * @returns percentage text, else an em dash placeholder.
 */
export function formatPercentValue(percent, locale) {
  if (!isNumber(percent)) {
    return '—';
  }
  const clamped = clampPercent(percent);
  const result = shared('formatPercent', clamped, locale);
  if (typeof result === 'string' && result.length > 0) {
    return result;
  }
  return `${Math.round(clamped)}%`;
}

/**
 * Elapsed share of one billing period, clamped to 0..100.
 * @param period - billing `currentPeriod` block (`{ start, end }` epoch ms or null).
 * @param now - current epoch milliseconds.
 * @returns elapsed percentage 0..100, or null when the period bounds are unusable.
 */
export function periodElapsedPercent(period, now) {
  if (period === null || typeof period !== 'object' || !isNumber(now)) {
    return null;
  }
  const start = toMs(period.start);
  const end = toMs(period.end);
  if (start === null || end === null || end <= start) {
    return null;
  }
  const fraction = (now - start) / (end - start);
  if (!Number.isFinite(fraction)) {
    return null;
  }
  return clampPercent(fraction * 100);
}

/**
 * Localized label of one billing period type.
 * @param type - `currentPeriod.type` string or null.
 * @param t - translator.
 * @returns the localized label, or null when the type is unknown.
 */
export function periodTypeLabel(type, t) {
  if (typeof type !== 'string' || type === '') {
    return null;
  }
  const key = PERIOD_TYPE_KEYS[type];
  return key === undefined ? null : tr(t, key);
}

/**
 * Localized tier label of a subscription tier value.
 * @param tier - `subscriptionTier` string or null.
 * @param t - translator.
 * @returns the localized label for a known tier, else the raw value, else null.
 */
export function tierLabel(tier, t) {
  if (typeof tier !== 'string' || tier.trim() === '') {
    return null;
  }
  const key = TIER_KEYS[tier.trim().toLowerCase()];
  return key === undefined ? tier : tr(t, key);
}
