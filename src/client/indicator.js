/**
 * Composer credit trigger and floating popover.
 *
 * The trigger lives in `conversation.input.right`, right beside the model
 * selector: one ring showing the REMAINING subscription credit (the ring's arc
 * is the remaining fraction of `creditUsagePercent`'s complement), a "Sign in"
 * chip while logged out, or a quiet warning dot when the credit cannot be
 * read. Clicking it opens a fixed-position popover rendered inline in the
 * trigger wrapper (never appended to `document.body`), anchored above the
 * trigger from its bounding rect and clamped to the viewport. Countdowns
 * re-render every 30 seconds.
 *
 * The widget renders only for Grok-model sessions (provider gate via the
 * per-session model directory) and, while signed out, only when the config's
 * `showIndicatorWhenLoggedOut` allows it.
 *
 * Everything here is written defensively: this component occupies a composer
 * slot, and a render-time exception would blank the composer row. All copy goes
 * through `t` from {@link indicatorDicts}; all colors go through
 * `--dsw-alias-*` theme tokens (never `--dsw-alias-brand-primary` as a data
 * fill).
 */

import { rt } from './runtime.js';
import { state } from './state.js';
import { useLocalized, useNow, useSnapshot } from './hooks.js';
import { countdown, formatPercent, formatRelative, formatUsd } from './format.js';
import { Bar, Button, EmptyState, Icon, IconButton, Notice, Spinner } from './ui.js';
import { SUPERGROK_URL } from './page-links.js';

/** Main panel key of the plugin's dedicated usage page (`main` slot). */
const PANEL_ID = 'grok-usage';

/** Countdown / relative-time cadence; matches the store ticker in entry.js. */
const TICK_MS = 30_000;

/** Minimum distance between the popover and any viewport edge. */
const VIEWPORT_MARGIN = 8;

/** Vertical distance between the trigger and the popover. */
const POPOVER_GAP = 8;

/** Nominal popover width; the actual width shrinks on narrow viewports. */
const POPOVER_WIDTH = 352;

/** Upper bound for the popover height (contract: `min(70vh, 520px)`). */
const POPOVER_MAX_HEIGHT = 520;

/** @returns {import('react').ReactElement} element built through the bound runtime. */
function h(...args) {
  return rt.h(...args);
}

/** Identity translate used only if a slot ever omits `t`; keeps render total. */
function passthroughTranslate(key) {
  return key;
}

/** @returns {boolean} whether `value` is a non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @returns {number|null} `value` when it is a finite number. */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @returns {number|null} `value` clamped to the 0..100 percentage range. */
function clampPercent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, number));
}

