import { migrationRequestId as createRandomUuid } from '../migration-client'
import { Sha256Stream } from '@/protocol/sha256-stream'
import { isMigrationSourceUploadPrepareParams, type MigrationSourceUploadStateResult, type MigrationSourceUploadFilesResult } from '../../../../shared/generated/contracts'
import type { createMobileSourceUploadApi } from './upload-api'
import { selectSourceUploadFiles, selectSourceUploadPackage, sourceUploadManifestBytes, SOURCE_UPLOAD_MAX_BYTES, SOURCE_UPLOAD_PART_BYTES, type SelectedSourceFile, type SelectedSourceUpload, type SourceUploadManifest } from './files'
import { sendSourceUploadFiles } from './send-upload'
import { assertSourceUploadPaths } from './path-policy'

type Api = Pick<ReturnType<typeof createMobileSourceUploadApi>, 'sourceUploadPrepare' | 'sourceUploadRead' | 'sourceUploadFiles' | 'sourceUploadPart' | 'sourceUploadFinish' | 'sourceUploadCancel' | 'sourceUploadResume'>
type StoragePort = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>
export type SourceUploadSelector = { version: 1; operationId: string; manifest: SourceUploadManifest; manifestSha256: string; cancelCommandId?: string }
export type SourceUploadSnapshot = {
  busy: boolean; hashing: boolean; hashedBytes: number; hashTotalBytes: number; error: string;
  selected: SelectedSourceUpload | null; selector: SourceUploadSelector | null;
  observed: MigrationSourceUploadStateResult | null; files: MigrationSourceUploadFilesResult | null;
  cached: SourceUploadSelector[]; unknown: boolean; readAttempted: boolean
}

