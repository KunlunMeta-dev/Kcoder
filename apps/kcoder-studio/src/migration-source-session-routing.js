import { PROJECT_SOURCE_METHODS } from './migration-project-query.js';
import { isContract } from '../shared/generated/validator.mjs';
import { MigrationSourceBridgeError } from './migration-source-private.js';
import { INSTRUCTION_METHODS } from '../shared/migrationInstructions.mjs';

const purposes = Object.freeze({ source: 'source', target: 'target', target_recovery: 'target-recovery' });
const fail = code => { throw new MigrationSourceBridgeError(code); };

/** Called only after HTTP authentication and Origin checks. resolveSelection
 * must resolve configured targets and current authority from Gateway state. */
export async function routeMigrationSourceSession(operation, payload, { owner, resolveSelection }) {
  if (!['open', 'read', 'close', 'query'].includes(operation)) fail('source_transfer_invalid_request');
  const schema = operation === 'query' ? 'MigrationSourceSessionQueryParams' : operation === 'open' ? 'MigrationSourceSessionOpenParams' : 'MigrationSourceSessionParams';
  if (!isContract(schema, payload)) fail('source_transfer_invalid_request');
  const query = operation === 'query' ? payload.query : null;
  payload = operation === 'query' ? payload.session : payload;
  const resolved = await resolveMigrationSourceSelection(payload, resolveSelection);
  const options = { sessionId: payload.sessionId, purpose: purposes[payload.purpose], ...resolved };
  if (query) {
    if (payload.purpose !== 'source') fail('source_transfer_method_unavailable');
    const method = { ...PROJECT_SOURCE_METHODS, instructions_capture: INSTRUCTION_METHODS.capture, instructions_page: INSTRUCTION_METHODS.page, instructions_body: INSTRUCTION_METHODS.body, configuration: 'migration/discover', plugins: 'migration/plugin/discover', definitions: 'migration/definitions/discover', source_bindings: 'migration/source/bindings', history: 'migration/history/discover', history_families: 'migration/history/families/discover', history_page: 'migration/history/sources',
      configuration_layers_read: 'migration/configuration/layers', codex_layers_select: 'migration/codex/layers/select', codex_layers_read: 'migration/codex/layers/read',
      directory_select: 'migration/source/directory/select', uploaded_select: 'migration/source/upload/select', memory: 'migration/memory/discover', memory_page: 'migration/memory/sources' }[query.kind];
    const params = query.kind === 'instructions_page' ? { target: { kind: 'source', captureId: query.params.captureId }, pageIndex: query.params.pageIndex ?? 0 }
      : query.kind === 'instructions_body' ? { target: { kind: 'source', captureId: query.params.captureId }, itemId: query.params.itemId, representation: query.params.representation, offset: query.params.offset ?? 0 }
      : ['codex_layers_read', 'configuration_layers_read'].includes(query.kind) ? { target: { kind: 'source', sourceId: query.params.sourceId }, pageIndex: query.params.pageIndex ?? 0 } : query.params;
    return owner.request(options, method, params);
  }
  if (operation === 'close') return owner.release(options);
  if (operation === 'open') await owner.open(options);
  return owner.read(options);
}

/** Shared by session and operation routes; resolveSelection is trusted Gateway composition. */
export async function resolveMigrationSourceSelection(payload, resolveSelection) {
  if (payload.targetId.length > 256 || !payload.targetId.trim() ||
      /[\p{Cc}]/u.test(payload.targetId) || (payload.workspacePath !== undefined &&
      (payload.workspacePath === null || payload.workspacePath.length > 2048 || !payload.workspacePath.trim() ||
       /[\p{Cc}]/u.test(payload.workspacePath)))) fail('source_transfer_invalid_request');
  // Pass a fresh selector only, not the original request object or authority-shaped fields.
  const resolved = await resolveSelection({ targetId: payload.targetId, workspacePath: payload.workspacePath });
  if (!resolved?.target || resolved.target.id !== payload.targetId || typeof resolved.captureCurrent !== 'function' ||
      resolved.workspacePath !== payload.workspacePath) fail('source_transfer_authority_unavailable');
  return resolved;
}
