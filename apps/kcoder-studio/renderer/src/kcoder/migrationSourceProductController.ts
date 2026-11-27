import { getRuntimeConfig } from '@/config/runtime'
import { createRandomUuid } from '@/lib/random-id'
import { isMigrationSourceProductRunParams, isMigrationSourceProductCancelParams, type MigrationSourceProductStateResult,
  type MigrationSourceProductRunParams, type MigrationSourceProductCancelParams, type SourceUploadState } from '../../../shared/generated/contracts'
import type { createSourceProductApi } from './gatewayMigrationSourceProduct'

type Pending = { kind: 'run' | 'resume'; params: MigrationSourceProductRunParams } | { kind: 'cancel'; params: MigrationSourceProductCancelParams }
export type SourceProductSnapshot = { busy: boolean; requested: boolean; observed: MigrationSourceProductStateResult | null;
  error: string; unknown: boolean; readAttempted: boolean; pending: Pending | null }
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>

/** Upload and materialization use different control epochs even though their operation and manifest are shared. */
export function createSourceProductController({ upload, api, storage, scope, isCurrent }: {
  upload: SourceUploadState; api: ReturnType<typeof createSourceProductApi>; storage: StoragePort; scope: string; isCurrent: () => boolean
}) {
  if (upload.stage !== 'ready') throw new Error('source_product_upload_not_ready')
  const binding = { operationId: upload.operationId, manifestSha256: upload.manifestSha256 }
  const key = `kcoder.migration.source-product:${scope}:${binding.operationId}`
  const mount = getRuntimeConfig().appBasePath, listeners = new Set<() => void>()
  let active = true, generation = 0, storageReady = true
  let snapshot: SourceProductSnapshot = { busy: false, requested: false, observed: null, error: '', unknown: false, readAttempted: false, pending: null }
  const current = () => active && isCurrent() && getRuntimeConfig().appBasePath === mount
  const publish = (patch: Partial<SourceProductSnapshot>) => { if (!current()) return; snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener() }
  const pendingValid = (value: unknown): value is Pending => {
    if (!value || typeof value !== 'object' || !('kind' in value) || !('params' in value) || Object.keys(value).length !== 2) return false
    const valid = value.kind === 'cancel' ? isMigrationSourceProductCancelParams(value.params)
      : (value.kind === 'run' || value.kind === 'resume') && isMigrationSourceProductRunParams(value.params)
    return valid && (value.params as MigrationSourceProductRunParams).operationId === binding.operationId
      && (value.params as MigrationSourceProductRunParams).manifestSha256 === binding.manifestSha256
  }
  try {
    const text = storage.getItem(key)
    if (text) {
      const value: unknown = text.length < 4096 ? JSON.parse(text) : null
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
        || !('operationId' in value) || value.operationId !== binding.operationId || !('manifestSha256' in value) || value.manifestSha256 !== binding.manifestSha256
        || !('pending' in value) || value.pending !== null && !pendingValid(value.pending)
        || Object.keys(value).some(key => !['version', 'operationId', 'manifestSha256', 'pending'].includes(key))) throw new Error('invalid selector')
      snapshot.requested = true; snapshot.pending = value.pending as Pending | null; snapshot.unknown = true
    }
  } catch { storageReady = false; snapshot.error = 'recoveryUnavailable' }
  const save = (pending: Pending | null) => {
    if (!storageReady) throw new Error('recoveryUnavailable')
    if (pending !== null && !pendingValid(pending)) throw new Error('recoveryUnavailable')
    const text = JSON.stringify({ version: 1, ...binding, pending })
    try { storage.setItem(key, text); if (storage.getItem(key) !== text) throw new Error('selector not retained') }
    catch (error) { storageReady = false; throw new Error('recoveryUnavailable', { cause: error }) }
    publish({ requested: true, pending })
  }
  const observe = (value: MigrationSourceProductStateResult) => {
    const next = value.materialization, previous = snapshot.observed?.materialization
    if (next.operationId !== binding.operationId || next.manifestSha256 !== binding.manifestSha256 || next.source !== upload.source
      || next.totalFiles !== upload.totalFiles || next.totalBytes !== upload.totalBytes
      || previous && (next.sequence < previous.sequence || next.cancelWatermark < previous.cancelWatermark || next.verifiedBytes < previous.verifiedBytes)) throw new Error('source_product_invalid_result')
    publish({ observed: value, unknown: false, requested: true })
  }
  const perform = async (action: (valid: () => boolean) => Promise<void>) => {
    if (!current() || snapshot.busy) return
    const request = ++generation, valid = () => current() && request === generation
    publish({ busy: true, error: '' })
    try { await action(valid) } catch (error) {
      if (valid()) publish({ error: error instanceof Error && error.message === 'recoveryUnavailable' ? 'recoveryUnavailable' : 'productUnknown', unknown: true })
    } finally { if (valid()) publish({ busy: false }) }
  }
  const execute = async (pending: Pending, valid: () => boolean) => {
    const result = pending.kind === 'cancel' ? await api.sourceProductCancel(pending.params)
      : pending.kind === 'run' ? await api.sourceProductRun(pending.params) : await api.sourceProductResume(pending.params)
    if (!valid()) return
    observe(result); save(null)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    activate() { active = true },
    dispose() { active = false; generation++; listeners.clear() },
    run: () => perform(async valid => {
      if (snapshot.requested) return
      const pending: Pending = { kind: 'run', params: { ...binding, expectedSequence: 0, cancelWatermark: 0 } }
      save(pending); await execute(pending, valid)
    }),
    read: () => perform(async valid => {
      publish({ readAttempted: true })
      const value = await api.sourceProductRead(binding)
      if (valid()) observe(value)
    }),
    retry: () => perform(async valid => {
      const pending = snapshot.pending
      if (!pending || !snapshot.readAttempted) return
      if (pending.kind !== 'cancel' && snapshot.observed && pending.params.expectedSequence !== snapshot.observed.materialization.sequence) return
      await execute(pending, valid)
    }),
    resume: () => perform(async valid => {
      let observed = snapshot.observed?.materialization
      if (!observed || observed.workerState !== 'stopped') return
      if (observed.stage === 'ready') return
      if (observed.cancelRequested || observed.stage !== 'prepared') {
        const pending: Pending = { kind: 'resume', params: { ...binding, expectedSequence: observed.sequence, cancelWatermark: observed.cancelWatermark } }
        save(pending); await execute(pending, valid)
        if (!valid()) return
        observed = snapshot.observed?.materialization
      }
      if (!observed || observed.stage === 'ready' || observed.workerState !== 'stopped' || observed.cancelRequested) return
      const run: Pending = { kind: 'run', params: { ...binding, expectedSequence: observed.sequence, cancelWatermark: observed.cancelWatermark } }
      save(run); await execute(run, valid)
    }),
    cancel: async () => {
      if (!current() || !snapshot.requested) return
      const request = ++generation, valid = () => current() && request === generation
      publish({ busy: true, error: '' })
      try {
        const pending: Pending = snapshot.pending?.kind === 'cancel' ? snapshot.pending : { kind: 'cancel', params: { ...binding, commandId: createRandomUuid() } }
        save(pending); await execute(pending, valid)
      } catch { if (valid()) publish({ error: 'productUnknown', unknown: true }) }
      finally { if (valid()) publish({ busy: false }) }
    },
  }
}