/**
 * Convert an upstream timestamp (epoch ms, epoch seconds, or an ISO/date
 * string) to epoch milliseconds.
 * @returns {number|null} epoch milliseconds, or null when unparseable.
 */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toMs(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Remaining credit percentage from the billing block. The upstream
 * `creditUsagePercent` is the USED share, so the remainder is its complement.
 * @returns {number|null} remaining percent, or null when unknown.
 */
function remainingPercentOf(overview) {
  const billing = isRecord(overview) && isRecord(overview.billing) ? overview.billing : null;
  if (billing === null || billing.error != null) return null;
  const used = clampPercent(billing.creditUsagePercent);
  if (used === null) return null;
  return clampPercent(100 - used);
}

/** @returns {'brand'|'warn'|'error'|'idle'} shared `Bar` tone for a remaining percentage. */
function toneOf(percent) {
  const value = clampPercent(percent);
  if (value === null) return 'idle';
  if (value < 5) return 'error';
  if (value < 20) return 'warn';
  return 'brand';
}

/** @returns {string} text color class for a remaining percentage. */
function textToneClass(percent) {
  const tone = toneOf(percent);
  if (tone === 'error') return ' grk-widget-text-error';
  if (tone === 'warn') return ' grk-widget-text-warn';
  return '';
}

/** @returns {string} remaining-percentage text (`72%`, `<1%`, or the dash placeholder). */
function percentText(percent, locale, t) {
  const value = clampPercent(percent);
  if (value === null) return t('widget.value.dash');
  if (value > 0 && value < 1) return t('widget.value.underOnePercent');
  return formatPercent(value, locale, 0);
}

/** @returns {number|null} epoch ms of the most recent successful refresh. */
function lastUpdatedMsOf(snapshot, overview) {
  const candidates = [
    isRecord(snapshot) ? snapshot.lastUpdated : null,
    isRecord(overview) ? overview.generatedAt : null,
  ];
  for (const candidate of candidates) {
    const ms = toMs(candidate);
    if (ms !== null) return ms;
  }
  return null;
}

/** @returns {string} localized "last updated" copy. */
function relativeUpdatedTextOf(lastUpdated, now, t) {
  if (lastUpdated === null) return t('widget.updated.never');
  const elapsed = Math.max(0, now - lastUpdated);
  if (elapsed < 60_000) return t('widget.updated.justNow');
  const relative = formatRelative(lastUpdated, t, now);
  if (typeof relative !== 'string' || relative === '') return t('widget.updated.never');
  return t('widget.updated', { time: relative });
}

/**
 * Call one store action without letting a missing method or a rejected promise
 * escape into the component tree.
 * @returns {Promise<unknown>} settled promise of the action result.
 */
function callState(method, ...args) {
  try {
    const target = state;
    const fn = target !== null && typeof target === 'object' && typeof target[method] === 'function'
      ? target[method]
      : null;
    if (fn === null) return Promise.resolve(undefined);
    return Promise.resolve(fn.apply(target, args)).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

/** Open an external URL in a new tab, tolerating blocked popups. */
function openExternal(url) {
  if (typeof url !== 'string' || url === '') return;
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* popup blocked: the caller keeps its other action available */
  }
}

/**
 * Start the device-code flow through the store, then open the authorization
 * page (the completion code renders in the usage page's login card).
 */
function requestSignIn() {
  try {
    const result = typeof state.startLogin === 'function' ? state.startLogin() : null;
    Promise.resolve(result).then((flow) => {
      const url = isRecord(flow)
        ? (flow.verificationUriComplete ?? flow.verificationUri)
        : null;
      if (typeof url === 'string' && url !== '') {
        openExternal(url);
      }
    }).catch(() => undefined);
  } catch {
    /* the store surfaces login failures through its own error state */
  }
}

/**
 * Panel-change subscription so the popover closes when the central panel
 * changes. Returns a no-op disposer when the layout service is unavailable.
 * @param onChange - callback invoked after a panel change is observed.
 * @returns {() => void} disposer.
 */
function subscribePanelChange(onChange) {
  let cleanup = null;
  try {
    const ctx = rt.ctx;
    const layout = ctx !== null && typeof ctx?.get === 'function' ? ctx.get('layout') : undefined;
    const observable = isRecord(layout) && layout.panelInfo !== null && typeof layout.panelInfo === 'object'
      ? layout.panelInfo
      : null;
    if (observable !== null && typeof observable.subscribe === 'function') {
      const read = () => {
        try {
          const info = typeof observable.getSnapshot === 'function' ? observable.getSnapshot() : null;
          return isRecord(info) ? (info.activePanelId ?? null) : null;
        } catch {
          return null;
        }
      };
      let last = read();
      const listener = () => {
        const next = read();
        if (next === last) return;
        last = next;
        onChange();
      };
      const unsubscribe = observable.subscribe(listener);
      cleanup = typeof unsubscribe === 'function' ? unsubscribe : null;
    }
  } catch {
    cleanup = null;
  }
  return () => {
    if (cleanup === null) return;
    try {
      cleanup();
    } catch {
      /* the layout service is already disposed */
    }
  };
}

/**
 * Track the current session's provider through the model directory service.
 * `available:false` means the service or session scope is unavailable, in which
 * case the provider gate must let the widget render.
 * @param sessionId - branded session id from the slot props.
 * @returns {{available: boolean, provider: string|null}} provider gate state.
 */
function useProviderGate(sessionId) {
  const React = rt.React;
  const [gate, setGate] = React.useState({ available: false, provider: null });
  React.useEffect(() => {
    let active = true;
    let unsubscribe = null;
    let store = null;
    try {
      const ctx = rt.ctx;
      const models = ctx !== null && typeof ctx?.get === 'function' ? ctx.get('modelDirectories') : undefined;
      const directory = isRecord(models) && typeof models.directoryFor === 'function' && sessionId !== undefined
        ? models.directoryFor(sessionId)
        : null;
      store = isRecord(directory) && isRecord(directory.store) ? directory.store : null;
    } catch {
      store = null;
    }
    if (store !== null && typeof store.getSnapshot === 'function') {
      const read = () => {
        if (!active) return;
        let provider = null;
        try {
          const directoryState = store.getSnapshot();
          if (isRecord(directoryState) && isRecord(directoryState.current)
            && typeof directoryState.current.provider === 'string') {
            provider = directoryState.current.provider;
          }
        } catch {
          provider = null;
        }
        setGate({ available: true, provider });
      };
      try {
        read();
        if (typeof store.subscribe === 'function') {
          const result = store.subscribe(read);
          unsubscribe = typeof result === 'function' ? result : null;
        }
      } catch {
        setGate({ available: false, provider: null });
      }
    } else {
      setGate({ available: false, provider: null });
    }
    return () => {
      active = false;
      if (unsubscribe === null) return;
      try {
        unsubscribe();
      } catch {
        /* the per-session directory is already disposed */
      }
    };
  }, [sessionId]);
  return gate;
}

/**
 * Apply the Grok provider gate to the live provider.
 * @returns {boolean} whether the widget may render for this session.
 */
function providerAllowed(gate) {
  // The widget is Grok-only: an unavailable directory service keeps the widget
  // visible (a missing service must not hide an otherwise-working plugin), but
  // a known non-grok provider hides it.
  if (!isRecord(gate) || gate.available !== true) return true;
  if (typeof gate.provider !== 'string' || gate.provider === '') return true;
  return gate.provider === 'grok';
}

/* ------------------------------------------------------------------ */
/* Widget sections that compose the shared primitives and add the      */
/* composer-specific layout (trigger ring, stat cells).                */
/* ------------------------------------------------------------------ */

/** @returns {import('react').ReactElement} warning dot used for quiet error affordances. */
function WarningDot() {
  return h('span', { className: 'grk-widget-dot', 'aria-hidden': 'true' });
}

/** @returns {import('react').ReactElement} loading placeholder lines. */
function Skeleton({ lines = 3 }) {
  const children = [];
  for (let index = 0; index < lines; index += 1) {
    children.push(h('span', { key: index, className: 'grk-widget-skeleton-line' }));
  }
  return h('div', { className: 'grk-widget-skeleton', 'aria-hidden': 'true' }, children);
}

/** @returns {import('react').ReactElement} inline error notice with its retry action. */
function ErrorNotice({ t, onRetry, stale }) {
  return h(Notice, {
    tone: 'error',
    title: t('widget.state.error'),
    action: h(Button, { size: 'sm', variant: 'subtle', onClick: onRetry }, t('widget.action.retry')),
  }, stale ? t('widget.state.stale') : null);
}

/** @returns {import('react').ReactElement} inline stale-data hint. */
function StaleHint({ t }) {
  return h('div', { className: 'grk-widget-stale', role: 'status' },
    h(Icon, { name: 'warning', size: 12 }),
    h('span', null, t('widget.state.stale')),
  );
}

/** @returns {import('react').ReactElement} sign-in notice for logged-out and expired sessions. */
function SignInNotice({ t, loginExpired, flow, onSignIn }) {
  const flowState = isRecord(flow) && typeof flow.state === 'string' ? flow.state : 'idle';
  const pending = !loginExpired && (flowState === 'starting' || flowState === 'pending');
  const failed = !loginExpired && flowState === 'error';
  const message = loginExpired
    ? t('widget.login.expired')
    : pending
      ? t('widget.login.pending')
      : failed
        ? t('widget.login.failed')
        : t('widget.login.loggedOut');
  let action = null;
  if (!pending) {
    action = h(Button, {
      size: 'sm',
      variant: 'primary',
      onClick: onSignIn,
    }, loginExpired || failed ? t('widget.action.relogin') : t('widget.action.signIn'));
  }
  return h(Notice, {
    tone: loginExpired || failed ? 'warn' : 'info',
    title: message,
    action,
  });
}

/** @returns {import('react').ReactElement} one quick-stat cell. */
function StatCell({ label, value }) {
  return h('div', { className: 'grk-widget-stat' },
    h('span', { className: 'grk-stat-label' }, label),
    h('span', { className: 'grk-stat-value grk-widget-stat-value' }, value),
  );
}

/**
 * Credit section of the popover: the remaining-percentage headline with its
 * bar, the current period with its reset countdown, and the prepaid balance.
 * @returns {import('react').ReactElement} the credit section.
 */
function CreditSection({ t, locale, overview, now }) {
  const billing = isRecord(overview) && isRecord(overview.billing) ? overview.billing : null;
  if (billing === null || billing.error != null) {
    return h('div', { className: 'grk-widget-empty' },
      h('span', { className: 'grk-widget-empty-hint' }, t('widget.credit.none')),
    );
  }
  const remaining = remainingPercentOf(overview);
  const prepaid = finiteNumber(billing.prepaidBalanceUsd);
  const periodEnd = toMs(billing.currentPeriod?.end);
  const cells = [
    h(StatCell, {
      key: 'remaining',
      label: t('widget.credit.remaining'),
      value: percentText(remaining, locale, t),
    }),
  ];
  if (periodEnd !== null) {
    cells.push(h(StatCell, {
      key: 'reset',
      label: t('widget.credit.resets'),
      value: periodEnd > now ? countdown(periodEnd, t, now) : t('time.resetDue'),
    }));
  }
  if (prepaid !== null) {
    cells.push(h(StatCell, {
      key: 'prepaid',
      label: t('widget.credit.prepaid'),
      value: formatUsd(prepaid, locale),
    }));
  }
  return h('div', { className: 'grk-widget-section' },
    h('div', { className: 'grk-widget-credit-head' },
      h('span', { className: `grk-widget-credit-pct${textToneClass(remaining)}` },
        percentText(remaining, locale, t)),
      h('span', { className: 'grk-widget-credit-caption' }, t('widget.credit.remainingCaption'))),
    h(Bar, {
      percent: remaining ?? 0,
      tone: toneOf(remaining),
      height: 6,
      label: t('widget.credit.barLabel', { percent: percentText(remaining, locale, t) }),
    }),
    h('div', { className: 'grk-widget-stats' }, cells));
}

/** @returns {import('react').ReactElement} popover header with the account title and controls. */
function PopoverHeader({ t, title, busy, onRefresh, onClose }) {
  return h('div', { className: 'grk-widget-pop-head' },
    h('div', { className: 'grk-widget-pop-titles' },
      h('span', { className: 'grk-widget-plan', title }, title),
      h('span', { className: 'grk-widget-sub' }, t('widget.subtitle')),
    ),
    h('div', { className: 'grk-widget-pop-actions' },
      h(IconButton, {
        label: t('widget.action.refresh'),
        onClick: onRefresh,
        disabled: busy === true,
        icon: h(Icon, { name: 'refresh', size: 16, className: busy === true ? 'grk-widget-spin' : undefined }),
      }),
      h(IconButton, {
        label: t('widget.action.close'),
        onClick: onClose,
        icon: h(Icon, { name: 'close', size: 16 }),
      }),
    ),
  );
}

/** @returns {import('react').ReactElement} popover footer with freshness and navigation. */
function PopoverFooter({ t, now, lastUpdated, onViewStats }) {
  return h('div', { className: 'grk-widget-pop-foot' },
    h('span', { className: 'grk-widget-updated' }, relativeUpdatedTextOf(lastUpdated, now, t)),
    h('div', { className: 'grk-widget-foot-row' },
      h(Button, { size: 'sm', variant: 'subtle', onClick: onViewStats }, t('widget.action.viewStats')),
      h('a', {
        className: 'grk-widget-link',
        href: SUPERGROK_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      t('widget.action.openSupergrok'),
      h(Icon, { name: 'external', size: 12 })),
    ),
  );
}

/**
 * Compute the fixed-position placement of the popover from the trigger rect.
 * Opens above the trigger, flipping below only when there is no usable space
 * above, and clamps every edge to the viewport margin.
 * @param trigger - the trigger button element.
 * @returns {object|null} inline `position: fixed` style, or null when unmeasurable.
 */
function measurePosition(trigger) {
  try {
    if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return null;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0
      ? window.innerWidth
      : 1024;
    const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' && window.innerHeight > 0
      ? window.innerHeight
      : 768;
    const width = Math.max(280, Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2));
    let left = rect.right - width;
    left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN));
    const aboveSpace = rect.top - POPOVER_GAP - VIEWPORT_MARGIN;
    const belowSpace = viewportHeight - rect.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
    const openUp = aboveSpace >= 200 || aboveSpace >= belowSpace;
    const available = Math.max(0, openUp ? aboveSpace : belowSpace);
    const maxHeight = Math.max(120, Math.min(viewportHeight * 0.7, POPOVER_MAX_HEIGHT, available));
    const maxEdge = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN);
    if (openUp) {
      const bottom = Math.min(Math.max(viewportHeight - rect.top + POPOVER_GAP, VIEWPORT_MARGIN), maxEdge);
      return { left, width, maxHeight, bottom };
    }
    const top = Math.min(Math.max(rect.bottom + POPOVER_GAP, VIEWPORT_MARGIN), maxEdge);
    return { left, width, maxHeight, top };
  } catch {
    return null;
  }
}

