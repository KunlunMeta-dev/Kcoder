import { startSnapshotPolling } from '@/lib/snapshotPolling'

/** Poll snapshots sequentially, keeping failures recoverable and background pages quiet. */
export function startWorkflowPolling(options: {
  poll: (isLive: () => boolean, signal: AbortSignal) => Promise<number | false>
  onError: (error: unknown) => void
  isCurrent: () => boolean
  active?: boolean
  changes?: {
    serverId: string
    definitionId?: string
    runId?: string
    onChange?: () => void
  }
}) {
  return startSnapshotPolling({
    poll: options.poll,
    onError: options.onError,
    isCurrent: options.isCurrent,
    active: options.active,
    subscribe(refresh) {
      const changeRevisions = new Map<string, { revision: number; updatedAtMs?: number }>()
      const changed = (event: Event) => {
        const scope = options.changes
        const detail: unknown = (event as CustomEvent<unknown>).detail
        if (!scope || !detail || typeof detail !== 'object') return
        const value = detail as Record<string, unknown>
        if (value.serverId !== scope.serverId) return
        const isRun = event.type === 'kcoder:workflow-run-changed'
        if (!isRun && scope.runId && !scope.definitionId) return
        const id = isRun ? value.runId : (value.definitionId ?? value.id)
        if (typeof id !== 'string') return
        if (
          isRun
            ? scope.runId && id !== scope.runId
            : scope.definitionId && id !== scope.definitionId
        )
          return
        if (
          isRun &&
          scope.definitionId &&
          value.definitionId != null &&
          value.definitionId !== scope.definitionId
        )
          return
        const key = `${event.type}:${id}`
        if (value.revision != null) {
          if (
            typeof value.revision !== 'number' ||
            !Number.isSafeInteger(value.revision) ||
            value.revision < 0
          )
            return
          const updatedAtMs = value.updatedAtMs
          if (
            updatedAtMs != null &&
            (typeof updatedAtMs !== 'number' ||
              !Number.isSafeInteger(updatedAtMs) ||
              updatedAtMs < 0)
          )
            return
          const previous = changeRevisions.get(key)
          if (
            previous &&
            (value.revision < previous.revision ||
              (value.revision === previous.revision &&
                (isRun || updatedAtMs == null || updatedAtMs <= (previous.updatedAtMs ?? -1))))
          )
            return
          if (!changeRevisions.has(key) && changeRevisions.size >= 256) {
            const oldest = changeRevisions.keys().next().value
            if (oldest) changeRevisions.delete(oldest)
          }
          changeRevisions.set(key, {
            revision: value.revision,
            ...(typeof updatedAtMs === 'number' ? { updatedAtMs } : {}),
          })
        }
        options.changes?.onChange?.()
        refresh()
      }
      if (options.changes) {
        window.addEventListener('kcoder:workflow-definition-changed', changed)
        window.addEventListener('kcoder:workflow-run-changed', changed)
      }
      return () => {
        window.removeEventListener('kcoder:workflow-definition-changed', changed)
        window.removeEventListener('kcoder:workflow-run-changed', changed)
      }
    },
  })
}

/** Completed, failed and cancelled runs can resume; keep a slow verification path. */
export function workflowRunPollDelay(status?: string) {
  return status === 'running' ? 1000 : status === 'interrupted' ? 2500 : 15_000
}
