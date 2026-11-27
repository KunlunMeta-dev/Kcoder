import { canonicalInstructionMappings, instructionMappingsSignature, validInstructionMappings } from '../../../shared/migrationInstructionMappings'
import { captureAccountContextRevision } from './accountContextEvents'
import { createRandomUuid } from '@/lib/random-id'
import { createMigrationSourceAdoptionClient } from './gatewayMigrationSourceAdoption'
import { createMigrationSourceAdoptionRecovery } from './migrationSourceAdoptionRecovery'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './gatewayMigrationSourceSessions'
import { migrationSourceRecoveryScope } from './migrationSourceTransferScope'
import type { GatewayServer } from './gatewayRpc'
import type { MigrationSourceReceipt, MigrationSourceReceivedResult, MigrationSourceReceivedItem, MigrationSourceAdoptionSession,
  MigrationSourceAdoptionPrepareParams, MigrationSourceAdoptionResult, MigrationSourceAdoptionState, MigrationSourceAdoptionSelection, MigrationSourceInstructionMapping } from '../../../shared/generated/contracts'

type Selected = { item: MigrationSourceReceivedItem; mapped: boolean; instructionMapping?: MigrationSourceInstructionMapping }
interface Snapshot {
  busy: boolean; error: string | null; page: MigrationSourceReceivedResult | null; pageIndex: number;
  selected: Selected[]; input: MigrationSourceAdoptionPrepareParams | null; result: MigrationSourceAdoptionResult | null;
  records: MigrationSourceAdoptionPrepareParams[]; pollingPaused: boolean
}
interface Options {
  target: GatewayServer; receipt: MigrationSourceReceipt; isCurrent: () => boolean;
  storage?: Storage; fetcher?: typeof fetch
}
function fail(code: string): never { throw new MigrationSourceHttpError(code, false) }
const mappingRequired = (item: MigrationSourceReceivedItem) => item.projectScoped && item.class !== 'history'
const signature = (items: MigrationSourceAdoptionSelection[], mappings: MigrationSourceInstructionMapping[] = []) => JSON.stringify([...items].sort((a, b) => a.entryId.localeCompare(b.entryId)).map(item => [item.entryId, item.projectMapping ?? null])) + instructionMappingsSignature(mappings)