/**
 * Compare two measured placements so scroll-driven updates only re-render on a
 * real change.
 * @returns {boolean} whether both placements describe the same box.
 */
function samePosition(previous, next) {
  if (previous === null || next === null) return previous === next;
  return previous.left === next.left
    && previous.width === next.width
    && previous.maxHeight === next.maxHeight
    && previous.bottom === next.bottom
    && previous.top === next.top;
}

/**
 * Floating credit popover. Mounted only while open; every listener and
 * observer it adds is removed on unmount.
 * @param props - `t`, store `snapshot`, trigger/root refs, close callback.
 * @returns {import('react').ReactElement} the fixed-position popover.
 */
function WidgetPopover({ t, snapshot, triggerRef, rootRef, onClose, locale }) {
  const React = rt.React;
  // Measured in a layout effect: during the first render the trigger ref is not
  // attached yet, and a render-time measurement would paint at the fallback
  // placement and jump once the observer fires.
  const [position, setPosition] = React.useState(null);
  const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;
  const nowValue = useNow(TICK_MS);
  const now = typeof nowValue === 'number' && Number.isFinite(nowValue) ? nowValue : Date.now();

  useLayoutEffect(() => {
    const update = () => {
      const next = measurePosition(triggerRef.current);
      setPosition((previous) => (samePosition(previous, next) ? previous : next));
    };
    update();
    try {
      window.addEventListener('resize', update);
      window.addEventListener('scroll', update, true);
    } catch {
      /* non-browser host */
    }
    let observer = null;
    try {
      if (typeof ResizeObserver === 'function' && triggerRef.current) {
        observer = new ResizeObserver(update);
        observer.observe(triggerRef.current);
      }
    } catch {
      observer = null;
    }
    return () => {
      try {
        window.removeEventListener('resize', update);
        window.removeEventListener('scroll', update, true);
      } catch {
        /* non-browser host */
      }
      try {
        if (observer !== null) observer.disconnect();
      } catch {
        /* observer already detached */
      }
    };
  }, [triggerRef]);

  React.useEffect(() => {
    const handlePointerDown = (event) => {
      let inside = false;
      try {
        inside = typeof rootRef?.current?.contains === 'function' && rootRef.current.contains(event.target);
      } catch {
        inside = false;
      }
      if (!inside) onClose();
    };
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      try {
        event.stopPropagation();
      } catch {
        /* ignore */
      }
      try {
        const trigger = triggerRef.current;
        if (trigger && typeof trigger.focus === 'function') trigger.focus({ preventScroll: true });
      } catch {
        /* focus restore is best effort */
      }
      onClose();
    };
    try {
      document.addEventListener('pointerdown', handlePointerDown, true);
      document.addEventListener('keydown', handleKeyDown, true);
    } catch {
      return undefined;
    }
    return () => {
      try {
        document.removeEventListener('pointerdown', handlePointerDown, true);
        document.removeEventListener('keydown', handleKeyDown, true);
      } catch {
        /* the document is already gone with the host page */
      }
    };
  }, [onClose, rootRef, triggerRef]);

  const overview = isRecord(snapshot.overview) ? snapshot.overview : null;
  const loggedIn = snapshot.loggedIn === true;
  const loginExpired = snapshot.loginExpired === true;
  const loading = isRecord(snapshot.loading) ? snapshot.loading : {};
  const busy = loading.overview === true;
  const user = overview !== null && isRecord(overview.user) ? overview.user : null;
  const email = user !== null && typeof user.email === 'string' && user.email !== '' ? user.email : null;
  const title = email !== null ? email : t('widget.title');
  const lastUpdated = lastUpdatedMsOf(snapshot, overview);
  const errorRecord = isRecord(snapshot.error) ? snapshot.error : (overview !== null && isRecord(overview.error) ? overview.error : null);
  const stale = overview !== null && overview.stale === true;

  const refresh = () => {
    void callState('refreshOverview', { force: true });
  };
  const viewStats = () => {
    try {
      const ctx = rt.ctx;
      const layout = ctx !== null && typeof ctx?.get === 'function' ? ctx.get('layout') : undefined;
      if (isRecord(layout) && typeof layout.selectPanel === 'function') {
        layout.selectPanel(PANEL_ID);
        onClose();
        return;
      }
    } catch {
      /* fall through to the external page */
    }
    openExternal(SUPERGROK_URL);
  };
  const signIn = () => {
    requestSignIn();
  };

  const body = [];
  if (!loggedIn || loginExpired) {
    body.push(h(SignInNotice, {
      key: 'sign-in',
      t,
      loginExpired,
      flow: snapshot.flow,
      onSignIn: signIn,
    }));
  } else if (busy && overview === null) {
    body.push(h(Skeleton, { key: 'skeleton', lines: 4 }));
  } else if (errorRecord !== null && overview === null) {
    body.push(h(ErrorNotice, { key: 'error', t, onRetry: refresh, stale: false }));
  } else if (overview === null || overview.error != null) {
    body.push(h(EmptyState, {
      key: 'empty',
      icon: 'gauge',
      title: t('widget.state.noData'),
      body: t('widget.state.noDataHint'),
      action: h(Button, { size: 'sm', variant: 'subtle', onClick: refresh }, t('widget.action.retry')),
    }));
  } else {
    if (errorRecord !== null) {
      body.push(h(ErrorNotice, { key: 'error', t, onRetry: refresh, stale }));
    } else if (stale) {
      body.push(h(StaleHint, { key: 'stale', t }));
    }
    body.push(h(CreditSection, { key: 'credit', t, locale, overview, now }));
  }

  // No placement yet (first layout effect has not run): render nothing rather
  // than flash the popover at a fallback position.
  if (position === null) return null;
  const style = position;
  return h('div', {
    className: 'grk-widget-popover',
    style,
    role: 'dialog',
    'aria-label': t('widget.dialog.label'),
    'data-grk-widget': 'popover',
  },
  h(PopoverHeader, {
    t,
    title,
    busy,
    onRefresh: refresh,
    onClose,
  }),
  h('div', { className: 'grk-widget-pop-body' }, body),
  h(PopoverFooter, {
    t,
    now,
    lastUpdated,
    onViewStats: viewStats,
  }),
  );
}

