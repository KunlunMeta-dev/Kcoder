import type { MigrationHistoryViewLease, MigrationHistoryViewResult } from './generated/contracts'

export interface HistoryViewApi {
  historyViewOpen(params: { requestId: string; jobId: string; expectedArchiveId: string; viewId?: string | null }): Promise<MigrationHistoryViewResult>
  historyViewRead(params: { requestId: string; leaseId?: string | null }): Promise<MigrationHistoryViewResult>
  historyViewRenew(params: { requestId: string; leaseId: string; expectedSequence: number }): Promise<MigrationHistoryViewResult>
  historyViewRelease(params: { requestId: string; leaseId: string }): Promise<MigrationHistoryViewResult>
}
export interface HistoryViewSnapshot {
  state: 'idle' | 'opening' | 'confirmed' | 'unconfirmed' | 'expired' | 'released'
  lease: MigrationHistoryViewLease | null
  error: string
}

/** The API must remain bound to its original logical channel and account.
 * A failed/expired hold never starts another open without an explicit caller action. */
export class HistoryViewLeaseController {
  private current: HistoryViewSnapshot = { state: 'idle', lease: null, error: '' }
  private readonly listeners = new Set<() => void>()
  private readonly ownedRequests = new Set<string>()
  private request: string | null = null
  private generation = 0
  private closed = false
  private deadline = 0
  private renewal: ReturnType<typeof setTimeout> | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  private readonly api: HistoryViewApi
  private readonly selection: { jobId: string; archiveId: string; viewId?: string | null }
  private readonly nonce: () => string
  private readonly clock: () => number
  constructor(
    api: HistoryViewApi,
    selection: { jobId: string; archiveId: string; viewId?: string | null },
    nonce: () => string,
    clock: () => number = () => performance.now(),
  ) { this.api = api; this.selection = selection; this.nonce = nonce; this.clock = clock }
  snapshot = (): HistoryViewSnapshot => this.current
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  requestId(): string | null { return this.request }
  private update(state: HistoryViewSnapshot['state'], lease = this.current.lease, error = '') {
    if (this.closed) return
    this.current = { state, lease: lease ? Object.freeze({ ...lease }) : null, error }
    for (const listener of this.listeners) listener()
  }
  private timers() {
    if (this.renewal !== null) clearTimeout(this.renewal)
    if (this.expiry !== null) clearTimeout(this.expiry)
    this.renewal = this.expiry = null
  }
  private valid(lease: MigrationHistoryViewLease, request: string) {
    return lease.requestId === request && lease.jobId === this.selection.jobId && lease.archiveId === this.selection.archiveId &&
      (lease.viewId ?? null) === (this.selection.viewId ?? null) && Number.isSafeInteger(lease.sequence) && lease.sequence >= 0 &&
      Number.isSafeInteger(lease.remainingMs) && lease.remainingMs >= 0 && lease.remainingMs <= 30_000
  }
  private cleanup(lease: MigrationHistoryViewLease | null | undefined) {
    if (lease && ['active','invalidated'].includes(lease.state) && this.ownedRequests.has(lease.requestId) && this.valid(lease, lease.requestId))
      void this.api.historyViewRelease({ requestId: lease.requestId, leaseId: lease.leaseId }).catch(() => undefined)
  }
  private accept(result: MigrationHistoryViewResult, request: string, generation: number, started: number) {
    const lease = result.lease
    if (!lease || !this.valid(lease, request)) throw new Error('history_view_invalid_response')
    if (this.closed || generation !== this.generation) { this.cleanup(lease); return }
    const old = this.current.lease
    if (old?.requestId === request && (old.leaseId !== lease.leaseId || lease.sequence < old.sequence)) throw new Error('history_view_invalid_response')
    this.timers()
    if (lease.state !== 'active') {
      this.update(lease.state === 'expired' ? 'expired' : lease.state === 'released' ? 'released' : 'unconfirmed', lease)
      return
    }
    // Subtract the entire request's elapsed time. Remote wall clocks are never compared.
    this.deadline = started + lease.remainingMs
    const remaining = this.deadline - this.clock()
    if (remaining <= 0) { this.update('expired', lease); this.cleanup(lease); return }
    this.update('confirmed', lease)
    this.expiry = setTimeout(() => {
      if (generation !== this.generation || this.closed) return
      this.generation++
      this.timers()
      this.update('expired')
    }, remaining)
    this.renewal = setTimeout(() => { void this.renew(request, generation) }, Math.min(10_000, remaining / 2))
  }
  async open(): Promise<void> {
    if (this.closed || this.current.state === 'opening' || this.current.state === 'confirmed') return
    this.cleanup(this.current.lease)
    this.timers()
    let request: string
    try { request = this.nonce() } catch { this.update('unconfirmed', null, 'history_view_unconfirmed'); return }
    const generation = ++this.generation
    if (this.ownedRequests.has(request) || this.ownedRequests.size >= 256) { this.update('unconfirmed', null, 'history_view_request_budget_exceeded'); return }
    this.ownedRequests.add(request)
    this.request = request
    this.update('opening', null)
    const started = this.clock()
    try {
      this.accept(await this.api.historyViewOpen({ requestId: request, jobId: this.selection.jobId, expectedArchiveId: this.selection.archiveId, viewId: this.selection.viewId ?? null }), request, generation, started)
    } catch (error) {
      const code = error instanceof Error && error.message === 'migration_history_view_update_required' ? error.message : 'history_view_unconfirmed'
      if (generation === this.generation) { this.timers(); this.update('unconfirmed', null, code) }
    }
  }
  private async renew(request: string, generation: number) {
    if (this.closed || generation !== this.generation || this.current.state !== 'confirmed') return
    const lease = this.current.lease
    if (!lease || this.clock() >= this.deadline) { this.invalidate(); return }
    const started = this.clock()
    try {
      this.accept(await this.api.historyViewRenew({ requestId: request, leaseId: lease.leaseId, expectedSequence: lease.sequence }), request, generation, started)
    } catch {
      if (generation === this.generation) this.invalidate()
    }
  }
  invalidate(): void {
    if (this.closed) return
    this.generation++
    this.timers()
    this.update('unconfirmed', this.current.lease, 'history_view_unconfirmed')
  }
  async release(): Promise<void> {
    const request = this.request, lease = this.current.lease
    const generation = ++this.generation
    this.timers()
    if (!request) { this.update('released'); return }
    this.update('unconfirmed')
    try {
      const known = lease ?? (await this.api.historyViewRead({ requestId: request })).lease
      if (known && !this.valid(known, request)) throw new Error('history_view_invalid_response')
      const result = known && ['active','invalidated'].includes(known.state)
        ? await this.api.historyViewRelease({ requestId: request, leaseId: known.leaseId })
        : { lease: known }
      if (result.lease && (!this.valid(result.lease, request) || ['active','invalidated'].includes(result.lease.state))) throw new Error('history_view_release_unconfirmed')
      if (generation === this.generation) this.update('released', result.lease)
    } catch {
      if (generation === this.generation) this.update('unconfirmed', lease, 'history_view_release_unconfirmed')
      throw new Error('history_view_release_unconfirmed')
    }
  }
  dispose(): void {
    void this.release().catch(() => undefined)
    this.closed = true
    this.listeners.clear()
  }
}
