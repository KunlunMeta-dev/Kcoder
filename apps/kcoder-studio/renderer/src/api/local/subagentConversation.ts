import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { requestLocalExecutor, subscribeLocalExecutorEvents } from '@/tauri/localExecutor'
import { createRandomUuid } from '@/lib/random-id'
import { SubagentConversationProjection } from '@/kcoder/subagentConversationProjection'
import type {
  RuntimeSubagentAddressRequest,
  RuntimeSubagentConversationEvent,
  RuntimeSubagentConversationSubscription,
} from '@/types/subagents'
import { record } from '@/kcoder/gateway/runtime/contracts'

/** Listen before admission, then let the caller install the atomic initial snapshot. */
export async function subscribeSubagentConversation(
  data: RuntimeSubagentAddressRequest,
  handler: (event: RuntimeSubagentConversationEvent) => void
): Promise<RuntimeSubagentConversationSubscription> {
  const subscriptionId = createRandomUuid()
  const current = captureAccountContextRevision()
  const projection = new SubagentConversationProjection(data.address)
  let active = true,
    ready = false
  const queued: Record<string, unknown>[] = []
  let overflowed = false
  let sequence = -1,
    runId = ''
  const deliver = (raw: Record<string, unknown>) => {
    if (!active || !current(data.address.deviceId)) return
    if (raw.type === 'reset') {
      if (raw.runId === runId && Number(raw.sequence) < sequence) return
      const snapshot = projection.snapshot(raw)
      sequence = snapshot.sequence
      runId = snapshot.runId
      handler({ type: 'reset', ...snapshot })
    } else if (raw.type === 'disconnected')
      handler(raw as unknown as RuntimeSubagentConversationEvent)
    else {
      if (raw.runId === runId && Number(raw.sequence) <= sequence) return
      if (raw.runId !== runId || Number(raw.sequence) !== sequence + 1) {
        handler({
          ...raw,
          type: 'event',
          actions: [],
        } as unknown as RuntimeSubagentConversationEvent)
        return
      }
      const event = projection.event(raw)
      sequence = Number(raw.sequence)
      handler(event)
    }
  }
  const unlisten = await subscribeLocalExecutorEvents(event => {
    if (event.event !== 'response.subagent.conversation') return
    const payload = record(event.payload),
      value = record(payload.data)
    if (
      payload.deviceId !== data.address.deviceId ||
      payload.taskId !== data.address.taskId ||
      value.subscriptionId !== subscriptionId ||
      value.agentId !== data.agentId ||
      (data.address.threadId && value.threadId !== data.address.threadId)
    )
      return
    if (ready) deliver(value)
    else if (!overflowed) {
      if (queued.length >= 4096) {
        overflowed = true
        queued.length = 0
      } else queued.push(value)
    }
  })
  const unsubscribe = async () => {
    if (!active) return
    active = false
    unlisten()
    queued.length = 0
    await requestLocalExecutor('runtime.tasks.agent_stream_unsubscribe', {
      ...data,
      subscriptionId,
    }).catch(() => undefined)
  }
  try {
    const raw = await requestLocalExecutor<Record<string, unknown>>(
      'runtime.tasks.agent_stream_subscribe',
      { ...data, subscriptionId }
    )
    if (
      !current(data.address.deviceId) ||
      raw.agentId !== data.agentId ||
      raw.subscriptionId !== subscriptionId ||
      (data.address.threadId && raw.threadId !== data.address.threadId) ||
      typeof raw.runId !== 'string' ||
      !raw.runId ||
      !Number.isSafeInteger(raw.sequence) ||
      Number(raw.sequence) < 0
    )
      throw new Error('subagent conversation identity changed')
    const snapshot = projection.snapshot(raw)
    sequence = snapshot.sequence
    runId = snapshot.runId
    setTimeout(() => {
      if (!active) return
      ready = true
      if (overflowed) {
        handler({
          type: 'disconnected',
          threadId: snapshot.threadId,
          agentId: data.agentId,
          subscriptionId,
          reason: 'subagent stream buffer exceeded',
        })
        return
      }
      for (const event of queued.splice(0)) deliver(event)
    }, 0)
    return { snapshot, unsubscribe }
  } catch (error) {
    await unsubscribe()
    throw error
  }
}