/**
 * Compact remaining-credit trigger for the composer tool row plus its popover.
 * @param props - slot props: localized `t` and the branded `sessionId`.
 * @returns {import('react').ReactElement|null} the trigger, or null when gated out.
 */
export function ComposerIndicator({ t: translate, sessionId }) {
  const React = rt.React;
  const t = typeof translate === 'function' ? translate : passthroughTranslate;
  const snapValue = useSnapshot();
  const snapshot = isRecord(snapValue) ? snapValue : {};
  const { locale } = useLocalized();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const gate = useProviderGate(sessionId);

  const config = isRecord(snapshot.config) ? snapshot.config : null;
  const loggedIn = snapshot.loggedIn === true;
  const loginExpired = snapshot.loginExpired === true;
  const showWhenLoggedOut = config !== null && config.showIndicatorWhenLoggedOut === true;
  const visible = config !== null
    && (loggedIn || loginExpired || showWhenLoggedOut)
    && providerAllowed(gate);

  const close = React.useCallback(() => {
    setOpen(false);
  }, []);
  const toggle = React.useCallback(() => {
    setOpen((value) => !value);
  }, []);

  const bootedRef = React.useRef(false);
  React.useEffect(() => {
    if (!visible || bootedRef.current) return;
    bootedRef.current = true;
    void callState('refreshOverview', { force: false });
  }, [visible]);

  React.useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  React.useEffect(() => {
    if (visible) return;
    setOpen(false);
  }, [visible]);

  React.useEffect(() => {
    if (!open) return undefined;
    return subscribePanelChange(close);
  }, [open, close]);

  const nowValue = useNow(TICK_MS);
  const now = typeof nowValue === 'number' && Number.isFinite(nowValue) ? nowValue : Date.now();

  if (!visible) return null;

  const overview = isRecord(snapshot.overview) ? snapshot.overview : null;
  const loading = isRecord(snapshot.loading) ? snapshot.loading : {};
  const title = triggerTitleOf({ t, overview, loggedIn, loginExpired, now, locale });
  const ariaLabel = loginExpired
    ? t('widget.trigger.expiredTooltip')
    : loggedIn
      ? t('widget.trigger.aria')
      : t('widget.trigger.loginTooltip');

  let content;
  if (!loggedIn || loginExpired) {
    content = h('span', { className: 'grk-widget-login-content' },
      loginExpired ? h(WarningDot, null) : null,
      h('span', { className: 'grk-widget-login-label' }, t('widget.trigger.login')),
    );
  } else if (loading.overview === true && overview === null) {
    content = h(Spinner, { size: 12 });
  } else {
    const remaining = remainingPercentOf(overview);
    if (remaining === null) {
      content = h('span', { className: 'grk-widget-unavailable' },
        h(WarningDot, null),
        h('span', { className: 'grk-widget-dash' }, t('widget.value.dash')),
      );
    } else {
      content = h('span', { className: 'grk-widget-rings' }, triggerRing(remaining));
    }
  }

  return h('div', { className: 'grk-widget-root', ref: rootRef },
    h('button', {
      type: 'button',
      ref: triggerRef,
      className: 'grk-widget-trigger',
      title,
      'aria-label': ariaLabel,
      'aria-haspopup': 'dialog',
      'aria-expanded': open ? 'true' : 'false',
      onClick: toggle,
      onMouseDown: (event) => {
        event.preventDefault();
      },
    }, content),
    open ? h(WidgetPopover, {
      t,
      snapshot,
      triggerRef,
      rootRef,
      onClose: close,
      locale,
    }) : null,
  );
}

