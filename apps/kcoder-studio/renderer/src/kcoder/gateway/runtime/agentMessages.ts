import { captureAccountContextRevision } from '../../accountContextEvents'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import { sameWorkspacePath, workspacePathKey } from '@/lib/workspace-path-identity'
import { isCrossSessionMessageTargetsResult } from '../../../../../shared/generated/contractGuards.mjs'
import { AGENT_MESSAGE_METHODS, AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY, AGENT_MESSAGE_RECEIPTS_CAPABILITY, AGENT_MESSAGE_REPLIES_CAPABILITY, agentMessageReceiptQuery, validAgentMessageReceiptList, agentMessageTargetQuery, validAgentMessageRequest, validAgentMessageReceipt, validAgentMessagePolicy, validAgentMessageResolvedAddress, validAgentMessageTargetSelector } from '../../../../../shared/agentMessageMethods.mjs'
import { sessionAddress, sessionAddressKey } from '../../../../../shared/peerAgentMessage'
import { record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

/** Freeze the displayed source before any target/connection await; IDs alone grant nothing. */
export async function requestAgentMessages(runtime: GatewayRuntimeCore, params: Record<string, unknown>) {
  const address = record(params.address)
  const id = text(params.taskId) ?? text(address.taskId)
  if (!id) throw new Error('agent_messages_source_required')
  const before = runtime.tasks.get(runtime.resolveTaskId(id) ?? id)
  const original = before ? { ...before } : undefined
  const accountCurrent = captureAccountContextRevision()
  const owner = await runtime.taskConnection(params)
  const task = { ...owner.task }
  const expected = original ?? task
  const connection = owner.client.diagnosticConnection?.connectionId
  if (owner.server.security?.identity.mode === 'kcoder-account' && !owner.server.accountIdentity?.principalId)
    throw new Error('agent_messages_account_unavailable')
  const targetIdentity = hookTargetScope(owner.server)
  const scope = JSON.stringify([targetIdentity, owner.server.id, workspacePathKey(task.workspacePath), task.threadId])
  const check = () => {
    const current = runtime.tasks.get(owner.taskId)
    if (runtime.disposed || !accountCurrent(owner.server.id) || task.ephemeral ||
        runtime.resolveTaskId(id) !== owner.taskId || !current ||
        [task, current].some(value => value.serverId !== expected.serverId || value.threadId !== expected.threadId ||
          !sameWorkspacePath(value.workspacePath, expected.workspacePath)) ||
        text(address.deviceId ?? params.deviceId) && text(address.deviceId ?? params.deviceId) !== owner.server.id ||
        address.workspacePath != null && !sameWorkspacePath(String(address.workspacePath), task.workspacePath) ||
        address.threadId != null && address.threadId !== task.threadId ||
        params.expectedScope !== undefined && params.expectedScope !== scope ||
        runtime.clientByTask.get(owner.taskId) !== owner.client || runtime.appServerDisconnectedClients.has(owner.client) ||
        owner.client.diagnosticConnection?.connectionId !== connection || hookTargetScope(owner.server) !== targetIdentity)
      throw new Error('agent_messages_source_changed')
  }
  await runtime.assertCommandTarget(owner.server)
  check()
  const supports = (cap: string) => owner.client.supportsExperimental?.(cap) === true
  const capabilities = { scope, sourceThreadId: task.threadId, discovery: supports('crossSessionDiscoveryV1'),
    search: supports(AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY),
    receipts: supports(AGENT_MESSAGE_RECEIPTS_CAPABILITY), replies: supports(AGENT_MESSAGE_REPLIES_CAPABILITY),
    messages: supports('crossSessionMessagesV1') && supports('peerAgentMessagesV1') }
  if (params.operation === 'supports') return capabilities
  const operation = params.operation
  if (operation !== 'targets' && operation !== 'send' && operation !== 'get' && operation !== 'listReceipts' && operation !== 'resolve' && operation !== 'policyRead' && operation !== 'policySave') throw new Error('agent_messages_invalid_operation')
  if (!(['targets', 'resolve'].includes(operation) ? capabilities.discovery : capabilities.messages)) throw new Error('agent_messages_update_required')
  if (operation === 'listReceipts' && !capabilities.receipts || operation === 'send' && record(params.message).replyToMessageId != null && !capabilities.replies)
    throw new Error('agent_messages_update_required')
  const method = AGENT_MESSAGE_METHODS[operation]
  const wire = operation === 'targets' ? { sourceThreadId: task.threadId, ...agentMessageTargetQuery(params) }
    : operation === 'listReceipts' ? { sourceThreadId: task.threadId, ...agentMessageReceiptQuery(params) }
    : operation === 'send' ? { sourceThreadId: task.threadId, message: params.message }
    : operation === 'resolve' ? { sourceThreadId: task.threadId, address: params.destinationAddress }
    : operation === 'policyRead' ? { sourceThreadId: task.threadId }
    : operation === 'policySave' ? { sourceThreadId: task.threadId, expectedRevision: params.expectedRevision, enabled: params.enabled, wakeIdle: params.wakeIdle }
    : { sourceThreadId: task.threadId, query: params.query }
  if (!validAgentMessageRequest(method, wire)) throw new Error('agent_messages_invalid_request')
  check()
  const result: unknown = await (connection && owner.client.requestOnConnection
    ? owner.client.requestOnConnection(connection, method, wire)
    : owner.client.request(method, wire))
  await runtime.assertCommandTarget(owner.server)
  check()
  if (operation === 'listReceipts') {
    if (!validAgentMessageReceiptList(result, task.threadId)) throw new Error('agent_messages_invalid_response')
    return result
  }
  if (operation === 'resolve') {
    const destination = sessionAddress(params.destinationAddress)
    if (!destination || !validAgentMessageResolvedAddress(result) || sessionAddressKey(result.address) !== sessionAddressKey(destination))
      throw new Error('agent_messages_invalid_navigation')
    return result
  }
  if (operation === 'policyRead' || operation === 'policySave') {
    if (!validAgentMessagePolicy(result)) throw new Error('agent_messages_invalid_policy')
    return result
  }
  if (operation === 'targets') {
    if (!isCrossSessionMessageTargetsResult(result) || result.targets.some(target => !validAgentMessageTargetSelector(target))) throw new Error('agent_messages_invalid_response')
    return result
  }
  const value = record(result)
  const receipt = operation === 'get' ? value.receipt : result
  if (operation === 'get' && Object.hasOwn(value, 'receipt') && receipt === null) return { receipt: null }
  if (!validAgentMessageReceipt(receipt)) throw new Error('agent_messages_invalid_receipt')
  const binding = record(operation === 'send' ? params.message : params.query)
  if (binding.clientMessageId && receipt.clientMessageId !== binding.clientMessageId ||
      operation === 'send' && (binding.replyToMessageId ?? null) !== (receipt.replyToMessageId ?? null) ||
      binding.messageId && receipt.messageId !== binding.messageId || binding.targetThreadId && receipt.targetThreadId !== binding.targetThreadId)
    throw new Error('agent_messages_receipt_mismatch')
  return operation === 'get' ? { receipt } : receipt
}
