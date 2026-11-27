import { isContract } from '../shared/generated/validator.mjs';
import { routeMigrationSourceCredential, validMigrationSourceCredentialResult } from './migration-source-credential-routing.js';
import { routeMigrationSourceOperation, validMigrationSourceOperationResult } from './migration-source-operation-routing.js';
import { MigrationSourceBridgeError } from './migration-source-private.js';

/** Mount after authentication, only with a durable operation service. */
export function createMigrationSourceOperationHttp({ service, requireSameOriginMutation, requestBody, jsonResponse, resolveSelection }) {
  return async ({ pathname, request, response, authSession }) => {
    const match = /^\/api\/migration\/source-transfer\/(run|read|cancel|target-read|target-cancel|target-resume|target-finish|received|adoption-prepare|adoption-read|adoption-resume|adoption-cancel)$/.exec(pathname);
    const privateMatch = /^\/api\/migration\/source-transfer\/private\/(candidates|run|read|source-read|prepare-status|cancel|resume|prepare|release)$/.exec(pathname);
    if (!match && !privateMatch) return false;
    const operation = (privateMatch ?? match)[1];
    if (!authSession) { jsonResponse(response, 401, { error: 'Authentication required' }); return true; }
    if (request.method !== 'POST') { jsonResponse(response, 405, { error: 'Method not allowed' }); return true; }
    if (!requireSameOriginMutation(request)) { jsonResponse(response, 403, { error: 'Same-origin JSON request required' }); return true; }
    let payload;
    try { payload = JSON.parse(await requestBody(request, (privateMatch ? 256 : 64) * 1024)); }
    catch { jsonResponse(response, 400, { error: privateMatch ? 'private_credentials_invalid_request' : 'source_transfer_invalid_request' }); return true; }
    try {
      const route = privateMatch ? routeMigrationSourceCredential : routeMigrationSourceOperation;
      const result = await route(operation, payload, {
        service, resolveSelection: selection => resolveSelection({ request, authSession, selection }),
      });
      const valid = privateMatch ? validMigrationSourceCredentialResult : validMigrationSourceOperationResult;
      if (!valid(operation, payload, result)) {
        throw new MigrationSourceBridgeError(privateMatch ? 'private_credentials_invalid_response' : 'source_transfer_invalid_response');
      }
      jsonResponse(response, 200, result);
    } catch (error) {
      const privateCode = privateMatch && error instanceof MigrationSourceBridgeError
        && isContract('MigrationSourceCredentialError', error.reason);
      const code = privateCode ? error.reason : privateMatch ? 'private_credentials_outcome_unknown'
        : error instanceof MigrationSourceBridgeError && /^source_transfer_[a-z_]+$/.test(error.reason)
          ? error.reason : 'source_transfer_outcome_unknown';
      jsonResponse(response, ['source_transfer_invalid_request', 'private_credentials_invalid_request'].includes(code) ? 400 : 409, { error: code });
    }
    return true;
  };
}