/**
 * One trigger progress ring: a 16x16 inline SVG whose arc length is the
 * REMAINING credit fraction, with the remaining percentage centered inside.
 * The composer trigger is a `<button>`, so the glyph stays phrasing content.
 * @param percent - remaining percentage, or null when unknown.
 * @returns {import('react').ReactElement} trigger ring glyph.
 */
function triggerRing(percent) {
  const value = clampPercent(percent);
  const radius = 9.25;
  const circumference = 2 * Math.PI * radius;
  const fraction = value === null ? 0 : Math.min(100, Math.max(0, value)) / 100;
  // MUI CircularProgressWithLabel pattern: the rounded percentage sits centered
  // inside the ring; unknown credit keeps the glyph balanced with a dash.
  const label = value === null ? '\u2013' : String(Math.round(value));
  const toneClass = value === null ? '' : value < 5 ? ' is-critical' : value < 20 ? ' is-warning' : '';
  return h('svg', {
    className: `grk-widget-ring${toneClass}`,
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    focusable: 'false',
  },
  h('circle', { className: 'grk-widget-ring-track', cx: 12, cy: 12, r: radius }),
  h('circle', {
    className: 'grk-widget-ring-arc',
    cx: 12,
    cy: 12,
    r: radius,
    transform: 'rotate(-90 12 12)',
    strokeDasharray: `${(circumference * fraction).toFixed(2)} ${circumference.toFixed(2)}`,
  }),
  h('text', {
    className: 'grk-widget-ring-text',
    x: 12,
    y: 12,
    textAnchor: 'middle',
    dominantBaseline: 'central',
  }, label));
}

