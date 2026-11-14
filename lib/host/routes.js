/**
 * Same-origin HTTP routes of the plugin's Host half.
 *
 * The Client bundle calls these routes with `fetch`; every route answers
 * `{ data }` on success and `{ error: { code, message } }` with a non-2xx status
 * on failure. Upstream credentials never leave the Host process.
 */
import { HostError, readJsonBody, sendError, sendJson } from './http.js';
import { ROUTE_PREFIX } from './constants.js';

/** True when the request method equals `expected`. */
function isMethod(request, expected) {
  return (request.method ?? 'GET').toUpperCase() === expected;
}

/** Answer 405 with the allowed method set. */
function methodNotAllowed(response, allowed) {
  response.writeHead(405, { allow: allowed.join(', ') });
  response.end();
}

/** Read an optional boolean query flag (`1`/`true`). */
function queryFlag(url, name) {
  const value = url.searchParams.get(name);
  return value === '1' || value === 'true';
}

/** Validate a flow id query parameter. */
function readFlowId(url) {
  const flowId = url.searchParams.get('flowId') ?? '';
  if (flowId === '') return undefined;
  if (flowId.length > 64) {
    throw new HostError('invalid_request', 'flowId must be at most 64 characters', { status: 400 });
  }
  return flowId;
}

/**
 * Wrap one async route handler: require an authenticated browser session,
 * reject unknown methods, map HostError to its response, and log unexpected
 * failures without response details.
 *
 * The routes live on the raw Web server, which bypasses the connection
 * carrier's authentication gate; `connection.requestRejection` restores that
 * gate (browser cookie plus Host/Origin fence) so a LAN peer that merely
 * reaches the port cannot read account data.
 * @param handler - async (request, response) implementer.
 * @param connectionOf - optional getter for the Host connection service.
 * @returns the webServer route handler.
 */
function routeHandler(handler, connectionOf) {
  return async (request, response) => {
    try {
      const connection = connectionOf?.();
      const rejection = connection?.requestRejection?.(request);
      if (rejection !== undefined) {
        response.writeHead(rejection, {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
        });
        response.end(rejection === 401 ? 'unauthorized\n' : 'forbidden\n');
        return;
      }
      await handler(request, response);
    } catch (error) {
      if (!(error instanceof HostError)) {
        console.error('grok-balance: unexpected route failure', error);
      }
      sendError(response, error);
    }
  };
}

/**
 * Register the plugin's routes on the Web server.
 * @param options - webServer service, optional connection service getter, plugin state modules, and logger.
 * @returns disposer removing every route.
 */
export function registerRoutes(options) {
  const { webServer, store, snapshot, connection } = options;
  const disposers = [];
  const route = (path, handler) => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}${path}`,
      handler: routeHandler(handler, connection),
    }));
  };

  route('/api/status', async (request, response) => {
    if (!isMethod(request, 'GET')) return methodNotAllowed(response, ['GET']);
    sendJson(response, 200, { data: await snapshot.status() });
  });

  route('/api/login', async (request, response) => {
    if (!isMethod(request, 'POST')) return methodNotAllowed(response, ['POST']);
    sendJson(response, 200, { data: await snapshot.startLogin() });
  });

  route('/api/login/poll', async (request, response) => {
    if (!isMethod(request, 'GET')) return methodNotAllowed(response, ['GET']);
    const url = new URL(request.url ?? '/', 'http://localhost');
    const status = await snapshot.loginStatus(readFlowId(url));
    if (status === undefined) {
      throw new HostError('unknown_flow', 'Unknown login flow', { status: 404 });
    }
    sendJson(response, 200, { data: status });
  });

  route('/api/logout', async (request, response) => {
    if (!isMethod(request, 'POST')) return methodNotAllowed(response, ['POST']);
    await snapshot.logout();
    sendJson(response, 200, { data: { ok: true } });
  });

  route('/api/config', async (request, response) => {
    if (!isMethod(request, 'POST')) return methodNotAllowed(response, ['POST']);
    const body = await readJsonBody(request);
    const next = store.writeConfig(body);
    snapshot.invalidate('config');
    sendJson(response, 200, { data: next });
  });

  route('/api/overview', async (request, response) => {
    if (!isMethod(request, 'GET')) return methodNotAllowed(response, ['GET']);
    sendJson(response, 200, {
      data: await snapshot.overview({ force: queryFlag(new URL(request.url ?? '/', 'http://localhost'), 'force') }),
    });
  });

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
