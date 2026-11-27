import { downloadMigrationAttachment } from './migrationAttachmentDownload'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { captureAccountContextRevision } from './accountContextEvents'
import { createMigrationApi } from './gatewayMigration'
import { sameHistoricalAttachmentSelection } from './migrationLocalAttachmentUpload'
import type { MigrationAttachmentContext } from './useMigrationAttachment'
import type {
  HistoricalAttachmentSelection,
  HistoricalLocalAttachmentUpload,
  HistoricalLocalAttachmentJob,
  MigrationUploadCollectionStateResult,
} from '../../../shared/generated/contracts'
const failure = (error: unknown) =>
  (error instanceof Error ? error.message : '').match(
    /\b(?:migration|local_upload|local_attachment|history_branch)_[a-z_]+\b/
  )?.[0] ?? 'local_upload_collection_outcome_unknown'
interface View {
  finalJob: HistoricalLocalAttachmentJob | null
  result: MigrationUploadCollectionStateResult | null
  items: MigrationUploadCollectionStateResult[]
  next: string | null
  pages: Array<string | null>
  selected: string | null
  busy: boolean
  error: string
}
const EMPTY: View = {
  finalJob: null,
  result: null,
  items: [],
  next: null,
  pages: [null],
  selected: null,
  busy: false,
  error: '',
}