/** @returns {string} localized tooltip/aria-label for the trigger. */
function triggerTitleOf({ t, overview, loggedIn, loginExpired, now, locale }) {
  if (loginExpired) return t('widget.trigger.expiredTooltip');
  if (!loggedIn) return t('widget.trigger.loginTooltip');
  const remaining = remainingPercentOf(overview);
  if (remaining === null) return t('widget.trigger.unavailable');
  const remainingText = percentText(remaining, locale, t);
  const periodEnd = toMs(overview?.billing?.currentPeriod?.end);
  if (periodEnd === null) {
    return t('widget.trigger.tooltipNoReset', { remaining: remainingText });
  }
  const reset = periodEnd > now ? t('widget.trigger.resetIn', { time: countdown(periodEnd, t, now) }) : t('time.resetDue');
  return t('widget.trigger.tooltip', { remaining: remainingText, reset });
}

/** Locale dictionaries owned by this module. Flat keys, `widget.` prefix. */
export const indicatorDicts = {
  zh: {
    'widget.title': 'Grok 订阅',
    'widget.subtitle': '额度与余额',
    'widget.trigger.aria': '查看 Grok 订阅剩余额度',
    'widget.trigger.tooltip': 'Grok 订阅剩余 {remaining}。{reset}',
    'widget.trigger.tooltipNoReset': 'Grok 订阅剩余 {remaining}',
    'widget.trigger.resetIn': '{time}后重置',
    'widget.trigger.unavailable': '暂时无法获取额度信息',
    'widget.trigger.login': '登录',
    'widget.trigger.loginTooltip': '登录 Grok 查看订阅剩余额度',
    'widget.trigger.expiredTooltip': '登录已过期，重新登录后可查看额度',
    'widget.dialog.label': 'Grok 订阅剩余额度',
    'widget.action.refresh': '刷新',
    'widget.action.close': '关闭',
    'widget.action.retry': '重试',
    'widget.action.viewStats': '查看完整用量',
    'widget.action.openSupergrok': '打开 SuperGrok',
    'widget.action.signIn': '登录 Grok',
    'widget.action.relogin': '重新登录',
    'widget.credit.remaining': '剩余额度',
    'widget.credit.remainingCaption': '当前周期剩余订阅额度',
    'widget.credit.barLabel': '剩余 {percent}',
    'widget.credit.resets': '周期重置',
    'widget.credit.prepaid': '预付费余额',
    'widget.credit.none': '暂无额度数据',
    'widget.value.dash': '--',
    'widget.value.underOnePercent': '<1%',
    'widget.updated': '更新于 {time}',
    'widget.updated.justNow': '刚刚更新',
    'widget.updated.never': '尚未更新',
    'widget.state.error': '加载失败，请稍后重试',
    'widget.state.stale': '数据可能不是最新',
    'widget.state.noData': '暂无额度数据',
    'widget.state.noDataHint': '刷新或稍后重试，即可查看订阅额度。',
    'widget.login.loggedOut': '登录 Grok 后可查看订阅剩余额度',
    'widget.login.expired': '登录已过期，请重新登录',
    'widget.login.pending': '在浏览器中完成授权…',
    'widget.login.failed': '登录失败，请重试',
  },
  en: {
    'widget.title': 'Grok subscription',
    'widget.subtitle': 'Credit & balance',
    'widget.trigger.aria': 'View Grok subscription credit',
    'widget.trigger.tooltip': '{remaining} credit left on your Grok subscription. {reset}',
    'widget.trigger.tooltipNoReset': '{remaining} credit left on your Grok subscription',
    'widget.trigger.resetIn': 'Resets in {time}',
    'widget.trigger.unavailable': 'Credit unavailable right now',
    'widget.trigger.login': 'Sign in',
    'widget.trigger.loginTooltip': 'Sign in to view your Grok subscription credit',
    'widget.trigger.expiredTooltip': 'Sign-in expired. Sign in again to see your credit.',
    'widget.dialog.label': 'Grok subscription credit',
    'widget.action.refresh': 'Refresh',
    'widget.action.close': 'Close',
    'widget.action.retry': 'Retry',
    'widget.action.viewStats': 'View full usage',
    'widget.action.openSupergrok': 'Open SuperGrok',
    'widget.action.signIn': 'Sign in to Grok',
    'widget.action.relogin': 'Sign in again',
    'widget.credit.remaining': 'Credit left',
    'widget.credit.remainingCaption': 'Subscription credit left this period',
    'widget.credit.barLabel': '{percent} left',
    'widget.credit.resets': 'Period resets',
    'widget.credit.prepaid': 'Prepaid balance',
    'widget.credit.none': 'No credit data',
    'widget.value.dash': '--',
    'widget.value.underOnePercent': '<1%',
    'widget.updated': 'Updated {time}',
    'widget.updated.justNow': 'Updated just now',
    'widget.updated.never': 'Not updated yet',
    'widget.state.error': "Couldn't load data. Try again.",
    'widget.state.stale': 'Data may be out of date',
    'widget.state.noData': 'No credit data',
    'widget.state.noDataHint': 'Refresh or try again later to see your subscription credit.',
    'widget.login.loggedOut': 'Sign in to Grok to see your subscription credit',
    'widget.login.expired': 'Your sign-in expired. Sign in again.',
    'widget.login.pending': 'Finish signing in in your browser…',
    'widget.login.failed': 'Sign-in failed. Try again.',
  },
};

