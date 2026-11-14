/**
 * Stable agent-id resolution: GROK_AGENT_ID priority, owner-only file
 * creation, and per-path memoization.
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getOrCreateGrokAgentId } from '../../../lib/host/agent-id.js';

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'grok-agent-id-'));
}

describe('Grok agent id', () => {
  it('prefers an explicit GROK_AGENT_ID environment value', () => {
    assert.equal(getOrCreateGrokAgentId({ env: { GROK_AGENT_ID: 'explicit-agent' }, home: '/nonexistent' }), 'explicit-agent');
    assert.equal(getOrCreateGrokAgentId({ env: { GROK_AGENT_ID: '  padded  ' }, home: '/nonexistent' }), 'padded');
    assert.equal(getOrCreateGrokAgentId({ env: { GROK_AGENT_ID: '   ' }, home: '/nonexistent-grok-agent-test', randomUUID: () => 'fallback' }), 'fallback');
  });

  it('creates the owner-only cache file once and reuses it', async () => {
    const home = await tempHome();
    let generated = 0;
    const first = getOrCreateGrokAgentId({
      env: {},
      home,
      randomUUID: () => `generated-${generated += 1}`,
    });
    assert.equal(first, 'generated-1');
    assert.equal(await readFile(join(home, 'agent_id'), 'utf8'), 'generated-1');
    if (process.platform !== 'win32') {
      const mode = (await stat(join(home, 'agent_id'))).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    const second = getOrCreateGrokAgentId({
      env: {},
      home,
      randomUUID: () => {
        throw new Error('a memoized id must not regenerate');
      },
    });
    assert.equal(second, 'generated-1');
  });

  it('reuses a pre-existing native agent_id and never regenerates', async () => {
    const home = await tempHome();
    await writeFile(join(home, 'agent_id'), 'native-agent\n', 'utf8');
    const id = getOrCreateGrokAgentId({
      env: {},
      home,
      randomUUID: () => {
        throw new Error('an existing file must be reused');
      },
    });
    assert.equal(id, 'native-agent');
  });

  it('keeps separate homes independent', async () => {
    const homeA = await tempHome();
    const homeB = await tempHome();
    const a = getOrCreateGrokAgentId({ env: {}, home: homeA, randomUUID: () => 'agent-a' });
    const b = getOrCreateGrokAgentId({ env: {}, home: homeB, randomUUID: () => 'agent-b' });
    assert.equal(a, 'agent-a');
    assert.equal(b, 'agent-b');
  });

  it('resolves $GROK_HOME from the environment when no home is given', async () => {
    const home = await tempHome();
    const id = getOrCreateGrokAgentId({ env: { GROK_HOME: home }, randomUUID: () => 'env-home-agent' });
    assert.equal(id, 'env-home-agent');
    assert.equal(await readFile(join(home, 'agent_id'), 'utf8'), 'env-home-agent');
  });
});