/** Retain only immutable selectors. The browser never grants a target path or treats its cache as a receipt. */
export function createSourceUploadController({ api, storage, scope, isCurrent }: {
  api: Api; storage: StoragePort; scope: string; isCurrent: () => boolean
}) {
  const prefix = `kcoder-studio:mobile-source-upload:${scope}:`
  let active = true, generation = 0, abort: AbortController | null = null
  let snapshot: SourceUploadSnapshot = { busy: false, hashing: false, hashedBytes: 0, hashTotalBytes: 0, error: '',
    selected: null, selector: null, observed: null, files: null, cached: [], unknown: false, readAttempted: false }
  const listeners = new Set<() => void>()
  const current = () => active && isCurrent()
  const publish = (patch: Partial<SourceUploadSnapshot>) => {
    if (!current()) return
    snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener()
  }
  const key = (id: string) => prefix + id
  const decode = (text: string | null, expectedKey: string): SourceUploadSelector => {
    if (!text || text.length > 1024 ** 2 + 2048) throw new Error('recoveryUnavailable')
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error('recoveryUnavailable') }
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('operationId' in value) || !('manifest' in value) || !('manifestSha256' in value)
      || !isMigrationSourceUploadPrepareParams({ operationId: value.operationId, manifest: value.manifest })
      || typeof value.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestSha256)
      || Object.keys(value).some(name => !['version', 'operationId', 'manifest', 'manifestSha256', 'cancelCommandId'].includes(name))
      || expectedKey !== key(String(value.operationId))
      || 'cancelCommandId' in value && (typeof value.cancelCommandId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.cancelCommandId))) throw new Error('recoveryUnavailable')
    const selector = value as SourceUploadSelector
    const canonical = sourceUploadManifestBytes(selector.manifest)
    if (selector.manifest.files.length < 1 || selector.manifest.files.length > 1024
      || canonical.length > 1024 ** 2
      || selector.manifest.files.reduce((sum, file) => sum + file.bytes, 0) > SOURCE_UPLOAD_MAX_BYTES
      || new Sha256Stream().update(canonical).digestHex() !== selector.manifestSha256) throw new Error('recoveryUnavailable')
    return selector
  }
  const cached = () => {
    if (storage.length > 4096) throw new Error('recoveryUnavailable')
    const values: SourceUploadSelector[] = []
    let metadataBytes = 0
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i)
      if (!name?.startsWith(prefix)) continue
      if (values.length >= 32) throw new Error('recoveryLimit')
      const raw = storage.getItem(name)
      metadataBytes += raw?.length ?? 0
      if (metadataBytes > 4 * 1024 ** 2) throw new Error('recoveryLimit')
      values.push(decode(raw, name))
    }
    return values.sort((a, b) => a.operationId.localeCompare(b.operationId))
  }
  const persist = (selector: SourceUploadSelector, replacing: boolean) => {
    try {
      const name = key(selector.operationId), old = storage.getItem(name)
      if (old) {
        const previous = decode(old, name)
        if (!replacing || previous.manifestSha256 !== selector.manifestSha256 || JSON.stringify(previous.manifest) !== JSON.stringify(selector.manifest)) throw new Error('recoveryUnavailable')
      } else if (replacing) throw new Error('recoveryUnavailable')
      if (!replacing && cached().length >= 32) throw new Error('recoveryLimit')
      const text = JSON.stringify(selector)
      decode(text, name); storage.setItem(name, text)
      if (storage.getItem(name) !== text) throw new Error('recoveryUnavailable')
      publish({ selector, cached: cached() })
    } catch (error) {
      if (error instanceof Error && error.message === 'recoveryLimit') throw error
      throw new Error('recoveryUnavailable', { cause: error })
    }
  }
  const observe = (value: MigrationSourceUploadStateResult, selector = snapshot.selector) => {
    const next = value.upload, previous = snapshot.observed?.upload
    if (!selector || next.operationId !== selector.operationId || next.manifestSha256 !== selector.manifestSha256
      || next.source !== selector.manifest.source || next.totalFiles !== selector.manifest.files.length
      || next.totalBytes !== selector.manifest.files.reduce((sum, file) => sum + file.bytes, 0)
      || previous && (next.sequence < previous.sequence || next.cancelWatermark < previous.cancelWatermark || next.receivedBytes < previous.receivedBytes)) throw new Error('invalidResponse')
    publish({ observed: value, unknown: false })
  }
  const perform = async (action: (signal: AbortSignal, valid: () => boolean) => Promise<void>, selecting = false) => {
    if (!current() || snapshot.busy) return
    const request = ++generation, controller = new AbortController(); abort = controller
    const valid = () => current() && generation === request && !controller.signal.aborted
    publish({ busy: true, error: '' })
    try { await action(controller.signal, valid) } catch (error) {
      const local = error instanceof Error && ['selectionMismatch', 'recoveryUnavailable', 'recoveryLimit', 'migration_source_upload_update_required'].includes(error.message)
      if (valid()) publish({ error: selecting ? error instanceof Error && error.message === 'selectionMismatch' ? 'selectionMismatch' : 'selectionFailed'
        : local ? error.message : snapshot.selector ? 'outcomeUnknown' : 'selectionFailed', unknown: selecting || local ? snapshot.unknown : !!snapshot.selector })
    } finally { if (valid()) { abort = null; publish({ busy: false, hashing: false }) } }
  }
  const acceptSelection = (selected: SelectedSourceUpload) => {
    if (snapshot.selector && selected.manifestSha256 !== snapshot.selector.manifestSha256) throw new Error('selectionMismatch')
    publish({ selected, hashing: false })
  }
  const send = async (signal: AbortSignal, valid: () => boolean, initial: MigrationSourceUploadStateResult) => {
    const selected = snapshot.selected
    if (!selected) throw new Error('selectionMismatch')
    const result = await sendSourceUploadFiles(selected, initial, { read: input => api.sourceUploadRead(input), files: input => api.sourceUploadFiles(input),
      part: input => api.sourceUploadPart(input), finish: input => api.sourceUploadFinish(input) }, signal, valid,
    value => { if (valid()) observe(value) })
    if (valid()) observe(result)
  }
  try { snapshot.cached = cached() } catch { snapshot.error = 'recoveryUnavailable' }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    activate() { active = true },
    dispose() { active = false; generation++; abort?.abort(); abort = null; listeners.clear() },
    selectFiles: (source: SourceUploadManifest['source'], files: readonly SelectedSourceFile[]) => perform(async (signal, valid) => {
      publish({ selected: null })
      assertSourceUploadPaths(files.map(file => file.relativePath))
      let ordered = files
      if (snapshot.selector) {
        const manifest = snapshot.selector.manifest, byPath = new Map(files.map(file => [file.relativePath, file]))
        if (source !== manifest.source || files.length !== manifest.files.length || byPath.size !== files.length || manifest.files.some(file => !byPath.has(file.relativePath))) throw new Error('selectionMismatch')
        ordered = manifest.files.map(file => byPath.get(file.relativePath)!)
      }
      publish({ hashing: true, selected: null, hashedBytes: 0, hashTotalBytes: ordered.reduce((sum, file) => sum + file.blob.size, 0) })
      const selected = await selectSourceUploadFiles(source, ordered, signal, valid, (hashedBytes, hashTotalBytes) => publish({ hashedBytes, hashTotalBytes }))
      if (valid()) acceptSelection(selected)
    }, true),
    selectPackage: (source: SourceUploadManifest['source'], file: Blob) => perform(async (signal, valid) => {
      publish({ hashing: true, selected: null, hashedBytes: 0, hashTotalBytes: 0 })
      const selected = await selectSourceUploadPackage(file, signal, valid)
      if (!valid()) return
      assertSourceUploadPaths(selected.manifest.files.map(file => file.relativePath))
      if (selected.manifest.source !== source) throw new Error('selectionMismatch')
      acceptSelection(selected)
    }, true),
    start: () => perform(async (signal, valid) => {
      const selected = snapshot.selected
      if (!selected || snapshot.selector) throw new Error('selectionMismatch')
      const selector: SourceUploadSelector = { version: 1, operationId: createRandomUuid(), manifest: selected.manifest, manifestSha256: selected.manifestSha256 }
      persist(selector, false)
      const initial = await api.sourceUploadPrepare({ operationId: selector.operationId, manifest: selector.manifest })
      if (!valid()) return
      observe(initial); await send(signal, valid, initial)
    }),
    restore: (id: string) => perform(async (_signal, valid) => {
      let selector: SourceUploadSelector
      try { selector = decode(storage.getItem(key(id)), key(id)) } catch { throw new Error('recoveryUnavailable') }
      publish({ selector, selected: null, observed: null, files: null, unknown: true, readAttempted: true })
      const result = await api.sourceUploadRead({ operationId: selector.operationId })
      if (valid()) observe(result, selector)
    }),
    read: () => perform(async (_signal, valid) => {
      const selector = snapshot.selector
      if (!selector) return
      publish({ readAttempted: true })
      const value = await api.sourceUploadRead({ operationId: selector.operationId })
      if (valid()) observe(value)
    }),
    retryPrepare: () => perform(async (_signal, valid) => {
      const selector = snapshot.selector, selected = snapshot.selected
      if (!snapshot.readAttempted || snapshot.observed || !selector || !selected || selected.manifestSha256 !== selector.manifestSha256) return
      const value = await api.sourceUploadPrepare({ operationId: selector.operationId, manifest: selector.manifest })
      if (valid()) observe(value)
    }),
    resume: () => perform(async (signal, valid) => {
      const selector = snapshot.selector, selected = snapshot.selected
      if (!selector || !selected || selector.manifestSha256 !== selected.manifestSha256) throw new Error('selectionMismatch')
      let value = await api.sourceUploadRead({ operationId: selector.operationId })
      if (!valid()) return
      observe(value)
      if (value.upload.workerState !== 'stopped') throw new Error('outcomeUnknown')
      if (value.upload.cancelRequested) {
        value = await api.sourceUploadResume({ operationId: selector.operationId, expectedSequence: value.upload.sequence, cancelWatermark: value.upload.cancelWatermark })
        if (!valid()) return
        observe(value)
      }
      if (selector.cancelCommandId) { const next = { ...selector }; delete next.cancelCommandId; persist(next, true) }
      await send(signal, valid, value)
    }),
    cancel: async () => {
      if (!current()) return
      abort?.abort(); abort = null
      const request = ++generation, valid = () => current() && generation === request
      const selector = snapshot.selector
      publish({ busy: true, hashing: false })
      if (!selector) { publish({ busy: false, selected: null, error: 'localStopped' }); return }
      try {
        const next = { ...selector, cancelCommandId: selector.cancelCommandId ?? createRandomUuid() }; persist(next, true)
        const value = await api.sourceUploadCancel({ operationId: next.operationId, commandId: next.cancelCommandId })
        if (valid()) observe(value)
      } catch { if (valid()) publish({ error: 'outcomeUnknown', unknown: true }) }
      finally { if (valid()) publish({ busy: false }) }
    },
    files: (cursor?: number) => perform(async (_signal, valid) => {
      const selector = snapshot.selector
      if (!selector) return
      const result = await api.sourceUploadFiles({ operationId: selector.operationId, ...(cursor == null ? {} : { cursor }) })
      if (result.page.manifestSha256 !== selector.manifestSha256 || result.page.files.some(file => {
        const entry = selector.manifest.files[file.fileIndex]
        return !entry || file.acceptedBytes > entry.bytes || file.complete !== (file.acceptedBytes === entry.bytes)
          || file.nextPart !== Math.ceil(file.acceptedBytes / SOURCE_UPLOAD_PART_BYTES)
      })) throw new Error('invalidResponse')
      if (valid()) publish({ files: result })
    }),
    newSelection() {
      if (!current() || snapshot.busy) return
      publish({ selected: null, selector: null, observed: null, files: null, unknown: false, error: '', hashedBytes: 0, hashTotalBytes: 0, readAttempted: false })
    },
    clearSelected() { if (current() && !snapshot.busy) publish({ selected: null, hashedBytes: 0, hashTotalBytes: 0 }) },
  }
}
