import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { requestLocalExecutor, subscribeLocalExecutorEvents } from '@/host/localExecutor'
import { createRandomUuid } from '@/lib/random-id'
import { SubagentConversationProjection } from '@/kcoder/subagentConversationProjection'
import { ToolPathPreviewConsumer, toolPathPreviews } from '@/kcoder/toolPathPreview'
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
  const expected = data.expectedBackgroundRun ? { ...data.expectedBackgroundRun } : undefined
  if (
    expected &&
    (data.agentId !== expected.agentId || data.address.threadId !== expected.parentSessionId)
  )
    throw new Error('Exact subagent parent/run identity is unavailable')
  const current = captureAccountContextRevision()
  const projection = new SubagentConversationProjection(data.address)
  const activityTaskId = `subagent-view:${subscriptionId}`
  const activityClient = {}
  let activity = new ToolPathPreviewConsumer()
  let releaseActivity: (() => void) | undefined
  let activitySequence = 0
  let active = true,
    ready = false
  const queued: Record<string, unknown>[] = []
  let overflowed = false
  let sequence = -1,
    runId = ''
  const releasePresentation = () => {
    releaseActivity?.()
    releaseActivity = undefined
    activity.dispose()
  }
  const observeActivity = (method: string, params: Record<string, unknown>, threadId: string) =>
    activity.handle(method, {
      ...params,
      serverId: subscriptionId,
      threadId,
      turnId: runId,
      sequence: ++activitySequence,
    }, data.address.deviceId, activityTaskId, activityClient)
  const installSnapshot = (raw: Record<string, unknown>) => {
    const snapshot = { ...projection.snapshot(raw), activityTaskId }
    sequence = snapshot.sequence
    runId = snapshot.runId
    releasePresentation()
    activity = new ToolPathPreviewConsumer()
    activitySequence = 0
    if (snapshot.active) {
      releaseActivity = toolPathPreviews.acquire(data.address.deviceId, activityTaskId)
      observeActivity('turn/started', {}, snapshot.threadId)
      for (const pending of Array.isArray(raw.pendingEvents) ? raw.pendingEvents : []) {
        observeActivity('item/event', { event: record(pending) }, snapshot.threadId)
      }
    }
    return snapshot
  }
  const deliver = (raw: Record<string, unknown>) => {
    if (!active || !current(data.address.deviceId)) return
    if (expected && raw.type !== 'disconnected' && raw.runId !== expected.runId) {
      handler({
        type: 'disconnected',
        threadId: expected.parentSessionId,
        agentId: expected.agentId,
        subscriptionId,
        reason: 'agent_run_changed',
      })
      void unsubscribe()
      return
    }
    if (raw.type === 'reset') {
      if (raw.runId === runId && Number(raw.sequence) < sequence) return
      const snapshot = installSnapshot(raw)
      handler({ type: 'reset', ...snapshot })
    } else if (raw.type === 'disconnected') {
      releasePresentation()
      handler(raw as unknown as RuntimeSubagentConversationEvent)
    } else {
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
      if (event.type === 'event') observeActivity(event.method, {
        ...event.params,
        ...(event.occurredAtMs !== undefined && { occurredAtMs: event.occurredAtMs }),
      }, event.threadId)
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
    releasePresentation()
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
      (expected && raw.runId !== expected.runId) ||
      !raw.runId ||
      !Number.isSafeInteger(raw.sequence) ||
      Number(raw.sequence) < 0
    )
      throw new Error('subagent conversation identity changed')
    const snapshot = installSnapshot(raw)
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
