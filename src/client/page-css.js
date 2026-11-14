/**
 * Stylesheet of the dedicated Grok usage page.
 *
 * Every class is prefixed `.grk-page-`; every color comes from a
 * `--dsw-alias-*` theme token (optionally through `color-mix`) so light and
 * dark themes both work without any theme-specific rule. Space, radius, and
 * font sizes are literal because the theme exposes no tokens for them.
 */

export const pageCss = `
/* Root: one scroll container, one centered content column. */
.grk-page {
  display: block;
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.6;
}
.grk-page-column {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: 32px clamp(20px, 4vw, 48px) 64px;
  box-sizing: border-box;
}
.grk-page-column > * {
  flex: none;
  min-width: 0;
}

/* Header */
.grk-page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 24px;
}
.grk-page-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.grk-page-title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary);
}
.grk-page-subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.grk-page-header-side {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.grk-page-account {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  max-width: 100%;
  padding: 4px 12px 4px 5px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  box-sizing: border-box;
}
.grk-page-account-text {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  line-height: 1.3;
}
.grk-page-account-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.grk-page-avatar {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
}
.grk-page-avatar-initials {
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: var(--dsw-alias-label-secondary);
  text-transform: uppercase;
  user-select: none;
}
.grk-page-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.grk-page-meta-warn {
  color: var(--dsw-alias-state-warn-primary);
}

/* Card hosts: named classes only carry layout constraints, not chrome. */
.grk-page-card {
  min-width: 0;
}

/* Sidebar glyph root. */
.grk-page-icon {
  display: block;
  flex: none;
  overflow: visible;
}

/* Section scaffolding */
.grk-page-sections {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}
.grk-page-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  margin: 4px 0 -6px;
}
.grk-page-section-title {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.grk-page-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.grk-page-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.grk-page-spacer {
  flex: 1;
}

/* Sign-in card */
.grk-page-auth {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  min-width: 0;
}
.grk-page-auth-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.grk-page-auth-body {
  margin: 0;
  max-width: 58ch;
  font-size: 13px;
  line-height: 21px;
  color: var(--dsw-alias-label-secondary);
}
.grk-page-auth-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.grk-page-waiting {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}

/* Device confirmation code */
.grk-page-device-code {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  box-sizing: border-box;
}
.grk-page-device-code-value {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 28px;
  line-height: 36px;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: copy;
  overflow-wrap: anywhere;
}
.grk-page-device-code-value:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
  border-radius: 6px;
}

/* Billing period progress */
.grk-page-period {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.grk-page-period-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}
.grk-page-period-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.grk-page-period-countdown {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}

/* Credit ring */
.grk-page-usage {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 20px 28px;
  min-width: 0;
}
.grk-page-ring {
  flex: none;
  width: 132px;
  height: 132px;
}
.grk-page-ring-track {
  fill: none;
  stroke: color-mix(in srgb, var(--dsw-alias-label-secondary) 20%, transparent);
  stroke-width: 9;
}
.grk-page-ring-arc {
  fill: none;
  /* Data fill: --dsw-alias-brand-primary is the monochrome button color,
     never a data hue. */
  stroke: var(--dsw-alias-state-business-primary, var(--dsw-alias-link));
  stroke-width: 9;
  stroke-linecap: round;
  transition: stroke-dasharray 300ms ease;
}
.grk-page-ring.is-warning .grk-page-ring-arc {
  stroke: var(--dsw-alias-state-warn-primary);
}
.grk-page-ring.is-critical .grk-page-ring-arc {
  stroke: var(--dsw-alias-state-error-primary);
}
.grk-page-ring-value {
  fill: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.grk-page-usage-side {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 12px 20px;
  min-width: 200px;
}
.grk-page-usage-fact {
  display: flex;
  flex: 1 1 130px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  box-sizing: border-box;
}
.grk-page-usage-fact-label {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grk-page-usage-fact-value {
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.grk-page-usage-fact-value.is-warning {
  color: var(--dsw-alias-state-warn-primary);
}
.grk-page-usage-fact-value.is-critical {
  color: var(--dsw-alias-state-error-primary);
}

/* Usage history table */
.grk-page-history {
  min-width: 0;
  max-height: 320px;
  overflow: auto;
}
.grk-page-history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 20px;
}
.grk-page-history-table th {
  position: sticky;
  top: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  text-align: right;
  white-space: nowrap;
}
.grk-page-history-table th:first-child {
  text-align: left;
}
.grk-page-history-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.grk-page-history-table td:first-child {
  text-align: left;
  color: var(--dsw-alias-label-primary);
}
.grk-page-history-table tr:last-child td {
  border-bottom: none;
}
.grk-page-history-total {
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

/* Inline confirm row */
.grk-page-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  box-sizing: border-box;
}
.grk-page-confirm-text {
  flex: 1 1 220px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
}

/* Settings form */
.grk-page-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  min-width: 0;
}
.grk-page-field:first-of-type {
  padding-top: 0;
}
.grk-page-field:last-of-type {
  border-bottom: none;
  padding-bottom: 0;
}
.grk-page-field-label {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.grk-page-field-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.grk-page-field-hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.grk-page-field-error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
.grk-page-input {
  height: 32px;
  width: 240px;
  max-width: 100%;
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
.grk-page-input.is-narrow {
  width: 110px;
}
.grk-page-input:hover {
  border-color: var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);
}
.grk-page-input:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);
}
.grk-page-form-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-top: 14px;
}
.grk-page-save-feedback {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.grk-page-save-feedback.is-success {
  color: var(--dsw-alias-state-success-primary);
}
.grk-page-save-feedback.is-error {
  color: var(--dsw-alias-state-error-primary);
}

/* Switch */
.grk-page-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.grk-page-switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.grk-page-switch-track {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);
  transition: background 140ms ease;
}
.grk-page-switch-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);
  transition: transform 140ms ease;
}
.grk-page-switch input:checked + .grk-page-switch-track {
  background: var(--dsw-alias-brand-primary);
}
.grk-page-switch input:checked + .grk-page-switch-track .grk-page-switch-thumb {
  transform: translateX(14px);
}
.grk-page-switch input:focus-visible + .grk-page-switch-track {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
}

/* Loading skeletons */
.grk-page-skeleton {
  background: var(--dsw-alias-bg-skeleton);
  border-radius: 8px;
  animation: grk-page-pulse 1.6s ease-in-out infinite;
}
.grk-page-skeleton-line {
  height: 12px;
  width: 100%;
}
.grk-page-skeleton-line.is-short {
  width: 46%;
}
@keyframes grk-page-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

/* Narrow layouts */
@media (max-width: 720px) {
  .grk-page-column {
    padding: 24px 20px 48px;
  }
  .grk-page-history-table th:nth-child(3),
  .grk-page-history-table td:nth-child(3) {
    display: none;
  }
}
@media (max-width: 560px) {
  .grk-page-header {
    flex-direction: column;
    align-items: stretch;
  }
  .grk-page-header-side {
    justify-content: flex-start;
  }
  .grk-page-account-name {
    max-width: 160px;
  }
  .grk-page-usage {
    justify-content: center;
    text-align: center;
  }
  .grk-page-input {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .grk-page-skeleton {
    animation: none;
  }
  .grk-page-ring-arc,
  .grk-page-switch-track,
  .grk-page-switch-thumb {
    transition: none;
  }
}
`;
