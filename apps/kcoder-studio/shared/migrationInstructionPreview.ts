import type * as C from './generated/contracts'
import { validInstructionCall, INSTRUCTION_METHODS } from './migrationInstructions.mjs'

interface Api {
  instructionPage(input: C.MigrationInstructionPageParams): Promise<C.MigrationInstructionPageResult>
  instructionBody(input: C.MigrationInstructionBodyParams): Promise<C.MigrationInstructionBodyResult>
}
interface Snapshot { busy: boolean; error: string | null; page: C.MigrationInstructionPageResult | null; body: C.MigrationInstructionBodyResult | null }
/** A fixed receipt/job scope owns every late response; preview never creates or enables a migration. */
export class InstructionPreviewController {
  private state: Snapshot = { busy: false, error: null, page: null, body: null }
  private active = true
  private flight: number | null = null
  private epoch = 0
  private readonly listeners = new Set<() => void>()
  private readonly api: Api
  private readonly target: C.MigrationInstructionReadTarget
  private readonly isCurrent: () => boolean
  constructor(api: Api, target: C.MigrationInstructionReadTarget, isCurrent: () => boolean) { this.api = api; this.target = structuredClone(target); this.isCurrent = isCurrent }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  activate = () => { this.active = true; this.epoch++ }
  dispose = () => { this.active = false; this.epoch++ }
  current = () => this.active && this.isCurrent()
  private update(patch: Partial<Snapshot>) { if (this.current()) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() } }
  private async perform(work: (ticket: number) => Promise<void>) {
    if (!this.current() || this.flight === this.epoch) return
    const ticket = this.epoch
    this.flight = ticket; this.update({ busy: true, error: null })
    try { await work(ticket) } catch (error) {
      if (this.current() && ticket === this.epoch) {
        const text = error instanceof Error ? error.message : ''
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null
        this.update({ error: typeof code === 'string' && /^(migration|source_transfer)_[a-z_]+$/.test(code) ? code
          : /^(migration|source_transfer)_[a-z_]+$/.test(text) ? text : 'migration_instruction_preview_unconfirmed' })
      }
    } finally { if (this.flight === ticket) { this.flight = null; this.update({ busy: false }) } }
  }
  load = (pageIndex = 0) => this.perform(async ticket => {
    const input = { target: this.target, pageIndex }
    if (!validInstructionCall(INSTRUCTION_METHODS.page, input)) throw new Error('migration_invalid_page')
    const page = await this.api.instructionPage(input)
    if (!this.current() || ticket !== this.epoch) return
    if (!validInstructionCall(INSTRUCTION_METHODS.page, input, page) || this.state.page && page.totalItems !== this.state.page.totalItems) throw new Error('migration_invalid_response')
    this.update({ page, body: null })
  })
  preview = (itemId: string, representation: C.InstructionRepresentation, offset = 0) => this.perform(async ticket => {
    const input = { target: this.target, itemId, representation, offset }
    if (!validInstructionCall(INSTRUCTION_METHODS.body, input)) throw new Error('migration_invalid_page')
    const body = await this.api.instructionBody(input)
    if (!this.current() || ticket !== this.epoch) return
    const previous = this.state.body
    if (!validInstructionCall(INSTRUCTION_METHODS.body, input, body) || offset > 0 && (!previous || previous.itemId !== itemId || previous.representation !== representation
      || previous.nextOffset !== offset || previous.sha256 !== body.sha256 || previous.totalBytes !== body.totalBytes)) throw new Error('migration_invalid_response')
    this.update({ body })
  })
}
