/**
 * Dedicated Grok usage page: the main panel behind the plugin's sidebar
 * icon.
 *
 * The page is a root-scope slot component. It renders without any session
 * binding, reads everything from the singleton store through the shared hooks,
 * and loads its own data once per login change. Every section is defensive: a
 * missing payload renders a state instead of throwing, so a partially loaded
 * account never blanks the panel.
 */
import { rt } from './runtime.js';
import { state } from './state.js';
import { useLocalized, useNow, useSnapshot } from './hooks.js';
import { Icon, Notice, Button } from './ui.js';
import { formatRelative } from './format.js';
import { SettingsCard } from './page-settings.js';
import {
  AccountCard,
  HistoryCard,
  LoginCard,
  TopupCard,
  UsageCard,
} from './page-sections.js';
import { attempt, cls, errorTextOf, isNumber } from './page-helpers.js';

export { pageCss } from './page-css.js';
export { pageDicts } from './page-dicts.js';

/** Element factory routed through the runtime binding. */
function el(type, props, ...children) {
  const h = rt.h;
  return typeof h === 'function' ? h(type, props, ...children) : null;
}

/**
 * Page header: title, subtitle, login identity, refresh action, and freshness.
 * @param props - `t`, `login`, `lastUpdated`, `now`, `stale`, `busy`, `onRefresh`.
 * @returns the header element.
 */
function PageHeader(props) {
  const {
    t, login, lastUpdated, now, stale = false, busy = false, onRefresh,
  } = props ?? {};
  const updated = isNumber(lastUpdated)
    ? attempt(() => formatRelative(lastUpdated, t, now), '')
    : '';
  const hasUpdated = typeof updated === 'string' && updated.length > 0;
  const email = login !== null && typeof login === 'object' && typeof login.email === 'string' ? login.email : null;
  return el('header', { className: 'grk-page-header' },
    el('div', { className: 'grk-page-heading' },
      el('h1', { className: 'grk-page-title' }, t('page.title')),
      el('p', { className: 'grk-page-subtitle' }, t('page.subtitle'))),
    el('div', { className: 'grk-page-header-side' },
      el('div', { className: 'grk-page-account' },
        el('span', { className: 'grk-page-avatar' },
          el('span', { className: 'grk-page-avatar-initials' }, el(Icon, { name: 'user', size: 13 }))),
        el('span', { className: 'grk-page-account-text' },
          el('span', { className: 'grk-page-account-name' },
            email !== null ? email : t('page.signedOut')))),
      el('div', { className: 'grk-page-inline' },
        el(Button, {
          variant: 'ghost',
          size: 'sm',
          busy,
          onClick: typeof onRefresh === 'function' ? onRefresh : undefined,
          title: t('page.refreshAria'),
        }, el(Icon, { name: 'refresh', size: 14 }), t('page.refresh')),
        hasUpdated
          ? el('span', { className: 'grk-page-meta' }, t('page.lastUpdated', { time: updated }))
          : null,
        stale === true
          ? el('span', { className: cls('grk-page-meta', 'grk-page-meta-warn') }, t('page.stale'))
          : null)));
}

/**
 * Dedicated Grok usage page.
 * @param props - slot props: `t` (locale translate) and the standard kit.
 * @returns the page element.
 */
