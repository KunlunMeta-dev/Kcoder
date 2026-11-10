import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createMigrationApi } from './gatewayMigration'
import { downloadMigrationAttachment } from './migrationAttachmentDownload'
import type {
  HistoricalAttachmentSelection,
  MigrationHistoryAttachmentStateResult,
  MigrationHistoryToolAttachmentItemsResult,
} from '../../../shared/generated/contracts'
export interface MigrationAttachmentContext {
  deviceId: string
  workspacePath?: string
  jobId: string
  viewId?: string
  toolAttachments?: boolean
  toolItemIndex?: number
  isCurrent: () => boolean
}
const code = (cause: unknown) =>
  (cause instanceof Error ? cause.message : '').match(
    /\b(?:migration|history|external_history)_[a-z_]+\b/
  )?.[0] ?? 'history_attachment_job_failed'
export function useMigrationAttachment(
  context: MigrationAttachmentContext,
  position: number,
  blockIndex: number
) {
  const { deviceId, workspacePath, jobId, viewId } = context
  const toolAttachments = Boolean(context.toolAttachments || context.toolItemIndex != null)
  const api = useMemo(
    () => createMigrationApi(deviceId, workspacePath, toolAttachments),
    [deviceId, workspacePath, toolAttachments]
  )
  const selection = useMemo<HistoricalAttachmentSelection>(
    () => ({
      jobId,
      viewId,
      position,
      blockIndex,
      ...(context.toolItemIndex != null ? { toolItemIndex: context.toolItemIndex } : {}),
    }),
    [jobId, viewId, position, blockIndex, context.toolItemIndex]
  )
  const current = useRef(context.isCurrent)
  useEffect(() => {
    current.current = context.isCurrent
  }, [context.isCurrent])
  const mounted = useRef(false),
    active = useRef(false),
    download = useRef<AbortController | null>(null)
  const [result, setResult] = useState<MigrationHistoryAttachmentStateResult | null>(null),
    latest = useRef<MigrationHistoryAttachmentStateResult | null>(null)
  const [items, setItems] = useState<MigrationHistoryToolAttachmentItemsResult | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [downloaded, setDownloaded] = useState<number | null>(null)
  const valid = useCallback(() => mounted.current && current.current(), [])
  const accept = useCallback(
    (value: MigrationHistoryAttachmentStateResult) => {
      if (
        !valid() ||
        (latest.current?.job?.sequence ?? 0) > (value.job?.sequence ?? 0) ||
        (latest.current?.job?.cancelRevision ?? 0) > (value.job?.cancelRevision ?? 0)
      )
        return
      latest.current = value
      setResult(value)
    },
    [valid]
  )
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (!valid()) return
      void api
        .historyAttachmentRead({ selection }, { signal: controller.signal })
        .then(value => {
          if (!controller.signal.aborted) accept(value)
        })
        .catch(cause => {
          if (!controller.signal.aborted && valid()) setError(code(cause))
        })
    }, 0)
    return () => {
      mounted.current = false
      controller.abort()
      download.current?.abort()
      clearTimeout(timer)
    }
  }, [api, selection, accept, valid])
  const perform = async (action: () => Promise<void>) => {
    if (!valid() || active.current) return false
    active.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      return valid()
    } catch (cause) {
      if (valid() && !(cause instanceof DOMException && cause.name === 'AbortError'))
        setError(code(cause))
      if (valid())
        try {
          accept(await api.historyAttachmentRead({ selection }))
        } catch {
          /* Observe without replaying a possibly accepted operation. */
        }
      return false
    } finally {
      active.current = false
      if (valid()) {
        setBusy(false)
        setDownloaded(null)
      }
    }
  }
  const run = () =>
    perform(async () => {
      const job = latest.current?.job
      accept(
        job && ['cancelled', 'failed'].includes(job.stage)
          ? await api.historyAttachmentResume({ selection, expectedSequence: job.sequence })
          : await api.historyAttachmentRun({ selection })
      )
    })
  const cancel = () => perform(async () => accept(await api.historyAttachmentCancel({ selection })))
  const refresh = () => perform(async () => accept(await api.historyAttachmentRead({ selection })))
  const save = () =>
    perform(async () => {
      const info = latest.current?.job?.info,
        receipt = info?.receipt
      if (!receipt) throw new Error('history_attachment_not_ready')
      const controller = new AbortController()
      download.current = controller
      setDownloaded(0)
      try {
        await downloadMigrationAttachment(
          receipt,
          info.displayName || `attachment-${position}-${blockIndex}.bin`,
          (offset, signal) =>
            api.historyAttachmentChunk({ selection, offset, limit: 256 * 1024 }, { signal }),
          controller.signal,
          bytes => {
            if (valid()) setDownloaded(bytes)
          },
          valid
        )
      } finally {
        if (download.current === controller) download.current = null
      }
    })
  const loadItems = (cursor?: number) =>
    perform(async () => {
      const value = await api.historyAttachmentItems({ selection, cursor })
      if (valid()) setItems(value)
    })
  const running = Boolean(result?.workerRunning)
  useEffect(() => {
    if (!running) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (!valid()) return
      try {
        const value = await api.historyAttachmentRead({ selection }, { signal: controller.signal })
        if (!controller.signal.aborted && valid()) {
          accept(value)
          if (latest.current?.workerRunning) timer = setTimeout(poll, 750)
        }
      } catch (cause) {
        if (!controller.signal.aborted && valid()) setError(code(cause))
      }
    }
    timer = setTimeout(poll, 300)
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [api, selection, running, accept, valid])
  return {
    result,
    items,
    loadItems,
    busy,
    error,
    downloaded,
    run,
    cancel,
    refresh,
    save,
    cancelDownload: () => download.current?.abort(),
  }
}
