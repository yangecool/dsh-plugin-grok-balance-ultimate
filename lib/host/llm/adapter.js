/**
 * Direct Grok Build-compatible Responses adapter with no model SDK.
 *
 * Not ported from the fork: `GrokLoopAttemptControl` (doom-loop injection,
 * transient-retry and fresh-HTTP/1.1 dispatch, image-strip retry), the
 * fork-private `purpose: 'permission-auto'` branch, and the undici proxy
 * transport (proxy.ts) — the external plugin sends through the injectable
 * `requestFetch` (default global fetch) instead of a transport-owned
 * dispatcher.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  attributionHeaders,
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm';
import { deadline, idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import {
  BACKEND_SEARCH_MODELS,
  GROK_AUTHENTICATE_RESPONSE,
  GROK_BUILD_CLIENT_VERSION,
  GROK_CLIENT_IDENTIFIER,
  GROK_TOKEN_AUTH,
  GROK_REASONING_EFFORTS,
  SUBSCRIPTION_PROXY_HOST,
} from './constants.js';
import { serializeGrokRequest } from './serialize.js';
import { parseGrokSse } from './sse.js';
import { translateGrokResponses } from './stream.js';

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const REQUEST_TIMEOUT_CODE = 'GROK_REQUEST_TIMEOUT';

/**
 * Lifecycle dependencies supplied by the owning module wiring.
 * @typedef {object} GrokAdapterOptions
 * @property {() => ReadonlyMap<string, object>} profiles - current immutable profiles; one map is captured before each operation's first await.
 * @property {(provider: string, profile: object) => Promise<string>} resolveApiKey - resolve the bearer/API key for the exact captured profile.
 * @property {() => import('@deepseek-ai/dsh-attachment').AttachmentStore | undefined} [resolveAttachments] - resolve durable image bytes when a request carries image content.
 * @property {() => readonly import('./serialize.js').GrokHostedToolSpec[]} [resolveHostedTools] - hosted Responses tools this deployment owns.
 * @property {() => string} resolveAgentId - stable native `$GROK_HOME/agent_id`, used only for subscription traffic.
 * @property {typeof globalThis.fetch} [requestFetch] - transport selected at module startup.
 */

/** Advertise one resolved model with the Harness's catalog fields. */
function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: [...model.input],
  };
}

/** Route-capability fallback for a model id the catalog does not list. */
function fallbackModel(profile, model) {
  return {
    id: model,
    name: model,
    contextWindow: profile.defaultContextWindow,
    input: profile.defaultInput,
    reasoningEfforts: GROK_REASONING_EFFORTS,
    reasoningSummary: 'concise',
  };
}

/** Case-insensitive lookup of one configured header. */
function configuredHeader(headers, wanted) {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === wanted.toLowerCase())?.[1];
}

/**
 * grok-build device identity headers for subscription traffic.
 * @param {Readonly<Record<string, string>>} headers - configured profile headers.
 * @returns the static identity header set.
 */
function grokBuildIdentityHeaders(headers) {
  const override = process.env.GROK_CLIENT_VERSION?.trim();
  const version = override === undefined || override.length === 0 ? GROK_BUILD_CLIENT_VERSION : override;
  const os = process.platform === 'darwin' ? 'macos' : process.platform;
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  const mode = configuredHeader(headers, 'x-grok-client-mode')?.trim().toLowerCase() === 'headless'
    ? 'headless'
    : 'interactive';
  return {
    'x-xai-token-auth': GROK_TOKEN_AUTH,
    'x-authenticateresponse': GROK_AUTHENTICATE_RESPONSE,
    'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
    'x-grok-client-version': version,
    'x-grok-client-mode': mode,
    'user-agent': `grok-shell/${version} (${os}; ${arch})`,
  };
}

