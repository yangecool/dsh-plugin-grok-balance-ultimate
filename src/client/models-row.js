/**
 * Models settings page integration for the Grok account.
 *
 * Two contributions live here:
 *  - `ModelsAccountRow` in `settings.models.footer`: an account row (status
 *    dot, sign-in state, email, expandable details, sign-out) beside the
 *    provider rows;
 *  - `GrokProviderNote` in `settings.models.provider-card` (keyed by the
 *    grok route's `llm-grok` settings namespace): one line inside the Grok
 *    provider card stating that the subscription sign-in covers inference and
 *    search, so no API key is needed.
 *
 * This module never touches credential values; sign-in state comes from the
 * singleton store.
 */
import { rt } from './runtime.js';
import { state } from './state.js';
import { useLocalized, useNow, useSnapshot } from './hooks.js';
import { Button, KeyValue, Notice, Spinner } from './ui.js';
import { countdown, formatDateTime } from './format.js';

/** Settings namespace of the grok LLM route (the Host module's default). */
const GROK_SETTINGS_NS = 'llm-grok';

/** createElement shorthand resolved at call time (React is bound after import). */
function el(type, props, ...children) {
  return rt.h(type, props, ...children);
}

/** True for a usable string. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Read a nested object safely. */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Epoch ms of an ISO/epoch value, else null. */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Status dot element with a tone class. */
function dot(tone) {
  return el('span', { className: `grk-models-dot grk-models-dot-${tone}`, 'aria-hidden': 'true' });
}

/** Open the account's dedicated usage page through the layout service. */
function openUsagePage() {
  try {
    const layout = rt.ctx?.get?.('layout');
    if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') {
      layout.selectPanel('grok-usage');
      return true;
    }
  } catch {
    /* the layout service is optional in unusual compositions */
  }
  return false;
}

/**
 * Account row for the Models settings page.
 * @param props - `t` from the slot locale face.
 * @returns the account row card.
 */
