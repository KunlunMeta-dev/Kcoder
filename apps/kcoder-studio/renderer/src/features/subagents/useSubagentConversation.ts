import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRetainedPageActive } from '@/components/layout/retainedPageState'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import type {
  RuntimeSubagentConversationEvent,
  RuntimeSubagentConversationSnapshot,
  RuntimeSubagentRun,
} from '@/types/subagents'
import { applySubagentConversationEvent } from './subagentConversationStream'

type Api = Pick<ReturnType<typeof createRuntimeWorkApi>, 'subscribeRuntimeSubagentConversation'>
type StreamEvent = Extract<RuntimeSubagentConversationEvent, { type: 'event' }>
interface ConversationView {
  scope: string
  subscriptionRunId?: string
  snapshot?: RuntimeSubagentConversationSnapshot
  loading: boolean
  error?: string
}
interface ObservationGeneration {
  runId?: string
  ownerScope?: string
  expectedBackgroundRun?: RuntimeSubagentRun
}

/** Upper bound of increments held for one frame; a hidden document must not grow it unbounded. */
const MAX_COALESCED_EVENTS = 1024
/** Animation frames pause in hidden documents; this keeps a background view bounded-stale. */
const FRAME_FALLBACK_MS = 100

/**
 * Latest observation of one worker. Streaming publishes here at most once per frame, so
 * only components that read the transcript re-render; hosts select coarse fields.
 */
export class SubagentConversationStore {
  private view: ConversationView | null = null
  private readonly listeners = new Set<() => void>()
  private summaryCache: {
    view: ConversationView | null
    scope: string
    runId?: string
    enabled: boolean
    value: SubagentConversationSummary
  } | null = null

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getView = () => this.view

  publish(view: ConversationView, notify = true) {
    this.view = view
    if (!notify) return
    for (const listener of [...this.listeners]) listener()
  }

  /** Structurally stable summary: transcript-only increments return the cached object. */
  summary(scope: string, runId: string | undefined, enabled: boolean): SubagentConversationSummary {
    const cached = this.summaryCache
    if (
      cached &&
      cached.view === this.view &&
      cached.scope === scope &&
      cached.runId === runId &&
      cached.enabled === enabled
    )
      return cached.value
    const next = summarizeConversation(this.view, scope, runId, enabled)
    const value = cached && sameSummary(cached.value, next) ? cached.value : next
    this.summaryCache = { view: this.view, scope, runId, enabled, value }
    return value
  }
}

/** Identity of one observation; transcript readers subscribe to `store` themselves. */
export interface SubagentConversationHandle {
  store: SubagentConversationStore
  scope: string
  runId?: string
  enabled: boolean
}

/** Everything a host needs from the stream except the transcript itself. */
export interface SubagentConversationSummary {
  key: string
  runId?: string
  status?: string
  activityTaskId?: string
  active: boolean
  observedActive?: boolean
  loading: boolean
  error?: string
  /** The latest assistant message ended as failed or cancelled. */
  latestAssistantInterrupted: boolean
}

function currentViews(view: ConversationView | null, scope: string, runId: string | undefined) {
  const current = view?.scope === scope ? view : null
  const currentGeneration = current?.subscriptionRunId === runId ? current : null
  const liveEstimatesOwned = Boolean(
    currentGeneration?.snapshot?.active &&
    !currentGeneration.loading &&
    !currentGeneration.error &&
    (!runId || currentGeneration.snapshot.runId === runId)
  )
  return { current, currentGeneration, liveEstimatesOwned }
}

function summarizeConversation(
  view: ConversationView | null,
  scope: string,
  runId: string | undefined,
  enabled: boolean
): SubagentConversationSummary {
  const { current, currentGeneration, liveEstimatesOwned } = currentViews(view, scope, runId)
  const messages = (enabled ? current?.snapshot?.messages : undefined) ?? []
  let latestAssistant: WorkbenchMessage | undefined
  for (let index = messages.length - 1; index >= 0 && !latestAssistant; index -= 1) {
    if (messages[index].role === 'assistant') latestAssistant = messages[index]
  }
  return {
    key: scope,
    runId: current?.snapshot?.runId,
    status: currentGeneration?.snapshot?.status,
    activityTaskId:
      enabled && liveEstimatesOwned ? currentGeneration?.snapshot?.activityTaskId : undefined,
    active: Boolean(
      currentGeneration?.snapshot?.active && !currentGeneration?.loading && !currentGeneration?.error
    ),
    observedActive: currentGeneration?.loading ? undefined : currentGeneration?.snapshot?.active,
    loading: enabled && (currentGeneration?.loading ?? true),
    error: currentGeneration?.error,
    latestAssistantInterrupted:
      latestAssistant?.status === 'failed' || latestAssistant?.runtimeStatus === 'cancelled',
  }
}

