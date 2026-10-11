import { captureAccountContextRevision } from '../../accountContextEvents'
import { normalizeAbsoluteWorkspacePath } from '@/lib/workspace-file-path'
import type { RuntimeSubagentListResponse, RuntimeSubagentSummary } from '@/types/subagents'
import { record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

/** Bind every observation/mutation to the task's actual target and account generation. */
export async function agentConnection(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const currentAccount = captureAccountContextRevision()
  const value = await runtime.taskConnection(params)
  const target = text(record(params.address).deviceId) ?? text(params.deviceId)
  if (target && target !== value.server.id) throw new Error('subagent target identity conflict')
  const assertCurrent = () => {
    if (
      !currentAccount(value.server.id) ||
      runtime.disposed ||
      runtime.clientByTask.get(value.taskId) !== value.client
    )
      throw new Error('subagent connection identity changed')
  }
  assertCurrent()
  return { ...value, assertCurrent }
}
function requireCapability(
  client: { supportsExperimental?: (value: string) => boolean },
  capability: string
) {
  if (client.supportsExperimental?.(capability) !== true)
    throw new Error(`KCoder app-server does not support ${capability}`)
}
function agentId(params: Record<string, unknown>) {
  const id = text(params.agentId)
  if (!id) throw new Error('actual subagent identity is required')
  return id
}
export async function listSubagents(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
): Promise<RuntimeSubagentListResponse> {
  const { task, server, client, assertCurrent } = await agentConnection(this, params)
  if (
    client.supportsExperimental?.('agentSteering') !== true &&
    client.supportsExperimental?.('agentArtifactsV1') !== true
  )
    throw new Error('KCoder app-server does not expose Agent discovery or artifacts')
  const result = await client.request<{ threadId: string; agents: RuntimeSubagentSummary[] }>(
    'agent/list',
    { threadId: task.threadId }
  )
  assertCurrent()
  const principal = server.accountIdentity?.principalId
  if (server.security?.identity.mode === 'kcoder-account' && !principal)
    throw new Error('KCoder account identity is unavailable')
  return {
    ...result,
    journalScope: JSON.stringify([
      server.authorityId ?? server.id,
      principal ?? 'compatibility-single-user',
      server.id,
      task.threadId,
    ]),
    capabilities: {
      artifacts: client.supportsExperimental?.('agentArtifactsV1') === true,
      publicTranscript: client.supportsExperimental?.('agentArtifactPagesV1') === true,
      pages: client.supportsExperimental?.('agentArtifactPagesV1') === true,
      live: client.supportsExperimental?.('agentLiveViewV1') === true,
      conversationStream: client.supportsExperimental?.('agentConversationStreamV1') === true,
      receipts: client.supportsExperimental?.('agentCommandReceiptsV1') === true,
      steering: client.supportsExperimental?.('agentSteering') === true,
      stop: client.supportsExperimental?.('agentStopV1') === true,
    },
  }
}
export async function agentRequest(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  method: string,
  capability: string
) {
  const { task, client, assertCurrent } = await agentConnection(this, params)
  requireCapability(client, capability)
  const id = agentId(params)
  const fields: Record<string, unknown> = { threadId: task.threadId, agentId: id }
  if (method === 'agent/live/read' && params.previousRevision !== undefined)
    fields.previousRevision = params.previousRevision
  if (method === 'agent/message/read') fields.clientMessageId = params.clientMessageId
  if (method === 'agent/messages/list') {
    fields.offset = params.offset ?? 0
    fields.limit = params.limit ?? 64
    if (params.receiptEpoch !== undefined) fields.receiptEpoch = params.receiptEpoch
  }
  if (method === 'agent/messages/archive') {
    fields.expectedEpoch = params.expectedEpoch
    fields.confirmedMessageIds = params.confirmedMessageIds
  }
  if (method === 'agent/stop') {
    const expected = record(params.expectedBackgroundRun)
    if (text(expected.agentId) !== id || !text(expected.parentSessionId) || !text(expected.runId))
      throw new Error('subagent stop run identity is required')
    fields.expectedBackgroundRun = expected
  }
  assertCurrent()
  const result = await client.request(method, fields)
  assertCurrent()
  return result
}
export async function readAgentArtifact(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const { task, client, assertCurrent } = await agentConnection(this, params)
  if (client.supportsExperimental?.('agentArtifactsV1') !== true)
    throw new Error('KCoder app-server 不支持 subagent 报告读取')
  const kind = text(params.kind) === 'transcript' ? 'transcript' : 'output'
  const pages = client.supportsExperimental?.('agentArtifactPagesV1') === true
  if (kind === 'transcript' && !pages)
    throw new Error('safe public subagent transcript is unavailable')
  let id: string | undefined = text(params.agentId) ?? undefined
  if (!id) {
    const requestedPath = text(params.path)
    if (!requestedPath) throw new Error('artifact path or actual agent identity is required')
    const normalized = normalizeAbsoluteWorkspacePath(requestedPath, 'invalid artifact path')
    const list = await client.request<{ agents?: RuntimeSubagentSummary[] }>('agent/list', {
      threadId: task.threadId,
    })
    id = list.agents?.find(agent => {
      const candidate = kind === 'transcript' ? agent.transcriptPath : agent.outputPath
      // Windows identities are case insensitive; POSIX identities must retain case.
      const compare = (value: string) => (/^[a-z]:\//i.test(value) ? value.toLowerCase() : value)
      return (
        candidate &&
        compare(normalizeAbsoluteWorkspacePath(candidate, 'invalid artifact path')) ===
          compare(normalized)
      )
    })?.agentId
    if (!id) throw new Error('未找到对应的 subagent 报告')
  }
  assertCurrent()
  const result = await client.request('agent/artifact/read', {
    threadId: task.threadId,
    agentId: id,
    kind,
    ...(pages
      ? {
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.revision !== undefined ? { revision: params.revision } : {}),
          ...(params.tail === true ? { tail: true } : {}),
        }
      : {}),
  })
  assertCurrent()
  return result
}

export async function subscribeAgentConversation(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const { task, server, client, assertCurrent } = await agentConnection(this, params)
  requireCapability(client, 'agentConversationStreamV1')
  const id = agentId(params)
  const subscriptionId = text(params.subscriptionId)
  if (!subscriptionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(subscriptionId))
    throw new Error('invalid subagent conversation subscription')
  if (this.agentConversationSubscriptions.has(subscriptionId))
    throw new Error('subagent subscription already exists')
  const onClose = () => {
    const current = this.agentConversationSubscriptions.get(subscriptionId)
    if (current?.client !== client) return
    this.agentConversationSubscriptions.delete(subscriptionId)
    void import('../../gatewayServiceBridge').then(({ emitRuntimeEvent }) =>
      emitRuntimeEvent('local-executor:event', {
        event: 'response.subagent.conversation',
        payload: {
          deviceId: server.id,
          taskId: task.taskId,
          data: {
            type: 'disconnected',
            threadId: task.threadId,
            agentId: id,
            subscriptionId,
            reason: 'connection_lost',
          },
        },
      })
    )
  }
  client.addEventListener('close', onClose, { once: true })
  this.agentConversationSubscriptions.set(subscriptionId, {
    client,
    serverId: server.id,
    taskId: task.taskId,
    threadId: task.threadId,
    agentId: id,
    assertCurrent,
    removeCloseListener: () => client.removeEventListener('close', onClose),
  })
  try {
    const result = await client.request('agent/stream/subscribe', {
      threadId: task.threadId,
      agentId: id,
      subscriptionId,
    })
    assertCurrent()
    return result
  } catch (error) {
    client.removeEventListener('close', onClose)
    this.agentConversationSubscriptions.delete(subscriptionId)
    void client.request('agent/stream/unsubscribe', { subscriptionId }).catch(() => undefined)
    throw error
  }
}
export async function unsubscribeAgentConversation(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const id = text(params.subscriptionId)
  const owned = id ? this.agentConversationSubscriptions.get(id) : undefined
  if (!id || !owned) return { unsubscribed: false }
  const target = text(record(params.address).deviceId)
  if (target !== owned.serverId || text(record(params.address).taskId) !== owned.taskId)
    throw new Error('subagent unsubscribe identity conflict')
  owned.removeCloseListener?.()
  this.agentConversationSubscriptions.delete(id)
  return owned.client.request('agent/stream/unsubscribe', { subscriptionId: id })
}
