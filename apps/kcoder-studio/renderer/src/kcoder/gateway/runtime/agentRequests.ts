import { captureAccountContextRevision } from '../../accountContextEvents'
import { normalizeAbsoluteWorkspacePath } from '@/lib/workspace-file-path'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { sharePendingRead, type PendingRead } from '@/lib/pendingRead'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { RuntimeSubagentListResponse, RuntimeSubagentSummary } from '@/types/subagents'
import { record, text, type GatewayTask } from './contracts'
import type { GatewayRuntimeCore } from './core'
import { requestResidentTaskRpc } from './threadResidency'
import {
  isAgentArtifactReadResult,
  isAgentLiveReadResult,
  isAgentMessageReadResult,
} from '../../../../../shared/generated/contractGuards.mjs'
import {
  agentConnection,
  exactAgentUnavailable,
  requestedAgentRun,
  sameAgentRun,
  verifyAgentReply,
} from './agentRunConstraint'

type AgentList = { threadId: string; agents: RuntimeSubagentSummary[] }
interface AgentListRead {
  assertCurrent: () => void
  pending: Map<string, PendingRead<AgentList>>
}
const agentLists = new WeakMap<GatewayRuntimeCore, Map<string, AgentListRead>>()

export function invalidateAgentList(runtime: GatewayRuntimeCore, taskId: string) {
  agentLists.get(runtime)?.delete(taskId)
}

/** Recovery and panel discovery share only an unfinished original-task read. */
export async function readAgentList(runtime: GatewayRuntimeCore, task: GatewayTask, client: GatewayClient): Promise<AgentList> {
  const { taskId, serverId, threadId, workspacePath } = task
  const account = captureAccountContextRevision(), configuration = runtime.configurationEpochByTarget.get(serverId)
  const connection = client.diagnosticConnection?.connectionId
  const assertCurrent = () => {
    const current = runtime.tasks.get(taskId)
    if (runtime.disposed || !account(serverId) || runtime.configurationEpochByTarget.get(serverId) !== configuration ||
      runtime.clientByTask.get(taskId) !== client || runtime.appServerDisconnectedClients.has(client) ||
      client.diagnosticConnection?.connectionId !== connection ||
      current?.serverId !== serverId || current.threadId !== threadId ||
      !sameWorkspacePath(current.workspacePath, workspacePath)) throw new Error('subagent list owner changed')
  }
  assertCurrent()
  const reads = agentLists.get(runtime) ?? new Map<string, AgentListRead>()
  agentLists.set(runtime, reads)
  let scope = reads.get(taskId)
  try { scope?.assertCurrent() } catch { scope = undefined }
  if (!scope) {
    scope = { assertCurrent: () => {
      assertCurrent()
      if (reads.get(taskId) !== scope) throw new Error('subagent list changed during read')
    }, pending: new Map() }
    reads.set(taskId, scope)
  }
  const currentScope = scope
  try {
    const result = await sharePendingRead(scope.pending, threadId, undefined, async signal => {
      currentScope.assertCurrent()
      try { return await requestResidentTaskRpc<AgentList>(runtime, task, client, 'agent/list', {}, { signal, assertCurrent: currentScope.assertCurrent }) }
      finally { currentScope.assertCurrent() }
    })
    assertCurrent()
    return structuredClone(result)
  } finally {
    if (scope.pending.size === 0 && reads.get(taskId) === scope) reads.delete(taskId)
  }
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
  const expected = requestedAgentRun(params)
  const { task, server, client, assertCurrent } = await agentConnection(this, params, expected)
  if (
    client.supportsExperimental?.('agentSteering') !== true &&
    client.supportsExperimental?.('agentArtifactsV1') !== true
  )
    throw new Error('KCoder app-server does not expose Agent discovery or artifacts')
  const result = await readAgentList(this, task, client)
  assertCurrent()
  if (
    expected &&
    (result.threadId !== expected.parentSessionId ||
      !result.agents.some(
        agent => agent.agentId === expected.agentId && sameAgentRun(agent.backgroundRun, expected)
      ))
  )
    throw exactAgentUnavailable()
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
      exactRun: client.supportsExperimental?.('agentExactRunV1') === true,
      exactControl: client.supportsExperimental?.('agentExactControlV1') === true,
      exactContinuation: client.supportsExperimental?.('agentExactContinuationV1') === true,
    },
  }
}
export async function agentRequest(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  method: string,
  capability: string
) {
  const expected = requestedAgentRun(params)
  if (expected && !['agent/live/read', 'agent/stop', 'agent/message/read'].includes(method)) throw exactAgentUnavailable()
  const { task, client, assertCurrent } = await agentConnection(this, params, expected,
    method === 'agent/stop' ? 'agentStopV1' : method === 'agent/message/read' ? 'agentExactControlV1' : 'agentExactRunV1')
  requireCapability(client, capability)
  const id = agentId(params)
  const fields: Record<string, unknown> = { threadId: task.threadId, agentId: id }
  if (expected) fields.expectedBackgroundRun = expected
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
  const mutation = method === 'agent/stop' || method === 'agent/messages/archive'
  if (mutation) invalidateAgentList(this, task.taskId)
  let result: unknown
  try { result = method === 'agent/live/read' || method === 'agent/stop'
    ? await requestResidentTaskRpc(this, task, client, method, fields, { assertCurrent })
    : await client.request(method, fields) }
  finally { if (mutation) invalidateAgentList(this, task.taskId) }
  assertCurrent()
  if (expected) {
    if (method === 'agent/live/read') {
      if (!isAgentLiveReadResult(result)) throw exactAgentUnavailable()
      verifyAgentReply(result, expected)
    } else if (method === 'agent/message/read') {
      if (!isAgentMessageReadResult(result) || result.threadId !== expected.parentSessionId
        || result.agentId !== expected.agentId || result.clientMessageId !== params.clientMessageId
        || (result.receipt && !sameAgentRun(result.receipt.backgroundRun, expected))) throw exactAgentUnavailable()
    } else {
      const value = record(result)
      if (value.threadId !== expected.parentSessionId || value.agentId !== expected.agentId
        || !sameAgentRun(value.expectedBackgroundRun, expected)) throw exactAgentUnavailable()
    }
  }
  return result
}
export async function readAgentArtifact(this: GatewayRuntimeCore, params: Record<string, unknown>) {
  const expected = requestedAgentRun(params)
  const { task, client, assertCurrent } = await agentConnection(this, params, expected)
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
    const list = await readAgentList(this, task, client)
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
  const result = await requestResidentTaskRpc(this, task, client, 'agent/artifact/read', {
    agentId: id,
    kind,
    ...(expected ? { expectedBackgroundRun: expected } : {}),
    ...(pages
      ? {
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.revision !== undefined ? { revision: params.revision } : {}),
          ...(params.tail === true ? { tail: true } : {}),
        }
      : {}),
  }, { assertCurrent })
  assertCurrent()
  if (expected) {
    if (!isAgentArtifactReadResult(result)) throw exactAgentUnavailable()
    verifyAgentReply(result, expected)
  }
  return result
}

