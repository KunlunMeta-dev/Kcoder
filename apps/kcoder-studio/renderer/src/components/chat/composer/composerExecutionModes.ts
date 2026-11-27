export type ComposerExecutionMode = 'orchestrate' | 'moa' | 'moa-plan'

export interface ComposerExecutionModeControls {
  canSelectOrchestrate: boolean
  onSelect: (mode: ComposerExecutionMode) => void
}
