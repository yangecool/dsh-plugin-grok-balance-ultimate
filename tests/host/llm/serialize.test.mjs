/**
 * Request-serialization wire golden samples for the Grok Responses adapter.
 *
 * Ported from grok-harness responses-wire.spec.ts, minus fork-private
 * behavior: no prompt_cache_key projection, no encrypted replay state, no
 * permission-auto purpose. All cases are offline.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { resolveGrokReasoningEffort, serializeGrokRequest } from '../../../lib/host/llm/index.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

const assistantTurn = {
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'thinking about it' },
    { type: 'text', text: 'let me read the file' },
    { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' },
  ],
  source: { kind: 'model', provider: 'grok', model: 'grok-4.6' },
};

const toolResult = {
  role: 'tool',
  toolCallId: 'call_1',
  content: [{ type: 'text', text: 'file body' }],
  source: { kind: 'tool', callId: 'call_1' },
};

describe('Grok Responses request serialization', () => {
  it('serializes system, user, assistant and tool history into Responses items', async () => {
    const body = await serializeGrokRequest({
      provider: 'grok',
      model: 'grok-4.6',
      system: 'be brief',
      messages: [assistantTurn, toolResult, user('continue')],
      sessionId: 'sess-wire',
    }, 'high');

    assert.deepEqual(body.input, [
      { type: 'message', role: 'system', content: 'be brief' },
      // Assistant reasoning is dropped: encrypted replay was not ported.
      { type: 'message', role: 'assistant', content: 'let me read the file' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
      { type: 'message', role: 'user', content: 'continue' },
    ]);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.model, 'grok-4.6');
    assert.deepEqual(body.reasoning, { effort: 'high', summary: 'concise' });
    // The fork's prompt_cache_key projection is deliberately not ported.
    assert.ok(!('prompt_cache_key' in body));
    assert.ok(!('max_output_tokens' in body));
  });

  it('replaces a colliding function with an owned hosted web_search and pins x_search bounds', async () => {
    const base = { provider: 'grok', model: 'grok-4.6', messages: [] };
    const webOwned = await serializeGrokRequest({
      ...base,
      tools: [
        { name: 'web_search', description: 'local', parameters: { type: 'object', properties: {} } },
        { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
      ],
    }, 'high', undefined, [{ wireName: 'web_search' }]);
    assert.deepEqual(webOwned.tools, [
      { type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
      { type: 'web_search' },
    ]);

    const pinned = await serializeGrokRequest(base, 'high', undefined, [{
      wireName: 'web_search',
      entry: { type: 'web_search', filters: { excluded_domains: ['reddit.com'] } },
    }, {
      wireName: 'x_search',
      entry: { type: 'x_search', from_date: '2026-01-01', to_date: '2026-08-29' },
    }]);
    assert.deepEqual(pinned.tools, [
      { type: 'web_search', filters: { excluded_domains: ['reddit.com'] } },
      { type: 'x_search', from_date: '2026-01-01', to_date: '2026-08-29' },
    ]);
  });

  it('keeps session-title requests text-only when hosted tools are owned', async () => {
    const body = await serializeGrokRequest({
      provider: 'grok',
      model: 'grok-4.6',
      messages: [],
      purpose: 'session-title',
      tools: [{ name: 'title_helper', description: 'aux', parameters: { type: 'object', properties: {} } }],
    }, 'high', undefined, [{ wireName: 'web_search' }, { wireName: 'x_search' }]);
    assert.ok(!('tools' in body));
    assert.ok(!('prompt_cache_key' in body));
  });

  it('honors per-model reasoning summary modes on the Responses wire', async () => {
    const options = { provider: 'grok', model: 'grok-4.6', messages: [], sessionId: 'summary-mode' };
    const omitted = await serializeGrokRequest(options, 'high', undefined, [], 'none');
    const detailed = await serializeGrokRequest(options, 'high', undefined, [], 'detailed');
    assert.deepEqual(omitted.reasoning, { effort: 'high' });
    assert.deepEqual(detailed.reasoning, { effort: 'high', summary: 'detailed' });
  });

  it('resolves the effort fallback and rejects unsupported effort spellings', async () => {
    assert.equal(resolveGrokReasoningEffort(undefined, 'high'), 'high');
    assert.equal(resolveGrokReasoningEffort('xhigh', 'low'), 'xhigh');
    await assert.rejects(serializeGrokRequest({
      provider: 'grok', model: 'grok-4.6', messages: [], reasoningEffort: 'extreme',
    }, 'high'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
  });

  it('refuses a hosted entry whose type mismatches its owner and an unknown hosted name', async () => {
    const options = { provider: 'grok', model: 'grok-4.6', messages: [] };
    await assert.rejects(
      serializeGrokRequest(options, 'high', undefined, [{ wireName: 'web_search', entry: { type: 'x_search' } }]),
      { code: 'UNSUPPORTED_TOOL' },
    );
    await assert.rejects(
      serializeGrokRequest(options, 'high', undefined, [{ wireName: 'code_interpreter' }]),
      { code: 'UNSUPPORTED_HOSTED_TOOL' },
    );
  });

  it('maps temperature and maxTokens onto the wire fields', async () => {
    const body = await serializeGrokRequest({
      provider: 'grok', model: 'grok-4.6', messages: [], temperature: 0.2, maxTokens: 1024,
    }, 'high');
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_output_tokens, 1024);
  });
});
