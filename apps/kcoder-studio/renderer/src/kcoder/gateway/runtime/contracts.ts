import { GatewayRpcError, type GatewayServer } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { type ModelSelectionMode } from '../../modelSelectionMode'
import { type ThreadRunActivity, type ThreadRunSummary } from '../../threadRunSummary'

export const EXECUTOR_EVENT = 'local-executor:event'

export const SELECTED_SERVER_KEY = 'kcoder-studio:selected-server'

export const TASK_METADATA_KEY = 'kcoder-studio:task-metadata-v1'

export const MAX_TASK_METADATA_ENTRIES = 10_000

export const MAX_INTERRUPTED_BACKGROUND_TOOL_TOMBSTONES = 512

export const PERSISTED_THREAD_MISS_THRESHOLD = 2

export const RUNTIME_PROJECT_PREFIX = 'runtime-target:'

export function runtimeProjectKey(serverId: string): string {
  return `${RUNTIME_PROJECT_PREFIX}${serverId}`
}

export function serverIdFromRuntimeProjectKey(
  projectKey: string | null | undefined
): string | null {
  if (!projectKey) return null
  if (projectKey.startsWith(RUNTIME_PROJECT_PREFIX)) {
    return projectKey.slice(RUNTIME_PROJECT_PREFIX.length) || null
  }
  // Compatibility key for KCoder project state and historical deep links written by the first release.
  if (projectKey.startsWith('kcoder:')) return projectKey.slice('kcoder:'.length) || null
  return null
}

export function runtimeTaskId(server: Pick<GatewayServer, 'id' | 'runtime'>, threadId: string): string {
  // First-release server configuration had no runtime field; treat old configuration and test fixtures as KCoder.
  return `${server.runtime ?? 'kcoder'}:${server.id}:${threadId}`
}

export interface GatewayTask {
  scheduled?: boolean
  ephemeral?: boolean
  serverId: string
  taskId: string
  threadId: string
  workspacePath: string
  projectKey?: string
  projectName?: string
  title: string
  runtime: 'kcoder'
  model?: string
  modelSelectionMode?: ModelSelectionMode
  persisted: boolean
  running: boolean
  /** Authoritative activity derived from the server run summary (S1/S4). */
  runActivity?: ThreadRunActivity
  runSummary?: ThreadRunSummary
  createdAt: number
  updatedAt: number
  runtimeHandle: { threadId: string }
  parent?: { taskId: string; threadId: string; lastTurnId: string }
}

export interface SharedRuntimeContext {
  instructions: string
  personality: 'friendly' | 'pragmatic'
  instructionsConfigured: boolean
  personalityConfigured: boolean
  configPath: string | null
}

export interface GatewayWorkspaceDescriptor {
  threadsComplete?: boolean
  threadListIssueCount?: number
  threadListSyncFailed?: boolean
  server: GatewayServer
  workspacePath: string
  workspaceKind: 'workspace' | 'worktree'
  label: string
  labelKey?: 'currentComputer'
  projectName: string
  projectKey: string
  projectSource?: string
  projectRoots?: string[]
  projectPinned: boolean
  projectPinnedOrder?: number | null
  projectActive: boolean
  projectAppearance?: unknown
  worktreeId?: string
  pinnedTaskIds: string[]
  available: boolean
  error?: string
}

export interface GatewayTaskMetadata {
  title?: string
  model?: string
  archivedAt?: number
  deletedAt?: number
  parent?: { taskId: string; threadId: string; lastTurnId: string }
  createdAt?: number
  updatedAt: number
}

export interface GatewayThreadMetadataPatch {
  title?: string | null
  model?: string | null
  archivedAt?: string | null
  parent?: GatewayTask['parent'] | null
}

export interface GatewayThreadMetadata {
  schema: 'kcoder.thread-metadata'
  version: 1
  revision: number
  title: string | null
  model: string | null
  archivedAt: string | null
  parent: GatewayTask['parent'] | null
}

export interface ActiveGatewayTurn {
  turnId: string
  internal: boolean
  completion: Promise<void>
  complete: () => void
}

