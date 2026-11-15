/**
 * Configuration card of the dedicated Grok usage page.
 *
 * The card edits the plugin config through `state.saveConfig` and reports the
 * save outcome inline.
 */
import { rt } from './runtime.js';
import { state } from './state.js';
import { Button, Card, Icon } from './ui.js';
import { cls, parseRefreshMinutes } from './page-helpers.js';
import { openExternal, SUPERGROK_URL } from './page-links.js';

/** Element factory routed through the runtime binding. */
function el(type, props, ...children) {
  const h = rt.h;
  return typeof h === 'function' ? h(type, props, ...children) : null;
}

/** Read the value of a DOM input event without assuming the event shape. */
function eventValue(event) {
  if (event !== null && typeof event === 'object' && event.target !== null && typeof event.target === 'object') {
    return typeof event.target.value === 'string' ? event.target.value : '';
  }
  return '';
}

/** Read the checked state of a DOM change event without assuming the event shape. */
function eventChecked(event) {
  if (event !== null && typeof event === 'object' && event.target !== null && typeof event.target === 'object') {
    return event.target.checked === true;
  }
  return false;
}

/**
 * Plugin settings card: refresh interval, composer visibility while signed
 * out, the Grok web-search provider toggle, its search model, and a shortcut
 * to the usage console.
 * @param props - `t`, `config`.
 * @returns the card element.
 */
