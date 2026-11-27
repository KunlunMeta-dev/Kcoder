import { requestLocalExecutor } from '@/host/localExecutor'
import { isContract } from '../../../../shared/generated/validator.mjs'
import {
  EVOLUTION_ERROR_CODES,
  EVOLUTION_METHODS,
  EVOLUTION_RATE_REASON_MAX_CHARS,
  EVOLUTION_RATE_TOOL_CALLS_MAX,
  EVOLUTION_SETTINGS_METHODS,
  type EvolutionDataClearParams,
  type EvolutionDataClearResult,
  type EvolutionErrorCode,
  type EvolutionOverlayContent,
  type EvolutionOverlayUpdateResult,
  type EvolutionPreferenceListResult,
  type EvolutionPreferenceUpdateResult,
  type EvolutionProposalDecideParams,
  type EvolutionProposalDecideResult,
  type EvolutionRateResult,
  type EvolutionRatingsListResult,
  type EvolutionSettings,
  type EvolutionSettingsReadResult,
  type EvolutionStatusResult,
  type EvolutionTargetDistillResult,
  type EvolutionTargetReadResult,
  type EvolutionTargetsListResult,
  type EvolutionTargetType,
} from './evolutionContract'

/**
 * The only module that names self-evolution RPC methods in the renderer. The
 * runtime layer (`gatewayEvolution.ts`) gates every call on `selfEvolutionV1`.
 */

export type EvolutionFailureKind =
  | 'unsupported'
  | 'conflict'
  | 'rejected'
  | 'too_large'
  | 'not_found'
  | 'invalid_transition'
  | 'disabled'
  | 'unconfirmed'
  | 'invalid'
  | 'unavailable'

