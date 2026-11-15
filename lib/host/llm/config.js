/**
 * Configuration for the direct, Grok Build-compatible model transport.
 *
 * One plugin instance owns exactly the `grok` provider route key; a generic
 * route would make two adapters compete for the same configuration shape.
 */

import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import {
  API_BASE_URL,
  BUILT_IN_MODELS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  GROK_MODALITIES,
  GROK_REASONING_EFFORTS,
  SUBSCRIPTION_BASE_URL,
} from './constants.js';

/**
 * Accept mixed-case effort spellings, matching Grok Build config parsing.
 * @param {string} value - configured effort spelling.
 * @returns the normalized effort.
 * @throws {z.ValidationError} for a value outside the effort vocabulary.
 */
function effortValue(value) {
  const normalized = value.toLowerCase();
  if (!GROK_REASONING_EFFORTS.includes(normalized)) {
    throw new z.ValidationError(`reasoning effort ${JSON.stringify(value)} is not one of ${GROK_REASONING_EFFORTS.join(', ')}`, {});
  }
  return normalized;
}

const effortProfile = z.object({
  low: z.const('low'),
  medium: z.const('medium'),
  high: z.const('high'),
  xhigh: z.const('xhigh'),
});

const modelProfile = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union([...GROK_MODALITIES])),
  reasoningEfforts: z.union([z.const(false), effortProfile]),
  reasoningSummary: z.union(['none', 'auto', 'concise', 'detailed']),
});

const providerProfile = z.object({
  authMode: z.union(['api-key', 'grok-subscription']).default('api-key'),
  apiKeyEnv: z.string().role('credential-ref'),
  displayName: z.string(),
  baseURL: z.string(),
  models: z.array(modelProfile),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultInput: z.array(z.union([...GROK_MODALITIES])).default([...GROK_MODALITIES]),
  headers: z.dict(z.string()),
  reasoning: z.transform(z.string(), effortValue).default('high'),
  timeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

/**
 * Runtime schema for the module's plugin configuration. `providers` is
 * volatile: live settings edits arrive through `config.providers.get()`
 * without remounting the plugin.
 */
export const Config = z.object({
  providers: z.dict(providerProfile).default({}).volatile(),
});

/** Reject a non-positive-integer capability field. */
function positiveInteger(value, field, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}: ${field} must be a positive integer`);
}

/** Reject a timer field outside Node's scheduling range. */
function timer(value, field, label) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${label}: ${field} must be positive and no greater than ${MAX_TIMER_DELAY_MS}`);
  }
}

