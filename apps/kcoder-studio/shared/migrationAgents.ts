import * as C from './generated/contracts'
export const AGENT_CAPABILITY = 'migrationAgentAdaptationV1'
export const AGENT_PREVIEW_METHOD = 'migration/agent/preview'
const toolNames = new Set(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'PowerShell', 'WebSearch', 'WebFetch', 'TodoWrite'])
export function hasAgentAdaptations(input: unknown): boolean {
  const choices = (input as { choices?: unknown[] } | null)?.choices
  return Array.isArray(choices) && choices.some(value => !!value && typeof value === 'object' && (value as { agentAdaptation?: unknown }).agentAdaptation != null)
}
export function validAgentPreview(input: unknown, result?: unknown): boolean {
  if (!C.isMigrationAgentPreviewParams(input) || !input.jobId || input.jobId.length > 128 || !input.itemId || input.itemId.length > 256) return false
  if (result === undefined) return true
  if (!C.isMigrationAgentPreviewResult(result) || result.jobId !== input.jobId || result.itemId !== input.itemId) return false
  const value = result.compatibility
  return /^[0-9a-f]{64}$/.test(value.sourceSha256) && value.availableTools.length <= 10
    && new Set(value.availableTools).size === value.availableTools.length && value.availableTools.every(tool => toolNames.has(tool))
    && (value.canAdapt ? value.problem == null : value.problem != null && value.availableTools.length === 0)
}
export function createAgentApi(invoke: <T>(method: string, params: object) => Promise<T>) {
  return { agentPreview: async (params: C.MigrationAgentPreviewParams) => {
    if (!validAgentPreview(params)) throw new Error('migration_invalid_parameters')
    const value = await invoke<C.MigrationAgentPreviewResult>(AGENT_PREVIEW_METHOD, params)
    if (!validAgentPreview(params, value)) throw new Error('migration_invalid_response')
    return value
  } }
}
export interface AgentChoiceState {
  enabled: boolean; busy: boolean; error: 'failed' | 'updateRequired' | null
  result?: C.MigrationAgentPreviewResult; kind: '' | 'inherit' | 'target'; provider: string; model: string; tools: string[]; confirmed: boolean
}
/** A new native source hash and an explicit user review are required before saving executable metadata. */
export class AgentChoiceController {
  private state: AgentChoiceState
  private active = false
  private epoch = 0
  private listeners = new Set<() => void>()
  private readonly api: ReturnType<typeof createAgentApi>
  private readonly locator: C.MigrationAgentPreviewParams
  private readonly current: () => boolean
  constructor(api: ReturnType<typeof createAgentApi>, locator: C.MigrationAgentPreviewParams,
    current: () => boolean, initial?: C.MigrationAgentAdaptation | null) {
    this.api = api; this.locator = locator; this.current = current
    this.state = { enabled: !!initial, busy: false, error: null, kind: initial?.model.kind ?? '', provider: initial?.model.kind === 'target' ? initial.model.provider : '', model: initial?.model.kind === 'target' ? initial.model.model : '', tools: initial?.tools ?? [], confirmed: false }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  snapshot = () => this.state
  activate = () => { this.active = true }
  dispose = () => { this.active = false; this.epoch++ }
  private update(value: Partial<AgentChoiceState>) { this.state = { ...this.state, ...value }; this.listeners.forEach(listener => listener()) }
  change = (value: Partial<Pick<AgentChoiceState, 'enabled' | 'kind' | 'provider' | 'model' | 'tools'>>) => this.update({ ...value, confirmed: false })
  confirm = (confirmed: boolean) => this.update({ confirmed })
  read = async () => {
    if (!this.active || !this.current()) return
    const ticket = ++this.epoch
    this.update({ busy: true, error: null, confirmed: false, result: undefined })
    try {
      const result = await this.api.agentPreview(this.locator)
      if (!this.active || !this.current() || ticket !== this.epoch) return
      if (!validAgentPreview(this.locator, result)) throw new Error('migration_invalid_response')
      this.update({ result, tools: result.compatibility.availableTools })
    } catch (error) {
      if (this.active && this.current() && ticket === this.epoch) this.update({ error: error instanceof Error && error.message === 'migration_agent_update_required' ? 'updateRequired' : 'failed' })
    } finally { if (this.active && this.current() && ticket === this.epoch) this.update({ busy: false }) }
  }
  value(): C.MigrationAgentAdaptation | null {
    const s = this.state, c = s.result?.compatibility
    const validText = (value: string) => !!value && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    if (!this.current() || !s.enabled || s.busy || s.error || !c?.canAdapt || !s.confirmed || !s.kind || new Set(s.tools).size !== s.tools.length || s.tools.some(tool => !c.availableTools.includes(tool))) return null
    if (s.kind === 'target' && (!validText(s.provider) || !validText(s.model) || s.provider.toLowerCase() === 'current')) return null
    return { reviewedSourceSha256: c.sourceSha256, model: s.kind === 'inherit' ? { kind: 'inherit' } : { kind: 'target', provider: s.provider, model: s.model }, tools: [...s.tools] }
  }
  ready(): boolean { return !this.state.enabled || !!this.value() }
}
