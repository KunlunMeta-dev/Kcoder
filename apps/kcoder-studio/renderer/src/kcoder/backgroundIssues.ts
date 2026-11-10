import { useSyncExternalStore } from 'react'
import { listenAccountContextChanges } from './accountContextEvents'

export type BackgroundIssueTarget = {
  deviceId?: string
  taskId?: string
  threadId?: string | null
  workspacePath?: string | null
}
export type BackgroundIssue = {
  kind: 'imported_history_check'
  code: 'IMPORTED_HISTORY_READ_FAILED'
  target: BackgroundIssueTarget
  isCurrent: () => boolean
  retry: () => void
  dismiss: () => void
}
const records = new Map<symbol, BackgroundIssue>()
let snapshot: readonly BackgroundIssue[] = []
const listeners = new Set<() => void>()
const emit = () => {
  snapshot = [...records.values()]
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** One observation owns exactly one ephemeral record, never a peer's task or persisted data. */
export function registerBackgroundIssue(issue: BackgroundIssue): () => void {
  const key = Symbol(issue.kind)
  let active = true
  const current = () => active && issue.isCurrent()
  records.set(key, { ...issue, isCurrent: current,
    retry: () => { if (current()) issue.retry() },
    dismiss: () => { if (current()) issue.dismiss() },
  })
  const dispose = () => {
    if (!active) return
    active = false
    stopAccountListener()
    records.delete(key)
    emit()
  }
  const stopAccountListener = listenAccountContextChanges(target => {
    if (target === issue.target.deviceId) dispose()
  })
  emit()
  return dispose
}

export function useTaskBackgroundIssues(target?: BackgroundIssueTarget) {
  const issues = useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
  return issues.filter(issue => target?.deviceId && target.taskId && issue.isCurrent()
    && issue.target.deviceId === target.deviceId && issue.target.taskId === target.taskId
    && (issue.target.workspacePath ?? undefined) === (target.workspacePath ?? undefined))
}
