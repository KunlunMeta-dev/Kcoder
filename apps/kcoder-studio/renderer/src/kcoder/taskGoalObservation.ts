import { captureAccountContextRevision } from './accountContextEvents'
import { requestLocalExecutor } from '@/host/localExecutor'
import type { RuntimeGoal, RuntimeTaskAddress } from '@/types/api'
import type { TaskWorkspaceNativeRef } from '../../../shared/generated/contracts'

export type TaskGoalReference = Extract<TaskWorkspaceNativeRef, { kind: 'goal' }>
export type ObservedTaskGoal = RuntimeGoal & { goalId: string; revision: number }
export class TaskGoalObservationError extends Error {
  readonly code: 'cancelled' | 'scope_changed' | 'unavailable' | 'unsupported' | 'reference_changed' | 'invalid_reply'
  constructor(code: TaskGoalObservationError['code']) { super(code);this.code=code }
}
const statuses = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete', 'cancelled'])
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function decode(value: unknown, reference: TaskGoalReference): ObservedTaskGoal {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TaskGoalObservationError('reference_changed')
  const goal = value as Record<string, unknown>
  if (typeof goal.goalId !== 'string' || !integer(goal.revision))
    throw new TaskGoalObservationError('unsupported')
  if (goal.goalId !== reference.goalId) throw new TaskGoalObservationError('reference_changed')
  if (goal.threadId !== reference.threadId || Number(goal.revision) < reference.revision ||
      typeof goal.objective !== 'string' || goal.objective.length > 1024 * 1024 ||
      !statuses.has(String(goal.status)) || !['standard', 'arrangement', 'strict'].includes(String(goal.mode)) ||
      !integer(goal.tokensUsed) || !integer(goal.createdAt) || !integer(goal.updatedAt) ||
      !(goal.tokenBudget === null || integer(goal.tokenBudget)) ||
      typeof goal.timeUsedSeconds !== 'number' || !Number.isFinite(goal.timeUsedSeconds) || goal.timeUsedSeconds < 0 ||
      (goal.events !== undefined && (!Array.isArray(goal.events) || goal.events.length > 5 ||
        goal.events.some(event => !event || typeof event !== 'object' ||
          typeof event.kind !== 'string' || typeof event.summary !== 'string' || !integer(event.timestamp)))))
    throw new TaskGoalObservationError('invalid_reply')
  return goal as unknown as ObservedTaskGoal
}

/** Select an existing original Goal. This consumer never creates or edits Goal state. */
export function createTaskGoalObservation(address: RuntimeTaskAddress, reference: TaskGoalReference, isCurrent: () => boolean) {
  const owner = structuredClone(address), selected = structuredClone(reference)
  if (owner.threadId !== selected.threadId || !owner.deviceId ||
      !owner.taskId || !selected.goalId || !integer(selected.revision))
    throw new TaskGoalObservationError('unsupported')
  const account = captureAccountContextRevision()
  const pending = new Set<AbortController>()
  let active = true, lastRevision = selected.revision
  const check = () => {
    if (!active || !isCurrent() || !account(owner.deviceId))
      throw new TaskGoalObservationError('scope_changed')
  }
  return {
    async read(signal?: AbortSignal): Promise<ObservedTaskGoal> {
      check()
      const abort = new AbortController(), cancel = () => abort.abort()
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) abort.abort()
      pending.add(abort)
      try {
        abort.signal.throwIfAborted()
        const result = await requestLocalExecutor<unknown>('runtime.tasks.goal.get', { address: owner }, { signal: abort.signal })
        abort.signal.throwIfAborted(); check()
        if (!result || typeof result !== 'object' || Array.isArray(result) || (result as { accepted?: unknown }).accepted !== true)
          throw new TaskGoalObservationError('unavailable')
        const goal = decode((result as { goal?: unknown }).goal, selected)
        if (goal.revision < lastRevision) throw new TaskGoalObservationError('invalid_reply')
        lastRevision = goal.revision
        return goal
      } catch (error) {
        if (abort.signal.aborted) throw new TaskGoalObservationError('cancelled')
        if (error instanceof TaskGoalObservationError) throw error
        check(); throw new TaskGoalObservationError('unavailable')
      } finally { pending.delete(abort); signal?.removeEventListener('abort', cancel) }
    },
    dispose() { active = false; for (const abort of pending) abort.abort(); pending.clear() },
  }
}
