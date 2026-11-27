import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { readTurnReceipt } from '../../../../../shared/turnReceipt'
import type { TurnSteerReceiptReadResult } from '../../../../../shared/generated/contracts'
import type { RuntimeInputDelivery } from '@/types/api'
import type { GatewayRuntimeCore } from './core'
import { record, text } from './contracts'

/** Observe or stop one original submission, never whichever turn is now active. */
export async function inputDelivery(
  core: GatewayRuntimeCore,
  params: Record<string, unknown>
): Promise<RuntimeInputDelivery> {
  const address = record(params.address)
  const clientMessageId = text(params.clientMessageId)
  const expectedTurnId = text(params.expectedTurnId)
  if (
    !clientMessageId ||
    clientMessageId.length > 1024 ||
    (params.expectedTurnId !== undefined && (!expectedTurnId || expectedTurnId.length > 1024)) ||
    !text(address.deviceId) ||
    !['read', 'cancel'].includes(String(params.action))
  )
    throw new Error('Invalid input delivery identity')
  const account = captureAccountContextRevision()
  const configuration = core.configurationEpochByTarget.get(String(address.deviceId))
  const known = core.tasks.get(core.resolveTaskId(text(address.taskId)) ?? '')
  const expected = known ? { ...known } : undefined
  const { taskId, task, client } = await core.taskConnection(params)
  const owner = expected ?? { ...task }
  const connection = client.diagnosticConnection?.connectionId
  const assertCurrent = () => {
    const current = core.tasks.get(taskId)
    if (
      core.disposed ||
      !account(owner.serverId) ||
      core.configurationEpochByTarget.get(owner.serverId) !== configuration ||
      client.diagnosticConnection?.connectionId !== connection ||
      !current ||
      core.resolveTaskId(text(address.taskId)) !== taskId ||
      current.threadId !== owner.threadId ||
      current.serverId !== owner.serverId ||
      address.deviceId !== owner.serverId ||
      (address.threadId != null && address.threadId !== owner.threadId) ||
      !sameWorkspacePath(current.workspacePath, owner.workspacePath) ||
      (address.workspacePath != null &&
        !sameWorkspacePath(String(address.workspacePath), owner.workspacePath)) ||
      core.clientByTask.get(taskId) !== client ||
      core.appServerDisconnectedClients.has(client)
    )
      throw new Error('Input delivery owner changed')
  }
  assertCurrent()
  if (params.deliveryMode === 'guidance' && client.supportsExperimental?.('turnSteerReceiptsV1')) {
    const result = await client.request<TurnSteerReceiptReadResult>('turn/steer/receipt/read', {
      threadId: owner.threadId, clientMessageId,
    })
    assertCurrent()
    const receipt = result?.receipt
    if (receipt && receipt.threadId === owner.threadId && receipt.clientMessageId === clientMessageId &&
        receipt.turnId && (!expectedTurnId || receipt.turnId === expectedTurnId)) {
      if (receipt.status === 'applied') return { status: 'applied', turnId: receipt.turnId }
      if (receipt.status === 'queued') return { status: 'accepted' }
    }
    // A missing or dropped mailbox receipt may have an in-flight fallback. Observe its original
    // turn receipt below; neither absence nor cancellation authorizes replay.
  }
  const read = async (): Promise<RuntimeInputDelivery> => {
    try {
      const result = await readTurnReceipt(client, { threadId: owner.threadId, clientMessageId })
      assertCurrent()
      const turn = result.turn!
      return {
        status:
          turn.status === 'failed'
            ? 'execution_failed'
            : (turn.status as RuntimeInputDelivery['status']),
        turnId: turn.id,
      }
    } catch {
      assertCurrent()
      return { status: 'unknown' }
    }
  }
  const observed = await read()
  if (expectedTurnId && observed.turnId !== expectedTurnId)
    return { status: 'unknown', turnId: expectedTurnId }
  if (params.action !== 'cancel' || observed.status !== 'running' || !observed.turnId)
    return observed
  // The app-server compares this exact turn under its active-turn lock. If a
  // different turn has started, it is left untouched and the old receipt wins.
  assertCurrent()
  await client.request('turn/interrupt', { threadId: owner.threadId, turnId: observed.turnId })
  assertCurrent()
  const settled = await read()
  return settled.status === 'unknown' || settled.turnId !== observed.turnId
    ? { status: 'unknown', turnId: observed.turnId }
    : settled
}
