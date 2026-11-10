import { MigrationSourceTransferService } from './migration-source-transfer-service.js';
import { createMigrationSourceOperationHttp } from './migration-source-operation-http.js';
import { createHash } from 'node:crypto';
import { MigrationSourceSessionOwner } from './migration-source-session-owner.js';
import { createMigrationSourceSessionLauncher } from './migration-source-session-launch.js';
import { createMigrationSourceSessionHttp } from './migration-source-session-http.js';
import { MigrationSourceBridgeError } from './migration-source-private.js';
import { authenticatedAccountProcess } from './account-process.js';

export function createGatewayMigrationSourceSessions({ maxMessageBytes, trackAppServerChild, loginContexts,
  closeContextSockets, requireSameOriginMutation, requestBody, jsonResponse, requestLoginOwner,
  authenticatedSessionId, authSessionById, getTarget, serverHealthSignature, isMock }) {
  const migrationSourceSessions = new MigrationSourceSessionOwner({
    launch: createMigrationSourceSessionLauncher({
      maxMessageBytes,
      trackChild: (child, target, scope) => trackAppServerChild(child, target.id, scope.ownerId),
      authenticate: (child, { target, workspacePath, capturedScope }) => {
        const owner = capturedScope.ownerId;
        const identity = loginContexts.identity(owner, target.id);
        const authentication = loginContexts.credential(owner, target.id);
        if (!authentication || identity?.principalId !== capturedScope.principal.principalId ||
            loginContexts.generation(owner, target.id) !== capturedScope.generation) {
          throw new MigrationSourceBridgeError('source_transfer_authority_changed');
        }
        return authenticatedAccountProcess(child, { ...authentication, workspace: workspacePath || target.remoteCwd }, {
          onAuthenticated: principal => {
            if (principal.principalId !== identity.principalId ||
                loginContexts.generation(owner, target.id) !== capturedScope.generation ||
                loginContexts.identity(owner, target.id)?.principalId !== identity.principalId) {
              return false;
            }
          },
          onFailure: ({ authenticationRejected }) => {
            if (authenticationRejected && loginContexts.generation(owner, target.id) === capturedScope.generation) {
              loginContexts.invalidate(owner, target.id);
              closeContextSockets(owner, target.id);
            }
          },
        });
      },
    }),
  });
  const transfers = new MigrationSourceTransferService({ owner: migrationSourceSessions });
  let migrationSourceSweepPending = false;
  const migrationSourceSweep = setInterval(() => {
    if (migrationSourceSweepPending) return;
    migrationSourceSweepPending = true;
    transfers.sweep().then(() => migrationSourceSessions.sweep()).catch(() => {}).finally(() => { migrationSourceSweepPending = false; });
  }, 1000);
  migrationSourceSweep.unref();
  const resolveSelection = ({ request, authSession, selection }) => {
      const loginOwner = requestLoginOwner(request, authSession);
      const credential = authenticatedSessionId(request);
      const target = getTarget(selection.targetId);
      const captureCurrent = () => {
        const currentSession = authSessionById(credential);
        const currentTarget = getTarget(selection.targetId);
        if (isMock() || !loginOwner || !currentTarget || !currentSession?.allowedServerIds.has(selection.targetId) ||
            requestLoginOwner(request, currentSession) !== loginOwner) {
          throw new MigrationSourceBridgeError('source_transfer_authority_unavailable');
        }
        const identity = currentTarget.security ? loginContexts.identity(loginOwner, currentTarget.id) : null;
        if (currentTarget.security && !identity) throw new MigrationSourceBridgeError('source_transfer_authority_unavailable');
        return { ownerId: loginOwner,
          generation: currentTarget.security ? loginContexts.generation(loginOwner, currentTarget.id) : 0,
          targetFingerprint: createHash('sha256').update(JSON.stringify([serverHealthSignature(currentTarget), selection.workspacePath ?? null])).digest('hex'),
          principal: identity ? { kind: 'verifiedAccount', principalId: identity.principalId } : { kind: 'localOs' } };
      };
      captureCurrent();
      return { target, workspacePath: selection.workspacePath, captureCurrent };
  };
  const migrationSourceSessionHandler = createMigrationSourceSessionHttp({
    owner: migrationSourceSessions, requireSameOriginMutation, requestBody, jsonResponse, resolveSelection,
  });
  const transferHandler = createMigrationSourceOperationHttp({
    service: transfers, requireSameOriginMutation, requestBody, jsonResponse, resolveSelection,
  });
  return { async handle(args) {
    return await migrationSourceSessionHandler(args) || await transferHandler(args);
  }, async close() {
    clearInterval(migrationSourceSweep);
    await transfers.close();
    await migrationSourceSessions.close();
  } };
}
