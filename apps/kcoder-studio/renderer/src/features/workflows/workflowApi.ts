import { requestLocalExecutor } from '@/tauri/localExecutor'
import type { WorkflowStorageCapacity, WorkflowVersionVerification } from './WorkflowVerification'
import type { WorkflowVersionReferenceView } from './WorkflowVerificationHistory'

export type WorkflowNodeKind =
  | 'agent'
  | 'transform'
  | 'wait'
  | 'human'
  | 'event'
  | 'subworkflow'
  | 'tool'
  | 'code'
  | 'input'
  | 'template'
  | 'condition'
  | 'switch'
  | 'merge'
  | 'loop'
  | 'output'
export interface WorkflowNode {
  kind?: WorkflowNodeKind
  config?: Record<string, unknown>
  runIf?: { nodeId: string; equals: boolean | string }
  id: string
  title: string
  prompt: string
  agentType: string
  maxTurns: number
  dependsOn: string[]
  position: { x: number; y: number }
  allowedWritePaths: string[]
  acceptanceCriteria: string[]
  expectedArtifacts: string[]
}
export interface WorkflowDefinition {
  inputSchema?: unknown
  id: string
  title: string
  description: string
  revision: number
  status: 'draft' | 'saved'
  nodes: WorkflowNode[]
  createdAtMs: number
  updatedAtMs: number
  savedVersion?: number | null
}
export type WorkflowSummary = Omit<WorkflowDefinition, 'nodes'> & { nodeCount: number }
export interface WorkflowList {
  items: WorkflowSummary[]
  truncated: boolean
  total: number
  nextOffset?: number
}
export interface WorkflowReadOptions {
  signal?: AbortSignal
}
function request<T>(
  serverId: string,
  method: string,
  params: object,
  options?: WorkflowReadOptions
) {
  const scope = { serverId, method, params }
  return options
    ? requestLocalExecutor<T>('runtime.workflows.request', scope, options)
    : requestLocalExecutor<T>('runtime.workflows.request', scope)
}
interface WorkflowUnchanged {
  unchanged: true
  id?: string
  runId?: string
  revision: number
  updatedAtMs?: number
}
export interface WorkflowRun {
  revision: number
  error?: string | null
  runId: string
  definitionId: string | null
  version: number | null
  threadId: string
  workspace: string
  status: string
  startedAtMs: number
  updatedAtMs: number
  resumeCount: number
  interactionModified?: boolean
  nodeStates: Array<{
    nodeId: string
    agentId?: string | null
    status: string
    iteration: number | null
    attempt: number
    startedAtMs: number | null
    finishedAtMs: number | null
    reused: boolean
    outputPreview: string | null
    error: string | null
  }>
}
export interface WorkflowPendingRequest {
  runId: string
  requestId: string
  nodeId: string
  request: { kind: 'wait' | 'human' | 'event'; prompt?: string; name?: string; schema?: unknown }
  deadlineUnixMs: number
  status: string
}
export interface WorkflowScenarioInput {
  id: string
  requiredCheckNodes: string[]
  expectedSkippedNodes?: string[] | null
}
export interface WorkflowCapabilities {
  verification: boolean
  storage: boolean
  versionHistory: boolean
  scenarios: boolean
  conditionalRead: boolean
  checkpointReuse?: boolean
  runArchive?: boolean
}
export interface WorkflowRunArchivePreview {
  previewToken: string
  entries: {
    runId: string
    revision: number
    status: string
    bytes: number
    blockers: string[]
    retainedReferences: string[]
  }[]
  activeRecords: number
  maximumRecords: number
  observationBytes: number
  maximumObservationBytes: number
  releasableBytes: number
  retainedRecoveryArtifacts: boolean
}
export interface WorkflowRunArchiveResult {
  previewToken: string
  archivedRunIds: string[]
  releasedBytes: number
  retainedRecoveryArtifacts: boolean
  recoveryPending: boolean
}
export const workflowApi = {
  archivePreview: (serverId: string, runIds: string[], options?: WorkflowReadOptions) =>
    request<WorkflowRunArchivePreview>(
      serverId,
      'workflow/runs/archive/preview',
      { runIds },
      options
    ),
  archiveRuns: (serverId: string, runIds: string[], previewToken: string, confirm: boolean) =>
    request<WorkflowRunArchiveResult>(serverId, 'workflow/runs/archive', {
      runIds,
      previewToken,
      confirm,
    }),
  archivedRuns: (serverId: string, offset = 0, options?: WorkflowReadOptions) =>
    request<{ items: WorkflowRun[]; total: number; nextOffset?: number | null }>(
      serverId,
      'workflow/runs/archive/list',
      { offset, limit: 20 },
      options
    ),
  archivedRun: (serverId: string, runId: string, options?: WorkflowReadOptions) =>
    request<WorkflowRun>(serverId, 'workflow/runs/archive/read', { runId }, options),
  capabilities: (serverId: string, options?: WorkflowReadOptions) =>
    request<WorkflowCapabilities>(serverId, 'workflow/capabilities/read', {}, options),
  verification: async (
    serverId: string,
    id: string,
    version: number,
    offset = 0,
    limit = 32,
    options?: WorkflowReadOptions
  ) => {
    const result = await request<WorkflowVersionVerification>(
      serverId,
      'workflow/verification/read',
      { id, version, offset, limit },
      options
    )
    if (
      result.definitionId !== id ||
      result.savedVersion !== version ||
      !Array.isArray(result.runs) ||
      (result.nextOffset != null &&
        (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset))
    )
      throw new Error('Workflow verification response did not match its selected version/page')
    return result
  },
  capacity: (serverId: string, options?: WorkflowReadOptions) =>
    request<WorkflowStorageCapacity>(serverId, 'workflow/storage/read', {}, options),
  migrateStorage: (serverId: string) =>
    request<{ backend: string; migrated: boolean; legacyBackup: string | null }>(
      serverId,
      'workflow/storage/migrate',
      { confirm: true }
    ),
  rollbackStorage: (serverId: string) =>
    request<{ backend: string; rolledBack: boolean }>(serverId, 'workflow/storage/rollback', {
      confirm: true,
    }),
  versionReferences: async (
    serverId: string,
    id: string,
    version: number,
    options?: WorkflowReadOptions
  ) => {
    const result = await request<WorkflowVersionReferenceView>(
      serverId,
      'workflow/versions/references',
      { id, version },
      options
    )
    if (result.definitionId !== id || result.version !== version)
      throw new Error('Workflow version references did not match the selected version')
    return result
  },
  archiveVersion: (serverId: string, id: string, version: number, expectedRevision: number) =>
    request<{ availability: string; historicalSnapshotRetained: boolean }>(
      serverId,
      'workflow/versions/archive',
      { id, version, expectedRevision, confirm: true }
    ),
  historicalVersion: (
    serverId: string,
    id: string,
    version: number,
    options?: WorkflowReadOptions
  ) =>
    request<{
      definition: WorkflowDefinition
      definitionSha256: string
      availability: string
      availableForNewRuns: false
    }>(serverId, 'workflow/versions/history/read', { id, version }, options),

  requests: async (serverId: string, runId: string, options?: WorkflowReadOptions) => {
    const requests: WorkflowPendingRequest[] = []
    let after: string | undefined
    for (let page = 0; page < 256; page++) {
      const result = await request<{
        supported: boolean
        requests: WorkflowPendingRequest[]
        nextAfter?: string | null
      }>(serverId, 'workflow/runs/requests', { runId, ...(after ? { after } : {}) }, options)
      requests.push(...result.requests)
      if (!result.nextAfter) return { supported: result.supported, requests }
      if (result.nextAfter === after || requests.length > 256)
        throw new Error('Workflow request pagination exceeded its bound')
      after = result.nextAfter
    }
    throw new Error('Workflow request pagination did not terminate')
  },
  respond: (serverId: string, runId: string, requestId: string, value: unknown) =>
    request<{ accepted: boolean }>(serverId, 'workflow/runs/respond', { runId, requestId, value }),
  move: (
    serverId: string,
    id: string,
    node: WorkflowNode,
    expectedPosition: WorkflowNode['position']
  ) =>
    request<WorkflowDefinition>(serverId, 'workflow/moveNode', {
      id,
      nodeId: node.id,
      expectedPosition,
      position: node.position,
    }),
  delete: (serverId: string, id: string, expectedRevision: number) =>
    request<{ deleted: boolean }>(serverId, 'workflow/delete', { id, expectedRevision }),
  versions: (serverId: string, id: string, options?: WorkflowReadOptions) =>
    request<
      Array<{
        version: number
        revision: number
        title: string
        nodeCount: number
        savedAtMs: number
      }>
    >(serverId, 'workflow/versions', { id }, options),
  exportDefinition: (
    serverId: string,
    id: string,
    version?: number,
    options?: WorkflowReadOptions
  ) =>
    request<WorkflowDefinition>(
      serverId,
      'workflow/export',
      {
        id,
        ...(version ? { version } : {}),
      },
      options
    ),
  clone: (serverId: string, id: string, version?: number) =>
    request<WorkflowDefinition>(serverId, 'workflow/clone', {
      id,
      ...(version ? { version } : {}),
    }),
  importDefinition: (serverId: string, definition: unknown) =>
    request<WorkflowDefinition>(serverId, 'workflow/import', { definition }),

  runs: (serverId: string, definitionId?: string, offset = 0, options?: WorkflowReadOptions) =>
    request<{ items: WorkflowRun[]; total: number; nextOffset?: number | null }>(
      serverId,
      'workflow/runs/list',
      { ...(definitionId ? { definitionId } : {}), offset, limit: 20 },
      options
    ),
  run: async (
    serverId: string,
    runId: string,
    current?: WorkflowRun | null,
    options?: WorkflowReadOptions
  ) => {
    const result = await request<WorkflowRun | WorkflowUnchanged>(
      serverId,
      'workflow/runs/read',
      {
        runId,
        ...(current?.runId === runId ? { knownRevision: current.revision } : {}),
      },
      options
    )
    if ('unchanged' in result) {
      if (
        !current ||
        result.unchanged !== true ||
        result.runId !== runId ||
        result.revision !== current.revision
      )
        throw new Error('Workflow run revision response did not match its snapshot')
      return current
    }
    return result
  },
  output: (
    serverId: string,
    runId: string,
    nodeId: string,
    offset = 0,
    options?: WorkflowReadOptions
  ) =>
    request<{ text: string; nextOffset?: number | null; truncated: boolean }>(
      serverId,
      'workflow/runs/output',
      { runId, nodeId, offset, limit: 16384 },
      options
    ),
  update: (serverId: string, definition: WorkflowDefinition, inputSchema: unknown) =>
    request<WorkflowDefinition>(serverId, 'workflow/update', {
      id: definition.id,
      expectedRevision: definition.revision,
      title: definition.title,
      description: definition.description,
      inputSchema,
    }),

  list: (serverId: string, offset = 0, options?: WorkflowReadOptions) =>
    request<WorkflowList>(serverId, 'workflow/list', { offset, limit: 32 }, options),
  read: async (
    serverId: string,
    id: string,
    current?: WorkflowDefinition | null,
    options?: WorkflowReadOptions
  ) => {
    const result = await request<WorkflowDefinition | WorkflowUnchanged>(
      serverId,
      'workflow/read',
      {
        id,
        ...(current?.id === id
          ? { knownRevision: current.revision, knownUpdatedAtMs: current.updatedAtMs }
          : {}),
      },
      options
    )
    if ('unchanged' in result) {
      if (
        !current ||
        result.unchanged !== true ||
        result.id !== id ||
        result.revision !== current.revision ||
        result.updatedAtMs !== current.updatedAtMs
      )
        throw new Error('Workflow definition revision response did not match its snapshot')
      return current
    }
    return result
  },
  create: (serverId: string, title: string, description: string) =>
    request<WorkflowDefinition>(serverId, 'workflow/create', { title, description }),
  upsert: (serverId: string, id: string, expectedRevision: number, node: WorkflowNode) =>
    request<WorkflowDefinition>(serverId, 'workflow/upsertNode', { id, expectedRevision, node }),
  remove: (serverId: string, id: string, expectedRevision: number, nodeId: string) =>
    request<WorkflowDefinition>(serverId, 'workflow/removeNode', { id, expectedRevision, nodeId }),
  save: (serverId: string, id: string, expectedRevision: number) =>
    request<WorkflowDefinition>(serverId, 'workflow/save', { id, expectedRevision }),
}

/** Never apply a late polling response over a newer mutation result. */
export function newerDefinition(current: WorkflowDefinition | null, next: WorkflowDefinition) {
  return !current ||
    current.id !== next.id ||
    next.revision > current.revision ||
    (next.revision === current.revision && next.updatedAtMs > current.updatedAtMs)
    ? next
    : current
}

/** Names are data, including the strings "true" and "false". */
export function workflowRouteLabels(node: WorkflowNode | undefined): string[] {
  const routes = node?.config?.switch as
    { cases?: Array<{ label?: unknown }>; default?: unknown } | undefined
  if (!routes || typeof routes !== 'object') return []
  return [
    ...new Set(
      [
        ...(Array.isArray(routes.cases) ? routes.cases.map(item => item?.label) : []),
        routes.default,
      ].filter((label): label is string => typeof label === 'string' && label.length > 0)
    ),
  ]
}