/** Only explicit user operations mutate staging. Reopen and recovery perform reads. */
export function useMigrationUploadCollection(
  context: MigrationAttachmentContext,
  input: HistoricalAttachmentSelection,
  upload?: HistoricalLocalAttachmentUpload
) {
  const selection = useMemo<HistoricalAttachmentSelection>(
    () => ({
      jobId: input.jobId,
      viewId: input.viewId,
      position: input.position,
      blockIndex: input.blockIndex,
      toolItemIndex: input.toolItemIndex,
    }),
    [input.jobId, input.viewId, input.position, input.blockIndex, input.toolItemIndex]
  )
  const api = useMemo(
    () => createMigrationApi(context.deviceId, context.workspacePath),
    [context.deviceId, context.workspacePath]
  )
  const key = JSON.stringify([
    selection.jobId,
    selection.viewId ?? null,
    selection.position,
    selection.blockIndex,
    selection.toolItemIndex ?? null,
  ])
  const scope = useMemo(
    () => ({
      api,
      key,
      isCurrent: context.isCurrent,
      target: context.deviceId,
      account: captureAccountContextRevision(),
    }),
    [api, key, context.isCurrent, context.deviceId]
  )
  const owner = useRef(scope)
  const download = useRef<AbortController | null>(null)
  const mounted = useRef(false),
    selected = useRef<string | null>(null)
  const active = useRef<object | null>(null),
    latest = useRef<MigrationUploadCollectionStateResult | null>(null)
  const currentUpload = useRef(upload)
  useLayoutEffect(() => {
    owner.current = scope
    currentUpload.current = upload
  }, [scope, upload])
  const [view, setView] = useState<View & { scope: typeof scope }>({ ...EMPTY, scope })
  const [refreshRevision, setRefresh] = useState(0)
  const state = view.scope === scope ? view : EMPTY
  const valid = useCallback(
    () =>
      mounted.current &&
      owner.current === scope &&
      scope.isCurrent() &&
      scope.account(scope.target),
    [scope]
  )
  const update = useCallback(
    (patch: Partial<View>) => {
      if (valid()) setView(old => ({ ...(old.scope === scope ? old : EMPTY), ...patch, scope }))
    },
    [scope, valid]
  )
  const accept = useCallback(
    (value: MigrationUploadCollectionStateResult, id: string) => {
      if (!valid() || selected.current !== id) return
      if (
        value.collection &&
        (!sameHistoricalAttachmentSelection(value.collection.selection, selection) ||
          value.collection.operationId !== id)
      )
        throw new Error('local_upload_collection_invalid_response')
      const before = latest.current?.collection,
        next = value.collection
      if (before?.operationId === id && (!next || before.collectionId !== next.collectionId))
        throw new Error('local_upload_collection_invalid_response')
      if (
        before?.operationId === id &&
        next &&
        (next.sequence < before.sequence || next.cancelRevision < before.cancelRevision)
      )
        return
      latest.current = value
      update({ result: value })
    },
    [selection, update, valid]
  )
  const read = useCallback(
    async (id: string, signal?: AbortSignal) => {
      const value = await api.uploadCollectionRead({ operationId: id, selection }, { signal })
      if (!signal?.aborted) accept(value, id)
      return value
    },
    [api, selection, accept]
  )
  async function page(cursor: string | null, pages: Array<string | null>) {
    const value = await api.uploadCollectionList({ selection, cursor })
    if (valid()) update({ items: value.items, next: value.nextCursor ?? null, pages })
  }
  useEffect(() => {
    mounted.current = true
    selected.current = null
    latest.current = null
    active.current = null
    const controller = new AbortController()
    void api
      .uploadCollectionList({ selection }, { signal: controller.signal })
      .then(value => {
        if (!controller.signal.aborted)
          update({ items: value.items, next: value.nextCursor ?? null })
      })
      .catch(error => {
        if (!controller.signal.aborted) update({ error: failure(error) })
      })
    return () => {
      mounted.current = false
      controller.abort()
      download.current?.abort()
    }
  }, [scope, api, selection, update])
  useEffect(() => {
    const id = state.selected
    if (!id) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let retries = 0
    async function poll() {
      try {
        const value = await read(id!, controller.signal)
        if (
          !controller.signal.aborted &&
          valid() &&
          selected.current === id &&
          (value.workerRunning || value.workerScheduled)
        )
          timer = setTimeout(() => {
            void poll()
          }, 500)
      } catch (error) {
        if (!controller.signal.aborted && valid() && selected.current === id) {
          const code = failure(error)
          if (['local_upload_collection_busy', 'local_upload_busy'].includes(code) && retries++ < 8)
            timer = setTimeout(() => {
              void poll()
            }, 250)
          else update({ error: code })
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [scope, state.selected, refreshRevision, read, valid, update])
  async function perform(action: () => Promise<void>) {
    if (!valid() || active.current) return false
    const ticket = {}
    active.current = ticket
    update({ busy: true, error: '' })
    try {
      await action()
      return valid()
    } catch (error) {
      update({ error: failure(error) })
      return false
    } finally {
      if (active.current === ticket) {
        active.current = null
        update({ busy: false })
      }
    }
  }
  const choose = (id: string) => {
    if (!valid()) return
    selected.current = id
    latest.current = null
    update({ selected: id, result: null, finalJob: null, error: '' })
    setRefresh(v => v + 1)
  }
  const prepare = () =>
    perform(async () => {
      const id = currentUpload.current?.operationId
      if (!id) throw new Error('local_attachment_upload_not_found')
      choose(id)
      const fresh = await api.localAttachmentRead({ operationId: id })
      if (!valid() || currentUpload.current?.operationId !== id) return
      if (!sameHistoricalAttachmentSelection(fresh.upload.selection, selection))
        throw new Error('local_upload_collection_selection_changed')
      const value = await api.uploadCollectionPrepare({
        operationId: id,
        selection,
        expectedUploadSequence: fresh.upload.sequence,
      })
      accept(value, id)
      setRefresh(v => v + 1)
    })
  const run = (
    confirmed: NonNullable<MigrationUploadCollectionStateResult['collection']>,
    action: 'run' | 'resume'
  ) =>
    perform(async () => {
      if (
        selected.current !== confirmed.operationId ||
        latest.current?.collection?.collectionId !== confirmed.collectionId ||
        latest.current.collection.sequence !== confirmed.sequence
      )
        throw new Error('local_upload_collection_stale_sequence')
      const params = {
        operationId: confirmed.operationId,
        selection,
        collectionId: confirmed.collectionId,
        expectedSequence: confirmed.sequence,
      }
      let value: MigrationUploadCollectionStateResult
      if (action === 'resume') {
        let sequence = confirmed.uploadSequence
        if (!confirmed.storageRetired) {
          const fresh = await api.localAttachmentRead({ operationId: confirmed.operationId })
          if (!valid()) return
          if (!sameHistoricalAttachmentSelection(fresh.upload.selection, selection))
            throw new Error('local_upload_collection_selection_changed')
          sequence = fresh.upload.sequence
        }
        value = await api.uploadCollectionResume({ ...params, expectedUploadSequence: sequence })
      } else value = await api.uploadCollectionRun(params)
      accept(value, confirmed.operationId)
      setRefresh(v => v + 1)
    })
  async function cancel() {
    const value = latest.current?.collection
    if (!valid() || !value) return
    try {
      const result = await api.uploadCollectionCancel({
        operationId: value.operationId,
        selection,
        collectionId: value.collectionId,
      })
      accept(result, value.operationId)
      setRefresh(v => v + 1)
    } catch (error) {
      update({ error: failure(error) })
    }
  }
  const save = () =>
    perform(async () => {
      const value = latest.current?.collection
      if (!value || value.stage !== 'collected')
        throw new Error('local_upload_collection_not_collected')
      const controller = new AbortController()
      download.current = controller
      try {
        const result = await api.uploadCollectionAttachment(
          { operationId: value.operationId, selection },
          { signal: controller.signal }
        )
        if (!valid() || selected.current !== value.operationId || controller.signal.aborted) return
        update({ finalJob: result.job })
        const receipt = result.job.state.receipt
        if (!receipt) throw new Error('local_attachment_not_ready')
        await downloadMigrationAttachment(
          receipt,
          result.job.info.displayName || receipt.attachmentId,
          (offset, signal) =>
            api.localAttachmentChunk(
              {
                operationId: value.operationId,
                selection,
                expectedReceipt: receipt,
                offset,
                limit: 256 * 1024,
              },
              { signal }
            ),
          controller.signal,
          () => undefined,
          () => valid() && selected.current === value.operationId
        )
      } finally {
        if (download.current === controller) download.current = null
      }
    })
  return {
    ...state,
    scope,
    prepare,
    run,
    cancel,
    choose,
    save,
    refresh: () => {
      update({ error: '' })
      setRefresh(v => v + 1)
      void page(state.pages.at(-1) ?? null, state.pages).catch(error =>
        update({ error: failure(error) })
      )
    },
    nextPage: () => state.next && perform(() => page(state.next, [...state.pages, state.next])),
    previousPage: () =>
      state.pages.length > 1 &&
      perform(() => page(state.pages.at(-2) ?? null, state.pages.slice(0, -1))),
  }
}
