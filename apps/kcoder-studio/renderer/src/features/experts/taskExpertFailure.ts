/**
 * Classify an original-task expert read/change failure.
 *
 * Transient reasons describe a task that is still the same original task but
 * could not answer right now (a live commit, a reconnect or a stalled
 * request). They never authorize a configuration; callers keep the last
 * authoritative snapshot or keep loading while a later read decides.
 */
export type TaskExpertFailureReason =
  | 'busy'
  | 'timeout'
  | 'connection'
  | 'taskChanged'
  | 'taskUnavailable'
  | 'workspaceChanged'
  | 'legacySource'
  | 'unsupported'
  | 'revisionConflict'
  | 'definitionUnavailable'
  | 'unknown'

const transientReasons: ReadonlySet<TaskExpertFailureReason> = new Set(['busy', 'timeout', 'connection'])

const messageReasons: ReadonlyArray<readonly [RegExp, TaskExpertFailureReason]> = [
  // The original task is committing history (streaming, compaction) or holds
  // its lifecycle lock for a short metadata update.
  [/CHAT_TASK_LIFECYCLE_BUSY|AGENT_TASK_APP_SERVER_BUSY|HISTORY_SOURCE_CHANGED|HISTORY_COMMIT_IN_PROGRESS|history source changed during resume preparation|history commit is in progress/, 'busy'],
  [/Gateway request expired/, 'timeout'],
  [/AGENT_TASK_CONNECTION_CHANGED|KCoder app-server restart is in progress|KCoder app-server 尚未连接|任务连接持续变化/, 'connection'],
  [/CHAT_TASK_WORKSPACE_CHANGED/, 'workspaceChanged'],
  [/CHAT_TASK_LEGACY_SOURCE_MIGRATION_REQUIRED|AGENT_LEGACY_CHANNEL_READ_ONLY/, 'legacySource'],
  [/AGENT_CONFIGURATION_REVISION_CONFLICT/, 'revisionConflict'],
  [/AGENT_DEFINITION_DISABLED|AGENT_DEFINITION_INVALID|AGENT_MODEL_SELECTION_UNAVAILABLE|AGENT_DEFINITION_NOT_FOUND/, 'definitionUnavailable'],
  [/AGENT_TURN_CONFIGURATION_UNSUPPORTED|agentTurnConfigurationV1 negotiation is required|AGENT_TASK_CLIENT_REQUIRED/, 'unsupported'],
  [/AGENT_ORIGINAL_TASK_UNAVAILABLE|NATIVE_SESSION_OWNED_ELSEWHERE|PERSISTED_THREAD_NOT_FOUND|THREAD_NOT_RESIDENT|thread\/start or thread\/resume is required|persisted thread not found|任务地址不存在或尚未恢复|任务服务器已不存在/, 'taskUnavailable'],
  [/AGENT_ORIGINAL_TASK_CHANGED|AGENT_ORIGINAL_RESPONSE_REQUIRED|AGENT_ORIGINAL_TASK_REQUIRED|ORIGINAL_TASK_TARGET_CHANGED|THREAD_MISMATCH|threadId does not match the active thread/, 'taskChanged'],
]

function errorField(error: unknown, field: 'name' | 'reason' | 'data'): unknown {
  return error && typeof error === 'object' ? (error as Record<string, unknown>)[field] : undefined
}

function wireFailureCode(error: unknown): string | undefined {
  const data = errorField(error, 'data')
  const kind = data && typeof data === 'object' ? (data as { kind?: unknown }).kind : undefined
  return typeof kind === 'string' && kind !== 'OTHER' && /^[A-Z][A-Z0-9_]{2,79}$/.test(kind)
    ? kind
    : undefined
}

export function taskExpertFailureReason(error: unknown): TaskExpertFailureReason {
  const name = errorField(error, 'name')
  if (name === 'AbortError') return 'connection'
  if (name === 'GatewayRpcTimeoutError' || errorField(error, 'reason') === 'timeout') return 'timeout'
  const message = wireFailureCode(error) ?? (error instanceof Error ? error.message : String(error))
  for (const [pattern, reason] of messageReasons) if (pattern.test(message)) return reason
  if (errorField(error, 'reason') === 'connection') return 'connection'
  return 'unknown'
}

export function isTransientTaskExpertFailure(error: unknown): boolean {
  return transientReasons.has(taskExpertFailureReason(error))
}

const phraseCodes: ReadonlyArray<readonly [RegExp, string]> = [
  [/history source changed during resume preparation/, 'HISTORY_SOURCE_CHANGED'],
  [/history commit is in progress/, 'HISTORY_COMMIT_IN_PROGRESS'],
  [/persisted thread not found/, 'PERSISTED_THREAD_NOT_FOUND'],
  [/thread\/start or thread\/resume is required/, 'THREAD_NOT_RESIDENT'],
  [/threadId does not match the active thread/, 'THREAD_MISMATCH'],
  [/Gateway request expired/, 'GATEWAY_REQUEST_EXPIRED'],
]

/**
 * A bounded, copyable code for a report. Raw messages may carry paths or
 * identifiers, so only an upper-case code or a known phrase category is kept.
 */
export function taskExpertFailureCode(error: unknown): string {
  const name = errorField(error, 'name')
  if (name === 'AbortError') return 'ABORTED'
  if (name === 'GatewayRpcTimeoutError' || errorField(error, 'reason') === 'timeout') return 'GATEWAY_TIMEOUT'
  const kind = wireFailureCode(error)
  if (kind) return kind
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, '')
  const code = /^[A-Z][A-Z0-9_]{2,80}\b/.exec(message)?.[0] ?? /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.exec(message)?.[0]
  if (code) return code
  for (const [pattern, phrase] of phraseCodes) if (pattern.test(message)) return phrase
  return errorField(error, 'reason') === 'connection' ? 'GATEWAY_CONNECTION' : 'UNKNOWN'
}
