import type * as C from './generated/contracts'
import { validInstructionSourceCall, INSTRUCTION_METHODS } from './migrationInstructions.mjs'
import type { createInstructionSourceApi } from './migrationInstructionSourceApi'

type SourceApi = ReturnType<typeof createInstructionSourceApi> & {
  open(input: C.MigrationSourceSessionOpenParams): Promise<C.MigrationSourceSessionStateResult>
  close(input: C.MigrationSourceSessionParams): Promise<C.MigrationSourceSessionCloseResult>
}
interface Options {
  targetId: string
  api: SourceApi
  cleanup: Pick<SourceApi, 'close'>
  newId(): string
  isCurrent(): boolean
}
interface State {
  busy: boolean
  error: string | null
  releasePending: boolean
  intent: C.MigrationInstructionCaptureParams | null
  session: C.MigrationSourceSessionParams | null
  capture: C.MigrationInstructionCaptureResult | null
  page: C.MigrationInstructionPageResult | null
  body: C.MigrationInstructionBodyResult | null
}
const empty = (): State => ({ busy: false, error: null, releasePending: false, intent: null, session: null, capture: null, page: null, body: null })
function failure(code: string): never { throw Object.assign(new Error(code), { code }) }
function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  return typeof code === 'string' && /^source_transfer_[a-z_]+$/.test(code) ? code : 'source_transfer_outcome_unknown'
}

/** One explicitly confirmed static capture owns one source child. A lost reply is observed before any further action. */
export class InstructionSourcesController {
  private state = empty()
  private active = true
  private flight = false
  private readonly listeners = new Set<() => void>()
  private resource: { session: C.MigrationSourceSessionParams; released: boolean } | null = null
  private epoch = 0
  private readonly options: Options
  constructor(options: Options) { this.options = options }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  activate = () => { this.active = true; this.epoch++ }
  current = () => this.active && this.options.isCurrent()
  private update(patch: Partial<State>) { if (this.current()) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() } }
  private check(ticket: number) { if (!this.current() || ticket !== this.epoch) failure('source_transfer_authority_changed') }
  private async release(resource: NonNullable<InstructionSourcesController['resource']>) {
    try { resource.released = (await this.options.cleanup.close(resource.session)).status === 'released' }
    catch { /* The original Gateway retains the uncertain owner; no replacement child is adopted. */ }
    return resource.released
  }
  dispose = () => { this.active = false; this.epoch++; if (this.resource) void this.release(this.resource) }
  private async perform(work: (ticket: number) => Promise<void>) {
    if (this.flight || !this.current()) return
    const ticket = this.epoch
    this.flight = true; this.update({ busy: true, error: null })
    try { await work(ticket) }
    catch (error) { if (this.current() && ticket === this.epoch) this.update({ error: errorCode(error) }) }
    finally {
      this.flight = false
      if (this.current() && ticket === this.epoch) this.update({ busy: false })
      else {
        if (this.current()) this.update({ busy: false, error: this.state.error ?? 'source_transfer_authority_changed' })
        if (this.resource) { this.resource.released = false; await this.release(this.resource) }
      }
    }
  }
  capture = (input: Omit<C.MigrationInstructionCaptureParams, 'captureId'>) => this.perform(async ticket => {
    if (this.state.intent || this.resource) failure('source_transfer_instruction_capture_fixed')
    const intent = { ...input, captureId: this.options.newId() }
    if (!validInstructionSourceCall(INSTRUCTION_METHODS.capture, intent)) failure('source_transfer_invalid_request')
    const session: C.MigrationSourceSessionParams = { sessionId: this.options.newId(), purpose: 'source', targetId: this.options.targetId, workspacePath: intent.sourceCwd }
    const resource = { session, released: false }
    this.resource = resource
    this.update({ intent, session })
    const opened = await this.options.api.open(session); this.check(ticket)
    if (opened.status !== 'ready') failure('source_transfer_source_not_ready')
    const capture = await this.options.api.instructionsCapture(session, intent); this.check(ticket)
    if (!validInstructionSourceCall(INSTRUCTION_METHODS.capture, intent, capture)) failure('source_transfer_invalid_response')
    this.update({ capture })
    await this.readPage(0, ticket)
  })
  private async readPage(pageIndex: number, ticket: number) {
    const { intent, session } = this.state
    if (!intent || !session || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 12) failure('source_transfer_invalid_request')
    const params = { captureId: intent.captureId, pageIndex }
    const page = await this.options.api.instructionsPage(session, params); this.check(ticket)
    if (!validInstructionSourceCall(INSTRUCTION_METHODS.page, { target: { kind: 'source', captureId: intent.captureId }, pageIndex }, page)
      || page.items.some(row => row.source !== intent.source || row.formatRevision !== 'scoped-instructions/v2')
      || this.state.page && this.state.page.totalItems !== page.totalItems
      || this.state.capture && page.items.some(row => row.sourceRevision !== this.state.capture!.sourceRevision)) failure('source_transfer_invalid_response')
    this.update({ page, body: null })
  }
  observe = () => this.perform(ticket => this.readPage(this.state.page?.pageIndex ?? 0, ticket))
  page = (index: number) => this.perform(ticket => this.readPage(index, ticket))
  preview = (itemId: string, representation: C.InstructionRepresentation, offset = 0) => this.perform(async ticket => {
    const { intent, session, page } = this.state
    if (!intent || !session || !page?.items.some(row => row.itemId === itemId)) failure('source_transfer_invalid_request')
    const params = { captureId: intent.captureId, itemId, representation, offset }
    const body = await this.options.api.instructionsBody(session, params); this.check(ticket)
    if (!validInstructionSourceCall(INSTRUCTION_METHODS.body, { target: { kind: 'source', captureId: intent.captureId }, itemId, representation, offset }, body)) failure('source_transfer_invalid_response')
    const previous = this.state.body
    if (offset > 0 && (!previous || previous.itemId !== itemId || previous.representation !== representation || previous.nextOffset !== offset || previous.sha256 !== body.sha256 || previous.totalBytes !== body.totalBytes)) failure('source_transfer_invalid_response')
    this.update({ body })
  })
  close = () => this.perform(async ticket => {
    if (!this.resource) return
    const released = await this.release(this.resource); this.check(ticket)
    if (!released) { this.update({ releasePending: true }); return }
    this.resource = null; this.state = empty()
    for (const listener of this.listeners) listener()
  })
}