export class EvolutionRequestError extends Error {
  readonly kind: EvolutionFailureKind
  constructor(kind: EvolutionFailureKind, message: string) {
    super(message)
    this.name = 'EvolutionRequestError'
    this.kind = kind
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Reads a contract error code from `data.kind`, `data.code` or a leading message token. */
export function evolutionErrorCode(error: unknown): EvolutionErrorCode | null {
  const failure = objectOf(error)
  const data = objectOf(failure?.data)
  const candidates = [data?.kind, data?.code, failure?.message]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const code = EVOLUTION_ERROR_CODES.find(
      value => candidate === value || candidate.startsWith(`${value}:`) || candidate.startsWith(`[${value}]`)
    )
    if (code) return code
  }
  return null
}

/** Server-provided rejection reason for `evolution_content_rejected`, never raw stacks. */
export function evolutionRejectionReason(error: unknown): string | null {
  const data = objectOf(objectOf(error)?.data)
  const reason = data?.reason ?? data?.detail
  return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null
}

export function evolutionFailureKind(error: unknown, writing = false): EvolutionFailureKind {
  if (error instanceof EvolutionRequestError) return error.kind
  const failure = objectOf(error)
  const data = objectOf(failure?.data)
  if (data?.kind === 'evolution_unsupported' || failure?.code === -32601) return 'unsupported'
  switch (evolutionErrorCode(error)) {
    case 'evolution_revision_conflict':
      return 'conflict'
    case 'evolution_content_rejected':
      return 'rejected'
    case 'evolution_content_too_large':
      return 'too_large'
    case 'evolution_target_not_found':
    case 'evolution_proposal_not_found':
      return 'not_found'
    case 'evolution_invalid_transition':
      return 'invalid_transition'
    case 'evolution_disabled':
      return 'disabled'
    case 'evolution_unsupported_target_type':
      return 'unsupported'
    default:
      break
  }
  // A write whose receipt was lost may still have been applied.
  if (writing && (failure?.reason === 'timeout' || failure?.reason === 'connection' || !failure?.reason))
    return 'unconfirmed'
  return 'unavailable'
}

function requireTarget(serverId: string): string {
  const id = serverId.trim()
  if (!id) throw new EvolutionRequestError('invalid', 'A self-evolution target is required')
  return id
}

/** Validates a reply against the generated contract schema before the UI sees it. */
function validated<T>(contract: string, method: string, value: unknown): T {
  if (!isContract(contract, value))
    throw new EvolutionRequestError('invalid', `Invalid ${method} response`)
  return value as T
}

async function evolutionRequest<T>(
  serverId: string,
  method: string,
  params: Record<string, unknown>,
  options: { workspacePath?: string; taskId?: string; signal?: AbortSignal } = {}
): Promise<T> {
  return requestLocalExecutor<T>(
    'runtime.evolution.request',
    {
      serverId: requireTarget(serverId),
      ...(options.workspacePath ? { workspacePath: options.workspacePath } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      method,
      params,
    },
    options.signal ? { signal: options.signal } : undefined
  )
}

function workspaceParams(workspace?: string) {
  return workspace ? { workspace } : {}
}

// ---------- Capability ----------

export async function supportsSelfEvolution(serverId: string, workspacePath?: string): Promise<boolean> {
  const result = objectOf(
    await requestLocalExecutor<unknown>('runtime.evolution.supports', {
      serverId: requireTarget(serverId),
      ...(workspacePath ? { workspacePath } : {}),
    })
  )
  return result?.supported === true
}

// ---------- Settings ----------

function validSettingsResult(value: unknown): EvolutionSettingsReadResult {
  return validated('EvolutionSettingsReadResult', EVOLUTION_SETTINGS_METHODS.read, value)
}

export async function readEvolutionSettings(serverId: string): Promise<EvolutionSettingsReadResult> {
  const result = await requestLocalExecutor<unknown>('runtime.settings.request', {
    serverId: requireTarget(serverId),
    method: EVOLUTION_SETTINGS_METHODS.read,
    params: {},
  })
  return validSettingsResult(result)
}

export async function saveEvolutionSettings(
  serverId: string,
  settings: EvolutionSettings,
  expectedRevision: string
): Promise<EvolutionSettingsReadResult> {
  const result = await requestLocalExecutor<unknown>('runtime.settings.request', {
    serverId: requireTarget(serverId),
    method: EVOLUTION_SETTINGS_METHODS.save,
    params: { settings, expectedRevision },
  })
  return validSettingsResult(result)
}

// ---------- Status and targets ----------

export async function readEvolutionStatus(
  serverId: string,
  workspace?: string
): Promise<EvolutionStatusResult> {
  const result = await evolutionRequest<unknown>(serverId, EVOLUTION_METHODS.status, workspaceParams(workspace))
  return validated('EvolutionStatusResult', EVOLUTION_METHODS.status, result)
}

export const EVOLUTION_TARGETS_PAGE_SIZE = 50

export async function listEvolutionTargets(
  serverId: string,
  type: EvolutionTargetType,
  options: { cursor?: string; workspace?: string; limit?: number } = {}
): Promise<EvolutionTargetsListResult> {
  const result = await evolutionRequest<unknown>(serverId, EVOLUTION_METHODS.targetsList, {
    ...workspaceParams(options.workspace),
    type,
    limit: Math.min(200, Math.max(1, options.limit ?? EVOLUTION_TARGETS_PAGE_SIZE)),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  })
  return validated('EvolutionTargetsListResult', EVOLUTION_METHODS.targetsList, result)
}

export async function readEvolutionTarget(
  serverId: string,
  targetKey: string,
  workspace?: string
): Promise<EvolutionTargetReadResult> {
  const result = await evolutionRequest<unknown>(
    serverId,
    EVOLUTION_METHODS.targetRead,
    { ...workspaceParams(workspace), targetKey },
    { workspacePath: workspace }
  )
  return validated('EvolutionTargetReadResult', EVOLUTION_METHODS.targetRead, result)
}

/** Asks the target to distill collected feedback for one object now. */
export async function distillEvolutionTarget(
  serverId: string,
  targetKey: string,
  workspace?: string
): Promise<EvolutionTargetDistillResult> {
  const result = await evolutionRequest<unknown>(
    serverId,
    EVOLUTION_METHODS.targetDistill,
    { ...workspaceParams(workspace), targetKey },
    { workspacePath: workspace }
  )
  return validated('EvolutionTargetDistillResult', EVOLUTION_METHODS.targetDistill, result)
}

export async function decideEvolutionProposal(
  serverId: string,
  params: EvolutionProposalDecideParams
): Promise<EvolutionProposalDecideResult> {
  const result = await evolutionRequest<unknown>(
    serverId,
    EVOLUTION_METHODS.proposalDecide,
    { ...params },
    { workspacePath: params.workspace ?? undefined }
  )
  return validated('EvolutionProposalDecideResult', EVOLUTION_METHODS.proposalDecide, result)
}

export async function updateEvolutionOverlay(
  serverId: string,
  targetKey: string,
  content: EvolutionOverlayContent,
  expectedRevision: string,
  workspace?: string
): Promise<EvolutionOverlayUpdateResult> {
  const result = await evolutionRequest<unknown>(
    serverId,
    EVOLUTION_METHODS.overlayUpdate,
    { ...workspaceParams(workspace), targetKey, slot: 'stable', content, expectedRevision },
    { workspacePath: workspace }
  )
  return validated('EvolutionOverlayUpdateResult', EVOLUTION_METHODS.overlayUpdate, result)
}

// ---------- Personal preferences ----------

export async function listEvolutionPreferences(serverId: string): Promise<EvolutionPreferenceListResult> {
  const result = await evolutionRequest<unknown>(serverId, EVOLUTION_METHODS.preferenceList, {})
  return validated('EvolutionPreferenceListResult', EVOLUTION_METHODS.preferenceList, result)
}

/** `value: null` deletes the preference. */
export async function updateEvolutionPreference(
  serverId: string,
  key: string,
  value: string | null,
  expectedRevision: string
): Promise<EvolutionPreferenceUpdateResult> {
  const result = await evolutionRequest<unknown>(serverId, EVOLUTION_METHODS.preferenceUpdate, {
    key,
    value,
    expectedRevision,
  })
  return validated('EvolutionPreferenceUpdateResult', EVOLUTION_METHODS.preferenceUpdate, result)
}

// ---------- Ratings and data ----------

/**
 * Rates one assistant turn. The runtime resolves the thread from the original
 * task connection, so a stale pane can never rate another conversation.
 * `turnId` should be the recorded turn id from `listEvolutionRatings`;
 * `toolCallIds` (the turn's `skill` calls) address the usage even when the
 * view's own turn identity differs, as in a subagent conversation.
 */
export async function rateEvolutionTurn(input: {
  deviceId: string
  taskId: string
  turnId: string
  rating: 'up' | 'down'
  reason?: string
  targetKey?: string
  toolCallIds?: readonly string[]
  /** Child-agent id when the rated turn belongs to a subagent of this task. */
  subagentId?: string
}): Promise<EvolutionRateResult> {
  const reason = input.reason?.trim().slice(0, EVOLUTION_RATE_REASON_MAX_CHARS)
  const toolCallIds = [...new Set(input.toolCallIds ?? [])]
    .filter(id => id.trim() === id && id.length > 0)
    .slice(0, EVOLUTION_RATE_TOOL_CALLS_MAX)
  const result = await evolutionRequest<unknown>(
    input.deviceId,
    EVOLUTION_METHODS.rate,
    {
      turnId: input.turnId,
      rating: input.rating,
      ...(reason ? { reason } : {}),
      ...(input.targetKey ? { targetKey: input.targetKey } : {}),
      ...(toolCallIds.length ? { toolCallIds } : {}),
      ...(input.subagentId ? { subagentId: input.subagentId } : {}),
    },
    { taskId: input.taskId }
  )
  return validated('EvolutionRateResult', EVOLUTION_METHODS.rate, result)
}

/**
 * Turns of the task's thread (or of one of its subagents) that
 * `rateEvolutionTurn` accepts, with the rating that stands for each.
 */
export async function listEvolutionRatings(input: {
  deviceId: string
  taskId: string
  subagentId?: string
  signal?: AbortSignal
}): Promise<EvolutionRatingsListResult> {
  const result = await evolutionRequest<unknown>(
    input.deviceId,
    EVOLUTION_METHODS.ratingsList,
    input.subagentId ? { subagentId: input.subagentId } : {},
    { taskId: input.taskId, ...(input.signal ? { signal: input.signal } : {}) }
  )
  return validated('EvolutionRatingsListResult', EVOLUTION_METHODS.ratingsList, result)
}

export async function clearEvolutionData(
  serverId: string,
  scope: EvolutionDataClearParams['scope'],
  workspace?: string
): Promise<EvolutionDataClearResult> {
  const params: EvolutionDataClearParams = { ...workspaceParams(workspace), scope, confirm: true }
  const result = await evolutionRequest<unknown>(serverId, EVOLUTION_METHODS.dataClear, { ...params })
  return validated('EvolutionDataClearResult', EVOLUTION_METHODS.dataClear, result)
}