export function SettingsCard(props) {
  const { t, config } = props ?? {};
  const React = rt.React;
  const [refreshText, setRefreshText] = React.useState('30');
  const [showLoggedOut, setShowLoggedOut] = React.useState(false);
  const [webSearch, setWebSearch] = React.useState(true);
  const [searchModel, setSearchModel] = React.useState('');
  const [proxyUrl, setProxyUrl] = React.useState('');
  const [saveStatus, setSaveStatus] = React.useState('idle');
  const [refreshInvalid, setRefreshInvalid] = React.useState(false);

  React.useEffect(() => {
    if (config === null || config === undefined || typeof config !== 'object') {
      return;
    }
    setRefreshText(String(config.refreshMinutes ?? 30));
    setShowLoggedOut(config.showIndicatorWhenLoggedOut === true);
    setWebSearch(config.webSearchEnabled !== false);
    setSearchModel(typeof config.searchModel === 'string' ? config.searchModel : '');
    setProxyUrl(typeof config.proxyUrl === 'string' ? config.proxyUrl : '');
  }, [config]);

  React.useEffect(() => {
    if (saveStatus !== 'saved' && saveStatus !== 'failed') {
      return undefined;
    }
    const timer = setTimeout(() => setSaveStatus('idle'), 2600);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  async function save() {
    if (saveStatus === 'saving') return;
    const parsed = parseRefreshMinutes(refreshText);
    if (parsed.ok !== true) {
      setRefreshInvalid(true);
      return;
    }
    setRefreshInvalid(false);
    setSaveStatus('saving');
    try {
      const result = await state.saveConfig({
        refreshMinutes: parsed.value,
        showIndicatorWhenLoggedOut: showLoggedOut,
        webSearchEnabled: webSearch,
        ...(searchModel.trim() !== '' ? { searchModel: searchModel.trim() } : {}),
        proxyUrl: proxyUrl.trim(),
      });
      if (result !== null && typeof result === 'object' && result.ok === true) {
        setSaveStatus('saved');
        void state.refreshOverview({ force: true });
      } else {
        setSaveStatus('failed');
      }
    } catch {
      setSaveStatus('failed');
    }
  }

  if (config === null || config === undefined || typeof config !== 'object') {
    return el(Card, { className: 'grk-page-card', title: t('settings.title') },
      el('div', { className: 'grk-page-stack' },
        el('div', { className: 'grk-page-skeleton grk-page-skeleton-line' }),
        el('div', { className: 'grk-page-skeleton grk-page-skeleton-line is-short' }),
        el('span', { className: 'grk-page-field-hint' }, t('settings.loading'))));
  }

  const parsedRefresh = parseRefreshMinutes(refreshText);
  const dirty = parsedRefresh.ok !== true
    || parsedRefresh.value !== Number(config.refreshMinutes ?? 30)
    || showLoggedOut !== (config.showIndicatorWhenLoggedOut === true)
    || webSearch !== (config.webSearchEnabled !== false)
    || searchModel.trim() !== (typeof config.searchModel === 'string' ? config.searchModel : '')
    || proxyUrl.trim() !== (typeof config.proxyUrl === 'string' ? config.proxyUrl : '');

  let feedback = null;
  let feedbackClass = 'grk-page-save-feedback';
  if (saveStatus === 'saving') {
    feedback = t('settings.saving');
  } else if (saveStatus === 'saved') {
    feedback = t('settings.saved');
    feedbackClass = cls(feedbackClass, 'is-success');
  } else if (saveStatus === 'failed') {
    feedback = t('settings.saveFailed');
    feedbackClass = cls(feedbackClass, 'is-error');
  } else if (dirty) {
    feedback = t('settings.unsavedHint');
  }

  return el(Card, {
    className: 'grk-page-card',
    title: t('settings.title'),
  }, el('div', { className: 'grk-page-stack' },
    el('div', { className: 'grk-page-field' },
      el('span', { className: 'grk-page-field-label' }, t('settings.refreshLabel')),
      el('div', { className: 'grk-page-field-controls' },
        el('input', {
          className: 'grk-page-input is-narrow',
          type: 'number',
          min: 1,
          max: 1440,
          step: 1,
          value: refreshText,
          'aria-label': t('settings.refreshLabel'),
          onChange: (event) => {
            setRefreshText(eventValue(event));
            setRefreshInvalid(false);
            setSaveStatus('idle');
          },
        })),
      el('p', { className: 'grk-page-field-hint' }, t('settings.refreshHint')),
      refreshInvalid === true
        ? el('p', { className: 'grk-page-field-error' }, t('settings.invalidRefresh'))
        : null),
    el('div', { className: 'grk-page-field' },
      el('label', { className: 'grk-page-switch' },
        el('input', {
          type: 'checkbox',
          checked: showLoggedOut,
          onChange: (event) => {
            setShowLoggedOut(eventChecked(event));
            setSaveStatus('idle');
          },
          'aria-label': t('settings.showIndicatorLabel'),
        }),
        el('span', { className: 'grk-page-switch-track' },
          el('span', { className: 'grk-page-switch-thumb' })),
        el('span', null, t('settings.showIndicatorLabel'))),
      el('p', { className: 'grk-page-field-hint' }, t('settings.showIndicatorHint'))),
    el('div', { className: 'grk-page-field' },
      el('label', { className: 'grk-page-switch' },
        el('input', {
          type: 'checkbox',
          checked: webSearch,
          onChange: (event) => {
            setWebSearch(eventChecked(event));
            setSaveStatus('idle');
          },
          'aria-label': t('settings.webSearchLabel'),
        }),
        el('span', { className: 'grk-page-switch-track' },
          el('span', { className: 'grk-page-switch-thumb' })),
        el('span', null, t('settings.webSearchLabel'))),
      el('p', { className: 'grk-page-field-hint' }, t('settings.webSearchHint'))),
    el('div', { className: 'grk-page-field' },
      el('span', { className: 'grk-page-field-label' }, t('settings.searchModelLabel')),
      el('div', { className: 'grk-page-field-controls' },
        el('input', {
          className: 'grk-page-input',
          type: 'text',
          value: searchModel,
          spellCheck: 'false',
          autoComplete: 'off',
          placeholder: 'grok-4.6',
          'aria-label': t('settings.searchModelLabel'),
          onChange: (event) => {
            setSearchModel(eventValue(event));
            setSaveStatus('idle');
          },
        })),
      el('p', { className: 'grk-page-field-hint' }, t('settings.searchModelHint'))),
    el('div', { className: 'grk-page-field' },
      el('span', { className: 'grk-page-field-label' }, t('settings.proxyLabel')),
      el('div', { className: 'grk-page-field-controls' },
        el('input', {
          className: 'grk-page-input',
          type: 'text',
          value: proxyUrl,
          spellCheck: 'false',
          autoComplete: 'off',
          placeholder: 'http://127.0.0.1:7890',
          'aria-label': t('settings.proxyLabel'),
          onChange: (event) => {
            setProxyUrl(eventValue(event));
            setSaveStatus('idle');
          },
        })),
      el('p', { className: 'grk-page-field-hint' }, t('settings.proxyHint'))),
    el('div', { className: 'grk-page-form-actions' },
      el(Button, { variant: 'primary', size: 'sm', onClick: save, busy: saveStatus === 'saving' },
        t('settings.save')),
      feedback !== null ? el('span', { className: feedbackClass }, feedback) : null,
      el('span', { className: 'grk-page-spacer' }),
      el(Button, {
        variant: 'subtle',
        size: 'sm',
        onClick: () => openExternal(SUPERGROK_URL),
        title: t('page.openConsoleHint'),
      }, el(Icon, { name: 'external', size: 14 }), t('page.openConsole')))));
}
