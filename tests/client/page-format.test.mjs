/**
 * Unit tests for the usage page's pure formatting adapter: billing-period
 * progress, USD amounts, and subscription-tier labels.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatUsd,
  periodElapsedPercent,
  periodTypeLabel,
  tierLabel,
} from '../../src/client/page-format.js';
import { pageDicts } from '../../src/client/page-dicts.js';
import { interpolate } from '../../src/client/dicts-core.js';

/** Translate function over one page dictionary (mirrors the locale service). */
function makeT(locale = 'en') {
  const dict = pageDicts[locale];
  return (key, params) => interpolate(dict[key] === undefined ? key : dict[key], params);
}

test('periodElapsedPercent tracks elapsed time inside the billing period', () => {
  const base = 1_700_000_000_000;
  const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: base, end: base + 10_000 };
  assert.equal(periodElapsedPercent(period, base), 0);
  assert.equal(periodElapsedPercent(period, base + 5_000), 50);
  assert.equal(periodElapsedPercent(period, base + 10_000), 100);
  // Out-of-bounds instants clamp instead of reporting >100% or negatives.
  assert.equal(periodElapsedPercent(period, base - 1), 0);
  assert.equal(periodElapsedPercent(period, base + 99_999), 100);
});

test('periodElapsedPercent rejects unusable period bounds', () => {
  assert.equal(periodElapsedPercent(null, 1_000), null);
  assert.equal(periodElapsedPercent({}, 1_000), null);
  assert.equal(periodElapsedPercent({ start: 2_000, end: 1_000 }, 1_500), null, 'an inverted window is unusable');
  assert.equal(periodElapsedPercent({ start: 1_000, end: 2_000 }, Number.NaN), null);
  const base = 1_700_000_000_000;
  assert.equal(
    periodElapsedPercent({ start: base, end: new Date(base + 10_000).toISOString() }, base + 5_000),
    50,
    'ISO ends parse',
  );
});

test('periodTypeLabel maps known period types and passes the rest through', () => {
  const t = makeT('en');
  assert.equal(periodTypeLabel('USAGE_PERIOD_TYPE_WEEKLY', t), 'Weekly period');
  assert.equal(periodTypeLabel('USAGE_PERIOD_TYPE_MONTHLY', makeT('zh')), '月周期');
  assert.equal(periodTypeLabel('SOMETHING_ELSE', t), null);
  assert.equal(periodTypeLabel(null, t), null);
});

test('formatUsd renders the dollar sign and two fraction digits', () => {
  assert.equal(formatUsd(12.3, 'en'), '$12.30');
  assert.equal(formatUsd(0.005, 'en'), '$0.01');
  assert.equal(formatUsd(null, 'en'), '—');
  assert.equal(formatUsd('nope', 'en'), '—');
});

test('tierLabel maps known tiers and echoes unknown spellings unchanged', () => {
  const t = makeT('en');
  assert.equal(tierLabel('supergrok_heavy', t), 'SuperGrok Heavy');
  assert.equal(tierLabel('SUPERGROK_LIGHT', t), 'SuperGrok Light');
  assert.equal(tierLabel('heavy', makeT('zh')), 'Heavy');
  assert.equal(tierLabel('Mystery Tier', t), 'Mystery Tier');
  assert.equal(tierLabel(null, t), null);
  assert.equal(tierLabel('  ', t), null);
});
