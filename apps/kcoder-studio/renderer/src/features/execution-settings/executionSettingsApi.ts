import { requestLocalExecutor } from '@/host/localExecutor'
import { isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import { KCODER_RUNTIME_METHODS } from '@/kcoder/legacyRuntimeAbi'

export const EXECUTION_PERMISSION_MODES = [
  'ask',
  'auto',
  'accept_edits',
  'dont_ask',
  'bypass',
  'yolo',
] as const

export type ExecutionPermissionMode = (typeof EXECUTION_PERMISSION_MODES)[number]

export interface ExecutionDefaults {
  persistedPermissionMode: ExecutionPermissionMode | null
  effectivePermissionMode: ExecutionPermissionMode
  cliPermissionModeOverride: ExecutionPermissionMode | null
}

export interface TargetCustomInstructions {
  instructions: string
  configPath: string | null
}

const CUSTOM_INSTRUCTIONS_BYTE_LIMIT = 64 * 1024

export function exceedsCustomInstructionsLimit(instructions: string): boolean {
  return instructions.length > CUSTOM_INSTRUCTIONS_BYTE_LIMIT ||
    new TextEncoder().encode(instructions).byteLength > CUSTOM_INSTRUCTIONS_BYTE_LIMIT
}

function requireTarget(serverId: string): string {
  const normalized = serverId.trim()
  if (!normalized) throw new Error('An execution settings target is required')
  if (!isKCoderGatewayPage()) {
    throw new Error('Execution settings are available through a KCoder Gateway target')
  }
  return normalized
}

function isExecutionPermissionMode(value: unknown): value is ExecutionPermissionMode {
  return EXECUTION_PERMISSION_MODES.some(mode => mode === value)
}

function validateExecutionDefaults(value: unknown): ExecutionDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid execution defaults response')
  }
  const result = value as Record<string, unknown>
  if (
    !(
      result.persistedPermissionMode === null ||
      isExecutionPermissionMode(result.persistedPermissionMode)
    ) ||
    !isExecutionPermissionMode(result.effectivePermissionMode) ||
    !(
      result.cliPermissionModeOverride === null ||
      isExecutionPermissionMode(result.cliPermissionModeOverride)
    )
  ) {
    throw new Error('Invalid execution defaults response')
  }
  return {
    persistedPermissionMode: result.persistedPermissionMode,
    effectivePermissionMode: result.effectivePermissionMode,
    cliPermissionModeOverride: result.cliPermissionModeOverride,
  }
}

export async function readExecutionDefaults(
  serverId: string,
  expected?: { targetScope: string }
): Promise<ExecutionDefaults> {
  const targetId = requireTarget(serverId)
  const result = await requestLocalExecutor<unknown>('runtime.settings.request', {
    serverId: targetId,
    method: 'settings/execution-defaults/read',
    params: {},
    ...(expected ? { targetScope: expected.targetScope } : {}),
  })
  return validateExecutionDefaults(result)
}

export async function saveExecutionDefaults(
  serverId: string,
  permissionMode: ExecutionPermissionMode | null,
  expected?: { targetScope: string }
): Promise<ExecutionDefaults> {
  const targetId = requireTarget(serverId)
  if (permissionMode !== null && !isExecutionPermissionMode(permissionMode)) {
    throw new Error('Unsupported execution permission mode')
  }
  const result = await requestLocalExecutor<unknown>('runtime.settings.request', {
    serverId: targetId,
    method: 'settings/execution-defaults/save',
    params: { permissionMode },
    ...(expected ? { targetScope: expected.targetScope } : {}),
  })
  return validateExecutionDefaults(result)
}

export async function readTargetCustomInstructions(
  serverId: string,
  expected?: { targetScope: string }
): Promise<TargetCustomInstructions> {
  const targetId = requireTarget(serverId)
  const result = await requestLocalExecutor<unknown>(KCODER_RUNTIME_METHODS.instructionsRead, {
    deviceId: targetId,
    ...(expected ? { targetScope: expected.targetScope } : {}),
  })
  return validateTargetCustomInstructions(result)
}

export async function saveTargetCustomInstructions(
  serverId: string,
  instructions: string,
  expected?: { targetScope: string }
): Promise<TargetCustomInstructions> {
  const targetId = requireTarget(serverId)
  if (exceedsCustomInstructionsLimit(instructions)) {
    throw new Error('Custom instructions exceed the 64 KiB limit')
  }
  const result = await requestLocalExecutor<unknown>(KCODER_RUNTIME_METHODS.instructionsWrite, {
    deviceId: targetId,
    instructions,
    ...(expected ? { targetScope: expected.targetScope } : {}),
  })
  return validateTargetCustomInstructions(result)
}

function validateTargetCustomInstructions(value: unknown): TargetCustomInstructions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid custom instructions response')
  }
  const result = value as Record<string, unknown>
  if (typeof result.instructions !== 'string') {
    throw new Error('Invalid custom instructions response')
  }
  return {
    instructions: result.instructions,
    configPath: typeof result.configPath === 'string' ? result.configPath : null,
  }
}

export function isExecutionDefaultsUnsupported(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const data = (error as { data?: unknown }).data
  return Boolean(
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).kind === 'execution_defaults_unsupported' &&
    (data as Record<string, unknown>).capability === 'executionDefaultsV1'
  )
}
