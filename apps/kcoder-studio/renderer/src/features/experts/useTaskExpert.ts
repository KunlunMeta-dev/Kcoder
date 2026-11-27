import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRetainedPageActive } from '@/components/layout/retainedPageState'
import { requestLocalExecutor } from '@/host/localExecutor'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import type { RuntimeTaskAddress } from '@/types/api'
import type { AgentDefinitionRef, ThreadExpertResult } from '../../../../shared/generated/contracts'
import { isThreadExpertResult } from '../../../../shared/generated/contractGuards.mjs'
import {
  isTransientTaskExpertFailure, taskExpertFailureCode, taskExpertFailureReason, type TaskExpertFailureReason,
} from './taskExpertFailure'

const refreshIntervalMs = 30_000
const failureRetryMs = 10_000
// Quiet retries while the original task is busy (for example compacting) or reconnecting.
const transientRetryMs = [2_000, 5_000, 10_000] as const
// A task without any authoritative snapshot stops loading quietly after these retries.
const transientAttemptsWithoutSnapshot = transientRetryMs.length
// The last authoritative snapshot stays visible through a bounded transient window
// that covers the longest manual compaction deadline.
const transientWindowWithSnapshotMs = 600_000

function failureOf(key: string, error: unknown) {
  return { key, message: String(error), reason: taskExpertFailureReason(error), code: taskExpertFailureCode(error) }
}