function sameSummary(left: SubagentConversationSummary, right: SubagentConversationSummary) {
  return (
    left.key === right.key &&
    left.runId === right.runId &&
    left.status === right.status &&
    left.activityTaskId === right.activityTaskId &&
    left.active === right.active &&
    left.observedActive === right.observedActive &&
    left.loading === right.loading &&
    left.error === right.error &&
    left.latestAssistantInterrupted === right.latestAssistantInterrupted
  )
}

function scheduleFrame(callback: () => void): () => void {
  let settled = false
  let frame: number | undefined
  const cancel = () => {
    settled = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
  const run = () => {
    if (settled) return
    cancel()
    callback()
  }
  const timer = setTimeout(run, FRAME_FALLBACK_MS)
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run)
  return cancel
}

/**
 * Ordinary increments are applied in arrival order at the next frame. Anything that
 * changes lifecycle, identity or ordering commits immediately after the queued ones.
 */
function isCoalescibleEvent(
  event: RuntimeSubagentConversationEvent,
  snapshot: RuntimeSubagentConversationSnapshot,
  tail: { runId: string; sequence: number }
): event is StreamEvent {
  if (event.type !== 'event' || event.terminalStatus || event.method === 'turn/completed')
    return false
  if (event.method === 'item/event') {
    const detail = event.params.event
    if (detail && typeof detail === 'object' && (detail as { type?: unknown }).type === 'error')
      return false
  }
  return (
    event.threadId === snapshot.threadId &&
    event.agentId === snapshot.agentId &&
    event.subscriptionId === snapshot.subscriptionId &&
    event.runId === tail.runId &&
    event.sequence === tail.sequence + 1
  )
}

function conversationScope(
  address: RuntimeTaskAddress | null | undefined,
  agentId: string | undefined,
  enabled: boolean,
  generation: ObservationGeneration | undefined
) {
  const expected = generation?.expectedBackgroundRun
  const exactKey = expected
    ? JSON.stringify([expected.parentSessionId, expected.agentId, expected.runId])
    : ''
  return enabled && address && agentId
    ? `${generation?.ownerScope ?? ''}\0${address.deviceId}\0${address.taskId}\0${agentId}${exactKey ? `\0${exactKey}` : ''}`
    : ''
}

