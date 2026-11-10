import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { captureAccountContextRevision, listenAccountContextChanges } from './accountContextEvents'
import { createMigrationApi } from './gatewayMigration'
import {
  isMigrationHistoryUndoLookupResult,
  isMigrationHistoryUndoPreviewResult,
  isMigrationHistoryUndoStateResult,
  type MigrationHistoryUndoPreviewResult,
  type MigrationHistoryUndoStateResult,
} from '../../../shared/generated/contracts'

const code = (cause: unknown) =>
  (cause instanceof Error ? cause.message : '').match(
    /\b(?:historical_undo|migration|continuation)_[a-z_]+\b/
  )?.[0] ?? 'error'

/** Only the server's source index restores undo ownership; no local cache authorizes a retry. */
export function useMigrationUndo(
  deviceId: string,
  workspacePath: string | undefined,
  continuationJobId: string | null,
  continuationSequence: number,
  isCurrent: () => boolean
) {
  const [account, setAccount] = useState(0)
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const scope = useMemo(
    () => ({ api, continuationJobId, account, valid: captureAccountContextRevision() }),
    [api, continuationJobId, account]
  )
  const owner = useRef(scope),
    mounted = useRef(false),
    current = useRef(isCurrent),
    sequence = useRef(continuationSequence)
  const pending = useRef<string | null>(null),
    active = useRef<typeof scope | null>(null),
    latest = useRef<MigrationHistoryUndoStateResult | null>(null)
  const requests = useRef(new Set<AbortController>())
  const blank = () => ({
    scope,
    ready: false,
    busy: false,
    error: '',
    unsupported: false,
    preview: null as MigrationHistoryUndoPreviewResult | null,
    result: null as MigrationHistoryUndoStateResult | null,
  })
  const [state, setState] = useState(blank)
  useLayoutEffect(() => {
    current.current = isCurrent
    sequence.current = continuationSequence
  }, [isCurrent, continuationSequence])
  useLayoutEffect(() => {
    owner.current = scope
    mounted.current = true
    pending.current = null
    latest.current = null
    const owned = requests.current
    return () => {
      if (owner.current === scope) {
        mounted.current = false
        for (const controller of owned) controller.abort()
        owned.clear()
      }
    }
  }, [scope])
  useEffect(
    () =>
      listenAccountContextChanges(target => {
        if (target === deviceId) setAccount(value => value + 1)
      }),
    [deviceId]
  )
  const valid = useCallback(
    () => mounted.current && owner.current === scope && scope.valid(deviceId) && current.current(),
    [scope, deviceId]
  )
  const update = useCallback(
    (partial: Partial<ReturnType<typeof blank>>) => {
      if (valid())
        setState(before => ({
          ...(before.scope === scope
            ? before
            : {
                scope,
                ready: false,
                busy: false,
                error: '',
                unsupported: false,
                preview: null,
                result: null,
              }),
          ...partial,
          scope,
        }))
    },
    [scope, valid]
  )
  const accept = useCallback(
    (value: MigrationHistoryUndoStateResult) => {
      if (
        !isMigrationHistoryUndoStateResult(value) ||
        value.job.continuationJobId !== continuationJobId
      )
        throw new Error('migration_invalid_result')
      if (!valid()) return
      const before = latest.current
      if (
        before?.job.jobId === value.job.jobId &&
        (before.job.sequence > value.job.sequence ||
          (before.job.sequence === value.job.sequence &&
            before.job.cancelRevision > value.job.cancelRevision))
      )
        return
      latest.current = value
      update({ result: value, ready: true })
    },
    [continuationJobId, valid, update]
  )
  const lookup = useCallback(
    async (signal?: AbortSignal) => {
      if (!continuationJobId || !valid()) return
      const value = await api.undoLookup({ continuationJobId }, { signal })
      if (!isMigrationHistoryUndoLookupResult(value)) throw new Error('migration_invalid_result')
      if (!valid() || signal?.aborted) return
      if (value.existingJob) {
        const observed = await api.undoRead({ jobId: value.existingJob.jobId }, { signal })
        if (!signal?.aborted) accept(observed)
      }
      update({ ready: true })
    },
    [api, continuationJobId, valid, accept, update]
  )
  useEffect(() => {
    if (!continuationJobId) return
    const controller = new AbortController()
    const owned = requests.current
    owned.add(controller)
    const timer = setTimeout(() => {
      void lookup(controller.signal).catch(cause => {
        if (!controller.signal.aborted)
          update({
            ready: true,
            error: code(cause),
            unsupported: code(cause) === 'migration_history_undo_update_required',
          })
      })
    }, 0)
    return () => {
      clearTimeout(timer)
      controller.abort()
      owned.delete(controller)
    }
  }, [continuationJobId, lookup, update])
  const perform = async (action: () => Promise<void>, mutation = false) => {
    if (!continuationJobId || !valid() || active.current === scope) return
    active.current = scope
    update({ busy: true, error: '' })
    try {
      await action()
    } catch (cause) {
      update({
        error: code(cause),
        ready: true,
        unsupported: code(cause) === 'migration_history_undo_update_required',
      })
      // A lost response cannot authorize another operation. Observe the source's canonical receipt.
      if (mutation && valid())
        try {
          await lookup()
        } catch {
          /* The pending request identity remains unchanged. */
        }
    } finally {
      if (active.current === scope) active.current = null
      update({ busy: false })
    }
  }
  const preview = () =>
    perform(async () => {
      const controller = new AbortController()
      requests.current.add(controller)
      try {
        const value = await api.undoPreview(
          { continuationJobId: continuationJobId! },
          { signal: controller.signal }
        )
        if (
          !isMigrationHistoryUndoPreviewResult(value) ||
          value.continuationJobId !== continuationJobId
        )
          throw new Error('migration_invalid_result')
        if (controller.signal.aborted || !valid()) return
        update({ preview: value })
        if (value.existingJob) {
          const observed = await api.undoRead(
            { jobId: value.existingJob.jobId },
            { signal: controller.signal }
          )
          if (!controller.signal.aborted) accept(observed)
        }
      } finally {
        requests.current.delete(controller)
      }
    })
  const start = () =>
    perform(async () => {
      const source = continuationJobId!
      let value = latest.current
      if (!value) {
        const requestId = pending.current ?? crypto.randomUUID()
        pending.current = requestId
        value = await api.undoCreate({
          requestId,
          continuationJobId: source,
          expectedContinuationSequence: sequence.current,
        })
        if (!valid()) return
        accept(value)
      }
      if (value.job.stage !== 'undone')
        accept(await api.undoRun({ jobId: value.job.jobId, expectedSequence: value.job.sequence }))
      update({ preview: null })
    }, true)
  const cancel = () =>
    perform(async () => {
      const value = latest.current
      if (value) accept(await api.undoCancel({ jobId: value.job.jobId }))
    }, true)
  const refresh = () =>
    perform(async () => {
      update({ preview: null })
      await lookup()
    })
  const value = state.scope === scope && scope.valid(deviceId) && isCurrent() ? state : null
  const running = Boolean(value?.result?.workerRunning),
    jobId = value?.result?.job.jobId
  useEffect(() => {
    if (!running || !jobId) return
    const controller = new AbortController()
    const owned = requests.current
    owned.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await api.undoRead({ jobId }, { signal: controller.signal })
        if (!controller.signal.aborted && valid()) {
          accept(next)
          if (latest.current?.workerRunning) timer = setTimeout(poll, 500)
        }
      } catch (cause) {
        if (!controller.signal.aborted) update({ error: code(cause) })
      }
    }
    timer = setTimeout(poll, 250)
    return () => {
      controller.abort()
      owned.delete(controller)
      if (timer) clearTimeout(timer)
    }
  }, [api, running, jobId, accept, valid, update])
  return {
    ready: !continuationJobId || Boolean(value?.ready),
    busy: Boolean(value?.busy),
    error: value?.error ?? '',
    unsupported: Boolean(value?.unsupported),
    preview: value?.preview ?? null,
    result: value?.result ?? null,
    prepare: preview,
    start,
    cancel,
    refresh,
  }
}
