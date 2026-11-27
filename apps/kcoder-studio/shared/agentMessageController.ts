import type { CrossSessionMessageReceipt, CrossSessionMessageSendParams, CrossSessionMessageTarget, CrossSessionMessageTargetsResult, CrossSessionMessagePolicyResult } from './generated/contracts'
import { AgentMessageJournal, agentMessageIntentDigest, receiptMatchesObservation, type AddressedMessageIntent, type AgentMessageObservation } from './agentMessageJournal'
import { agentMessageUtf8Bytes, agentMessageDiscoveryErrorData, validAgentMessageTargetQuery,
  validAgentMessagePolicy, validAgentMessageReceipt, validAgentMessageTargetSelector } from './agentMessageMethods.mjs'
import { sessionAddressKey, type SessionAddress } from './peerAgentMessage'
import { agentMessageReadDiagnostic, type AgentMessageReadDiagnostic, type AgentMessageReadStage } from './agentMessageReadDiagnostic.mjs'
export type AgentMessageOperation = 'targets' | 'send' | 'get' | 'listReceipts' | 'resolve' | 'policyRead' | 'policySave'
export type AddressedMessageTarget = CrossSessionMessageTarget & { address?: SessionAddress | null }
export type AgentMessagePolicy = CrossSessionMessagePolicyResult
export function agentMessageTargetKey(target: AddressedMessageTarget): string {
  return target.address ? sessionAddressKey(target.address) : `legacy:${target.threadId}`
}
export interface AgentMessageSupport { scope: string; sourceThreadId: string; discovery: boolean; messages: boolean; search?: boolean; receipts?: boolean; replies?: boolean }
export interface AgentMessageAdapter {
  support(): Promise<AgentMessageSupport>
  request(operation: AgentMessageOperation, input: Record<string, unknown>, scope: string): Promise<unknown>
  journal(scope: string): AgentMessageJournal
  current(): boolean
  createId(): string
}
export interface AgentMessagePanelSnapshot {
  support?: AgentMessageSupport
  loading: boolean
  busy: boolean
  sending?: boolean
  searchTitle?: string
  readDiagnostic?: AgentMessageReadDiagnostic
  targets: AddressedMessageTarget[]
  page?: CrossSessionMessageTargetsResult
  selected?: AddressedMessageTarget
  policy?: AgentMessagePolicy
  draft: string
  mode: CrossSessionMessageSendParams['mode']
  observations: AgentMessageObservation[]
  absent: string[]
  error?: 'read_failed' | 'send_unknown' | 'record_failed' | 'receipt_failed' | 'recovery_write_failed' | 'resolve_first' | 'policy_unknown'
}
/** UI observations only. Dispatch and recovery always use the original authenticated source. */
export class AgentMessageController {
  private alive = true
  private sequence = 0
  private targetsCurrent = false
  private loadedPages = 0
  private searchUnavailableScope?: string
  private readonly listeners = new Set<() => void>()
  private snapshot: AgentMessagePanelSnapshot = { loading: false, busy: false, targets: [], draft: '', mode: 'enqueue_only', observations: [], absent: [] }
  private readonly adapter: AgentMessageAdapter
  constructor(adapter: AgentMessageAdapter) { this.adapter = adapter }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private current() { return this.alive && this.adapter.current() }
  private patch(update: Partial<AgentMessagePanelSnapshot>) {
    if (!this.current()) return
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }
  activate() { this.alive = true }
  dispose() { this.alive = false; this.sequence += 1; this.snapshot = { ...this.snapshot, readDiagnostic: undefined }; this.listeners.clear() }
  setDraft(draft: string) { this.patch({ draft }) }
  select(key: string) {
    const selected = this.snapshot.targets.find(target => agentMessageTargetKey(target) === key)
    this.patch({ selected, mode: selected?.allowedModes.includes('enqueue_only') ? 'enqueue_only' : 'wake_if_idle' })
  }
  setMode(mode: CrossSessionMessageSendParams['mode']) { this.patch({ mode }) }
  async load(cursor?: string) {
    if (!this.current() || this.snapshot.busy) return
    if (cursor && (this.snapshot.loading || cursor !== this.snapshot.page?.nextCursor)) return
    await this.read(cursor)
  }
  async search(title: string) {
    if (!this.current() || this.snapshot.busy) return
    const normalized = title.trim()
    if (normalized && !validAgentMessageTargetQuery({ title: normalized })) return
    this.targetsCurrent = false
    this.loadedPages = 0
    this.patch({ searchTitle: normalized || undefined, targets: [], selected: undefined, page: undefined, error: undefined, readDiagnostic: undefined })
    await this.read()
  }
  private async read(cursor?: string, pages = 1) {
    const sequence = ++this.sequence
    let searchTitle = this.snapshot.searchTitle
    this.targetsCurrent = false
    this.patch({ loading: true, error: undefined })
    let stage: AgentMessageReadStage = 'support'
    try {
      let support = await this.adapter.support()
      if (!this.current() || sequence !== this.sequence) return
      if (this.snapshot.support && this.snapshot.support.scope !== support.scope) {
        searchTitle = undefined; cursor = undefined; pages = 1; this.loadedPages = 0
        this.searchUnavailableScope = undefined
        this.patch({ targets: [], selected: undefined, page: undefined, policy: undefined, readDiagnostic: undefined, searchTitle: undefined })
      }
      if (this.searchUnavailableScope === support.scope) support = { ...support, search: false }
      if (searchTitle && support.search !== true) {
        searchTitle = undefined; cursor = undefined; pages = 1; this.loadedPages = 0
        this.patch({ searchTitle: undefined, targets: [], selected: undefined, page: undefined })
      }
      stage = 'journal'
      const journal = support.scope ? this.adapter.journal(support.scope) : undefined
      const observations = journal ? await journal.load() : []
      if (!this.current() || sequence !== this.sequence) return
      this.patch({ support, observations })
      if (support.messages) {
        stage = 'policy'
        const policy = await this.adapter.request('policyRead', {}, support.scope)
        if (!this.current() || sequence !== this.sequence) return
        if (!validAgentMessagePolicy(policy)) throw new Error('agent_messages_invalid_policy')
        this.patch({ policy })
        if (!policy.enabled) { this.patch({ targets: [], selected: undefined, page: undefined, loading: false, readDiagnostic: undefined }); return }
      }
      if (!support.discovery) { this.patch({ targets: [], page: undefined, loading: false, readDiagnostic: undefined }); return }
      let targets = cursor ? this.snapshot.targets : []
      let page!: CrossSessionMessageTargetsResult
      let loadedPages = cursor ? this.loadedPages : 0
      for (let index = 0; index < pages; index++) {
        stage = 'targets'
        try {
          page = await this.adapter.request('targets', cursor ? { cursor } : searchTitle ? { title: searchTitle } : {}, support.scope) as CrossSessionMessageTargetsResult
        } catch (error) {
          if (!this.current() || sequence !== this.sequence) return
          const code = (error as { code?: unknown } | null)?.code
          if (cursor || !searchTitle || !(agentMessageDiscoveryErrorData(error)?.reason === 'search_unsupported' || code === -32601 || code === -32602)) throw error
          // A valid title rejected by an older query protocol falls back only
          // to a read. Default rows must never appear as filtered matches.
          this.searchUnavailableScope = support.scope
          support = { ...support, search: false }; searchTitle = undefined; pages = 1; loadedPages = 0; targets = []
          this.patch({ support, searchTitle: undefined, targets: [], selected: undefined, page: undefined })
          page = await this.adapter.request('targets', {}, support.scope) as CrossSessionMessageTargetsResult
        }
        if (!this.current() || sequence !== this.sequence) return
        stage = 'validation'
        const rows = page.targets as AddressedMessageTarget[]
        for (const row of rows) if (!validAgentMessageTargetSelector(row)) throw new Error('agent_messages_invalid_target')
        targets = [...new Map([...targets, ...rows].map(row => [agentMessageTargetKey(row), row])).values()]
        loadedPages += 1
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      const selected = this.snapshot.selected && targets.find(row => agentMessageTargetKey(row) === agentMessageTargetKey(this.snapshot.selected!))
      this.targetsCurrent = true
      this.loadedPages = loadedPages
      this.patch({ page, targets, selected, loading: false, readDiagnostic: undefined })
    } catch (error) {
      if (sequence === this.sequence) this.patch({ loading: false, error: 'read_failed', readDiagnostic: agentMessageReadDiagnostic(stage, error) })
    }
  }
  async savePolicy(enabled: boolean, wakeIdle: boolean) {
    const support = this.snapshot.support, policy = this.snapshot.policy
    if (!this.current() || this.snapshot.busy || this.snapshot.loading || this.snapshot.error === 'policy_unknown' || !support?.messages || !policy) return
    // Keep the displayed rows while revoking their dispatch eligibility until a
    // fresh read validates the same canonical receiver under the new policy.
    this.targetsCurrent = false
    this.patch({ busy: true, error: undefined })
    try {
      const result = await this.adapter.request('policySave', { expectedRevision: policy.revision, enabled, wakeIdle }, support.scope)
      if (!this.current()) return
      if (!validAgentMessagePolicy(result)) throw new Error('agent_messages_invalid_policy')
      this.patch({ policy: result })
      await this.read(undefined, Math.max(1, this.loadedPages))
    } catch {
      if (!this.current()) return
      // A lost settings receipt is reconciled by reading, never a second write.
      try {
        const current = await this.adapter.request('policyRead', {}, support.scope)
        if (!validAgentMessagePolicy(current)) throw new Error('agent_messages_invalid_policy')
        this.patch({ policy: current, error: 'policy_unknown' })
      } catch { this.patch({ error: 'policy_unknown' }) }
    } finally { this.patch({ busy: false }) }
  }
  retryCandidate() {
    const { selected, mode, draft, observations } = this.snapshot
    if (!selected || !draft) return undefined
    const digest = agentMessageIntentDigest({ targetThreadId: selected.threadId, targetAddress: selected.address, mode, text: draft })
    return observations.find(row => row.bodyDigest === digest && (!row.receipt || row.receipt.status === 'unknown'))
  }
  canSend() {
    const state = this.snapshot
    const pending = this.retryCandidate()
    return this.current() && this.targetsCurrent && !state.busy && !state.loading && state.policy?.enabled === true && (state.mode !== 'wake_if_idle' || state.policy.wakeIdle) && state.support?.messages === true &&
      !!state.selected?.allowedModes.includes(state.mode) && !!state.draft.trim() && agentMessageUtf8Bytes(state.draft) <= 16384 &&
      (!pending || state.absent.includes(pending.clientMessageId))
  }
  async send() {
    const state = this.snapshot
    const selected = state.selected
    const support = state.support
    if (!this.current() || !this.canSend() || !support || !selected) return
    const pending = this.retryCandidate()
    if (pending && !state.absent.includes(pending.clientMessageId)) { this.patch({ error: 'resolve_first' }); return }
    let intent: AddressedMessageIntent
    try { intent = { clientMessageId: pending?.clientMessageId ?? this.adapter.createId(), targetThreadId: selected.threadId,
      ...(selected.address ? { targetAddress: { ...selected.address } } : {}), mode: state.mode, text: state.draft } }
    catch { this.patch({ error: 'record_failed' }); return }
    this.patch({ busy: true, sending: true, error: undefined })
    let journal: AgentMessageJournal
    let observations: AgentMessageObservation[]
    try { journal = this.adapter.journal(support.scope); if (!pending) await journal.remember(intent); observations = await journal.load() }
    catch { this.patch({ busy: false, sending: false, error: 'record_failed' }); return }
    if (!this.current()) return
    this.patch({ observations, absent: this.snapshot.absent.filter(id => id !== intent.clientMessageId) })
    let receipt: CrossSessionMessageReceipt
    try {
      const value = await this.adapter.request('send', { message: intent }, support.scope)
      const original = observations.find(row => row.clientMessageId === intent.clientMessageId)
      if (!original || !validAgentMessageReceipt(value) || !receiptMatchesObservation(value, original))
        throw new Error('agent_message_invalid_receipt')
      receipt = value
    } catch { this.patch({ busy: false, sending: false, error: 'send_unknown' }); return }
    if (!this.current()) return
    this.patch({ observations: this.snapshot.observations.map(row => row.clientMessageId === receipt.clientMessageId ? { ...row, receipt } : row),
      ...(receipt.status !== 'unknown' && this.snapshot.draft === intent.text && this.snapshot.selected &&
        agentMessageTargetKey(this.snapshot.selected) === agentMessageTargetKey(selected) ? { draft: '' } : {}), busy: false, sending: false })
    try { await journal.observe(receipt) }
    catch { this.patch({ error: 'recovery_write_failed' }) }
  }
  async reconcile(clientMessageId: string) {
    const support = this.snapshot.support
    const original = this.snapshot.observations.find(row => row.clientMessageId === clientMessageId)
    if (!this.current() || this.snapshot.busy || !support?.messages || !original) return
    this.patch({ busy: true, error: undefined })
    try {
      const value = await this.adapter.request('get', { query: { clientMessageId } }, support.scope) as { receipt: CrossSessionMessageReceipt | null }
      if (!this.current()) return
      if (value.receipt === null && original.receipt) throw new Error('agent_message_receipt_disappeared')
      if (value.receipt === null) { this.patch({ busy: false, absent: [...this.snapshot.absent.filter(id => id !== clientMessageId), clientMessageId] }); return }
      const receipt = value.receipt
      if (!validAgentMessageReceipt(receipt) || !receiptMatchesObservation(receipt, original))
        throw new Error('agent_message_receipt_owner_changed')
      const sameDraft = this.snapshot.selected && agentMessageIntentDigest({ targetThreadId: this.snapshot.selected.threadId,
        targetAddress: this.snapshot.selected.address, mode: this.snapshot.mode, text: this.snapshot.draft }) === original.bodyDigest
      this.patch({ busy: false, observations: this.snapshot.observations.map(row => row.clientMessageId === clientMessageId ? { ...row, receipt } : row),
        ...(receipt.status !== 'unknown' && sameDraft ? { draft: '' } : {}),
        absent: this.snapshot.absent.filter(id => id !== clientMessageId) })
      try { await this.adapter.journal(support.scope).observe(receipt) }
      catch { this.patch({ error: 'recovery_write_failed' }) }
    } catch { this.patch({ busy: false, error: 'receipt_failed' }) }
  }
}