export function ModelsAccountRow(props) {
  const { t } = props ?? {};
  const snap = useSnapshot();
  const { locale } = useLocalized();
  const now = useNow(30_000);
  const [expanded, setExpanded] = rt.React.useState(false);
  const [confirmLogout, setConfirmLogout] = rt.React.useState(false);
  const [busy, setBusy] = rt.React.useState(false);
  const [failure, setFailure] = rt.React.useState(null);

  const config = record(snap?.config);
  if (config === null) return null;
  const login = record(snap?.login);
  const flow = record(snap?.flow);
  const loggedIn = snap?.loggedIn === true;
  const expired = snap?.loginExpired === true;
  const pending = flow?.state === 'pending' || flow?.state === 'starting';
  const email = text(login?.email) ? login.email : null;
  const statusTone = loggedIn ? 'success' : expired ? 'error' : 'idle';
  const statusLabel = loggedIn
    ? t('modelsRow.statusSignedIn')
    : expired
      ? t('modelsRow.statusExpired')
      : pending
        ? t('modelsRow.statusPending')
        : t('modelsRow.statusSignedOut');

  /**
   * Run one async account action with the shared busy/failure state.
   * @param action - operation returning `{ ok, error }`.
   */
  const run = (action) => {
    setBusy(true);
    setFailure(null);
    Promise.resolve(action())
      .then((result) => {
        if (result !== null && result !== undefined && result.ok === false) setFailure('error');
      })
      .catch(() => setFailure('error'))
      .finally(() => setBusy(false));
  };

  const onSignIn = () => {
    setBusy(true);
    setFailure(null);
    Promise.resolve(state.startLogin())
      .then((flowStart) => {
        const url = record(flowStart)
          ? (text(flowStart.verificationUriComplete) ? flowStart.verificationUriComplete : flowStart.verificationUri)
          : null;
        if (text(url)) {
          try {
            const opened = window.open(url, '_blank', 'noopener');
            if (opened === null) setFailure('popup');
          } catch {
            setFailure('popup');
          }
        } else {
          setFailure('error');
        }
      })
      .catch(() => setFailure('error'))
      .finally(() => setBusy(false));
  };
  const onLogout = () => run(async () => {
    const result = await state.logout();
    setExpanded(false);
    setConfirmLogout(false);
    return result;
  });
  const usageLink = () => {
    if (!openUsagePage()) setFailure('error');
  };

  /** Headline actions: edit for a signed-in account, sign-in otherwise. */
  const actions = loggedIn
    ? [
        el(Button, {
          key: 'edit',
          variant: 'subtle',
          size: 'sm',
          onClick: () => { setExpanded((value) => !value); setFailure(null); },
          'aria-expanded': expanded ? 'true' : 'false',
        }, t(expanded ? 'modelsRow.actionClose' : 'modelsRow.actionEdit')),
      ]
    : pending
      ? [
          el('span', { key: 'waiting', className: 'grk-models-pending' }, el(Spinner, { size: 12 }), t('modelsRow.statusPending')),
          el(Button, {
            key: 'cancel',
            variant: 'subtle',
            size: 'sm',
            onClick: () => { state.cancelLogin(); setFailure(null); },
          }, t('modelsRow.actionCancel')),
        ]
      : [
          el(Button, { key: 'login', variant: 'primary', size: 'sm', busy, onClick: onSignIn }, t('modelsRow.actionLogin')),
        ];

  const detailRows = [];
  if (loggedIn) {
    if (email !== null) detailRows.push({ label: t('modelsRow.labelEmail'), value: email });
    const loggedInAt = toMs(login?.loggedInAt);
    if (loggedInAt !== null) {
      detailRows.push({ label: t('modelsRow.labelSignedInAt'), value: formatDateTime(loggedInAt, locale) });
    }
    const expiresAt = toMs(login?.expiresAt);
    if (expiresAt !== null) {
      detailRows.push({
        label: t('modelsRow.labelExpiresAt'),
        value: el('span', { className: 'grk-models-expiry' },
          formatDateTime(expiresAt, locale),
          el('span', { className: 'grk-models-expiry-countdown' },
            expiresAt > now ? countdown(expiresAt, t, now) : t('modelsRow.expiredHint'))),
      });
    }
    detailRows.push({
      label: t('modelsRow.labelWebSearch'),
      value: el('span', { className: `grk-models-inference grk-models-inference-${config.webSearchEnabled !== false ? 'success' : 'idle'}` },
        dot(config.webSearchEnabled !== false ? 'success' : 'idle'),
        config.webSearchEnabled !== false
          ? t('modelsRow.webSearchOn', { model: text(config.searchModel) ? config.searchModel : 'grok-4.6' })
          : t('modelsRow.webSearchOff')),
    });
  }

  const authorizeUrl = pending && record(flow)
    ? (text(flow.verificationUriComplete) ? flow.verificationUriComplete : flow.verificationUri)
    : null;
  const flowCode = pending && record(flow) && text(flow.userCode) ? flow.userCode : null;
  const flowExpiresAt = pending ? toMs(flow?.expiresAt) : null;

  return el('div', { className: 'grk-models-row' },
    el('div', { className: 'grk-models-head' },
      el('span', { className: 'grk-models-glyph', 'aria-hidden': 'true' }, renderGlyph()),
      el('span', { className: 'grk-models-identity' },
        el('span', { className: 'grk-models-name' }, t('modelsRow.title')),
        el('span', { className: 'grk-models-tag' }, t('modelsRow.tag')),
        el('span', { className: `grk-models-status grk-models-status-${statusTone}` },
          dot(statusTone),
          statusLabel)),
      el('span', { className: 'grk-models-actions' }, actions)),
    pending && authorizeUrl !== null
      ? el('div', { className: 'grk-models-waiting' },
          flowCode !== null
            ? el('span', null, t('modelsRow.waitingHint'), ' ', el('code', { className: 'grk-models-code' }, flowCode))
            : el('span', null, t('modelsRow.waitingHint')),
          flowExpiresAt !== null
            ? el('span', null, t('modelsRow.codeExpires', { time: countdown(flowExpiresAt, t, now) }))
            : null,
          el('a', {
            className: 'grk-models-link',
            href: authorizeUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, t('modelsRow.actionOpenAuthorization')))
      : null,
    failure !== null
      ? el(Notice, { tone: failure === 'popup' ? 'warn' : 'error' }, t(failure === 'popup' ? 'modelsRow.popupBlocked' : 'modelsRow.errorGeneric'))
      : null,
    expanded && loggedIn
      ? el('div', { className: 'grk-models-details' },
          el(KeyValue, { rows: detailRows }),
          el('p', { className: 'grk-models-hint' }, t('modelsRow.hintNoKey')),
          el('div', { className: 'grk-models-detail-actions' },
            el(Button, { variant: 'subtle', size: 'sm', onClick: usageLink }, t('modelsRow.actionOpenUsage')),
            confirmLogout
              ? el('span', { className: 'grk-models-confirm' },
                  el('span', null, t('modelsRow.logoutConfirm')),
                  el(Button, { variant: 'subtle', size: 'sm', busy, onClick: onLogout }, t('modelsRow.actionConfirmLogout')),
                  el(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirmLogout(false) }, t('modelsRow.actionCancel')))
              : el(Button, { variant: 'subtle', size: 'sm', onClick: () => setConfirmLogout(true) }, t('modelsRow.actionLogout'))),
          el('p', { className: 'grk-models-hint grk-models-hint-muted' }, t('modelsRow.hintLogout')))
      : null);
}

