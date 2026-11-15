/**
 * Registration wiring for createLlmModule against a real cordis context with
 * the published LlmService: directory entry, adapter routes, model discovery,
 * hot replacement, and disposal. Streaming goes through an injected fetch.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmService from '@deepseek-ai/dsh-llm';
import { Config, createLlmModule } from '../../../lib/host/llm/index.js';
import { completedText, recordingFetch, sseResponse, userMessage } from './helpers.mjs';

/** A module-scoped cordis context with the llm service mounted. */
async function llmContext() {
  const ctx = new Context();
  await ctx.plugin(LlmService);
  return ctx;
}

/** A live config-like object whose volatile providers read the given raw map. */
function liveConfig(raw) {
  return { providers: { get: () => raw } };
}

/** Names of providers with a registered adapter route. */
function providersOf(ctx) {
  return ctx.get('llm').listProviders().map((provider) => provider.id);
}

describe('createLlmModule registration wiring', () => {
  it('registers the directory entry, adapter route, and built-in discovery', async () => {
    const ctx = await llmContext();
    try {
      const { fetch } = recordingFetch(sseResponse(completedText('fine')));
      const mod = createLlmModule({
        oauth: { resolveAccessToken: async () => 'subscription-access' },
        fetch,
      });
      mod.apply(ctx, Config({ providers: { grok: { authMode: 'grok-subscription' } } }));

      assert.deepEqual(providersOf(ctx), ['grok']);
      const entry = ctx.get('llm').listConfigurableProviders().find((candidate) => candidate.provider === 'grok');
      assert.equal(entry.settingsNs, 'llm-grok');
      assert.deepEqual(entry.settingsPath, ['providers', 'grok']);

      const discovered = await ctx.get('llm').discoverModels('llm-grok', { provider: 'grok' });
      assert.deepEqual(discovered.map((model) => model.id), ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);

      const models = await ctx.get('llm').resolveModelInfo('grok', 'grok-4.6');
      assert.equal(models.context.contextWindow, 500_000);
      assert.deepEqual(models.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high', 'xhigh']);
      assert.equal(models.reasoning.defaultEffort, 'high');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('streams a full call through the registered route', async () => {
    const ctx = await llmContext();
    try {
      const { fetch, calls } = recordingFetch(sseResponse(completedText('hello from grok')));
      const mod = createLlmModule({
        oauth: { resolveAccessToken: async () => 'subscription-access' },
        fetch,
      });
      mod.apply(ctx, Config({ providers: { grok: { authMode: 'grok-subscription' } } }));

      const chunks = [];
      for await (const chunk of ctx.get('llm').stream({
        provider: 'grok',
        model: 'grok-4.6',
        messages: [userMessage('hi')],
        sessionId: 'sess-module',
      })) chunks.push(chunk);

      assert.equal(calls[0].url, 'https://cli-chat-proxy.grok.com/v1/responses');
      assert.equal(calls[0].init.headers.authorization, 'Bearer subscription-access');
      assert.ok(chunks.some((chunk) => chunk.type === 'block-end' && chunk.block?.text === 'hello from grok'));
      assert.equal(chunks.at(-1).type, 'finish');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('swaps routes and directory facts through handle.replace', async () => {
    const ctx = await llmContext();
    try {
      const { fetch } = recordingFetch(sseResponse(completedText('ok')));
      const mod = createLlmModule({ oauth: { resolveAccessToken: async () => 'token' }, fetch });
      mod.apply(ctx, Config({ providers: { grok: { authMode: 'grok-subscription' } } }));
      assert.deepEqual(providersOf(ctx), ['grok']);

      // Empty providers: the registration survives with zero routes.
      mod.handle.replace(Config({ providers: {} }));
      assert.deepEqual(providersOf(ctx), []);

      mod.handle.replace(Config({ providers: { grok: { authMode: 'grok-subscription', displayName: 'Grok Staging' } } }));
      assert.deepEqual(providersOf(ctx), ['grok']);
      assert.equal(ctx.get('llm').listProviders()[0].name, 'Grok Staging');
      assert.equal(ctx.get('llm').listConfigurableProviders()[0].displayName, 'Grok Staging');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('withdraws every registration through handle.dispose', async () => {
    const ctx = await llmContext();
    try {
      const { fetch } = recordingFetch(sseResponse(completedText('ok')));
      const mod = createLlmModule({ oauth: { resolveAccessToken: async () => 'token' }, fetch });
      mod.apply(ctx, Config({ providers: { grok: {} } }));
      assert.deepEqual(providersOf(ctx), ['grok']);

      mod.handle.dispose();
      assert.deepEqual(providersOf(ctx), []);
      assert.deepEqual(ctx.get('llm').listConfigurableProviders(), []);
      await assert.rejects(
        ctx.get('llm').discoverModels('llm-grok', { provider: 'grok' }),
        { code: 'NO_DISCOVERY' },
      );
      mod.handle.dispose();
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('keeps the previous routes after a refused volatile update', async () => {
    const ctx = await llmContext();
    try {
      const raw = { grok: { authMode: 'grok-subscription' } };
      const { fetch } = recordingFetch(sseResponse(completedText('ok')));
      const warnings = [];
      const mod = createLlmModule({
        oauth: { resolveAccessToken: async () => 'token' },
        fetch,
        logger: { warn: (message) => warnings.push(String(message)) },
      });
      mod.apply(ctx, liveConfig(raw));
      assert.deepEqual(providersOf(ctx), ['grok']);

      raw.grok = { authMode: 'grok-subscription', baseURL: 'ftp://broken' };
      mod.handle.replace(liveConfig(raw));
      assert.deepEqual(providersOf(ctx), ['grok']);
      assert.ok(warnings.some((message) => message.includes('keeping the previously registered routes')));
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('fails loud when the llm service is not mounted', () => {
    const ctx = new Context();
    const mod = createLlmModule({ oauth: { resolveAccessToken: async () => 'token' } });
    assert.throws(() => mod.apply(ctx, Config({})), /llm service is not mounted/);
  });

  it('merges the live account catalog over the built-in table', async () => {
    const ctx = await llmContext();
    try {
      const calls = [];
      const fetch = async (url) => {
        calls.push(String(url));
        if (String(url).endsWith('/models')) {
          return Response.json({
            data: [
              { id: 'grok-4.8', name: 'Grok 4.8', context_window: 400_000, max_output_tokens: 64_000 },
              { id: 'grok-4.6', name: 'Grok 4.6 (server)' },
            ],
          });
        }
        return sseResponse(completedText('unused'));
      };
      const mod = createLlmModule({ oauth: { resolveAccessToken: async () => 'token' }, fetch });
      mod.apply(ctx, Config({ providers: { grok: { authMode: 'grok-subscription' } } }));

      const models = await ctx.get('llm').listModels('grok');
      assert.deepEqual(models.map((model) => model.id), [
        'grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5', 'grok-4.8',
      ]);

      const info = await ctx.get('llm').resolveModelInfo('grok', 'grok-4.8');
      assert.equal(info.context.contextWindow, 400_000);
      assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high', 'xhigh']);
      assert.equal(calls.filter((url) => url.endsWith('/models')).length, 1);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('never extends a declared model table with the live catalog', async () => {
    const ctx = await llmContext();
    try {
      let modelFetches = 0;
      const fetch = async (url) => {
        if (String(url).endsWith('/models')) modelFetches += 1;
        return Response.json({ data: [{ id: 'grok-4.8' }] });
      };
      const mod = createLlmModule({ oauth: { resolveAccessToken: async () => 'token' }, fetch });
      mod.apply(ctx, Config({
        providers: { grok: { authMode: 'grok-subscription', models: [{ id: 'grok-custom' }] } },
      }));
      const models = await ctx.get('llm').listModels('grok');
      assert.deepEqual(models.map((model) => model.id), ['grok-custom']);
      assert.equal(modelFetches, 0);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
