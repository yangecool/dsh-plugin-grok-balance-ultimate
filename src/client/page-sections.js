/**
 * Signed-in sections of the dedicated Grok usage page: the device-code login
 * card, the account/subscription card, the credit-usage card, the usage
 * history table, and the auto-top-up rule card.
 *
 * Each section owns only presentation state (inline confirm, copy outcome);
 * every network call goes through the singleton `state` store, and every
 * payload access tolerates a missing or malformed field.
 */
import { rt } from './runtime.js';
import { state } from './state.js';
import { Badge, Bar, Button, Card, EmptyState, Icon, KeyValue, Notice, Spinner } from './ui.js';
import {
  formatCountdown,
  formatDateTime,
  formatPercentValue,
  formatResetAt,
  formatUsd,
  periodElapsedPercent,
  periodTypeLabel,
  tierLabel,
} from './page-format.js';
import { cls, errorTextOf, isNumber, remainingPercentOf, toMs } from './page-helpers.js';
import { openExternal, SUPERGROK_URL } from './page-links.js';

/** Element factory routed through the runtime binding. */
function el(type, props, ...children) {
  const h = rt.h;
  return typeof h === 'function' ? h(type, props, ...children) : null;
}

/**
 * One SVG progress ring. The arc is the USED credit fraction; the centered
 * label is the REMAINING percentage, so a fuller ring means less credit left.
 * @param props - `usedPercent` (0..100 or null), `remainingText`, `label` (a11y).
 * @returns the ring element.
 */
export function CreditRing(props) {
  const { usedPercent, remainingText, label } = props ?? {};
  const used = isNumber(usedPercent) ? Math.min(100, Math.max(0, usedPercent)) : null;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const fraction = used === null ? 0 : used / 100;
  const toneClass = used === null ? '' : used >= 95 ? ' is-critical' : used >= 80 ? ' is-warning' : '';
  return el('svg', {
    className: cls('grk-page-ring', toneClass),
    viewBox: '0 0 128 128',
    role: 'img',
    'aria-label': label,
  },
  el('circle', { className: 'grk-page-ring-track', cx: 64, cy: 64, r: radius }),
  el('circle', {
    className: 'grk-page-ring-arc',
    cx: 64,
    cy: 64,
    r: radius,
    transform: 'rotate(-90 64 64)',
    strokeDasharray: `${(circumference * fraction).toFixed(2)} ${circumference.toFixed(2)}`,
  }),
  el('text', {
    className: 'grk-page-ring-value',
    x: 64,
    y: 64,
    textAnchor: 'middle',
    dominantBaseline: 'central',
  }, remainingText));
}

/**
 * Device-code login card for the logged-out, expired, pending, and failed
 * states. Shows the confirmation code in large type with copy support, the
 * authorization link, and the code's expiry countdown.
 * @param props - `t`, `flow`, `loginExpired`, `loadingLogin`.
 * @returns the card element.
 */