export interface GatewayBackgroundJob {
  parentAttemptId?: string
  runId?: string
  taskId: string
  turnId: string
  toolCallId: string
  toolName: string
  serverId: string
}

export interface InterruptedGatewayBackgroundTool {
  taskId: string
  toolCallId: string
  agentId: string
  output: Record<string, unknown>
}

export interface PendingGatewayQuestion {
  client: GatewayClient
  requestId: number
  taskId: string
  turnId: string
  block: Record<string, unknown>
  renderPayload: Record<string, unknown>
  approvalId?: string
  questionId?: string
  approvalDecisions?: Record<string, 'accept' | 'accept_for_session' | 'decline'>
  autoResolutionTimer?: number
  responsePending?: boolean
  submittedResponse?: Record<string, unknown>
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function rawDeltaText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function sanitizeBrowserLabelSegment(value: string): string {
  return value
    .trim()
    .split('')
    .map(character => (/^[a-zA-Z0-9_-]$/.test(character) ? character : '-'))
    .join('')
}

export function metadataTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

export function taskParent(value: unknown): GatewayTask['parent'] | undefined {
  let parent = record(value)
  if (typeof value === 'string') {
    try {
      parent = record(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  const taskId = text(parent.taskId)
  const threadId = text(parent.threadId)
  const lastTurnId = text(parent.lastTurnId)
  return taskId && threadId && lastTurnId ? { taskId, threadId, lastTurnId } : undefined
}

export function authoritativeThreadMetadata(value: unknown): GatewayThreadMetadata | undefined {
  const metadata = record(value)
  if (
    metadata.schema !== 'kcoder.thread-metadata' ||
    metadata.version !== 1 ||
    typeof metadata.revision !== 'number' ||
    !Number.isFinite(metadata.revision)
  ) {
    return undefined
  }
  const nullableText = (field: string) =>
    metadata[field] === null || typeof metadata[field] === 'string'
      ? (metadata[field] as string | null)
      : null
  return {
    schema: 'kcoder.thread-metadata',
    version: 1,
    revision: metadata.revision,
    title: nullableText('title'),
    model: nullableText('model'),
    archivedAt: nullableText('archivedAt'),
    parent: metadata.parent === null ? null : (taskParent(metadata.parent) ?? null),
  }
}

export function readTaskMetadata(): Map<string, GatewayTaskMetadata> {
  try {
    const entries = record(JSON.parse(localStorage.getItem(TASK_METADATA_KEY) ?? '{}'))
    return new Map(
      Object.entries(entries).flatMap(([key, value]) => {
        const entry = record(value)
        const updatedAt = finiteNumber(entry.updatedAt)
        if (!updatedAt) return []
        const parent = record(entry.parent)
        const parentTaskId = text(parent.taskId)
        const parentThreadId = text(parent.threadId)
        const parentLastTurnId = text(parent.lastTurnId)
        return [
          [
            key,
            {
              ...(text(entry.title) ? { title: text(entry.title)! } : {}),
              ...(text(entry.model) ? { model: text(entry.model)! } : {}),
              ...(finiteNumber(entry.archivedAt)
                ? { archivedAt: finiteNumber(entry.archivedAt) }
                : {}),
              ...(finiteNumber(entry.deletedAt)
                ? { deletedAt: finiteNumber(entry.deletedAt) }
                : {}),
              ...(finiteNumber(entry.createdAt)
                ? { createdAt: finiteNumber(entry.createdAt) }
                : {}),
              ...(parentTaskId && parentThreadId && parentLastTurnId
                ? {
                    parent: {
                      taskId: parentTaskId,
                      threadId: parentThreadId,
                      lastTurnId: parentLastTurnId,
                    },
                  }
                : {}),
              updatedAt,
            },
          ] as const,
        ]
      })
    )
  } catch {
    return new Map()
  }
}

export function isRetryableReadonlyTaskConnectionError(error: unknown): boolean {
  return error instanceof GatewayRpcError && error.reason === 'connection'
}

export interface KCoderGatewayRuntimeOptions {
  loadServers?: () => Promise<GatewayServer[]>
  createClient?: (
    serverId: string,
    token: string,
    channel?: 'runtime' | 'browser',
    workspacePath?: string
  ) => GatewayClient
}
