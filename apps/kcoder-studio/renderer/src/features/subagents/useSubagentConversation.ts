import { useEffect, useRef, useState } from 'react'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { RuntimeTaskAddress } from '@/types/api'
import type {
  RuntimeSubagentConversationEvent,
  RuntimeSubagentConversationSnapshot,
} from '@/types/subagents'
import { applySubagentConversationEvent } from './subagentConversationStream'

type Api = Pick<ReturnType<typeof createRuntimeWorkApi>, 'subscribeRuntimeSubagentConversation'>
interface ConversationView {
  scope: string
  subscriptionRunId?: string
  snapshot?: RuntimeSubagentConversationSnapshot
  loading: boolean
  error?: string
}

/** One subscription per selected worker; close releases observation, never the worker. */
export function useSubagentConversation(
  api: Api | undefined,
  address: RuntimeTaskAddress | null | undefined,
  agentId: string | undefined,
  enabled: boolean,
  generation?: { runId?: string; ownerScope?: string }
) {
  const runId = generation?.runId
  const scope =
    enabled && address && agentId
      ? `${generation?.ownerScope ?? ''}\0${address.deviceId}\0${address.taskId}\0${agentId}`
      : ''
  const [view, setView] = useState<ConversationView | null>(null)
  const retainedView = useRef<ConversationView | null>(null)
  useEffect(() => {
    if (!scope || !api || !address || !agentId) return
    let disposed = false
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stopSubscription: (() => Promise<void>) | undefined
    let failures = 0
    let connectionError: string | undefined
    // New runs retain the same worker's transcript until the new authoritative snapshot arrives.
    let snapshot = retainedView.current?.scope === scope ? retainedView.current.snapshot : undefined
    const publish = (loading: boolean) => {
      if (!disposed) {
        const next = { scope, subscriptionRunId: runId, snapshot, loading, error: connectionError }
        retainedView.current = next
        setView(next)
      }
    }
    const release = () => {
      const stop = stopSubscription
      stopSubscription = undefined
      if (stop) void stop().catch(() => undefined)
    }
    const restart = (error: string, immediate = false) => {
      attempt += 1
      release()
      connectionError = error
      publish(true)
      clearTimeout(retryTimer)
      retryTimer = setTimeout(
        () => void subscribe(),
        immediate ? 0 : Math.min(1000 * 2 ** failures++, 10000)
      )
    }
    const subscribe = async () => {
      if (disposed) return
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
          restart(event.reason ?? 'subagent stream disconnected')
          return
        }
        if (!initialized) {
          if (queued.length >= 4096) restart('subagent stream buffer exceeded', true)
          else queued.push(event)
          return
        }
        if (!snapshot) return
        const next = applySubagentConversationEvent(snapshot, event)
        if (next.resubscribe) {
          restart('subagent stream sequence changed', true)
          return
        }
        if (next.snapshot !== snapshot) {
          snapshot = next.snapshot
          publish(false)
        }
      }
      publish(true)
      try {
        const subscription = await api.subscribeRuntimeSubagentConversation(
          { address, agentId },
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
        publish(false)
        for (const event of queued) accept(event)
      } catch (failure) {
        if (!disposed && request === attempt)
          restart(failure instanceof Error ? failure.message : 'subagent stream unavailable')
      }
    }
    const initial = setTimeout(() => void subscribe(), 0)
    return () => {
      disposed = true
      attempt += 1
      clearTimeout(initial)
      clearTimeout(retryTimer)
      release()
    }
    // Address identity, not object identity, owns this observation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scope, runId])
  const current = view?.scope === scope ? view : null
  const currentGeneration = current?.subscriptionRunId === runId ? current : null
  return {
    key: scope,
    messages: enabled ? (current?.snapshot?.messages ?? []) : undefined,
    active: Boolean(
      currentGeneration?.snapshot?.active &&
      !currentGeneration?.loading &&
      !currentGeneration?.error
    ),
    observedActive: currentGeneration?.loading ? undefined : currentGeneration?.snapshot?.active,
    loading: enabled && (currentGeneration?.loading ?? true),
    error: currentGeneration?.error,
  }
}
