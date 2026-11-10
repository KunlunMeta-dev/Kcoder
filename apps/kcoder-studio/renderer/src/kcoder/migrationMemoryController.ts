import { createRandomUuid } from '@/lib/random-id'
import { isMigrationMemoryControlParams, type MigrationMemoryControlParams, type MigrationMemoryControlResult,
  type MigrationMemoryListResult, type MigrationMemoryReadResult, type ImportedMemoryRecordSummary } from '../../../shared/generated/contracts'
import type { createMemoryApi } from './gatewayMigrationMemory'

type Api = ReturnType<typeof createMemoryApi>
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type MemoryManagerSnapshot = {
  busy: boolean; error: string; pageIndex: number; page: MigrationMemoryListResult | null;
  body: MigrationMemoryReadResult | null; pending: MigrationMemoryControlParams | null;
  outcome: MigrationMemoryControlResult | null; checked: boolean
  recoveryBlocked: boolean
}

/** Browser storage retains an operation selector only. Native CAS and receipts remain authoritative. */
export function createMemoryManager({ api, storage, scope, isCurrent }: {
  api: Api; storage: StoragePort; scope: string; isCurrent: () => boolean
}) {
  const key = `kcoder.migration.memory-control:${scope}`
  let active = true, generation = 0, storageReady = true, snapshot: MemoryManagerSnapshot = {
    busy: false, error: '', pageIndex: 0, page: null, body: null, pending: null, outcome: null, checked: false, recoveryBlocked: false,
  }
  const listeners = new Set<() => void>()
  const current = () => active && isCurrent()
  const publish = (patch: Partial<MemoryManagerSnapshot>) => {
    if (!current()) return
    snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener()
  }
  try {
    const text = storage.getItem(key)
    if (text) {
      const pending: unknown = text.length <= 4096 ? JSON.parse(text) : null
      if (!isMigrationMemoryControlParams(pending)) throw new Error('invalid selector')
      snapshot.pending = pending
    }
  } catch { storageReady = false; snapshot.error = 'recoveryUnavailable'; snapshot.recoveryBlocked = true }
  const perform = async (action: (accept: () => boolean) => Promise<void>) => {
    if (!current() || snapshot.busy) return
    const request = ++generation
    publish({ busy: true, error: '' })
    try { await action(() => current() && request === generation) } catch (error) {
      if (request === generation) publish({ error: error instanceof Error && error.message === 'migration_memory_update_required' ? 'updateRequired' : snapshot.pending ? 'outcomeUnknown' : 'readFailed' })
    } finally { if (request === generation) publish({ busy: false }) }
  }
  const observe = (result: MigrationMemoryControlResult) => {
    const pending = snapshot.pending
    if (!pending) throw new Error('missing selector')
    if (result.receipt && JSON.stringify(result.receipt.request) !== JSON.stringify(pending)) {
      const request = result.receipt.request
      if (Object.keys(pending).some(key => pending[key as keyof typeof pending] !== request[key as keyof typeof request])) throw new Error('wrong receipt')
    }
    publish({ outcome: result, checked: true })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    activate() { active = true },
    dispose() { active = false; generation++; listeners.clear() },
    load: (pageIndex = 0) => perform(async accept => {
      const page = await api.memoryList({ pageIndex })
      if (!accept()) return
      publish({ page, pageIndex, body: null })
    }),
    read: (record: ImportedMemoryRecordSummary, offset = 0) => perform(async accept => {
      const body = await api.memoryRead({ id: record.id, offset })
      if (!accept()) return
      if (body.record.ownerOperationId !== record.ownerOperationId || body.record.revision !== record.revision) throw new Error('record changed')
      publish({ body })
    }),
    control: (record: ImportedMemoryRecordSummary, enabled: boolean, confirmed: boolean) => perform(async accept => {
      if (!storageReady || snapshot.pending || enabled && !confirmed) throw new Error('confirmation required')
      const pending: MigrationMemoryControlParams = { requestId: createRandomUuid(), id: record.id,
        ownerOperationId: record.ownerOperationId, expectedRevision: record.revision,
        enabled, confirmUnverifiedNotes: enabled && confirmed }
      const text = JSON.stringify(pending)
      try {
        storage.setItem(key, text)
        if (storage.getItem(key) !== text) throw new Error('selector not retained')
      } catch { storageReady = false; publish({ error: 'recoveryUnavailable', recoveryBlocked: true }); return }
      publish({ pending, outcome: null, checked: false })
      if (!accept()) return
      const result = await api.memoryControl(pending)
      if (accept()) observe(result)
    }),
    check: () => perform(async accept => {
      if (!snapshot.pending) return
      const result = await api.memoryControlRead({ requestId: snapshot.pending.requestId })
      if (accept()) observe(result)
    }),
    retry: () => perform(async accept => {
      if (!snapshot.pending || !snapshot.checked || snapshot.outcome?.receipt) return
      const result = await api.memoryControl(snapshot.pending)
      if (accept()) observe(result)
    }),
    acknowledge() {
      if (!current() || snapshot.busy || !snapshot.outcome?.receipt) return
      try { storage.removeItem(key); if (storage.getItem(key) !== null) throw new Error('selector retained') }
      catch { publish({ error: 'recoveryUnavailable' }); return }
      publish({ pending: null, outcome: null, checked: false })
    },
  }
}