/** Inline Grok spark mark used by the account row (currentColor for the body). */
function renderGlyph() {
  return el('svg', { viewBox: '0 0 20 20', width: 18, height: 18, fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    el('rect', { x: 1.2, y: 1.2, width: 17.6, height: 17.6, rx: 4.4, stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.75 }),
    el('path', {
      d: 'M10 5.2 L11.15 8.85 L14.8 10 L11.15 11.15 L10 14.8 L8.85 11.15 L5.2 10 L8.85 8.85 Z',
      fill: 'currentColor',
    }),
    el('circle', { cx: 15.5, cy: 15.2, r: 2.5, fill: 'var(--dsw-alias-state-success-primary)' }));
}

/**
 * One-line note rendered inside the Grok provider card.
 * @param props - `t`, plus the slot's owner props carrying the route entry.
 * @returns the note element, or null when the card is not the grok route.
 */
export function GrokProviderNote(props) {
  const { t, provider } = props ?? {};
  const snap = useSnapshot();
  const config = record(snap?.config);
  if (config === null) return null;
  const entry = record(provider);
  const providerId = text(entry?.provider) ? entry.provider : text(entry?.id) ? entry.id : '';
  // Gate on the route's own identity; other providers' cards stay untouched.
  if (providerId !== 'grok') return null;
  const loggedIn = snap?.loggedIn === true;
  return el('p', { className: 'grk-models-note' },
    dot(loggedIn ? 'success' : 'idle'),
    el('span', null, t('modelsRow.note')));
}

/** zh dictionary of the Models-page integration. */
const zh = {
  'modelsRow.title': 'Grok 账号',
  'modelsRow.tag': '订阅登录',
  'modelsRow.statusSignedIn': '已登录',
  'modelsRow.statusSignedOut': '未登录',
  'modelsRow.statusExpired': '登录已过期',
  'modelsRow.statusPending': '等待浏览器授权…',
  'modelsRow.actionEdit': '编辑',
  'modelsRow.actionClose': '收起',
  'modelsRow.actionLogin': '登录 Grok',
  'modelsRow.actionCancel': '取消',
  'modelsRow.actionOpenUsage': '打开用量页面',
  'modelsRow.actionLogout': '退出登录',
  'modelsRow.actionConfirmLogout': '确认退出',
  'modelsRow.actionOpenAuthorization': '打开授权页面',
  'modelsRow.labelEmail': '邮箱',
  'modelsRow.labelSignedInAt': '登录时间',
  'modelsRow.labelExpiresAt': '过期时间',
  'modelsRow.labelWebSearch': '网页搜索',
  'modelsRow.webSearchOn': '已启用（{model}）',
  'modelsRow.webSearchOff': '未启用',
  'modelsRow.expiredHint': '已过期',
  'modelsRow.waitingHint': '请在授权页面输入确认码：',
  'modelsRow.codeExpires': '确认码 {time}后过期',
  'modelsRow.logoutConfirm': '退出登录后模型请求将改用 API key（若有），确定？',
  'modelsRow.hintNoKey': '订阅登录即覆盖推理与搜索，无需 API key。',
  'modelsRow.hintLogout': '退出后可随时重新登录恢复。',
  'modelsRow.note': '订阅登录即覆盖推理与搜索，无需 API key。',
  'modelsRow.popupBlocked': '浏览器拦截了授权窗口，请使用上方授权链接或允许弹窗后重试。',
  'modelsRow.errorGeneric': '操作失败，请稍后重试。',
};

/** en dictionary of the Models-page integration. */
const en = {
  'modelsRow.title': 'Grok account',
  'modelsRow.tag': 'Subscription',
  'modelsRow.statusSignedIn': 'Signed in',
  'modelsRow.statusSignedOut': 'Not signed in',
  'modelsRow.statusExpired': 'Sign-in expired',
  'modelsRow.statusPending': 'Waiting for browser authorization…',
  'modelsRow.actionEdit': 'Edit',
  'modelsRow.actionClose': 'Close',
  'modelsRow.actionLogin': 'Sign in to Grok',
  'modelsRow.actionCancel': 'Cancel',
  'modelsRow.actionOpenUsage': 'Open usage page',
  'modelsRow.actionLogout': 'Sign out',
  'modelsRow.actionConfirmLogout': 'Confirm sign out',
  'modelsRow.actionOpenAuthorization': 'Open authorization page',
  'modelsRow.labelEmail': 'Email',
  'modelsRow.labelSignedInAt': 'Signed in',
  'modelsRow.labelExpiresAt': 'Expires',
  'modelsRow.labelWebSearch': 'Web search',
  'modelsRow.webSearchOn': 'Enabled ({model})',
  'modelsRow.webSearchOff': 'Disabled',
  'modelsRow.expiredHint': 'Expired',
  'modelsRow.waitingHint': 'Enter this confirmation code on the authorization page:',
  'modelsRow.codeExpires': 'Code expires in {time}',
  'modelsRow.logoutConfirm': 'After signing out, model requests fall back to an API key (if any). Continue?',
  'modelsRow.hintNoKey': 'The subscription sign-in covers inference and search; no API key is needed.',
  'modelsRow.hintLogout': 'You can sign in again any time to restore it.',
  'modelsRow.note': 'The subscription sign-in covers inference and search; no API key is needed.',
  'modelsRow.popupBlocked': 'The browser blocked the authorization window; use the authorization link above or allow pop-ups and retry.',
  'modelsRow.errorGeneric': 'The action failed; try again later.',
};

/** Dictionaries merged into the plugin locale namespace. */
export const modelsRowDicts = Object.freeze({ zh, en });

/** Stylesheet for the Models-page integration (theme tokens only). */
export const modelsRowCss = `
.grk-models-row{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;margin-top:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1))}
.grk-models-head{display:flex;align-items:center;gap:10px;min-width:0}
.grk-models-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.grk-models-identity{display:inline-flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.grk-models-name{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.grk-models-tag{flex:none;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-xs,4px);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.grk-models-status{display:inline-flex;flex:none;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.grk-models-status-success{color:var(--dsw-alias-state-success-primary)}
.grk-models-status-error{color:var(--dsw-alias-state-error-primary)}
.grk-models-status-idle{color:var(--dsw-alias-label-secondary)}
.grk-models-dot{box-sizing:border-box;display:inline-block;flex:none;width:8px;height:8px;border-radius:50%}
.grk-models-dot-success{background:var(--dsw-alias-state-success-primary)}
.grk-models-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.grk-models-dot-error{background:var(--dsw-alias-state-error-primary)}
.grk-models-dot-idle{background:var(--dsw-alias-state-idle-primary)}
.grk-models-actions{display:inline-flex;align-items:center;gap:8px;margin-left:auto;flex:none}
.grk-models-pending{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.grk-models-waiting{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.grk-models-code{padding:1px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-family:var(--dsw-font-family-mono,monospace);font-size:14px;letter-spacing:.08em;color:var(--dsw-alias-label-primary)}
.grk-models-link{color:var(--dsw-alias-link);text-decoration:none}
.grk-models-link:hover{text-decoration:underline}
.grk-models-details{display:flex;flex-direction:column;gap:10px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}
.grk-models-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.grk-models-hint-muted{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.grk-models-detail-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.grk-models-confirm{display:inline-flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-state-error-primary)}
.grk-models-expiry{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.grk-models-expiry-countdown{color:var(--dsw-alias-label-secondary);font-size:12px}
.grk-models-inference{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px}
.grk-models-inference-success{color:var(--dsw-alias-state-success-primary)}
.grk-models-inference-idle{color:var(--dsw-alias-label-secondary)}
.grk-models-note{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0;padding-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
@media (max-width:560px){
  .grk-models-row{padding:10px 12px}
  .grk-models-head{flex-wrap:wrap}
  .grk-models-actions{margin-left:0;flex-basis:100%;justify-content:flex-end}
}
`;
