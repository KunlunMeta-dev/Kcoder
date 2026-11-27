import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isMigrationLocalAttachmentStateResult, isMigrationLocalAttachmentListResult } from '../../../shared/generated/contracts'
import type {
  HistoricalAttachmentSelection, HistoricalLocalAttachmentUpload,
  MigrationLocalAttachmentStateResult,
} from '../../../shared/generated/contracts'
import type { MigrationAttachmentContext } from './useMigrationAttachment'
import { createMigrationApi } from './gatewayMigration'
import { createRandomUuid } from '@/lib/random-id'
import { uploadMigrationLocalAttachment, sameHistoricalAttachmentSelection } from './migrationLocalAttachmentUpload'
import { downloadMigrationAttachment } from './migrationAttachmentDownload'
import { captureAccountContextRevision } from './accountContextEvents'

type UploadScope = { isCurrent: () => boolean; accountCurrent: (target: string) => boolean; target: string;
  api: ReturnType<typeof createMigrationApi>; selection: HistoricalAttachmentSelection }
interface UploadView {
  state: MigrationLocalAttachmentStateResult | null
  items: HistoricalLocalAttachmentUpload[]
  nextCursor: string | null
  busy: boolean
  error: string
  hashing: number | null
}
const EMPTY_VIEW: UploadView = { state: null, items: [], nextCursor: null, busy: false, error: '', hashing: null }

const failure = (error: unknown) => (error instanceof Error ? error.message : '')
  .match(/\b(?:migration|local_attachment|local_upload)_[a-z_]+\b/)?.[0] ?? 'local_attachment_operation_failed'