/** Component state is a cancellable projection of the original task's expert configuration. */
export function useTaskExpert(address: RuntimeTaskAddress | null | undefined) {
  const pageActive = useRetainedPageActive()
  const pageActiveRef = useRef(pageActive)
  const { deviceId, taskId, workspacePath } = address ?? {}
  const threadId = runtimeThreadId(address)
  const canResolveTask = Boolean(deviceId && taskId)
  const key = JSON.stringify([deviceId, taskId, threadId, workspacePath])
  const [snapshot, setSnapshot] = useState<{ key: string; result: ThreadExpertResult }>()
  const [failure, setFailure] = useState<{ key: string; message: string; reason: TaskExpertFailureReason; code: string }>()
  const [pendingChange, setPendingChange] = useState<{ key: string; signal?: AbortSignal }>()
  const owner = useRef<{
    key: string
    abort: AbortController
    schedule: (delay?: number) => void
  } | null>(null)
  const current = useRef<{ key: string; result: ThreadExpertResult } | undefined>(undefined)
  const inFlightRead = useRef<{ key: string; promise: Promise<ThreadExpertResult> } | undefined>(undefined)
  const transient = useRef<{ key: string; since: number; attempts: number } | undefined>(undefined)
  const load = useCallback(async (expert?: AgentDefinitionRef | null, isCurrentRead?: () => boolean) => {
    const lifetime = owner.current
    if (!lifetime || lifetime.key !== key || lifetime.abort.signal.aborted || !canResolveTask)
      throw new Error('AGENT_ORIGINAL_TASK_REQUIRED')
    const previous = current.current?.key === key ? current.current.result : undefined
    if (expert !== undefined && !previous) throw new Error('AGENT_CONFIGURATION_REVISION_REQUIRED')
    const expectedThreadId = threadId ?? previous?.threadId
    const result = await requestLocalExecutor<unknown>('runtime.taskExpert.request', {
      deviceId, taskId, ...(expectedThreadId ? { threadId: expectedThreadId } : {}), workspacePath,
      ...(expert === undefined ? {} : { change: { expectedRevision: previous!.revision, expert } }),
    }, { signal: lifetime.abort.signal })
    lifetime.abort.signal.throwIfAborted()
    if (owner.current !== lifetime || !isThreadExpertResult(result) ||
      (expectedThreadId && result.threadId !== expectedThreadId))
      throw new Error('AGENT_ORIGINAL_TASK_CHANGED')
    if (isCurrentRead && !isCurrentRead()) throw new Error('AGENT_CONFIGURATION_STALE_REPLY')
    if (current.current?.key === key && result.revision < current.current.result.revision)
      throw new Error('AGENT_CONFIGURATION_STALE_REPLY')
    current.current = { key, result }
    if (transient.current?.key === key) transient.current = undefined
    setSnapshot({ key, result })
    setFailure(undefined)
    return result
  }, [canResolveTask, deviceId, taskId, threadId, workspacePath, key])
  const read = useCallback(() => {
    const pending = inFlightRead.current
    if (pending?.key === key) return pending.promise
    const lifetime = owner.current?.key === key ? owner.current : null
    lifetime?.schedule()
    const isCurrentRead = () => inFlightRead.current?.promise === promise
    const promise: Promise<ThreadExpertResult> = load(undefined, isCurrentRead).then(result => {
      if (isCurrentRead()) lifetime?.schedule(refreshIntervalMs)
      return result
    }, error => {
      if (isCurrentRead() && lifetime && !lifetime.abort.signal.aborted && owner.current === lifetime) {
        const message = String(error)
        if (message.includes('AGENT_CONFIGURATION_STALE_REPLY')) {
          lifetime.schedule(failureRetryMs)
        } else if (isTransientTaskExpertFailure(error)) {
          const previous = transient.current?.key === key ? transient.current : undefined
          const state = { key, since: previous?.since ?? Date.now(), attempts: (previous?.attempts ?? 0) + 1 }
          transient.current = state
          const quiet = current.current?.key === key
            ? Date.now() - state.since < transientWindowWithSnapshotMs
            : state.attempts <= transientAttemptsWithoutSnapshot
          // A busy or reconnecting original task keeps its last authoritative
          // snapshot (or keeps loading); only a persistent failure is shown.
          if (!quiet) setFailure(failureOf(key, error))
          lifetime.schedule(quiet
            ? transientRetryMs[Math.min(state.attempts, transientRetryMs.length) - 1]
            : failureRetryMs)
        } else {
          setFailure(failureOf(key, error))
          lifetime.schedule(failureRetryMs)
        }
      }
      throw error
    }).finally(() => {
      if (inFlightRead.current?.promise === promise) inFlightRead.current = undefined
    })
    inFlightRead.current = { key, promise }
    return promise
  }, [key, load])
  useEffect(() => {
    let timer: number | undefined
    const lifetime = { key, abort: new AbortController(), schedule: (delay?: number) => {
      window.clearTimeout(timer)
      timer = undefined
      if (delay !== undefined && canResolveTask && pageActiveRef.current && document.visibilityState === 'visible' &&
        owner.current === lifetime && !lifetime.abort.signal.aborted)
        timer = window.setTimeout(refresh, delay)
    } }
    owner.current = lifetime
    current.current = undefined
    const refresh = () => {
      if (!canResolveTask || !pageActiveRef.current || document.visibilityState !== 'visible') {
        lifetime.schedule()
        return
      }
      void read().catch(() => {})
    }
    refresh()
    if (canResolveTask) {
      window.addEventListener('focus', refresh)
      document.addEventListener('visibilitychange', refresh)
    }
    return () => {
      lifetime.abort.abort()
      lifetime.schedule()
      if (canResolveTask) {
        window.removeEventListener('focus', refresh)
        document.removeEventListener('visibilitychange', refresh)
      }
      if (inFlightRead.current?.key === key) inFlightRead.current = undefined
      if (owner.current === lifetime) owner.current = null
    }
  }, [canResolveTask, key, read])
  useLayoutEffect(() => {
    pageActiveRef.current = pageActive
    const lifetime = owner.current
    if (!lifetime || lifetime.key !== key || lifetime.abort.signal.aborted) return
    // Visibility pauses presentation work without retiring an accepted mutation's owner.
    if (pageActive && document.visibilityState === 'visible') void read().catch(() => {})
    else lifetime.schedule()
  }, [pageActive, key, read])
  const select = useCallback(async (expert: AgentDefinitionRef | null) => {
    const lifetime = owner.current?.key === key ? owner.current : null
    lifetime?.schedule()
    const operation = { key, signal: lifetime?.abort.signal }
    setPendingChange(operation)
    // Reads spanning the change cannot serve its authoritative readback.
    if (lifetime) inFlightRead.current = undefined
    try {
      await load(expert).finally(() => {
        if (owner.current === lifetime) inFlightRead.current = undefined
      })
      lifetime?.schedule(refreshIntervalMs)
    } catch (error) {
      if (lifetime && !lifetime.abort.signal.aborted) {
        // A lost mutation reply is reconciled by reading; never replay it with a new revision.
        await read().catch(() => {})
        if (!lifetime.abort.signal.aborted) setFailure(failureOf(key, error))
      }
      throw error
    } finally { setPendingChange(current => current === operation ? undefined : current) }
  }, [key, load, read])
  // An explicit refresh during a transient failure keeps the last authoritative
  // snapshot; a later change still carries its revision for server-side CAS.
  const refresh = useCallback(() => read().catch(error => {
    const kept = current.current?.key === key ? current.current.result : undefined
    if (kept && isTransientTaskExpertFailure(error)) return kept
    throw error
  }), [key, read])
  const result = snapshot?.key === key ? snapshot.result : undefined
  const error = failure?.key === key ? failure.message : ''
  const errorReason = failure?.key === key ? failure.reason : undefined
  const errorCode = failure?.key === key ? failure.code : undefined
  const busy = (pendingChange?.key === key && !pendingChange.signal?.aborted) || (canResolveTask && !result && !error)
  return { snapshot: result, error, errorReason, errorCode, busy, select, refresh }
}
