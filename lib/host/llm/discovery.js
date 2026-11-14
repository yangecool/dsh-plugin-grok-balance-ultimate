/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * The owned `grok` route is answered from the module's built-in catalog, with
 * no network call. A draft custom endpoint can still be interrogated via the
 * OpenAI-compatible `GET /models` shape; every other protocol reports that it
 * cannot be interrogated so the surface falls back to hand-entry.
 */

import { attributionHeaders, INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm';
import { BUILT_IN_MODELS } from './constants.js';

/** Protocols whose model listing this module can read. */
const LISTABLE_PROTOCOLS = new Set(['openai-responses']);

/** Endpoint replies larger than this are refused; a truncated listing is not parseable. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** A positive integer field of a listing entry, or undefined when absent or unusable. */
function capacity(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return undefined;
}

/** A non-empty string field of a listing entry, or undefined. */
function label(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Join the endpoint base with the listing path. The base is a prefix rather
 * than a URL to resolve against, so a deployment path keeps its segments.
 */
function listingUrl(baseURL) {
  return `${baseURL.replace(/\/+$/, '')}/models`;
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total enforces the bound for one that under-declares.
 * @param {Response} response - the listing reply.
 * @param {string} url - endpoint URL used in diagnostics.
 * @returns the decoded body text.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} `DISCOVERY_FAILED` when the reply is oversized.
 */
async function readBounded(response, url) {
  const oversized = () => new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED');
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw oversized();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw oversized();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
      // Cancel after a drained or abandoned read is cleanup; the reply is decided.
    });
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * Read one OpenAI-compatible listing reply. Entries without a usable id are
 * skipped rather than failing the whole interrogation.
 * @param {unknown} body - parsed listing reply.
 * @returns the advertised models in endpoint order.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} `DISCOVERY_FAILED` when the reply is not a listing.
 */
function readListing(body) {
  const data = body?.data;
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    );
  }
  const models = [];
  for (const raw of data) {
    const entry = raw;
    const id = label(entry?.id);
    if (id === undefined) continue;
    const name = label(entry?.name, entry?.display_name);
    const contextWindow = capacity(entry?.context_window, entry?.context_length);
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens);
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  }
  return models;
}

/**
 * Accept one probe key, or refuse it before the header is built; a ByteString
 * rejection inside fetch would blame the network for a local, deterministic fault.
 * @param {string} raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} `INVALID_CREDENTIAL` when the key is unusable.
 */
function usableProbeKey(raw) {
  const checked = normalizeApiKey(raw);
  if (checked.ok) return checked.value;
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  );
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 * @param {object} request - the endpoint, protocol, and one-shot credential to use.
 * @param {() => Promise<string | undefined>} [storedApiKey] - the credential the named route already stored.
 * @param {string} [label] - diagnostic owner label used in discovery errors.
 * @param {typeof globalThis.fetch} [requestFetch] - HTTP transport selected by the owning module.
 * @returns the advertised models in endpoint order.
 * @throws {import('@deepseek-ai/dsh-llm').LlmError} when the protocol has no readable listing, the endpoint refuses or fails the request, or the reply is not a model listing.
 */
export async function discoverModels(request, storedApiKey, label = 'grok-model', requestFetch = globalThis.fetch) {
  if (request.provider === 'grok') {
    return BUILT_IN_MODELS.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow }));
  }
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      `${label} ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    );
  }
  const api = request.api ?? 'openai-responses';
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `${label} protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    );
  }
  const url = listingUrl(request.baseURL);
  // A key typed into the form wins: it is the one the user is testing, and it
  // may be the replacement for exactly the stored key that is failing.
  const supplied = request.apiKey ?? await storedApiKey?.();
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied);
  let response;
  try {
    response = await requestFetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        ...attributionHeaders(),
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error });
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error });
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    );
  }
  let text;
  try {
    text = await readBounded(response, url);
  } catch (error) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error });
    }
    throw error;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error });
  }
  return readListing(body);
}