/** Preview preparation owns its own target child. Ordinary batch APIs alone publish configuration. */
export class MigrationSourceAdoptionController {
  private state: Snapshot = { busy: false, error: null, page: null, pageIndex: 0, selected: [], input: null, result: null, records: [], pollingPaused: false }
  private readonly listeners = new Set<() => void>()
  private active = true
  private flight = false
  private session: { value: MigrationSourceAdoptionSession; ready: boolean; released: boolean } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private polls = 0
  private readonly controlFences = new Map<string, { sequence: number; cancelWatermark: number }>()
  private readonly cancelIds = new Map<string, string>()
  private readonly options: Options
  private readonly scope: string
  private readonly accountCurrent = captureAccountContextRevision()
  private readonly identity = createRandomUuid()
  private readonly sessions
  private readonly client
  private recovery: ReturnType<typeof createMigrationSourceAdoptionRecovery> | null = null
  constructor(options: Options) {
    this.options = { ...options, target: structuredClone(options.target), receipt: { ...options.receipt } }
    this.scope = migrationSourceRecoveryScope(options.target)
    const captureScope = () => this.visible() ? this.identity : ''
    const captureCleanupScope = () => this.accountCurrent(this.options.target.id) && migrationSourceRecoveryScope(this.options.target) === this.scope ? this.identity : ''
    this.sessions = createMigrationSourceSessionClient({ captureScope: captureCleanupScope, fetcher: options.fetcher })
    this.client = createMigrationSourceAdoptionClient({ captureScope, fetcher: options.fetcher })
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  activate = () => { this.active = true }
  private visible() { return this.active && this.options.isCurrent() && this.accountCurrent(this.options.target.id) && migrationSourceRecoveryScope(this.options.target) === this.scope }
  private check() { if (!this.visible()) fail('source_transfer_authority_changed') }
  private update(patch: Partial<Snapshot>) {
    if (!this.visible()) return
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener()
  }
  private refreshRecords() {
    this.state = { ...this.state, records: this.cache().list(this.options.receipt.requestId).filter(item => item.manifestSha256 === this.options.receipt.manifestSha256
      && item.locator.target.targetId === this.options.target.id && (item.locator.target.workspacePath ?? null) === (this.options.target.workspacePath ?? null)) }
  }
  private cache() {
    this.check()
    if (!this.recovery) this.recovery = createMigrationSourceAdoptionRecovery({ captureScope: () => this.visible() ? this.identity : '', fetcher: this.options.fetcher,
      storage: this.options.storage ?? localStorage, recoveryScope: this.scope })
    return this.recovery
  }
  private async release() {
    const session = this.session
    if (!session || session.released) return
    try { session.released = (await this.sessions.close(session.value)).status === 'released' } catch { /* Preserve uncertain ownership in the original Gateway. */ }
  }
  dispose = () => {
    this.active = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; void this.release()
  }
  private async target() {
    this.check()
    if (!this.session) this.session = { value: { sessionId: createRandomUuid(), purpose: 'target_recovery', targetId: this.options.target.id,
      ...(this.options.target.workspacePath === undefined ? {} : { workspacePath: this.options.target.workspacePath }) }, ready: false, released: false }
    const owned = this.session
    if (!owned.ready) {
      const opened = await this.sessions.open(owned.value)
      if (!this.visible()) {
        owned.released = false; await this.release(); fail('source_transfer_authority_changed')
      }
      if (opened.status !== 'ready') fail('source_transfer_target_not_ready')
      owned.ready = true
    }
    return owned.value
  }
  private accept(result: MigrationSourceAdoptionResult) {
    this.check()
    const value = result.state
    if (value?.control) {
      const old = this.controlFences.get(value.adoptionId)
      if (old && (value.control.sequence < old.sequence || value.control.cancelWatermark < old.cancelWatermark)) fail('source_transfer_invalid_response')
      this.controlFences.set(value.adoptionId, value.control)
    }
    this.update({ result })
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const value = this.state.result?.state
    if (!this.visible() || !value || !this.state.input || !(value.workerState === 'running' || ['prepared', 'scanning', 'cancel_requested'].includes(value.phase))) return
    if (++this.polls > 30) { this.update({ pollingPaused: true }); return }
    this.timer = setTimeout(() => { this.timer = null; void this.read() }, 1000)
  }
  private async perform(work: () => Promise<void>) {
    if (this.flight || !this.visible()) return
    this.flight = true; this.update({ busy: true, error: null })
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try { await work() } catch (error) {
      this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_outcome_unknown' })
    } finally {
      this.flight = false
      if (this.visible()) { this.update({ busy: false }); if (!this.state.error) this.schedule() }
      else await this.release()
    }
  }
  load = (pageIndex = 0) => this.perform(async () => {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 102) fail('source_transfer_invalid_request')
    const page = await this.client.received({ target: await this.target(), requestId: this.options.receipt.requestId,
      manifestSha256: this.options.receipt.manifestSha256, pageIndex })
    this.check()
    if (page.items.length > 10 || this.state.page && page.totalSources !== this.state.page.totalSources) fail('source_transfer_invalid_response')
    for (const row of page.items) {
      const selected = this.state.selected.find(item => item.item.entryId === row.entryId)
      if (selected && JSON.stringify(selected.item) !== JSON.stringify(row)) fail('source_transfer_invalid_response')
    }
    this.refreshRecords(); this.update({ page, pageIndex, records: this.state.records })
  })
  select = (entryId: string, checked: boolean) => {
    if (!this.visible() || this.flight) return
    const item = this.state.page?.items.find(row => row.entryId === entryId)
    if (!item) return
    const selected = this.state.selected.filter(row => row.item.entryId !== entryId)
    if (checked) { if (selected.length >= 64) return; selected.push({ item, mapped: false }) }
    this.update({ selected })
  }
  map = (entryId: string, mapped: boolean) => {
    if (!this.visible() || this.flight || !this.options.target.workspacePath) return
    this.update({ selected: this.state.selected.map(row => row.item.entryId === entryId && mappingRequired(row.item) ? { ...row, mapped } : row) })
  }
  mapInstructions = (entryId: string, mapping: MigrationSourceInstructionMapping | null) => {
    if (!this.visible() || this.flight || !this.options.target.workspacePath) return
    if (mapping && (mapping.entryId !== entryId || !validInstructionMappings([mapping], [{ entryId, projectMapping: 'current_workspace' }]))) return
    this.update({ selected: this.state.selected.map(row => row.item.entryId === entryId && row.item.class === 'instructions' ? { ...row, instructionMapping: mapping ?? undefined } : row) })
  }
  canPrepare = () => this.state.selected.length > 0 && this.state.selected.length <= 64 && this.state.selected.every(row => (!mappingRequired(row.item) || row.mapped && !!this.options.target.workspacePath) && (row.item.class !== 'instructions' || !!row.instructionMapping))
  prepare = () => this.perform(async () => {
    this.refreshRecords()
    if (!this.canPrepare()) fail('source_transfer_project_mapping_required')
    const target = await this.target(); this.check()
    const selections = this.state.selected.map(({ item, mapped }) => ({ entryId: item.entryId, ...(mapped ? { projectMapping: 'current_workspace' as const } : {}) }))
    const mappings = canonicalInstructionMappings(this.state.selected.flatMap(row => row.instructionMapping ? [row.instructionMapping] : []))
    if (!validInstructionMappings(mappings, selections)) fail('source_transfer_instruction_mapping_invalid')
    const previous = this.state.records.find(item => signature(item.selections, item.instructionMappings) === signature(selections, mappings))
    const input: MigrationSourceAdoptionPrepareParams = { locator: { requestId: this.options.receipt.requestId, adoptionId: previous?.locator.adoptionId ?? createRandomUuid(), target },
      manifestSha256: this.options.receipt.manifestSha256, selections, ...(mappings.length ? { instructionMappings: mappings } : {}) }
    this.update({ input, result: null }); this.polls = 0
    try {
      const prepared = await this.cache().prepare(input); this.check()
      this.update({ input: { ...input, locator: prepared.locator } }); this.accept(prepared.result)
    } finally { if (this.visible()) { this.refreshRecords(); this.update({ records: this.state.records }) } }
  })
  read = (record?: MigrationSourceAdoptionPrepareParams) => this.perform(async () => {
    const input = record ?? this.state.input
    if (!input) fail('source_transfer_adoption_recovery_invalid')
    const target = await this.target(); this.check()
    this.update({ input: { ...input, locator: { ...input.locator, target } }, ...(record ? { result: null, pollingPaused: false } : {}) })
    if (record) this.polls = 0
    this.accept(await this.cache().read(input, target))
  })
  operate = (mode: 'cancel' | 'resume', confirmed: MigrationSourceAdoptionState) => this.perform(async () => {
    const input = this.state.input
    if (!input || !confirmed.control || input.locator.adoptionId !== confirmed.adoptionId) fail('source_transfer_adoption_control_unavailable')
    const target = await this.target(), locator = { ...input.locator, target }
    const fresh = await this.client.read(locator); this.accept(fresh); this.check()
    const value = fresh.state
    if (value?.phase === 'preview_ready' || mode === 'cancel' && value?.cancelRequested === true) return
    if (!value?.control || value.control.cancelWatermark !== confirmed.control.cancelWatermark || mode === 'resume' && value.control.sequence !== confirmed.control.sequence) fail('source_transfer_adoption_stale_control')
    if (mode === 'resume' && value.workerState !== 'stopped') fail('source_transfer_adoption_control_unavailable')
    this.polls = 0; this.update({ pollingPaused: false })
    if (mode === 'resume') {
      this.accept(await this.client.resume({ locator, expectedControl: value.control }))
      this.cancelIds.delete(value.adoptionId)
    }
    else {
      let commandId = this.cancelIds.get(value.adoptionId)
      if (!commandId) { commandId = createRandomUuid(); this.cancelIds.set(value.adoptionId, commandId) }
      this.accept(await this.client.cancel({ locator, commandId }))
    }
  })
}

export { mappingRequired as adoptionProjectMappingRequired }
