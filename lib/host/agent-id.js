/**
 * Stable device identity for Grok subscription model requests.
 *
 * Mirrors grok-build's `$GROK_HOME/agent_id`: an explicit `GROK_AGENT_ID`
 * environment value wins; otherwise the owner-only bare-value file is reused
 * or created once (mode 0600, exclusive create with a race-safe re-read) and
 * memoized per resolved path for the process lifetime.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Process-lifetime cache of resolved ids, keyed by absolute file path. */
const agentIdMemo = new Map();

/**
 * Read one non-empty cached agent id and tighten its Unix mode when possible.
 * @param path - absolute `agent_id` file path.
 * @returns the cached id, or undefined when absent or empty.
 */
function readAgentId(path) {
  let value;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (value.length === 0) return undefined;
  try {
    chmodSync(path, 0o600);
  } catch {
    // A readable id from a foreign-ownership filesystem stays compatible.
  }
  return value;
}

/**
 * Resolve the stable agent id sent as `x-grok-agent-id` on subscription calls.
 *
 * Persistence is best effort so an unwritable home never blocks an otherwise
 * valid model request; the process-stable fallback id keeps retry chains
 * coherent.
 * @param options - optional home, environment, and UUID source for tests.
 * @param options.home - explicit Grok home directory override.
 * @param options.env - environment used to resolve `GROK_AGENT_ID` and `$GROK_HOME`.
 * @param options.randomUUID - UUID generator used only when no id exists yet.
 * @returns the non-empty agent id.
 */
export function getOrCreateGrokAgentId(options = {}) {
  const env = options.env ?? process.env;
  const explicit = typeof env.GROK_AGENT_ID === 'string' ? env.GROK_AGENT_ID.trim() : '';
  if (explicit.length > 0) return explicit;
  const configured = options.home ?? env.GROK_HOME;
  const home = resolve(configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.grok'));
  const path = join(home, 'agent_id');
  const memoized = agentIdMemo.get(path);
  if (memoized !== undefined) return memoized;

  let id = readAgentId(path);
  if (id === undefined) {
    const created = (options.randomUUID ?? randomUUID)();
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // Exclusive create is the atomic first-writer win; a concurrent native
      // process that created the file first makes this throw.
      writeFileSync(path, created, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      id = created;
    } catch {
      id = readAgentId(path);
      if (id === undefined) {
        try {
          writeFileSync(path, created, { encoding: 'utf8', mode: 0o600 });
          chmodSync(path, 0o600);
        } catch {
          // Keep a process-stable id when persistence is unavailable.
        }
        id = created;
      }
    }
  }
  agentIdMemo.set(path, id);
  return id;
}