/** One W3C trace-parent value for a single call. */
function traceparent() {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

/**
 * Per-call routing headers for subscription traffic. Auxiliary purposes get
 * their own conversation/req id namespaces so they never collide with the
 * parent conversation's routing slot.
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options - the assembled request.
 * @param {string} agentId - stable native agent id.
 * @returns the per-call header set.
 */
function grokBuildCallHeaders(options, agentId) {
  const sessionId = options.sessionId === undefined ? '' : String(options.sessionId);
  if (options.purpose === 'compaction') {
    return {
      traceparent: traceparent(),
      'x-grok-conv-id': sessionId,
      'x-grok-req-id': `xai-compact-${randomUUID()}`,
      'x-grok-model-override': options.model,
      'x-grok-session-id': sessionId,
      'x-grok-agent-id': agentId,
    };
  }
  if (options.purpose === 'session-title') {
    return {
      traceparent: traceparent(),
      'x-grok-conv-id': `title-refresh-${randomUUID()}`,
      'x-grok-req-id': `xai-title-refresh-${randomUUID()}`,
      'x-grok-model-override': options.model,
      'x-grok-session-id': sessionId,
      'x-grok-agent-id': agentId,
    };
  }
  const turn = options.messages.reduce(
    (total, message) => total + (message.role === 'user' ? 1 : 0),
    0,
  );
  return {
    traceparent: traceparent(),
    'x-grok-conv-id': sessionId,
    'x-grok-req-id': randomUUID(),
    'x-grok-model-override': options.model,
    'x-grok-session-id': sessionId,
    'x-grok-agent-id': agentId,
    ...(turn === 0 ? {} : { 'x-grok-turn-idx': String(turn) }),
  };
}

/** Whether the base URL points at the subscription proxy host. */
function isSubscriptionProxyUrl(baseURL) {
  try {
    return new URL(baseURL).hostname === SUBSCRIPTION_PROXY_HOST;
  } catch {
    return false;
  }
}

/**
 * Assemble one request's headers. Profile headers may add deployment facts but
 * cannot overwrite protocol identity; `x-authenticateresponse` is a
 * subscription-proxy-only marker, so a custom subscription baseURL that is not
 * the proxy never carries it.
 * @param {object} profile - resolved provider profile.
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options - the assembled request.
 * @param {string} apiKey - resolved bearer or API key.
 * @param {string | undefined} agentId - native agent id for subscription traffic.
 * @returns the complete header map.
 */
function requestHeaders(profile, options, apiKey, agentId) {
  const identity = profile.authMode === 'grok-subscription'
    ? (() => {
      const headers = {
        ...grokBuildIdentityHeaders(profile.headers),
        ...grokBuildCallHeaders(options, agentId ?? ''),
      };
      if (!isSubscriptionProxyUrl(profile.baseURL)) delete headers['x-authenticateresponse'];
      return headers;
    })()
    : attributionHeaders();
  const required = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'accept-encoding': 'gzip, br, deflate',
    ...identity,
  };
  const reserved = new Set(Object.keys(required).map((name) => name.toLowerCase()));
  return {
    ...Object.fromEntries(
      Object.entries(profile.headers).filter(([name]) => !reserved.has(name.toLowerCase())),
    ),
    ...required,
  };
}

/** Whether the base URL is a first-party xAI/Grok HTTPS endpoint. */
function trustedFirstPartyUrl(baseURL) {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return url.hostname === SUBSCRIPTION_PROXY_HOST
    || url.hostname === 'x.ai'
    || url.hostname.endsWith('.x.ai');
}

/**
 * Add the native no-inline-citations include for backend-search models on
 * first-party endpoints; every other model or endpoint keeps the wire body
 * unchanged.
 */
function withNativeIncludes(body, profile, model) {
  if (!BACKEND_SEARCH_MODELS.includes(model.id) || !trustedFirstPartyUrl(profile.baseURL)) return body;
  return { ...body, include: [...body.include, 'no_inline_citations'] };
}

/**
 * Parse one `Retry-After` header value into a positive delay in milliseconds.
 * @param {string | null} value - raw header value (delta seconds or HTTP date).
 * @returns the delay, or undefined when absent, non-positive, or unparsable.
 */
