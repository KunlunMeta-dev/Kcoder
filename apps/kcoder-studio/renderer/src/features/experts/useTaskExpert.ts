import { useCallback, useEffect, useRef, useState } from 'react'
import { requestLocalExecutor } from '@/host/localExecutor'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import type { RuntimeTaskAddress } from '@/types/api'
import type { AgentDefinitionRef, ThreadExpertResult } from '../../../../shared/generated/contracts'
import { isThreadExpertResult } from '../../../../shared/generated/contractGuards.mjs'

/** Component state is a cancellable projection of the original task's expert configuration. */
export function useTaskExpert(address: RuntimeTaskAddress | null | undefined) {
  const { deviceId, taskId, workspacePath } = address ?? {}
  const threadId = runtimeThreadId(address)
  const key = JSON.stringify([deviceId, taskId, threadId, workspacePath])
  const [snapshot, setSnapshot] = useState<{ key: string; result: ThreadExpertResult }>()
  const [failure, setFailure] = useState<{ key: string; message: string }>()
  const [sending, setSending] = useState<{ key: string; busy: boolean }>()
  const owner = useRef<{ key: string; abort: AbortController } | null>(null)
  const current = useRef<{ key: string; result: ThreadExpertResult } | undefined>(undefined)
  const load = useCallback(async (expert?: AgentDefinitionRef | null) => {
    const lifetime = owner.current
    if (!lifetime || lifetime.key !== key || lifetime.abort.signal.aborted || !threadId)
      throw new Error('AGENT_ORIGINAL_TASK_REQUIRED')
    const previous = current.current?.key === key ? current.current.result : undefined
    if (expert !== undefined && !previous) throw new Error('AGENT_CONFIGURATION_REVISION_REQUIRED')
    const result = await requestLocalExecutor<unknown>('runtime.taskExpert.request', {
      deviceId, taskId, threadId, workspacePath,
      ...(expert === undefined ? {} : { change: { expectedRevision: previous!.revision, expert } }),
    }, { signal: lifetime.abort.signal })
    lifetime.abort.signal.throwIfAborted()
    if (owner.current !== lifetime || !isThreadExpertResult(result) || result.threadId !== threadId)
      throw new Error('AGENT_ORIGINAL_TASK_CHANGED')
    if (current.current?.key === key && result.revision < current.current.result.revision)
      throw new Error('AGENT_CONFIGURATION_STALE_REPLY')
    current.current = { key, result }
    setSnapshot({ key, result })
    setFailure(undefined)
    return result
  }, [deviceId, taskId, threadId, workspacePath, key])
  useEffect(() => {
    const lifetime = { key, abort: new AbortController() }
    owner.current = lifetime
    current.current = undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try { await load() } catch (error) {
        if (!lifetime.abort.signal.aborted) {
          setFailure({ key, message: String(error) })
          retry = setTimeout(() => { void read() }, 10_000)
        }
      }
    }
    if (threadId) void read()
    return () => {
      lifetime.abort.abort()
      clearTimeout(retry)
      if (owner.current === lifetime) owner.current = null
    }
  }, [key, load, threadId])
  const select = useCallback(async (expert: AgentDefinitionRef | null) => {
    const lifetime = owner.current
    setSending({ key, busy: true })
    try { await load(expert) } catch (error) {
      if (lifetime && !lifetime.abort.signal.aborted) {
        // A lost mutation reply is reconciled by reading; never replay it with a new revision.
        await load().catch(() => {})
        if (!lifetime.abort.signal.aborted) setFailure({ key, message: String(error) })
      }
      throw error
    } finally { if (lifetime && !lifetime.abort.signal.aborted) setSending({ key, busy: false }) }
  }, [load, key])
  const result = snapshot?.key === key ? snapshot.result : undefined
  const error = failure?.key === key ? failure.message : ''
  const busy = (sending?.key === key && sending.busy) || (!!threadId && !result && !error)
  return { snapshot: result, error, busy, select, refresh: load }
}
