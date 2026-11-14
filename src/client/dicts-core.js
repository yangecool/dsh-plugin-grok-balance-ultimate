/**
 * Shared zh/en dictionaries every client module may use.
 *
 * Keys are flat and dot-separated; owners are split by prefix: `state.*`,
 * `auth.*`, `app.*`, and `time.*` live here because the shared store and
 * format helpers reference them, while the page owns `page.*`/`settings.*`,
 * the composer widget owns `widget.*`, and the Models-page row owns
 * `modelsRow.*`. Placeholders use `{name}` and are filled by the locale
 * service's translate function (or {@link interpolate} for the store's
 * pre-binding fallback). English copy is sentence case.
 */

/** Chinese dictionary. */
const zh = {
  'state.error': '出错了',
  'state.networkError': '网络连接失败',
  'state.justNow': '刚刚',
  'state.minutesAgo': '{n} 分钟前',
  'state.hoursAgo': '{n} 小时前',
  'state.daysAgo': '{n} 天前',

  'auth.loginFailed': '登录失败，请重试。',
  'auth.loginCodeExpired': '确认码已过期，请重新登录。',

  'app.nav': 'Grok 用量',

  'time.resetDue': '即将重置',
  'time.lessThanMinute': '不到 1 分钟',
  'time.hoursShort': '{n} 小时',
  'time.minutesShort': '{n} 分钟',
  'time.daysShort': '{n} 天',
};

/** English dictionary (sentence case). */
const en = {
  'state.error': 'Something went wrong',
  'state.networkError': 'Network error',
  'state.justNow': 'Just now',
  'state.minutesAgo': '{n} min ago',
  'state.hoursAgo': '{n} hr ago',
  'state.daysAgo': '{n} d ago',

  'auth.loginFailed': 'Sign-in failed. Try again.',
  'auth.loginCodeExpired': 'The confirmation code expired. Sign in again.',

  'app.nav': 'Grok usage',

  'time.resetDue': 'Resetting now',
  'time.lessThanMinute': 'Less than a minute',
  'time.hoursShort': '{n} hr',
  'time.minutesShort': '{n} min',
  'time.daysShort': '{n} d',
};

/**
 * Fill `{name}` placeholders in one dictionary template.
 * @param template - dictionary string.
 * @param params - placeholder values; `null`/`undefined` keep the literal placeholder.
 * @returns the interpolated string, or the input when it is not a string.
 */
export function interpolate(template, params) {
  if (typeof template !== 'string' || params === null || typeof params !== 'object') return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Shared dictionaries, keyed by dictionary locale id. */
export const coreDicts = Object.freeze({ zh: Object.freeze(zh), en: Object.freeze(en) });
