import type { GatewayRuntimeCore } from './gateway/runtime/core'
import { record, text } from './gateway/runtime/contracts'
import { requestNativeIntegration } from './gatewayIntegrations'
import { captureAccountContextRevision } from './accountContextEvents'
import { hookTargetScope } from './gatewayHookConfiguration'
import { createRandomUuid } from '@/lib/random-id'
import { isContract } from '../../../shared/generated/validator.mjs'
import type { IntegrationScope, IntegrationReply } from '../../../shared/generated/contracts'

/** Resolve browser labels through their actual target; callers cannot route by a guessed ID. */
export async function browserProfiles(this: GatewayRuntimeCore, raw: unknown): Promise<unknown> {
  const args = record(raw)
  const label = text(args.label) ?? 'workspace-browser'
  const action = text(args.action) ?? 'list'
  const methods: Record<string, string> = {
    list: 'integrations/browserProfiles/list',
    save: 'integrations/browserProfiles/save',
    archive: 'integrations/browserProfiles/setArchived',
  }
  const method = methods[action]
  if (!method) throw new Error('BROWSER_PROFILE_METHOD_UNSUPPORTED')
  const accountCurrent = captureAccountContextRevision()
  const generation = this.workspaceScanGeneration
  const server = await this.serverForBrowserLabel(label)
  const identity = hookTargetScope(server)
  const assertCurrent = async () => {
    if (
      this.disposed ||
      generation !== this.workspaceScanGeneration ||
      !accountCurrent(server.id) ||
      hookTargetScope(await this.serverForBrowserLabel(label)) !== identity
    )
      throw new Error('BROWSER_PROFILE_OWNER_CHANGED')
  }
  await assertCurrent()
  const client = await this.commandClient(server, server.workspacePath)
  await assertCurrent()
  if (
    client.supportsExperimental?.('browserProfilesV1') !== true ||
    client.supportsExperimental?.('browserProfileSessionsV1') !== true
  )
    return { available: false, targetId: server.id, targetLabel: server.label }
  const scope = (await requestNativeIntegration.call(this, {
    method: 'integrations/scope/read',
    serverId: server.id,
    workspacePath: server.workspacePath,
    params: {},
  })) as IntegrationScope
  await assertCurrent()
  const scopeKey = (value: IntegrationScope) =>
    JSON.stringify([
      value.accountId,
      value.targetId,
      value.workspaceId,
      value.identityGeneration,
      value.targetRevision,
      value.organizationId ?? null,
    ])
  if (
    args.scope != null &&
    (!isContract('IntegrationScope', args.scope) ||
      scopeKey(args.scope as IntegrationScope) !== scopeKey(scope))
  )
    throw new Error('BROWSER_PROFILE_OWNER_CHANGED')
  if (action !== 'list' && !args.scope) throw new Error('BROWSER_PROFILE_OWNER_REQUIRED')
  const payload = record(args.payload)
  const inputContract =
    action === 'list'
      ? 'BrowserProfilesListParams'
      : action === 'save'
        ? 'BrowserProfilesSaveParams'
        : 'BrowserProfilesArchiveParams'
  if (!isContract(inputContract, payload)) throw new Error('BROWSER_PROFILE_REQUEST_INVALID')
  const operation = action === 'list' ? undefined : text(args.operationId)
  if (action !== 'list' && !operation) throw new Error('BROWSER_PROFILE_OPERATION_REQUIRED')
  const reply = (await requestNativeIntegration.call(this, {
    method,
    serverId: server.id,
    workspacePath: server.workspacePath,
    params: {
      contractVersion: 'parallel-v1',
      requestId: createRandomUuid(),
      scope,
      timeoutMs: 1000,
      ...(operation ? { operationId: operation } : {}),
      payload,
    },
  })) as IntegrationReply
  await assertCurrent()
  if (reply.status !== 'completed' || !reply.result)
    throw new Error(reply.error?.code ?? 'BROWSER_PROFILE_UNCONFIRMED')
  const result = record(reply.result)
  const data = action === 'list' ? result.page : result.profile
  if (!isContract(action === 'list' ? 'BrowserAccountProfilePage' : 'BrowserAccountProfile', data))
    throw new Error('BROWSER_PROFILE_REPLY_INVALID')
  return { available: true, targetId: server.id, targetLabel: server.label, scope, ...result }
}