/** One subscription per selected worker; close releases observation, never the worker. */
function useSubagentConversationObservation(
  api: Api | undefined,
  address: RuntimeTaskAddress | null | undefined,
  agentId: string | undefined,
  enabled: boolean,
  generation?: ObservationGeneration,
  active = true
): SubagentConversationHandle {
  const pageActive = useRetainedPageActive()
  const visibility = useRef<{ active: boolean; changed?: () => void }>({ active: active && pageActive })
  useLayoutEffect(() => {
    visibility.current.active = active && pageActive
    visibility.current.changed?.()
  }, [active, pageActive])
  const expected = generation?.expectedBackgroundRun
  const runId = expected?.runId ?? generation?.runId
  const scope = conversationScope(address, agentId, enabled, generation)
  const [store] = useState(() => new SubagentConversationStore())
  useEffect(() => {
    if (!scope || !api || !address || !agentId) return
    let disposed = false
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stopSubscription: (() => Promise<void>) | undefined
    let failures = 0
    let retryPending = true
    const presentation = visibility.current
    const visible = () => presentation.active && document.visibilityState !== 'hidden'
    const schedule = (delay: number) => {
      clearTimeout(retryTimer)
      if (retryPending && visible()) retryTimer = setTimeout(() => void subscribe(), delay)
    }
    let connectionError: string | undefined
    // New runs retain the same worker's transcript until the new authoritative snapshot arrives.
    const retained = store.getView()
    let snapshot = retained?.scope === scope ? retained.snapshot : undefined
    let pending: StreamEvent[] = []
    let pendingRequest = 0
    let cancelFrame: (() => void) | undefined
    const publish = (loading: boolean, notify = true) => {
      if (!disposed)
        store.publish({ scope, subscriptionRunId: runId, snapshot, loading, error: connectionError }, notify || visible())
    }
    const discardPending = () => {
      cancelFrame?.()
      cancelFrame = undefined
      pending = []
    }
    const release = () => {
      const stop = stopSubscription
      stopSubscription = undefined
      if (stop) void stop().catch(() => undefined)
    }
    const restart = (error: string, immediate = false) => {
      discardPending()
      attempt += 1
      release()
      connectionError = error
      if (expected) {
        retryPending = false
        snapshot = undefined
        publish(false)
        clearTimeout(retryTimer)
        return
      }
      publish(true)
      clearTimeout(retryTimer)
      retryPending = true
      schedule(immediate ? 0 : Math.min(1000 * 2 ** failures++, 10000))
    }
    // Applies ordered events and commits one view; a sequence break resubscribes instead.
    const commit = (
      events: readonly RuntimeSubagentConversationEvent[],
      request: number,
      force = false,
      notify = true
    ) => {
      if (disposed || request !== attempt || !snapshot) return
      const before = snapshot
      for (const event of events) {
        const next = applySubagentConversationEvent(snapshot, event)
        if (next.resubscribe) {
          restart('subagent stream sequence changed', true)
          return
        }
        snapshot = next.snapshot
      }
      if (force || snapshot !== before) publish(false, notify)
    }
    const flushPending = () => {
      const events = pending
      const request = pendingRequest
      discardPending()
      if (events.length > 0) commit(events, request, false, false)
    }
    const subscribe = async () => {
      if (disposed || !retryPending || !visible()) return
      retryPending = false
      discardPending()
      const request = ++attempt
      const queued: RuntimeSubagentConversationEvent[] = []
      let initialized = false
      const accept = (event: RuntimeSubagentConversationEvent) => {
        if (disposed || request !== attempt) return
        if (event.agentId !== agentId) return
        if (event.type === 'disconnected') {
          if (
            initialized &&
            snapshot &&
            (event.threadId !== snapshot.threadId ||
              event.subscriptionId !== snapshot.subscriptionId)
          )
            return
          // Increments received before the disconnect remain observed facts.
          flushPending()
          if (disposed || request !== attempt) return
          restart(event.reason ?? 'subagent stream disconnected')
          return
        }
        if (!initialized) {
          if (queued.length >= 4096) restart('subagent stream buffer exceeded', true)
          else queued.push(event)
          return
        }
        if (!snapshot) return
        if (isCoalescibleEvent(event, snapshot, pending.at(-1) ?? snapshot)) {
          if (pending.length === 0) {
            pendingRequest = request
            cancelFrame = scheduleFrame(flushPending)
          }
          pending.push(event)
          if (pending.length >= MAX_COALESCED_EVENTS) flushPending()
          return
        }
        flushPending()
        commit([event], request)
      }
      publish(true)
      try {
        const subscription = await api.subscribeRuntimeSubagentConversation(
          { address, agentId, ...(expected ? { expectedBackgroundRun: { ...expected } } : {}) },
          accept
        )
        if (disposed || request !== attempt) {
          void subscription.unsubscribe().catch(() => undefined)
          return
        }
        stopSubscription = subscription.unsubscribe
        if (runId && subscription.snapshot.runId !== runId) {
          throw new Error('subagent stream snapshot has not reached the authoritative run')
        }
        if (
          subscription.snapshot.agentId !== agentId ||
          !Number.isSafeInteger(subscription.snapshot.sequence) ||
          subscription.snapshot.sequence < 0
        ) {
          throw new Error('subagent stream snapshot identity or cursor is invalid')
        }
        snapshot = subscription.snapshot
        initialized = true
        failures = 0
        connectionError = undefined
        // The snapshot and the increments buffered while it loaded commit together.
        commit(queued.splice(0), request, true)
      } catch (failure) {
        if (!disposed && request === attempt)
          restart(failure instanceof Error ? failure.message : 'subagent stream unavailable')
      }
    }
    const changed = () => {
      const current = store.getView()
      if (visible() && current?.scope === scope && current.subscriptionRunId === runId)
        store.publish(current)
      schedule(0)
    }
    presentation.changed = changed
    document.addEventListener('visibilitychange', changed)
    changed()
    return () => {
      disposed = true
      attempt += 1
      discardPending()
      presentation.changed = undefined
      document.removeEventListener('visibilitychange', changed)
      clearTimeout(retryTimer)
      release()
    }
    // Address identity, not object identity, owns this observation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scope, runId])
  return useMemo(() => ({ store, scope, runId, enabled }), [store, scope, runId, enabled])
}

function useConversationMessages(
  view: ConversationView | null,
  handle: SubagentConversationHandle
): WorkbenchMessage[] | undefined {
  const { current, liveEstimatesOwned } = currentViews(view, handle.scope, handle.runId)
  const snapshotMessages = current?.snapshot?.messages
  const messages = useMemo(() => {
    if (liveEstimatesOwned) return snapshotMessages ?? []
    // Retained history never carries live activity across an observation gap.
    return (snapshotMessages ?? []).map(message => {
      const thinking = message.status === 'streaming' && message.latestModelActivity === 'thinking'
      const estimates = message.blocks?.some(block => block.type === 'tool' && block.generatedLineProgress)
      if (!thinking && !estimates) return message
      return {
        ...message,
        ...(thinking ? { latestModelActivity: undefined } : {}),
        ...(estimates ? {
          blocks: message.blocks?.map(block =>
            block.type === 'tool' ? { ...block, generatedLineProgress: undefined } : block
          ),
        } : {}),
      }
    })
  }, [snapshotMessages, liveEstimatesOwned])
  return handle.enabled ? messages : undefined
}

const idleStore = new SubagentConversationStore()

/** Transcript reader for the component that renders it; hosts use the summary instead. */
export function useSubagentConversationMessages(
  handle: SubagentConversationHandle | undefined
): WorkbenchMessage[] | undefined {
  const store = handle?.store ?? idleStore
  const view = useSyncExternalStore(store.subscribe, store.getView, store.getView)
  const messages = useConversationMessages(
    view,
    handle ?? { store, scope: '', enabled: false }
  )
  return handle ? messages : undefined
}

/**
 * Host form: owns the subscription but re-renders only when lifecycle fields change.
 * Streaming text reaches `useSubagentConversationMessages(handle)` consumers alone.
 */
export function useSubagentConversationSource(
  api: Api | undefined,
  address: RuntimeTaskAddress | null | undefined,
  agentId: string | undefined,
  enabled: boolean,
  generation?: ObservationGeneration,
  active = true
) {
  const handle = useSubagentConversationObservation(api, address, agentId, enabled, generation, active)
  const { store, scope, runId } = handle
  const getSummary = useCallback(
    () => store.summary(scope, runId, enabled),
    [store, scope, runId, enabled]
  )
  const summary = useSyncExternalStore(store.subscribe, getSummary, getSummary)
  return { handle, summary }
}

/** Self-contained form for views that render the transcript where they observe it. */
export function useSubagentConversation(
  api: Api | undefined,
  address: RuntimeTaskAddress | null | undefined,
  agentId: string | undefined,
  enabled: boolean,
  generation?: ObservationGeneration,
  active = true
) {
  const handle = useSubagentConversationObservation(api, address, agentId, enabled, generation, active)
  const { store } = handle
  const view = useSyncExternalStore(store.subscribe, store.getView, store.getView)
  const messages = useConversationMessages(view, handle)
  const summary = summarizeConversation(view, handle.scope, handle.runId, enabled)
  return {
    key: summary.key,
    runId: summary.runId,
    status: summary.status,
    messages,
    activityTaskId: summary.activityTaskId,
    active: summary.active,
    observedActive: summary.observedActive,
    loading: summary.loading,
    error: summary.error,
  }
}
