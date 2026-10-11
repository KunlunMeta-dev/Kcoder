import type { ModelSelectionMode } from '@/types/model-selection'
export type { ModelSelectionMode } from '@/types/model-selection'
export const MODEL_SELECTION_MODE_CAPABILITY = 'modelSelectionModeV1'

interface ModelSelectionClient {
  supportsExperimental?: (capability: string) => boolean
}

/** Validate intent before any interruption, metadata write, or model request. */
export function modelSelectionModeParams(
  value: unknown,
  client: ModelSelectionClient,
  model: string | null | undefined,
  retryFromTurnId?: string | null
): { modelSelectionMode?: ModelSelectionMode } {
  if (value === undefined || value === null) return {}
  if (value !== 'explicit' && value !== 'follow_target_default') {
    throw new Error('Invalid modelSelectionMode')
  }
  if (!client.supportsExperimental?.(MODEL_SELECTION_MODE_CAPABILITY)) {
    throw new Error('This server does not support explicit model selection modes')
  }
  if (value === 'follow_target_default') {
    if (model) throw new Error('follow_target_default cannot include model')
    if (retryFromTurnId) throw new Error('A failed-turn continuation cannot change to target-default following')
  } else if (!model?.trim()) {
    throw new Error('explicit model selection requires a nonempty model')
  }
  return { modelSelectionMode: value }
}

/** Absence is not proof of explicit selection on a legacy history projection. */
export function threadModelSelectionMode(thread: Record<string, unknown>): ModelSelectionMode | undefined {
  const mode = thread.modelSelectionMode
  if (mode === undefined || mode === null) return undefined
  if (mode !== 'explicit' && mode !== 'follow_target_default') throw new Error('Invalid thread modelSelectionMode')
  return mode
}

export function applyThreadModelSelection(
  task: { model?: string; modelSelectionMode?: ModelSelectionMode },
  thread: Record<string, unknown>
): void {
  const mode = threadModelSelectionMode(thread)
  if (mode === undefined) return
  const selected = thread.selectedModel
  if (selected !== undefined && selected !== null && (typeof selected !== 'string' || !selected.trim())) {
    throw new Error('Invalid thread selectedModel')
  }
  task.modelSelectionMode = mode
  if (typeof selected === 'string') task.model = selected
}