export function providerRetryAfterMs(value) {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

/** Read the provider-issued request id from one response's headers. */
function requestId(headers) {
  const value = headers.get('x-request-id')
    ?? headers.get('x-grok-request-id')
    ?? headers.get('request-id');
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}

/**
 * Map one non-success Responses status and error envelope to a stable Harness code.
 * @param {number} status - HTTP response status.
 * @param {{message?: string, type?: string, code?: string}} [error] - optional provider error details.
 * @param {boolean} [requestHasImages] - whether this exact attempt has images that a retry can remove.
 * @param {boolean} [retryVeto] - whether the provider explicitly marked the response non-retryable.
 * @returns the stable failure code exposed to retry and UI consumers.
 */
export function grokHttpErrorCode(status, error, requestHasImages = false, retryVeto = false) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 426) return 'CLIENT_VERSION_REQUIRED';
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (requestHasImages && status === 413) return 'IMAGE_PAYLOAD_TOO_LARGE';
  if (requestHasImages && (status === 400 || status === 500)
    && (error?.code === 'invalid_image'
      || error?.message?.includes('Could not process image') === true
      || error?.message?.includes('.image.source.') === true)) return 'INVALID_IMAGE';
  if (status === 429) return retryVeto ? 'RETRY_VETOED' : 'RATE_LIMIT';
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return 'INVALID_REQUEST';
  }
  if (status === 525 || status === 526) return `HTTP_${status}`;
  if (status >= 500) return retryVeto ? 'RETRY_VETOED' : 'SERVER';
  return `HTTP_${status}`;
}

/**
 * Resolve and validate the model-visible reasoning effort against the model's
 * declared set.
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options - the assembled request.
 * @param {object} profile - resolved provider profile.
 * @param {object} model - resolved model.
 * @returns the validated native effort.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} `UNSUPPORTED_REASONING_EFFORT` for an unsupported value.
 */
