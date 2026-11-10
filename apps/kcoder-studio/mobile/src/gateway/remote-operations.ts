import { isContract } from '../../../shared/generated/validator.mjs';
import { isRemoteOperationControlReply, isRemoteOperationListReply } from '../../../shared/remotes/controlContracts.mjs';
import type { IntegrationScope } from '../../../shared/generated/contracts.integrations-core';
import type { RemoteOperationControlMethod, RemoteOperationControlParams, RemoteOperationControlReply, RemoteOperationListReply } from '../../../shared/generated/contracts.integrations-remotes';
import type { GatewayRpcClient } from './rpc';
import type { GatewayProfile, KCoderServer } from './types';

export class MobileRemoteOperationError extends Error {
  readonly code: string; readonly uncertain: boolean;
  constructor(code: string, uncertain = false) { super(code); this.code = code; this.uncertain = uncertain; }
}
/** Current authenticated mobile connection only; unknown cancellation is never replayed. */
export class MobileRemoteOperations {
  private scope?: IntegrationScope;
  private readonly client: GatewayRpcClient; private readonly profile: GatewayProfile;
  private readonly server: KCoderServer; private readonly workspacePath: string;
  constructor(client: GatewayRpcClient, profile: GatewayProfile, server: KCoderServer, workspacePath: string) {
    this.client = client; this.profile = profile; this.server = server; this.workspacePath = workspacePath;
  }
  private check() {
    if (!this.client.matchesRuntimeOwner(this.profile, this.server, this.workspacePath)) throw new MobileRemoteOperationError('REMOTE_CONTROL_OWNER_CHANGED');
    if (!this.client.supportsExperimental('integrationScopeV1') || !this.client.supportsExperimental('remoteOperationControlV1'))
      throw new MobileRemoteOperationError('REMOTE_CONTROL_UPGRADE_REQUIRED');
  }
  private async run(method: RemoteOperationControlMethod, requestId: string, operationId: string, expectedRevision?: number): Promise<RemoteOperationControlReply> {
    this.check();
    if (!this.scope) {
      const scope = await this.client.request('integrations/scope/read', {}, 5000);
      this.check();
      if (!isContract('IntegrationScope', scope)) throw new MobileRemoteOperationError('REMOTE_CONTROL_SCOPE_INVALID');
      this.scope = Object.freeze(structuredClone(scope as IntegrationScope));
    }
    const params: RemoteOperationControlParams = { requestId, scope: this.scope, operationId,
      ...(expectedRevision === undefined ? {} : { expectedRevision }) };
    this.check();
    let reply: unknown;
    try { reply = await this.client.request(method, { ...params }, 5000); }
    catch { throw new MobileRemoteOperationError('REMOTE_CONTROL_OUTCOME_UNKNOWN', method === 'integrations/remotes/cancelOperation'); }
    this.check();
    if (!isRemoteOperationControlReply(reply) || reply.requestId !== requestId || reply.operationId !== operationId ||
      ['accountId', 'targetId', 'workspaceId', 'identityGeneration', 'targetRevision', 'organizationId']
        .some(key => JSON.stringify((reply.scope as unknown as Record<string, unknown>)[key]) !== JSON.stringify((this.scope as unknown as Record<string, unknown>)[key])))
      throw new MobileRemoteOperationError('REMOTE_CONTROL_INVALID_REPLY', method === 'integrations/remotes/cancelOperation');
    return reply;
  }
  async recent(requestId: string): Promise<RemoteOperationListReply> {
    this.check();
    if (!this.scope) {
      const scope = await this.client.request('integrations/scope/read', {}, 5000); this.check();
      if (!isContract('IntegrationScope', scope)) throw new MobileRemoteOperationError('REMOTE_CONTROL_SCOPE_INVALID');
      this.scope = Object.freeze(structuredClone(scope as IntegrationScope));
    }
    const reply = await this.client.request('integrations/remotes/listOperations', { requestId, scope: this.scope }, 5000);
    this.check();
    if (!isRemoteOperationListReply(reply) || reply.requestId !== requestId || reply.items.length > 10 || reply.total < reply.items.length ||
      ['accountId', 'targetId', 'workspaceId', 'identityGeneration', 'targetRevision', 'organizationId']
        .some(key => JSON.stringify((reply.scope as unknown as Record<string, unknown>)[key]) !== JSON.stringify((this.scope as unknown as Record<string, unknown>)[key])))
      throw new MobileRemoteOperationError('REMOTE_CONTROL_INVALID_REPLY');
    return reply;
  }
  read(requestId: string, operationId: string) { return this.run('integrations/remotes/readOperation', requestId, operationId); }
  cancel(requestId: string, operationId: string, expectedRevision: number) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) return Promise.reject(new MobileRemoteOperationError('REMOTE_CONTROL_REVISION_REQUIRED'));
    return this.run('integrations/remotes/cancelOperation', requestId, operationId, expectedRevision);
  }
}
