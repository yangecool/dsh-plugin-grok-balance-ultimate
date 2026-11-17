/**
 * Replay-envelope round trips through the real Harness block assembler.
 *
 * Assembly prunes per-block replay entries in step with the blocks it keeps,
 * so the adapter's read path must consume the pruned envelope half. These cases
 * pin the two ways that alignment can break: max-token truncation dropping a
 * tool call, and hosted calls that own no durable block. All cases are offline.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { serializeGrokRequest, translateGrokResponses } from '../../../lib/host/llm/index.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

async function* payloads(values) {
  for (const value of values) yield typeof value === 'string' ? value : JSON.stringify(value);
}

async function assemble(values) {
  const assembler = new BlockAssembler();
  for await (const chunk of translateGrokResponses(payloads(values))) assembler.push(chunk);
  return assembler;
}

/** The durable assistant message the agent loop stores after assembly. */
function assistantMessage(assembler) {
  const message = assembler.message({ provider: 'grok', model: 'grok-4.6' });
  return { ...message, source: { ...message.source, replayState: assembler.replayState } };
}

describe('Grok replay state through the block assembler', () => {
  it('keeps replay aligned when max-token truncation drops a tool call', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', status: 'completed', encrypted_content: 'sealed', summary: [] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"REA' },
    ];
    const assembler = await assemble([
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.output_item.done', output_index: 1, item: output[1] },
      { type: 'response.incomplete', response: { id: 'resp_truncated', incomplete_details: { reason: 'max_output_tokens' }, output } },
      '[DONE]',
    ]);

    // The assembler dropped the truncated call from content and metadata alike.
    assert.deepEqual(assembler.blocks().map((block) => block.type), ['reasoning']);
    assert.deepEqual(assembler.replayState.blocks.map((block) => block.type), ['reasoning']);

    const body = await serializeGrokRequest({
      provider: 'grok',
      model: 'grok-4.6',
      messages: [assistantMessage(assembler), user('next question')],
    }, 'high');
    assert.deepEqual(body.input, [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'sealed', summary: [] },
      { type: 'message', role: 'user', content: 'next question' },
    ]);
  });

  it('keeps every hosted call in a response that searched twice', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', status: 'completed', encrypted_content: 'sealed', summary: [] },
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'q1' } },
      { type: 'web_search_call', id: 'ws_2', status: 'completed', action: { type: 'search', query: 'q2' } },
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ];
    const assembler = await assemble([
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.output_item.done', output_index: 1, item: output[1] },
      { type: 'response.output_item.done', output_index: 2, item: output[2] },
      { type: 'response.output_item.done', output_index: 3, item: output[3] },
      { type: 'response.completed', response: { id: 'resp_two_searches', output } },
      '[DONE]',
    ]);

    assert.deepEqual(assembler.blocks().map((block) => block.type), ['reasoning', 'text']);
    assert.deepEqual(assembler.replayState.blocks.map((block) => block.type), ['reasoning', 'text']);

    const body = await serializeGrokRequest({
      provider: 'grok',
      model: 'grok-4.6',
      messages: [assistantMessage(assembler), user('and the other one?')],
    }, 'high');
    assert.deepEqual(body.input, [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'sealed', summary: [] },
      { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'q1' } },
      { type: 'web_search_call', id: 'ws_2', action: { type: 'search', query: 'q2' } },
      { type: 'message', role: 'assistant', content: 'answer' },
      { type: 'message', role: 'user', content: 'and the other one?' },
    ]);
  });

  it('rejects an owned replay whose entries no longer match the content', async () => {
    const request = (replayState) => serializeGrokRequest({
      provider: 'grok',
      model: 'grok-4.6',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'grok', model: 'grok-4.6', replayState },
      }],
    }, 'high');

    await assert.rejects(request({
      response: { kind: 'grok-build-responses', version: 1 },
      blocks: [],
    }), { code: 'INVALID_REPLAY_STATE' });
    await assert.rejects(request({
      response: { kind: 'grok-build-responses', version: 1 },
      blocks: [{ type: 'text', hostedBefore: 'not-an-array' }],
    }), { code: 'INVALID_REPLAY_STATE' });
    await assert.rejects(request({
      response: { kind: 'grok-build-responses', version: 2 },
      blocks: [{ type: 'text' }],
    }), { code: 'INVALID_REPLAY_STATE' });
  });

  it('ignores replay state owned by another adapter kind', async () => {
    const body = await serializeGrokRequest({
      provider: 'grok',
      model: 'grok-4.6',
      messages: [{
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'foreign' }, { type: 'text', text: 'answer' }],
        source: {
          kind: 'model',
          provider: 'grok',
          model: 'grok-4.6',
          replayState: { response: { kind: 'other-adapter', version: 1 }, blocks: [{ type: 'reasoning' }, { type: 'text' }] },
        },
      }],
    }, 'high');
    assert.deepEqual(body.input, [{ type: 'message', role: 'assistant', content: 'answer' }]);
  });
});
