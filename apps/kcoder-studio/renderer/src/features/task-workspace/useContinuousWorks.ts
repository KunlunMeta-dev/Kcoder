import { useEffect, useMemo, useState } from 'react'
import { isContinuousWorkView } from '../../../../shared/generated/contractGuards.mjs'
import type { ContinuousWorkView } from '../../../../shared/generated/contracts'
import { requestLocalExecutor } from '@/host/localExecutor'
import { workspacePathKey } from '@/lib/workspace-path-identity'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { subscribeRuntimeWorkChanged } from '@/kcoder/runtimeWorkEvents'
import type { ContinuousWorkBatch } from '@/kcoder/gateway/runtime/continuousWorks'

export interface ContinuousWorkspaceObservation {
  status: 'loading' | 'complete' | 'partial' | 'unsupported' | 'unavailable'
  items: ContinuousWorkView[]
}
type WorkspaceObservations = Record<string, ContinuousWorkspaceObservation>
type Snapshot = {
  owner: string
  scopeOwner: string
  workspaces: WorkspaceObservations
}
const MAX_WORKS = 4096
const MAX_PARALLEL_WORKSPACES = 4

/** A target that has not settled a page yet is reported as pending, not as read work. */
function pendingWorkspaces(
  entries: Array<[string, string]>,
  status: 'loading' | 'unsupported',
  carried: WorkspaceObservations | undefined
): WorkspaceObservations {
  return Object.fromEntries(
    entries.map(([key]) => [
      key,
      // Only an earlier read of the same target scope keeps its items visible.
      { status, items: status === 'loading' ? (carried?.[key]?.items ?? []) : [] },
    ])
  )
}

/** The board observes existing records only while it is open. */
export function useContinuousWorks(
  serverId: string,
  paths: string[],
  paused: boolean,
  refreshRevision: number
): Record<string, ContinuousWorkspaceObservation> {
  const { key: scopeKey, isCurrent } = usePluginTargetScope(serverId)
  const [revision, setRevision] = useState(0)
  // Resuming starts a new read of the same owner, so statuses settled before the
  // pause must not outlive it: the resumed read is pending until it settles again.
  const [resumeRevision, setResumeRevision] = useState(0)
  const [lastPaused, setLastPaused] = useState(paused)
  if (lastPaused !== paused) {
    setLastPaused(paused)
    if (!paused) setResumeRevision(value => value + 1)
  }
  const pathKey = JSON.stringify(
    [...new Map(paths.filter(Boolean).map(path => [workspacePathKey(path), path])).entries()].sort(
      ([left], [right]) => left.localeCompare(right)
    )
  )
  const entries = useMemo(() => JSON.parse(pathKey) as Array<[string, string]>, [pathKey])
  const scopeOwner = JSON.stringify([serverId, scopeKey])
  const owner = JSON.stringify([scopeOwner, pathKey, revision, resumeRevision, refreshRevision])
  const [snapshot, setSnapshot] = useState<Snapshot>()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeRuntimeWorkChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setRevision(value => value + 1), 350)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!serverId || paused) return
    const cancel = new AbortController()
    const current = () => !cancel.signal.aborted && isCurrent()
    // Native hosts report the pending observation during render and read no pages.
    // Rendering owns the pending view, so only a settled page may commit a snapshot here.
    const publish = (key: string, value: ContinuousWorkspaceObservation) => {
      if (!current()) return
      setSnapshot(previous => {
        const settled = previous?.owner === owner ? previous.workspaces : undefined
        const base =
          settled ??
          pendingWorkspaces(
            entries,
            'loading',
            previous?.scopeOwner === scopeOwner ? previous.workspaces : undefined
          )
        const oldItems = base[key]?.items ?? []
        const status =
          value.status === 'unsupported' && oldItems.length ? 'unavailable' : value.status
        const items =
          status === 'complete' || status === 'unsupported'
            ? value.items
            : [...new Map([...oldItems, ...value.items].map(item => [item.workId, item])).values()]
        return { owner, scopeOwner, workspaces: { ...base, [key]: { status, items } } }
      })
    }
    let nextWorkspace = 0
    async function readWorkspace(key: string, path: string) {
      const found = new Map<string, ContinuousWorkView>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      let pageCount = 0
      let incomplete = false
      try {
        while (current()) {
          const batch = await requestLocalExecutor<ContinuousWorkBatch>(
            'runtime.continuousWork.list',
            {
              deviceId: serverId,
              workspacePath: path,
              ...(cursor ? { cursor } : {}),
            },
            { signal: cancel.signal }
          )
          if (!current()) return
          if (
            !batch ||
            !['complete', 'more', 'unsupported', 'unavailable'].includes(batch.status) ||
            !Array.isArray(batch.items) ||
            batch.items.length > 100 ||
            !Number.isSafeInteger(batch.pageCount) ||
            (batch.incomplete != null && typeof batch.incomplete !== 'boolean') ||
            batch.pageCount < 0 ||
            batch.pageCount > 10 ||
            (batch.status === 'more' && batch.pageCount === 0) ||
            (batch.status === 'unsupported' &&
              (batch.pageCount !== 0 || batch.items.length !== 0)) ||
            batch.items.some(item => !isContinuousWorkView(item))
          )
            throw new Error('invalid work observation')
          pageCount += batch.pageCount
          incomplete ||= batch.incomplete === true
          for (const item of batch.items) {
            if (found.has(item.workId)) throw new Error('duplicate work observation')
            found.set(item.workId, item)
          }
          if (found.size > MAX_WORKS) throw new Error('work observation limit exceeded')
          const items = [...found.values()]
          if (batch.status !== 'more') {
            // Native work pages do not yet share one snapshot identity.
            const status =
              batch.status === 'complete' && incomplete
                ? 'unavailable'
                : batch.status === 'complete' && pageCount > 1
                  ? 'partial'
                  : batch.status
            publish(key, { status, items })
            return
          }
          if (!batch.nextCursor || cursors.has(batch.nextCursor) || batch.nextCursor === cursor)
            throw new Error('invalid work cursor')
          cursors.add(batch.nextCursor)
          cursor = batch.nextCursor
          publish(key, { status: 'loading', items })
        }
      } catch {
        if (current()) publish(key, { status: 'unavailable', items: [...found.values()] })
      }
    }
    async function worker() {
      while (current() && nextWorkspace < entries.length) {
        const [key, path] = entries[nextWorkspace++]
        await readWorkspace(key, path)
      }
    }
    void Promise.all(
      Array.from({ length: Math.min(MAX_PARALLEL_WORKSPACES, entries.length) }, worker)
    )
    return () => cancel.abort()
  }, [entries, isCurrent, owner, paused, scopeOwner, serverId])

  if (!isCurrent()) return {}
  const committed = snapshot?.scopeOwner === scopeOwner ? snapshot : undefined
  if (!paused && committed?.owner === owner) return committed.workspaces
  return pendingWorkspaces(
    entries,
    'loading',
    committed?.workspaces
  )
}