/** Normalize and validate one absolute HTTP(S) base URL. */
function endpoint(value, label) {
  const normalized = value.replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label}: baseURL must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label}: baseURL must use HTTP or HTTPS`);
  }
  return normalized;
}

/**
 * Expand one model's declared effort set. An omitted or empty object means the
 * full vocabulary; `false` means the model does not reason.
 * @param {Record<string, string> | false | undefined} source - configured effort declarations.
 * @param {string} label - diagnostic owner for configuration errors.
 * @returns the ordered effort list.
 */
function resolveEfforts(source, label) {
  if (source === false) return [];
  if (source === undefined || Object.keys(source).length === 0) return [...GROK_REASONING_EFFORTS];
  const efforts = [];
  for (const effort of GROK_REASONING_EFFORTS) {
    const value = source[effort];
    if (value === undefined) continue;
    if (value !== effort) throw new Error(`${label}: reasoningEfforts.${effort} must map to "${effort}"`);
    efforts.push(effort);
  }
  return efforts;
}

/**
 * Resolve one route's model catalog. An omitted table adopts the built-in
 * grok-4.7 / grok-4.7-build-fast / grok-4.6 / grok-4.5 entries; declared
 * entries keep their exact spelling.
 * @param {object} source - configured provider profile.
 * @param {string} label - diagnostic owner for configuration errors.
 * @returns immutable resolved model entries.
 */
function resolveModels(source, label) {
  const defaultContextWindow = source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const defaultInput = source.defaultInput ?? [...GROK_MODALITIES];
  const declared = source.models === undefined || source.models.length === 0
    ? BUILT_IN_MODELS
    : source.models;
  const ids = new Set();
  return declared.map((model, index) => {
    const modelLabel = `${label}: model ${index}`;
    if (model.id.trim().length === 0) throw new Error(`${modelLabel} has an empty id`);
    if (ids.has(model.id)) throw new Error(`${label}: duplicate model id "${model.id}"`);
    ids.add(model.id);
    const contextWindow = model.contextWindow ?? defaultContextWindow;
    positiveInteger(contextWindow, 'contextWindow', modelLabel);
    if (model.maxTokens !== undefined) positiveInteger(model.maxTokens, 'maxTokens', modelLabel);
    // Schemastery materializes an omitted nested array as `[]`; at model level
    // that means "use the route fallback", not a textless model.
    const input = model.input === undefined || model.input.length === 0 ? defaultInput : model.input;
    return Object.freeze({
      id: model.id,
      name: model.name ?? model.id,
      ...(model.description === undefined ? {} : { description: model.description }),
      contextWindow,
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      input: Object.freeze([...input]),
      reasoningEfforts: Object.freeze(resolveEfforts(model.reasoningEfforts, modelLabel)),
      reasoningSummary: model.reasoningSummary ?? 'concise',
    });
  });
}

/**
 * Resolve the route retry policy, widening the normal default with
 * `STREAM_CLOSED`: a transport that dies before its terminal event is the one
 * transient failure this protocol can silently produce.
 * @param {object | undefined} source - configured retry policy.
 * @param {string} label - diagnostic owner for configuration errors.
 * @returns the immutable resolved policy.
 */
function resolveGrokRetryPolicy(source, label) {
  const policy = resolveRetryPolicy(source, label);
  if (policy.mode !== 'normal'
    || source !== undefined && source.mode === 'normal' && source.retryableCodes !== undefined) return policy;
  return Object.freeze({
    ...policy,
    retryableCodes: Object.freeze([...policy.retryableCodes, 'STREAM_CLOSED']),
  });
}

/**
 * Resolve and validate every route without importing a provider SDK or catalog.
 * @param {Readonly<Record<string, object>> | undefined} providers - route-keyed provider profiles from plugin configuration.
 * @param {string} [label] - diagnostic owner included in configuration errors.
 * @returns immutable resolved profiles keyed by provider id.
 */
export function resolveProfiles(providers, label = 'grok-model') {
  if (Array.isArray(providers)) throw new Error(`${label}: providers must be a route-keyed object`);
  const resolved = new Map();
  for (const [provider, source] of Object.entries(providers ?? {})) {
    const routeLabel = `${label}: provider "${provider}"`;
    if (provider !== 'grok') throw new Error(`${routeLabel} is unsupported; this plugin owns only "grok"`);
    if (source.displayName !== undefined && source.displayName.trim().length === 0) {
      throw new Error(`${routeLabel} has an empty displayName`);
    }
    const authMode = source.authMode ?? 'api-key';
    if (authMode === 'grok-subscription' && source.apiKeyEnv !== undefined) {
      throw new Error(`${routeLabel} must not set apiKeyEnv with grok-subscription auth`);
    }
    const defaultContextWindow = source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const defaultMaxTokens = source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    positiveInteger(defaultContextWindow, 'defaultContextWindow', routeLabel);
    positiveInteger(defaultMaxTokens, 'defaultMaxTokens', routeLabel);
    const defaultInput = source.defaultInput ?? [...GROK_MODALITIES];
    if (defaultInput.length === 0) throw new Error(`${routeLabel}: defaultInput must not be empty`);
    timer(source.timeoutMs, 'timeoutMs', routeLabel);
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    timer(streamIdleTimeoutMs, 'streamIdleTimeoutMs', routeLabel);
    const baseURL = endpoint(
      source.baseURL ?? (authMode === 'grok-subscription' ? SUBSCRIPTION_BASE_URL : API_BASE_URL),
      routeLabel,
    );
    resolved.set(provider, Object.freeze({
      provider,
      authMode,
      ...(authMode === 'api-key'
        ? { apiKeyEnv: credentialRef(source.apiKeyEnv ?? DEFAULT_API_KEY_ENV) }
        : {}),
      displayName: source.displayName ?? 'Grok',
      baseURL,
      models: Object.freeze(resolveModels(source, routeLabel)),
      defaultContextWindow,
      defaultMaxTokens,
      defaultInput: Object.freeze([...defaultInput]),
      headers: Object.freeze({ ...source.headers }),
      reasoning: source.reasoning ?? 'high',
      ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
      streamIdleTimeoutMs,
      retryPolicy: resolveGrokRetryPolicy(source.retryPolicy, `${routeLabel} retryPolicy`),
    }));
  }
  return resolved;
}

/**
 * Reject a plugin configuration that cannot serve its declared Grok route.
 * @param {{providers: {get(): object}}} config - plugin configuration to resolve.
 * @param {string} [label] - diagnostic owner included in configuration errors.
 */
export function assertServiceable(config, label = 'grok-model') {
  resolveProfiles(structuredClone(config.providers.get()), label);
}
