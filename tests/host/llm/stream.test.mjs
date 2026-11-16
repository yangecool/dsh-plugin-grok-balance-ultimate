/**
 * Stream-translation behavior for the Grok Responses adapter.
 *
 * Ported from grok-harness stream.spec.ts, minus fork-private behavior: no
 * doom-loop control or recovery, no replayState envelope on the finish chunk.
 * All cases are offline payload fixtures.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mapGrokUsage, parseGrokSse, translateGrokResponses } from '../../../lib/host/llm/index.js';

async function* payloads(values) {
  for (const value of values) yield typeof value === 'string' ? value : JSON.stringify(value);
}

async function collect(values, options) {
  const chunks = [];
  for await (const chunk of translateGrokResponses(payloads(values), options)) chunks.push(chunk);
  return chunks;
}

function sseStream(values) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const value of values) {
        const data = typeof value === 'string' ? value : JSON.stringify(value);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.close();
    },
  });
}

describe('Grok Responses usage mapping', () => {
  it('retains an explicit zero cached_tokens as miss evidence', () => {
    assert.deepEqual(mapGrokUsage({
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 10,
      },
    }), { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 });
  });

  it('keeps an omitted cached_tokens field unknown', () => {
    assert.deepEqual(mapGrokUsage({ usage: { input_tokens: 100, output_tokens: 10 } }),
      { inputTokens: 100, outputTokens: 10 });
  });

  it('subtracts cached input and retains reasoning usage', () => {
    assert.deepEqual(mapGrokUsage({
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 75 },
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 6 },
      },
    }), {
      inputTokens: 25,
      outputTokens: 10,
      cacheReadTokens: 75,
      reasoningTokens: 6,
    });
  });
});

describe('Grok direct Responses translation', () => {
  it('translates reasoning, text and usage after DONE without a replay envelope', async () => {
    const chunks = await collect([
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'check' },
      { type: 'response.output_text.delta', output_index: 1, delta: 'done' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_fixture',
          output: [
            { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'check' }], status: 'completed' },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }], status: 'completed' },
          ],
          usage: {
            input_tokens: 20,
            input_tokens_details: { cached_tokens: 5 },
            output_tokens: 4,
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
      '[DONE]',
    ]);

    assert.deepEqual(chunks.find((c) => c.type === 'block-end' && c.index === 0),
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'check' } });
    assert.deepEqual(chunks.find((c) => c.type === 'block-end' && c.index === 1),
      { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } });
    assert.deepEqual(chunks.at(-2), {
      type: 'usage',
      usage: { inputTokens: 15, outputTokens: 4, cacheReadTokens: 5, reasoningTokens: 2 },
    });
    const finish = chunks.at(-1);
    assert.equal(finish.type, 'finish');
    assert.deepEqual(finish.reason, { kind: 'stop' });
    // The fork's replayState envelope is deliberately not ported.
    assert.ok(!('replayState' in finish));
  });

  it('recovers a tool name from the terminal response when only argument deltas streamed', async () => {
    const chunks = await collect([
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call_fixture', delta: '{"path":"README.md"}' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_tool',
          output: [{ type: 'function_call', call_id: 'call_fixture', name: 'read_file', arguments: '{"path":"README.md"}' }],
          usage: { input_tokens: 8, output_tokens: 3 },
        },
      },
      '[DONE]',
    ]);

    assert.deepEqual(chunks.find((c) => c.type === 'block-end'),
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_fixture', name: 'read_file', arguments: '{"path":"README.md"}' },
      });
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
  });

  it('accepts clean EOF after a terminal response when the gateway omits DONE', async () => {
    const chunks = [];
    for await (const chunk of translateGrokResponses(parseGrokSse(sseStream([{
      type: 'response.completed',
      response: {
        id: 'resp_clean_eof',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'complete' }] }],
      },
    }])))) chunks.push(chunk);

    assert.deepEqual(chunks.find((c) => c.type === 'block-end'),
      { type: 'block-end', index: 0, block: { type: 'text', text: 'complete' } });
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  });

  for (const [reason, expected] of [
    ['max_output_tokens', { kind: 'max-tokens', rawReason: 'max_tokens' }],
    ['max_prompt_tokens', { kind: 'max-tokens', rawReason: 'model_context_window_exceeded' }],
    ['max_time_limit', { kind: 'max-tokens' }],
    ['future_reason', { kind: 'max-tokens' }],
    [undefined, { kind: 'max-tokens' }],
  ]) {
    it(`maps incomplete reason ${reason} without inventing a successful stop`, async () => {
      const chunks = await collect([{
        type: 'response.incomplete',
        response: {
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }],
          ...(reason === undefined ? {} : { incomplete_details: { reason } }),
        },
      }, '[DONE]']);
      assert.deepEqual(chunks.at(-1).reason, expected);
    });
  }

  it('maps content_filter to its terminal stop reason', async () => {
    const chunks = await collect([{
      type: 'response.incomplete',
      response: {
        incomplete_details: { reason: 'content_filter' },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'filtered' }] }],
      },
    }, '[DONE]']);
    assert.deepEqual(chunks.at(-1).reason, { kind: 'content-filter' });
  });

  it('salvages an incomplete batch only when every tool argument is complete', async () => {
    const terminal = (secondArguments) => [{
      type: 'response.incomplete',
      response: {
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'first', arguments: '{"ok":true}' },
          { type: 'function_call', call_id: 'call_2', name: 'second', arguments: secondArguments },
        ],
      },
    }, '[DONE]'];

    const complete = await collect(terminal('{}'));
    assert.deepEqual(complete.at(-1).reason, { kind: 'tool-calls' });

    const truncated = await collect(terminal('{"cut":'));
    assert.deepEqual(truncated.at(-1).reason, { kind: 'max-tokens', rawReason: 'max_tokens' });
  });

  it('hides hosted calls and continues when a response searched without answering', async () => {
    const web = await collect([{
      type: 'response.completed',
      response: { id: 'resp_search', output: [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'capybaras' } }] },
    }, '[DONE]']);
    assert.deepEqual(web.at(-1), { type: 'continue-response', responseId: 'resp_search' });
    assert.equal(web.some((chunk) => chunk.type === 'text-delta'), false);

    const answered = await collect([{
      type: 'response.completed',
      response: {
        id: 'resp_search',
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'capybaras' } },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        ],
      },
    }, '[DONE]']);
    assert.equal(answered.at(-1).type, 'finish');
    assert.deepEqual(answered.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')?.block,
      { type: 'text', text: 'done' });
  });

  it('holds a later function call until a terminal hosted item fills the output index gap', async () => {
    const chunks = await collect([
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'plan' },
      { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'call_2', delta: '{"target":"probe.txt"}' },
      {
        type: 'response.completed',
        response: {
          output: [
            { type: 'reasoning', id: 'reasoning_0', summary: [{ type: 'summary_text', text: 'plan' }], status: 'completed' },
            { type: 'web_search_call', id: 'search_1', action: { type: 'search', query: 'replay order' }, status: 'completed' },
            { type: 'function_call', call_id: 'call_2', name: 'edit_file', arguments: '{"target":"probe.txt"}', status: 'completed' },
          ],
        },
      },
      '[DONE]',
    ]);
    assert.deepEqual(chunks.filter((c) => c.type === 'block-start').map((c) => c.index), [0, 2]);
    assert.deepEqual(chunks.find((c) => c.type === 'block-end' && c.index === 2).block,
      { type: 'tool-call', id: 'call_2', name: 'edit_file', arguments: '{"target":"probe.txt"}' });
  });

  it('keeps every block paired when a hosted call arrives before earlier slots begin', async () => {
    const chunks = await collect([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r0', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'web_search_call', id: 'ws1', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'message', id: 'm0', role: 'assistant', status: 'in_progress' } },
      { type: 'response.output_text.delta', output_index: 2, delta: 'answer' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_pairing',
          output: [
            { type: 'reasoning', id: 'r0', status: 'completed', summary: [] },
            { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'search', query: 'q' } },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
          ],
        },
      },
      '[DONE]',
    ]);
    const starts = chunks.filter((chunk) => chunk.type === 'block-start').map((chunk) => chunk.index);
    const ends = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.index);
    assert.deepEqual(starts, [0, 2]);
    assert.deepEqual(ends, [0, 2]);
  });

  it('refuses unsupported backend items instead of silently losing context', async () => {
    await assert.rejects(collect([{
      type: 'response.completed',
      response: { output: [{ type: 'image_generation_call', id: 'ig_1', status: 'completed' }] },
    }, '[DONE]']), { code: 'UNSUPPORTED_RESPONSE_ITEM' });
  });

  it('classifies a streamed invalid-image code only when the request has images to strip', async () => {
    const events = [{ type: 'error', error: { code: 'invalid_image', message: 'provider rejected an image' } }];
    await assert.rejects(collect(events, { requestHasImages: true }), { code: 'INVALID_IMAGE' });
    await assert.rejects(collect(events, { requestHasImages: false }), { code: 'SERVER' });
  });

  it('swallows malformed and detector frames without failing the response', async () => {
    const chunks = await collect([
      { type: 'response.doom_loop_check', doom_loop_check: { triggers: 'not-an-array' } },
      {
        type: 'response.completed',
        response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'accepted' }] }] },
      },
      '[DONE]',
    ]);
    assert.deepEqual(chunks.find((c) => c.type === 'block-end'),
      { type: 'block-end', index: 0, block: { type: 'text', text: 'accepted' } });
  });

  it('still rejects clean EOF before a terminal response', async () => {
    const chunks = [];
    await assert.rejects((async () => {
      for await (const chunk of translateGrokResponses(parseGrokSse(sseStream([{
        type: 'response.output_text.delta',
        output_index: 0,
        delta: 'partial',
      }])))) chunks.push(chunk);
    })(), { code: 'STREAM_CLOSED' });
  });
});