function validateEffort(options, profile, model) {
  const effort = options.reasoningEffort === undefined ? profile.reasoning : String(options.reasoningEffort);
  if (model.reasoningEfforts.some((candidate) => candidate === effort)) return effort;
  throw new LlmError(
    `Grok model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  );
}

/** Direct Grok Build-compatible Responses adapter. */
class GrokAdapter extends LlmAdapter {
  /** @param {GrokAdapterOptions} config */
  constructor(config) {
    super();
    this.#config = config;
  }

  #config;

  /** Resolve the profile owning one provider route, or fail with `NO_ADAPTER`. */
  #profileOf(profiles, provider) {
    const profile = profiles.get(provider);
    if (profile === undefined) throw new LlmError(`grok-model does not own provider "${provider}"`, 'NO_ADAPTER');
    return profile;
  }

  /** Resolve one model against the profile catalog, with route fallbacks. */
  #modelOf(profile, model) {
    return profile.models.find((candidate) => candidate.id === model) ?? fallbackModel(profile, model);
  }

  /** @override */
  providerInfo(provider) {
    return { id: provider, name: this.#config.profiles().get(provider)?.displayName ?? provider };
  }

  /** @override */
  providerRetryPolicy(provider) {
    return this.#config.profiles().get(provider)?.retryPolicy;
  }

  /** @override */
  listModels(provider) {
    const profile = this.#profileOf(this.#config.profiles(), provider);
    return Promise.resolve(profile.models.map((model) => modelInfo(provider, model)));
  }

  /** @override */
  resolveModel(provider, model) {
    const profile = this.#profileOf(this.#config.profiles(), provider);
    const resolved = this.#modelOf(profile, model);
    const defaultEffort = resolved.reasoningEfforts.includes(profile.reasoning)
      ? profile.reasoning
      : resolved.reasoningEfforts[0];
    return Promise.resolve({
      ...modelInfo(provider, resolved),
      context: { contextWindow: resolved.contextWindow },
      ...(resolved.maxTokens === undefined ? {} : { defaultMaxTokens: resolved.maxTokens }),
      ...(resolved.reasoningEfforts.length === 0
        ? {}
        : {
          reasoning: {
            efforts: resolved.reasoningEfforts.map((effort) => ({
              id: ReasoningEffortId(effort),
              name: effort === 'xhigh' ? 'Extra High' : `${effort[0]?.toUpperCase()}${effort.slice(1)}`,
            })),
            ...(defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }),
          },
        }),
    });
  }

  /** @override */
  async * stream(options) {
    if (options.stop !== undefined) {
      throw new LlmError('grok-model does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION');
    }
    const profile = this.#profileOf(this.#config.profiles(), options.provider);
    const model = this.#modelOf(profile, options.model);
    const effort = validateEffort(options, profile, model);
    const apiKey = await this.#config.resolveApiKey(options.provider, profile);
    const agentId = profile.authMode === 'grok-subscription' ? this.#config.resolveAgentId() : undefined;

    const containsImage = options.messages.some((message) => contentHasImage(message.content));
    if (containsImage && !model.input.includes('image')) {
      throw new LlmError(`Grok model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT');
    }
    const attachments = containsImage ? this.#config.resolveAttachments?.() : undefined;
    if (containsImage && attachments === undefined) {
      throw new LlmError('grok-model image input requires the attachment service', 'UNSUPPORTED_CONTENT');
    }

    const consumer = new AbortController();
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal]);
    const requestDeadline = deadline(upstream, profile.timeoutMs ?? 0, REQUEST_TIMEOUT_CODE);
    let watchdog;
    try {
      watchdog = idleWatchdog(requestDeadline.signal, profile.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);
    } catch (error) {
      requestDeadline[Symbol.dispose]();
      throw error;
    }
    const iterator = this.#request(
      options,
      profile,
      model,
      effort,
      apiKey,
      agentId,
      attachments,
      watchdog.signal,
      () => { watchdog.pulse(); },
    )[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      for (;;) {
        const result = await watchdog.next(iterator);
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Grok stream idle timeout after ${profile.streamIdleTimeoutMs}ms`,
          'IDLE_TIMEOUT',
          { cause: error },
        );
      }
      if (timeoutOf(requestDeadline.signal, REQUEST_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`Grok request timeout after ${profile.timeoutMs}ms`, 'TIMEOUT', { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError('Grok request aborted by caller', 'ABORTED', { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`Grok Responses request to ${profile.baseURL} failed`, 'TRANSPORT', { cause: error });
    } finally {
      watchdog[Symbol.dispose]();
      requestDeadline[Symbol.dispose]();
      consumer.abort('grok-model stream consumer stopped');
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return();
        } catch {
          // The lifecycle signal already owns cancellation and the public outcome.
        }
      }
    }
  }

  /** Perform one POST /responses attempt and translate its event stream. */
  async * #request(options, profile, model, effort, apiKey, agentId, attachments, signal, onComment) {
    const body = withNativeIncludes(
      await serializeGrokRequest(
        { ...options, reasoningEffort: ReasoningEffortId(effort) },
        effort,
        attachments,
        this.#config.resolveHostedTools?.() ?? [],
        model.reasoningSummary,
      ),
      profile,
      model,
    );
    const url = `${profile.baseURL}/responses`;
    let response;
    try {
      const requestFetch = this.#config.requestFetch ?? globalThis.fetch;
      response = await requestFetch(url, {
        method: 'POST',
        headers: requestHeaders(profile, options, apiKey, agentId),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = error instanceof Error && error.message.length > 0 ? `: ${error.message}` : '';
      throw new LlmError(`Grok Responses request to ${url} failed${detail}`, 'TRANSPORT', { cause: error });
    }

    if (!response.ok) {
      let parsed;
      try {
        const text = await response.text();
        if (text.length > 0) parsed = JSON.parse(text);
      } catch {
        // The status remains authoritative when a gateway returns an empty or malformed body.
      }
      const providerError = parsed?.error;
      const message = providerError?.message
        ?? parsed?.message
        ?? `Grok API error (HTTP ${response.status})`;
      const delay = providerRetryAfterMs(response.headers.get('retry-after'));
      const id = requestId(response.headers);
      const requestHasImages = options.messages.some((item) => contentHasImage(item.content));
      const retryVeto = response.headers.get('x-should-retry')?.toLowerCase() === 'false';
      throw new LlmError(message, grokHttpErrorCode(
        response.status,
        providerError,
        requestHasImages,
        retryVeto,
      ), {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        ...(id === undefined ? {} : { requestId: id }),
      });
    }
    if (response.body === null) throw new LlmError('Grok API returned no response body', 'EMPTY_RESPONSE');
    const contentType = response.headers.get('content-type');
    if (contentType !== null && !contentType.toLowerCase().includes('text/event-stream')) {
      await response.body.cancel();
      throw new LlmError(`Grok API returned ${contentType} instead of text/event-stream`, 'PROTOCOL');
    }
    yield* translateGrokResponses(parseGrokSse(response.body, onComment), {
      requestHasImages: options.messages.some((item) => contentHasImage(item.content)),
    });
  }
}

/**
 * Build one Grok Responses adapter bound to its lifecycle dependencies.
 * @param {GrokAdapterOptions} config - profiles, credential and tool resolvers, and transport.
 * @returns the adapter instance ready for `registerAdapter`.
 */
export function createGrokAdapter(config) {
  return new GrokAdapter(config);
}