export function GrokUsagePage(props) {
  const { t: tProp } = props ?? {};
  const React = rt.React;
  const snapshot = useSnapshot();
  const localized = useLocalized();
  const now = useNow(30_000);
  const t = typeof tProp === 'function' ? tProp : localized.t;
  const locale = localized !== null && localized !== undefined && localized.locale === 'zh' ? 'zh' : 'en';

  const loadKeyRef = React.useRef(false);

  const snap = snapshot !== null && snapshot !== undefined && typeof snapshot === 'object' ? snapshot : {};
  const config = snap.config !== null && snap.config !== undefined ? snap.config : null;
  const overview = snap.overview !== null && snap.overview !== undefined ? snap.overview : null;
  const loggedIn = snap.loggedIn === true;
  const login = snap.login !== null && snap.login !== undefined ? snap.login : null;
  const flow = snap.flow !== null && snap.flow !== undefined && typeof snap.flow === 'object'
    ? snap.flow
    : { state: 'idle' };
  const loading = snap.loading !== null && snap.loading !== undefined && typeof snap.loading === 'object'
    ? snap.loading
    : {};
  const user = overview !== null && overview.user !== null && overview.user !== undefined ? overview.user : null;
  const billing = overview !== null && overview.billing !== null && overview.billing !== undefined
    ? overview.billing
    : null;
  const topup = overview !== null ? overview.topup : null;
  const generatedAt = overview !== null && isNumber(overview.generatedAt) ? overview.generatedAt : null;
  const lastUpdated = isNumber(snap.lastUpdated) ? snap.lastUpdated : generatedAt;

  // Load what the page needs once; the store caches and shares in-flight
  // requests, so repeated mounts never duplicate work.
  React.useEffect(() => {
    void state.refreshOverview({ force: false });
  }, []);

  // Refresh once when a sign-in completes while the page stays mounted.
  React.useEffect(() => {
    if (loggedIn !== true || loadKeyRef.current === true) return;
    loadKeyRef.current = true;
    void state.refreshOverview({ force: true });
  }, [loggedIn]);
  React.useEffect(() => {
    if (loggedIn === true) return;
    loadKeyRef.current = false;
  }, [loggedIn]);

  function refreshAll() {
    void state.refreshOverview({ force: true });
  }

  const columnChildren = [];
  columnChildren.push(el(PageHeader, {
    key: 'header',
    t,
    login,
    lastUpdated,
    now,
    stale: overview !== null && overview.stale === true,
    busy: loading.overview === true,
    onRefresh: refreshAll,
  }));

  if (overview !== null && overview.error !== null && overview.error !== undefined && loggedIn === true) {
    columnChildren.push(el(Notice, {
      key: 'overview-error',
      tone: 'error',
      title: t('page.errorTitle'),
      children: el('span', null, errorTextOf(overview.error, t)),
      action: el(Button, {
        variant: 'ghost',
        size: 'sm',
        onClick: refreshAll,
      }, t('page.retry')),
    }));
  }

  if (loggedIn !== true) {
    columnChildren.push(el(LoginCard, {
      key: 'login',
      t,
      flow,
      loginExpired: snap.loginExpired === true,
      loadingLogin: loading.login === true,
    }));
    columnChildren.push(el(SettingsCard, { key: 'settings', t, config }));
  } else {
    const sections = [];
    sections.push(el(AccountCard, {
      key: 'account',
      t,
      locale,
      now,
      login,
      user,
      billing,
    }));
    sections.push(el(UsageCard, {
      key: 'usage',
      t,
      locale,
      now,
      billing,
    }));
    sections.push(el(HistoryCard, {
      key: 'history',
      t,
      locale,
      billing,
    }));
    const topupCard = el(TopupCard, {
      key: 'topup',
      t,
      locale,
      topup,
    });
    if (topupCard !== null) sections.push(topupCard);
    sections.push(el(SettingsCard, { key: 'settings', t, config }));
    columnChildren.push(el('div', { key: 'sections', className: 'grk-page-sections' }, sections));
  }

  let column = null;
  try {
    column = el('div', { className: 'grk-page-column' }, columnChildren);
  } catch {
    column = el('div', { className: 'grk-page-column' },
      el(Notice, {
        tone: 'error',
        title: t('page.errorTitle'),
        children: el('span', null, t('page.errorUnknown')),
      }));
  }
  return el('div', { className: 'grk-page' }, column);
}

/**
 * Sidebar glyph of the usage page: the Grok mark (the two-stroke xAI glyph)
 * with a status dot. 16/18px target size, `currentColor` fill, no external
 * assets.
 * @param props - `size` in pixels (clamped 12..24), `active` selection flag.
 * @returns the sidebar icon element.
 */
export function PanelIcon(props) {
  const { size = 16, active = false } = props ?? {};
  const numeric = Number(size);
  const pixels = Number.isFinite(numeric) ? Math.max(12, Math.min(24, numeric)) : 16;
  const selected = active === true;
  return el('svg', {
    className: cls('grk-page-icon', selected ? 'is-active' : null),
    width: pixels,
    height: pixels,
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': 'true',
    focusable: 'false',
  },
  el('g', {
    fill: 'currentColor',
    fillRule: 'evenodd',
    opacity: selected ? 1 : 0.82,
    transform: 'translate(1.2 1.2) scale(0.78)',
  },
  el('path', { d: 'M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292' }),
  el('path', { d: 'M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815' })),
  el('circle', {
    cx: 19.6,
    cy: 19.4,
    r: 3.1,
    fill: selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-success-primary)',
  }));
}