export function useMigrationLocalAttachment(context: MigrationAttachmentContext, position: number, blockIndex: number) {
  const selection = useMemo<HistoricalAttachmentSelection>(() => ({ jobId: context.jobId,
    ...(context.viewId ? { viewId: context.viewId } : {}), position, blockIndex,
    ...(context.toolItemIndex == null ? {} : { toolItemIndex: context.toolItemIndex }),
  }), [context.jobId, context.viewId, context.toolItemIndex, position, blockIndex])
  const api = useMemo(() => createMigrationApi(context.deviceId, context.workspacePath), [context.deviceId, context.workspacePath])
  const scope = useMemo<UploadScope>(() => ({ api, selection, isCurrent: context.isCurrent,
    accountCurrent: captureAccountContextRevision(), target: context.deviceId }), [api, selection, context.isCurrent, context.deviceId])
  const scopeRef = useRef(scope), mounted = useRef(false)
  const pending = useRef<AbortController | null>(null), active = useRef(false)
  const latest = useRef<MigrationLocalAttachmentStateResult | null>(null)
  const selectedOperation = useRef<string | null>(null)
  const pendingId = useRef<string | null>(null)
  const [view, setView] = useState<UploadView & { scope: UploadScope }>({ scope, ...EMPTY_VIEW })
  const { state, items, nextCursor, busy, error, hashing } = view.scope === scope ? view : EMPTY_VIEW
  useLayoutEffect(() => {
    scopeRef.current = scope
  }, [scope])
  const valid = useCallback((owner: UploadScope) => mounted.current && scopeRef.current === owner &&
    owner.isCurrent() && owner.accountCurrent(owner.target), [])
  const update = useCallback((patch: Partial<UploadView>) => {
    if (valid(scope)) setView(before => ({ ...(before.scope === scope ? before : EMPTY_VIEW), ...patch, scope }))
  }, [scope, valid])
  const setState = useCallback((state: MigrationLocalAttachmentStateResult | null) => update({ state }), [update])
  const setItems = useCallback((items: HistoricalLocalAttachmentUpload[]) => update({ items }), [update])
  const setNextCursor = useCallback((nextCursor: string | null) => update({ nextCursor }), [update])
  const setBusy = useCallback((busy: boolean) => update({ busy }), [update])
  const setError = useCallback((error: string) => update({ error }), [update])
  const setHashing = useCallback((hashing: number | null) => update({ hashing }), [update])
  const accept = useCallback((value: MigrationLocalAttachmentStateResult, owner: UploadScope) => {
    if (!valid(owner)) return
    if (!isMigrationLocalAttachmentStateResult(value)) throw new Error('local_attachment_upload_invalid_result')
    if (selectedOperation.current !== value.upload.operationId) return
    const selected = value.upload.selection
    if (!sameHistoricalAttachmentSelection(selected, selection)) throw new Error('local_attachment_upload_invalid_result')
    const previous = latest.current?.upload
    if (previous?.operationId === value.upload.operationId &&
      (previous.sequence > value.upload.sequence || previous.cancelRevision > value.upload.cancelRevision ||
       (previous.localJob && value.upload.localJob && (previous.localJob.state.sequence > value.upload.localJob.state.sequence ||
        previous.localJob.state.cancelRevision > value.upload.localJob.state.cancelRevision)))) return
    latest.current = value
    setState(value)
  }, [selection, valid, setState])
  useEffect(() => {
    mounted.current = true
    latest.current = null; selectedOperation.current = null; pendingId.current = null; active.current = false
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void api.localAttachmentList({ selection }, { signal: controller.signal }).then(page => {
        if (!isMigrationLocalAttachmentListResult(page) || page.items.length > 10 ||
          page.items.some(item => !sameHistoricalAttachmentSelection(item.selection, selection)))
          throw new Error('local_attachment_upload_invalid_result')
        if (valid(scope) && !controller.signal.aborted) { setItems(page.items); setNextCursor(page.nextCursor ?? null) }
      }).catch(cause => { if (valid(scope) && !controller.signal.aborted) setError(failure(cause)) })
    }, 0)
    return () => { mounted.current = false; controller.abort(); pending.current?.abort(); clearTimeout(timer) }
  }, [api, selection, scope, valid, setItems, setNextCursor, setError])

  const perform = async (action: (owner: UploadScope, signal: AbortSignal) => Promise<void>) => {
    if (!valid(scope) || active.current) return false
    const owner = scope, controller = new AbortController()
    active.current = true; pending.current = controller; setBusy(true); setError('')
    try {
      await action(owner, controller.signal)
      return valid(owner)
    } catch (cause) {
      if (valid(owner) && !controller.signal.aborted) setError(failure(cause))
      return false
    } finally {
      if (pending.current === controller) pending.current = null
      if (valid(owner)) { active.current = false; setBusy(false); setHashing(null) }
    }
  }
  const observe = async (id: string, owner: UploadScope) => {
    const value = await api.localAttachmentRead({ operationId: id })
    if (!isMigrationLocalAttachmentStateResult(value) || value.upload.operationId !== id) throw new Error('local_attachment_upload_invalid_result')
    accept(value, owner)
    return value
  }
  const prepare = () => perform(async owner => {
    const id = pendingId.current ?? createRandomUuid()
    pendingId.current = id
    selectedOperation.current = id
    latest.current = null
    setState(null)
    try {
      const value = await api.localAttachmentPrepare({ requestId: id, selection })
      if (!isMigrationLocalAttachmentStateResult(value) || value.upload.operationId !== id) throw new Error('local_attachment_upload_invalid_result')
      accept(value, owner)
      if (valid(owner)) pendingId.current = null
    } catch (cause) {
      // Creation may have committed. Keep the identity and only reconcile it.
      if (valid(owner)) await observe(id, owner).then(() => {
        if (valid(owner)) pendingId.current = null
      }).catch(() => undefined)
      throw cause
    }
  })
  const open = (id: string) => perform(async owner => {
    selectedOperation.current = id
    pendingId.current = null
    latest.current = null
    setState(null)
    await observe(id, owner)
  })
  const refresh = () => latest.current && open(latest.current.upload.operationId)
  const finish = async (result: MigrationLocalAttachmentStateResult, owner: UploadScope) => {
    try {
      const value = await api.localAttachmentFinish({ operationId: result.upload.operationId, expectedSequence: result.upload.sequence })
      if (!isMigrationLocalAttachmentStateResult(value) || value.upload.operationId !== result.upload.operationId) throw new Error('local_attachment_upload_invalid_result')
      accept(value, owner)
    } catch (cause) {
      if (valid(owner)) await observe(result.upload.operationId, owner).catch(() => undefined)
      throw cause
    }
  }
  const finalize = () => perform(async owner => {
    const current = latest.current
    if (!current || current.upload.stage !== 'receiving' || current.upload.cancelRequested ||
      current.upload.bytes == null || current.upload.receivedBytes !== current.upload.bytes)
      throw new Error('local_attachment_upload_incomplete')
    // All original bytes are already owned by the target. Do not require the source File again.
    await finish(current, owner)
  })
  const upload = (file: File) => perform(async (owner, signal) => {
    const initial = latest.current
    if (!initial) throw new Error('local_attachment_upload_not_found')
    const result = await uploadMigrationLocalAttachment(file, initial, api, signal, () => valid(owner),
      value => accept(value, owner), bytes => { if (valid(owner)) setHashing(bytes) })
    if (!valid(owner) || signal.aborted) return
    await finish(result, owner)
  })
  const run = () => perform(async owner => {
    const current = latest.current, local = current?.upload.localJob
    if (!current || !local) throw new Error('local_attachment_job_not_found')
    try {
      const value = await api.localAttachmentRun({ operationId: current.upload.operationId, expectedSequence: local.state.sequence })
      if (!isMigrationLocalAttachmentStateResult(value) || value.upload.operationId !== current.upload.operationId) throw new Error('local_attachment_upload_invalid_result')
      accept(value, owner)
    }
    catch (cause) { if (valid(owner)) await observe(current.upload.operationId, owner).catch(() => undefined); throw cause }
  })
  const resume = () => perform(async owner => {
    const current = latest.current
    if (!current) return
    const value = await api.localAttachmentResume({ operationId: current.upload.operationId, expectedSequence: current.upload.sequence })
    if (!isMigrationLocalAttachmentStateResult(value) || value.upload.operationId !== current.upload.operationId) throw new Error('local_attachment_upload_invalid_result')
    accept(value, owner)
  })
  const cancel = async () => {
    const owner = scope, id = latest.current?.upload.operationId ?? pendingId.current
    pending.current?.abort()
    if (!valid(owner) || !id) return
    try {
      const value = await api.localAttachmentCancel({ operationId: id })
      if (!isMigrationLocalAttachmentStateResult(value) || value.upload.operationId !== id) throw new Error('local_attachment_upload_invalid_result')
      if (selectedOperation.current === id) accept(value, owner)
    }
    catch (cause) { if (valid(owner) && selectedOperation.current === id) setError(failure(cause)) }
  }
  const listMore = () => perform(async owner => {
    if (!nextCursor) return
    const page = await api.localAttachmentList({ selection, cursor: nextCursor })
    if (!isMigrationLocalAttachmentListResult(page) || page.items.length > 10 ||
      page.items.some(item => !sameHistoricalAttachmentSelection(item.selection, selection)))
      throw new Error('local_attachment_upload_invalid_result')
    if (valid(owner)) { setItems(page.items); setNextCursor(page.nextCursor ?? null) }
  })
  const save = () => perform(async (owner, signal) => {
    const upload = latest.current?.upload, receipt = upload?.localJob?.state.receipt
    if (!upload || !receipt) throw new Error('local_attachment_not_ready')
    await downloadMigrationAttachment(receipt, upload.filename || 'supplement.bin',
      (offset, signal) => api.localAttachmentChunk({ operationId: upload.operationId,
        selection, expectedReceipt: receipt, offset, limit: 256 * 1024 }, { signal }),
      signal, () => undefined, () => valid(owner))
  })
  const running = state?.workerRunning ?? false
  const operationId = state?.upload.operationId
  useEffect(() => {
    if (!running || !operationId) return
    const owner = scope, id = operationId, controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!valid(owner)) return
      try {
        const value = await api.localAttachmentRead({ operationId: id }, { signal: controller.signal })
        if (controller.signal.aborted || !valid(owner)) return
        if (latest.current?.upload.operationId !== id || value.upload.operationId !== id) return
        accept(value, owner)
        if (value.workerRunning) timer = setTimeout(poll, 500)
      } catch (cause) { if (!controller.signal.aborted && valid(owner)) setError(failure(cause)) }
    }
    timer = setTimeout(poll, 250)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [api, running, operationId, scope, valid, accept, setError])
  return { state, items, nextCursor, busy, error, hashing, prepare, open, refresh, upload, finalize, run, resume, cancel, listMore, save }
}
