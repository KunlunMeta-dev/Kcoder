import { routeMigrationSourceSession } from './migration-source-session-routing.js';
import { MigrationSourceBridgeError } from './migration-source-private.js';

/** This handler is mounted after the Gateway's normal authentication gate. */
export function createMigrationSourceSessionHttp({ owner, requireSameOriginMutation, requestBody, jsonResponse, resolveSelection }) {
  return async ({ pathname, request, response, authSession }) => {
    const match = /^\/api\/migration\/source-session\/(open|read|close|query)$/.exec(pathname);
    if (!match) return false;
    if (!authSession) { jsonResponse(response, 401, { error: 'Authentication required' }); return true; }
    if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method not allowed' }); return true; }
    if (!requireSameOriginMutation(request)) { jsonResponse(response, 403, { error: 'Same-origin JSON request required' }); return true; }
    let payload;
    try { payload = JSON.parse(await requestBody(request, 64 * 1024)); }
    catch { jsonResponse(response, 400, { error: 'source_transfer_invalid_request' }); return true; }
    try {
      const result = await routeMigrationSourceSession(match[1], payload, {
        owner, resolveSelection: selection => resolveSelection({ request, authSession, selection }),
      });
      jsonResponse(response, 200, result);
    } catch (error) {
      const code = error instanceof MigrationSourceBridgeError && /^source_transfer_[a-z_]+$/.test(error.reason)
        ? error.reason : 'source_transfer_outcome_unknown';
      jsonResponse(response, code === 'source_transfer_invalid_request' ? 400 : 409, { error: code });
    }
    return true;
  };
}