export async function subscribeAgentConversation(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>
) {
  const expected = requestedAgentRun(params)
  const { task, server, client, assertCurrent } = await agentConnection(this, params, expected)
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
  const subscription = {
    client,
    serverId: server.id,
    taskId: task.taskId,
    threadId: task.threadId,
    agentId: id,
    assertCurrent,
    expectedBackgroundRun: expected,
    removeCloseListener: () => client.removeEventListener('close', onClose),
  }
  this.agentConversationSubscriptions.set(subscriptionId, subscription)
  const assertSubscription = () => {
    assertCurrent()
    if (this.agentConversationSubscriptions.get(subscriptionId) !== subscription)
      throw new Error('subagent subscription has been released')
  }
  try {
    const result = await requestResidentTaskRpc(this, task, client, 'agent/stream/subscribe', {
      agentId: id,
      subscriptionId,
      ...(expected ? { expectedBackgroundRun: expected } : {}),
      ...(client.supportsExperimental?.('agentConversationReasoningV1') === true && {
        includeReasoning: true,
      }),
    }, { assertCurrent: assertSubscription })
    if (expected) {
      const value = record(result)
      if (
        value.threadId !== expected.parentSessionId ||
        value.agentId !== expected.agentId ||
        value.runId !== expected.runId
      )
        throw exactAgentUnavailable()
    }
    return result
  } catch (error) {
    client.removeEventListener('close', onClose)
    if (this.agentConversationSubscriptions.get(subscriptionId) === subscription) {
      this.agentConversationSubscriptions.delete(subscriptionId)
      void client.request('agent/stream/unsubscribe', { subscriptionId }).catch(() => undefined)
    }
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