export function LoginCard(props) {
  const { t, flow, loginExpired = false, loadingLogin = false } = props ?? {};
  const React = rt.React;
  const [starting, setStarting] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const flowState = flow && typeof flow === 'object' ? flow.state : 'idle';
  const expired = loginExpired === true;
  const busy = starting === true || loadingLogin === true;
  const pending = busy || flowState === 'starting' || flowState === 'pending';
  const failed = pending !== true && (failure !== null || flowState === 'error');

  React.useEffect(() => {
    if (copied !== true) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function requestLogin() {
    if (busy) return;
    setStarting(true);
    setFailure(null);
    try {
      await state.startLogin();
    } catch (error) {
      setFailure(error);
    } finally {
      setStarting(false);
    }
  }

  function cancelLogin() {
    try {
      state.cancelLogin();
    } catch {
      // Cancelling an already-finished flow is harmless.
    }
    setFailure(null);
    setStarting(false);
    setCopied(false);
  }

  function copyCode() {
    const code = flow?.userCode;
    if (typeof code !== 'string' || code === '') return;
    try {
      void navigator.clipboard?.writeText(code).then(() => setCopied(true));
    } catch {
      // Clipboard access may be denied; the code stays selectable as text.
    }
  }

  if (pending && flowState === 'pending') {
    const code = typeof flow.userCode === 'string' ? flow.userCode : '';
    const expiresAt = toMs(flow.expiresAt);
    const authorizeUrl = flow.verificationUriComplete ?? flow.verificationUri;
    return el(Card, { className: 'grk-page-card' },
      el('div', { className: 'grk-page-auth' },
        el('h3', { className: 'grk-page-auth-title' }, t('page.loginWaitingTitle')),
        el('div', { className: 'grk-page-device-code', role: 'group', 'aria-label': t('page.loginCode') },
          el('button', {
            type: 'button',
            className: 'grk-page-device-code-value',
            title: t('page.loginCopy'),
            onClick: copyCode,
          }, code !== '' ? code : '—'),
          el(Button, {
            variant: 'subtle',
            size: 'sm',
            onClick: copyCode,
          }, el(Icon, { name: 'copy', size: 14 }), copied ? t('page.loginCopied') : t('page.loginCopy'))),
        el('p', { className: 'grk-page-auth-body' }, t('page.loginWaitingBody')),
        expiresAt !== null
          ? el('p', { className: 'grk-page-field-hint' }, t('page.loginCodeExpires', {
            time: formatCountdown(expiresAt - Date.now(), t),
          }))
          : null,
        el('div', { className: 'grk-page-auth-actions' },
          authorizeUrl != null
            ? el(Button, {
              variant: 'primary',
              size: 'sm',
              onClick: () => openExternal(authorizeUrl),
            }, el(Icon, { name: 'external', size: 14 }), t('page.loginOpenLink'))
            : null,
          el(Button, { variant: 'subtle', size: 'sm', onClick: cancelLogin }, t('page.cancel')))));
  }

  if (pending) {
    return el(Card, { className: 'grk-page-card' },
      el('div', { className: 'grk-page-auth' },
        el('h3', { className: 'grk-page-auth-title' }, t('page.loginWaitingTitle')),
        el('div', { className: 'grk-page-waiting' },
          el(Spinner, { size: 16 }),
          el('span', null, t('page.loginStarting'))),
        el('p', { className: 'grk-page-auth-body' }, t('page.loginWaitingBody')),
        el('div', { className: 'grk-page-auth-actions' },
          el(Button, { variant: 'subtle', size: 'sm', onClick: cancelLogin }, t('page.cancel')))));
  }

  if (failed) {
    return el(Card, { className: 'grk-page-card' },
      el('div', { className: 'grk-page-auth' },
        el('h3', { className: 'grk-page-auth-title' }, t('page.loginFailedTitle')),
        el(Notice, {
          tone: 'error',
          children: el('span', null,
            flow?.error != null ? flow.error : failure !== null ? errorTextOf(failure, t) : t('page.loginFailedBody')),
        }),
        el('div', { className: 'grk-page-auth-actions' },
          el(Button, { variant: 'primary', busy: busy, onClick: requestLogin }, t('page.loginRetry')),
          el(Button, { variant: 'subtle', size: 'sm', onClick: cancelLogin }, t('page.cancel')))));
  }

  return el(Card, { className: 'grk-page-card' },
    el('div', { className: 'grk-page-auth' },
      el('h3', { className: 'grk-page-auth-title' }, expired ? t('page.loginExpiredTitle') : t('page.loginTitle')),
      expired
        ? el(Notice, { tone: 'warn', children: el('span', null, t('page.loginExpiredBody')) })
        : null,
      el('p', { className: 'grk-page-auth-body' }, t('page.loginBody')),
      el('div', { className: 'grk-page-auth-actions' },
        el(Button, {
          variant: 'primary',
          busy: busy,
          onClick: requestLogin,
        }, el(Icon, { name: 'login', size: 14 }), t('page.loginButton')))));
}

/**
 * Account/subscription card: identity, tier, billing period with its progress,
 * and the inline-confirm sign-out action.
 * @param props - `t`, `locale`, `now`, `login`, `user`, `billing`.
 * @returns the card element.
 */
export function AccountCard(props) {
  const { t, locale, now, login, user, billing } = props ?? {};
  const React = rt.React;
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const userError = user !== null && typeof user === 'object' && user.error != null ? user.error : null;
  const email = login !== null && typeof login.email === 'string' ? login.email : null;
  const name = !userError && user !== null && typeof user === 'object' && typeof user.name === 'string' && user.name !== ''
    ? user.name
    : null;
  const tierSource = !userError && user !== null && typeof user === 'object' && typeof user.subscriptionTier === 'string'
    ? user.subscriptionTier
    : (billing !== null && typeof billing === 'object' && typeof billing.subscriptionTier === 'string'
      ? billing.subscriptionTier
      : null);
  const tier = tierLabel(tierSource, t);

  const rows = [];
  if (email !== null) rows.push({ label: t('page.accountEmail'), value: email });
  if (name !== null) rows.push({ label: t('page.accountName'), value: name });
  if (tier !== null) rows.push({ label: t('page.accountTier'), value: tier });

  const billingPeriod = billing !== null && typeof billing === 'object' && billing.currentPeriod != null
    && typeof billing.currentPeriod === 'object'
    ? billing.currentPeriod
    : null;
  const periodLabel = periodTypeLabel(billingPeriod?.type, t);
  const start = toMs(billingPeriod?.start);
  const end = toMs(billingPeriod?.end);
  if (start !== null && end !== null) {
    rows.push({
      label: t('page.accountPeriod'),
      value: `${formatDateTime(start, locale, { dateOnly: true })} → ${formatResetAt(end, locale, now)}`,
    });
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await state.logout();
      if (result !== null && typeof result === 'object' && result.ok === false) {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const body = [];
  body.push(userError !== null
    ? el(Notice, {
      key: 'user-error',
      tone: 'warn',
      children: el('span', null, errorTextOf(userError, t)),
    })
    : el(KeyValue, { key: 'kv', rows }));
  if (periodLabel !== null && start !== null && end !== null) {
    const progress = periodElapsedPercent(billingPeriod, now);
    body.push(el('div', { key: 'period', className: 'grk-page-period' },
      el('div', { className: 'grk-page-period-head' },
        el('span', { className: 'grk-page-period-label' }, periodLabel),
        end > now
          ? el('span', { className: 'grk-page-period-countdown' },
            t('page.periodEndsIn', { time: formatCountdown(end - now, t) }))
          : el('span', { className: 'grk-page-period-countdown' }, t('time.resetDue'))),
      el(Bar, {
        percent: progress ?? 0,
        tone: 'brand',
        height: 6,
        label: t('page.periodProgress', { percent: formatPercentValue(progress, locale) }),
      })));
  }
  body.push(confirming === true
    ? el('div', { key: 'logout-confirm', className: 'grk-page-confirm' },
      el('span', { className: 'grk-page-confirm-text' }, t('page.logoutConfirm')),
      el(Button, { variant: 'primary', size: 'sm', busy: busy, onClick: logout }, t('page.logoutConfirmAction')),
      el(Button, {
        variant: 'subtle',
        size: 'sm',
        disabled: busy,
        onClick: () => setConfirming(false),
      }, t('page.cancel')))
    : el('div', { key: 'logout', className: 'grk-page-inline' },
      failed === true ? el('span', { className: 'grk-page-field-error' }, t('page.logoutFailed')) : null,
      el('span', { className: 'grk-page-spacer' }),
      el(Button, {
        variant: 'subtle',
        size: 'sm',
        onClick: () => {
          setFailed(false);
          setConfirming(true);
        },
      }, el(Icon, { name: 'logout', size: 14 }), t('page.logout'))));

  return el(Card, {
    className: 'grk-page-card',
    title: t('page.accountTitle'),
    actions: tier !== null ? el(Badge, { tone: 'brand' }, tier) : null,
  }, el('div', { className: 'grk-page-stack' }, body));
}

/**
 * Credit usage card: one ring for `creditUsagePercent` (used) with the
 * remaining percentage beside it, the prepaid balance, and the billing badges.
 * @param props - `t`, `locale`, `now`, `billing`.
 * @returns the card element, or an empty state when billing failed.
 */
export function UsageCard(props) {
  const { t, locale, now, billing } = props ?? {};
  if (billing === null || typeof billing !== 'object') {
    return el(Card, { className: 'grk-page-card', title: t('page.usageTitle') },
      el(EmptyState, {
        icon: 'gauge',
        title: t('page.usageUnavailable'),
        body: t('page.usageUnavailableBody'),
      }));
  }
  if (billing.error != null) {
    return el(Card, { className: 'grk-page-card', title: t('page.usageTitle') },
      el(EmptyState, {
        icon: 'gauge',
        title: t('page.usageUnavailable'),
        body: errorTextOf(billing.error, t),
      }));
  }
  const usedPercent = isNumber(billing.creditUsagePercent) ? billing.creditUsagePercent : null;
  const remainingPercent = remainingPercentOf(billing);
  const prepaid = isNumber(billing.prepaidBalanceUsd) ? billing.prepaidBalanceUsd : null;
  const periodEnd = toMs(billing.currentPeriod?.end);

  const badges = [];
  if (billing.onDemandEnabled === true) badges.push(el(Badge, { key: 'ondemand', tone: 'neutral' }, t('page.usageOnDemand')));
  if (billing.isUnifiedBillingUser === true) badges.push(el(Badge, { key: 'unified', tone: 'neutral' }, t('page.usageUnifiedBilling')));

  const facts = [];
  facts.push(el('div', { key: 'used', className: 'grk-page-usage-fact' },
    el('span', { className: 'grk-page-usage-fact-label' }, t('page.usageUsed')),
    el('span', {
      className: cls('grk-page-usage-fact-value', usedPercent !== null && usedPercent >= 95
        ? 'is-critical'
        : usedPercent !== null && usedPercent >= 80 ? 'is-warning' : null),
    }, formatPercentValue(usedPercent, locale))));
  if (prepaid !== null) {
    facts.push(el('div', { key: 'prepaid', className: 'grk-page-usage-fact' },
      el('span', { className: 'grk-page-usage-fact-label' }, t('page.usagePrepaid')),
      el('span', { className: 'grk-page-usage-fact-value' }, formatUsd(prepaid, locale))));
  }
  if (periodEnd !== null && periodEnd > now) {
    facts.push(el('div', { key: 'reset', className: 'grk-page-usage-fact' },
      el('span', { className: 'grk-page-usage-fact-label' }, t('page.usageResetsIn')),
      el('span', { className: 'grk-page-usage-fact-value' }, formatCountdown(periodEnd - now, t))));
  }

  return el(Card, {
    className: 'grk-page-card',
    title: t('page.usageTitle'),
    actions: badges.length > 0 ? el('span', { className: 'grk-page-inline' }, badges) : null,
  }, el('div', { className: 'grk-page-usage' },
    el(CreditRing, {
      usedPercent,
      remainingText: formatPercentValue(remainingPercent, locale),
      label: t('page.usageRingLabel', {
        used: formatPercentValue(usedPercent, locale),
        remaining: formatPercentValue(remainingPercent, locale),
      }),
    }),
    el('div', { className: 'grk-page-usage-side' }, facts)));
}

/**
 * Usage history card: the billing per-cycle USD table.
 * @param props - `t`, `locale`, `billing`.
 * @returns the card element.
 */
export function HistoryCard(props) {
  const { t, locale, billing } = props ?? {};
  const history = billing !== null && typeof billing === 'object' && Array.isArray(billing.history)
    ? billing.history.filter((entry) => entry !== null && typeof entry === 'object')
    : [];
  if (history.length === 0) {
    return el(Card, { className: 'grk-page-card', title: t('page.historyTitle') },
      el(EmptyState, {
        icon: 'chart',
        title: t('page.historyEmpty'),
        body: t('page.historyEmptyBody'),
      }));
  }
  return el(Card, { className: 'grk-page-card', title: t('page.historyTitle') },
    el('div', { className: 'grk-page-history grk-scroll' },
      el('table', { className: 'grk-page-history-table' },
        el('thead', null,
          el('tr', null,
            el('th', { scope: 'col' }, t('page.historyCycle')),
            el('th', { scope: 'col' }, t('page.historyIncluded')),
            el('th', { scope: 'col' }, t('page.historyOnDemand')),
            el('th', { scope: 'col' }, t('page.historyTotal')))),
        el('tbody', null,
          history.map((entry, index) => el('tr', { key: `${entry.billingCycle ?? index}-${index}` },
            el('td', { className: 'grk-page-history-cycle' },
              typeof entry.billingCycle === 'string' && entry.billingCycle !== '' ? entry.billingCycle : '—'),
            el('td', null, formatUsd(entry.includedUsedUsd, locale)),
            el('td', null, formatUsd(entry.onDemandUsedUsd, locale)),
            el('td', { className: 'grk-page-history-total' }, formatUsd(entry.totalUsedUsd, locale))))))));
}

/**
 * Auto-top-up rule card; renders nothing when the account has no rule.
 * @param props - `t`, `locale`, `topup`.
 * @returns the card element, or null.
 */
export function TopupCard(props) {
  const { t, locale, topup } = props ?? {};
  if (topup === null || topup === undefined || typeof topup !== 'object') {
    return null;
  }
  const rows = [
    { label: t('page.topupEnabled'), value: topup.enabled === true ? t('page.topupOn') : t('page.topupOff') },
    ...(isNumber(topup.minBeforeHittingSlUsd)
      ? [{ label: t('page.topupMinBefore'), value: formatUsd(topup.minBeforeHittingSlUsd, locale) }]
      : []),
    ...(isNumber(topup.topupAmountUsd)
      ? [{ label: t('page.topupAmount'), value: formatUsd(topup.topupAmountUsd, locale) }]
      : []),
    ...(isNumber(topup.maxAmountPerMonthUsd)
      ? [{ label: t('page.topupMonthlyCap'), value: formatUsd(topup.maxAmountPerMonthUsd, locale) }]
      : []),
  ];
  return el(Card, {
    className: 'grk-page-card',
    title: t('page.topupTitle'),
    actions: el(Badge, { tone: topup.enabled === true ? 'success' : 'idle' },
      topup.enabled === true ? t('page.topupOn') : t('page.topupOff')),
  }, el('div', { className: 'grk-page-stack' },
    el(KeyValue, { rows }),
    el('div', { className: 'grk-page-inline' },
      el('span', { className: 'grk-page-spacer' }),
      el(Button, {
        variant: 'ghost',
        size: 'sm',
        onClick: () => openExternal(SUPERGROK_URL),
      }, el(Icon, { name: 'external', size: 14 }), t('page.openConsole')))));
}
