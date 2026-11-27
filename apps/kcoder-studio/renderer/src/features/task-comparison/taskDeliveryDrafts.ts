import type { TaskDeliveryResult } from '../../../../shared/generated/contracts'

export interface TaskDeliveryDraftState {
  delivery: TaskDeliveryResult | null
  base: string
  title: string
  body: string
  requestId: string | null
  requestUnknown: boolean
  queued: boolean
  appendUnknown: boolean
  uncertain: boolean
  inputsRevision: number
  version: number
  pending: string | null
}
export interface TaskDeliveryDraftSlot {
  key: string
  unavailable?: boolean
  activate: () => void
  getSnapshot: () => TaskDeliveryDraftState
  subscribe: (listener: () => void) => () => void
  update: (change: (state: TaskDeliveryDraftState) => TaskDeliveryDraftState) => void
}
export interface DeliveryResponseIdentity { messageId: string; turnId: string | null; attemptId: string | null }
export interface TaskDeliveryDrafts {
  slot: (key: string) => TaskDeliveryDraftSlot
  forResponse: (scope: string, identity: DeliveryResponseIdentity, nativeUnique: boolean) => TaskDeliveryDrafts
}
export function createTaskDeliveryDrafts(): TaskDeliveryDrafts {
  const records: { scope: string; binding: string; identity: DeliveryResponseIdentity; slot: TaskDeliveryDraftSlot }[] = []
  const blocked = new Map<string, TaskDeliveryDraftSlot>()
  const compatible = (old: DeliveryResponseIdentity, next: DeliveryResponseIdentity) =>
    (!old.turnId || old.turnId === next.turnId) && (!old.attemptId || old.attemptId === next.attemptId)
  const makeSlot = (key: string, unavailable = false): TaskDeliveryDraftSlot => {
    let state: TaskDeliveryDraftState = { delivery: null, base: 'main', title: '', body: '', requestId: null,
      requestUnknown: false, queued: false, appendUnknown: false, uncertain: false, inputsRevision: 0, version: 0, pending: null }
    const listeners = new Set<() => void>()
    return { key, unavailable, activate: () => {}, getSnapshot: () => state,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      update(change) { if (unavailable) return; const next = change(state); if (next === state) return;
        state = { ...next, version: state.version + 1 }; for (const listener of listeners) listener() } }
  }
  const view = (scope: string, identity: DeliveryResponseIdentity, nativeUnique: boolean): TaskDeliveryDrafts => ({
    forResponse: view,
    slot(binding) {
      const candidates = records.filter(record => record.scope === scope && record.binding === binding)
      const sameId = candidates.filter(record => record.identity.messageId === identity.messageId)
      const complete = Boolean(identity.turnId && identity.attemptId)
      const nativeExact = complete ? sameId.filter(record => record.identity.turnId === identity.turnId && record.identity.attemptId === identity.attemptId) : []
      const exact = nativeExact.length ? nativeExact : sameId.filter(record => compatible(record.identity, identity))
      const native = !sameId.length && nativeUnique && complete
        ? candidates.filter(record => record.identity.turnId === identity.turnId && record.identity.attemptId === identity.attemptId) : []
      if (exact.length > 1 || native.length > 1 || (!complete && sameId.some(record => (record.identity.turnId && !identity.turnId) || (record.identity.attemptId && !identity.attemptId)))) {
        const key = JSON.stringify(['unavailable', scope, binding, identity])
        let slot = blocked.get(key)
        if (!slot) { slot = makeSlot(key, true); blocked.set(key, slot) }
        return slot
      }
      let record = exact[0] ?? native[0]
      if (!record) {
        record = { scope, binding, identity: { ...identity }, slot: makeSlot(String(records.length)) }
        records.push(record)
      }
      const retained = record
      return { ...retained.slot, activate() {
        if (!compatible(retained.identity, identity)) throw new Error('delivery response identity changed')
        // Only committed views enrich identity. Missing or conflicting evidence
        // never downgrades a previously bound response or creates an alias.
        retained.identity = { ...identity }
      } }
    },
  })
  return view('local', { messageId: 'local', turnId: null, attemptId: null }, false)
}
