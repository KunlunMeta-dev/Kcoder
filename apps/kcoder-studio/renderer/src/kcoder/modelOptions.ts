import { normalizeModelOptions } from '@/lib/model-ui'
import type { ModelOptions, UnifiedModel } from '@/types/api'

const permissionModes = new Set([
  'default',
  'ask',
  'auto',
  'accept_edits',
  'dont_ask',
  'bypass',
  'yolo',
])

export function runtimeModelOptions(options: ModelOptions): ModelOptions {
  const mode = options.kcoderPermissionMode
  return permissionModes.has(mode) ? { kcoderPermissionMode: mode } : {}
}

export function normalizeRuntimeModelOptions(
  model: UnifiedModel | null,
  options: ModelOptions
): ModelOptions {
  // Runtime permissions are independent of the selected provider's model controls.
  return { ...normalizeModelOptions(model, options), ...runtimeModelOptions(options) }
}