/** Stylesheet owned by this module; entry.js concatenates it into the plugin style tag. */
export const indicatorCss = `
.grk-widget-root {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.grk-widget-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  margin: 0;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

@media (hover: hover) {
  .grk-widget-trigger:hover {
    background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent);
    color: var(--dsw-alias-label-primary);
  }
}

.grk-widget-trigger[aria-expanded='true'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
  color: var(--dsw-alias-label-primary);
}

.grk-widget-trigger:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

.grk-widget-rings {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 1px;
}

.grk-widget-ring {
  display: block;
  width: 24px;
  height: 24px;
}

.grk-widget-ring-track {
  fill: none;
  stroke: color-mix(in srgb, var(--dsw-alias-label-secondary) 26%, transparent);
  stroke-width: 2.5px;
}

.grk-widget-ring-arc {
  fill: none;
  /* Data fill: --dsw-alias-brand-primary is the monochrome button color,
     never a data hue. */
  stroke: var(--dsw-alias-state-business-primary, var(--dsw-alias-link));
  stroke-width: 2.5px;
  stroke-linecap: round;
}

.grk-widget-ring.is-warning .grk-widget-ring-arc {
  stroke: var(--dsw-alias-state-warn-primary);
}

.grk-widget-ring.is-critical .grk-widget-ring-arc {
  stroke: var(--dsw-alias-state-error-primary);
}

.grk-widget-ring-text {
  fill: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 7.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.grk-widget-login-content {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 2px;
}

.grk-widget-login-label {
  font-size: 12px;
  line-height: 12px;
}

.grk-widget-unavailable {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.grk-widget-dash {
  font-size: 10px;
  line-height: 10px;
  letter-spacing: 0.04em;
}

.grk-widget-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-state-warn-primary);
}

.grk-widget-spin {
  animation: grk-widget-spin 900ms linear infinite;
}

@keyframes grk-widget-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .grk-widget-spin { animation-duration: 3s; }
}

/* The host's own menu recipe (see ui-schedule PickerPopover): the translucent
   --dsw-specific-menu fill with its backdrop blur adapts to light and dark
   themes, and the elevation triple (0.5px hairline stroke drawn inside the
   box-shadow, plus soft light) replaces a layout border. */
.grk-widget-popover {
  position: fixed;
  z-index: 2000;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 352px;
  max-width: calc(100vw - 16px);
  max-height: min(70vh, 520px);
  overflow: hidden;
  border: 0;
  border-radius: 16px;
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.45;
  animation: grk-widget-pop-in 120ms ease-out;
}

@keyframes grk-widget-pop-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .grk-widget-popover { animation: none; }
}

.grk-widget-pop-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.grk-widget-pop-titles {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.grk-widget-plan {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grk-widget-sub {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}

.grk-widget-pop-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}

.grk-widget-pop-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 12px 14px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.grk-widget-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.grk-widget-credit-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.grk-widget-credit-pct {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.grk-widget-credit-caption {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.grk-widget-text-warn {
  color: var(--dsw-alias-state-warn-primary);
}

.grk-widget-text-error {
  color: var(--dsw-alias-state-error-primary);
}

.grk-widget-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.grk-widget-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  /* Menu tile fill: blends with the popover's translucent surface in both
     themes, like the host's MenuGroup cards. */
  background: var(--dsw-alias-menu-group-header-fill);
}

.grk-widget-stat .grk-stat-label {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grk-widget-stat-value {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
}

.grk-widget-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-link);
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
}

.grk-widget-link:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
  border-radius: 4px;
}

@media (hover: hover) {
  .grk-widget-link:hover {
    text-decoration: underline;
  }
}

.grk-widget-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 0;
}

.grk-widget-empty-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.grk-widget-stale {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.grk-widget-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 0;
}

.grk-widget-skeleton-line {
  display: block;
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent);
  animation: grk-widget-pulse 1.4s ease-in-out infinite;
}

.grk-widget-skeleton-line:nth-child(2) { width: 78%; }
.grk-widget-skeleton-line:nth-child(3) { width: 58%; }
.grk-widget-skeleton-line:nth-child(4) { width: 84%; }

@keyframes grk-widget-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

@media (prefers-reduced-motion: reduce) {
  .grk-widget-skeleton-line { animation: none; }
}

.grk-widget-pop-foot {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

.grk-widget-updated {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.grk-widget-foot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
`;
