import { requestLocalExecutor } from '@/tauri/localExecutor'

export type WorkflowNodeKind =
  'agent' | 'transform' | 'wait' | 'human' | 'event' | 'subworkflow' | 'tool' | 'code' | 'input' | 'template' | 'condition' | 'switch' | 'merge' | 'loop' | 'output'
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
function request<T>(serverId: string, method: string, params: object) {
  return requestLocalExecutor<T>('runtime.workflows.request', { serverId, method, params })
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
  nodeStates: Array<{
    nodeId: string
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
export const workflowApi = {
  requests: async (serverId: string, runId: string) => {
    const requests: WorkflowPendingRequest[] = []
    let after: string | undefined
    for (let page = 0; page < 256; page++) {
      const result = await request<{supported:boolean;requests:WorkflowPendingRequest[];nextAfter?:string|null}>(serverId,'workflow/runs/requests',{runId,...(after ? {after} : {})})
      requests.push(...result.requests)
      if (!result.nextAfter) return { supported: result.supported, requests }
      if (result.nextAfter === after || requests.length > 256) throw new Error('Workflow request pagination exceeded its bound')
      after = result.nextAfter
    }
    throw new Error('Workflow request pagination did not terminate')
  },
  respond: (serverId: string, runId: string, requestId: string, value: unknown) => request<{accepted:boolean}>(serverId,'workflow/runs/respond',{runId,requestId,value}),
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
  versions: (serverId: string, id: string) =>
    request<
      Array<{
        version: number
        revision: number
        title: string
        nodeCount: number
        savedAtMs: number
      }>
    >(serverId, 'workflow/versions', { id }),
  exportDefinition: (serverId: string, id: string, version?: number) =>
    request<WorkflowDefinition>(serverId, 'workflow/export', {
      id,
      ...(version ? { version } : {}),
    }),
  clone: (serverId: string, id: string, version?: number) =>
    request<WorkflowDefinition>(serverId, 'workflow/clone', {
      id,
      ...(version ? { version } : {}),
    }),
  importDefinition: (serverId: string, definition: unknown) =>
    request<WorkflowDefinition>(serverId, 'workflow/import', { definition }),

  runs: (serverId: string, definitionId: string, offset = 0) =>
    request<{ items: WorkflowRun[]; total: number; nextOffset?: number | null }>(
      serverId,
      'workflow/runs/list',
      { definitionId, offset, limit: 20 }
    ),
  run: (serverId: string, runId: string) =>
    request<WorkflowRun>(serverId, 'workflow/runs/read', { runId }),
  output: (serverId: string, runId: string, nodeId: string, offset = 0) =>
    request<{ text: string; nextOffset?: number | null; truncated: boolean }>(
      serverId,
      'workflow/runs/output',
      { runId, nodeId, offset, limit: 16384 }
    ),
  update: (serverId: string, definition: WorkflowDefinition, inputSchema: unknown) =>
    request<WorkflowDefinition>(serverId, 'workflow/update', {
      id: definition.id,
      expectedRevision: definition.revision,
      title: definition.title,
      description: definition.description,
      inputSchema,
    }),

  list: (serverId: string, offset = 0) =>
    request<WorkflowList>(serverId, 'workflow/list', { offset, limit: 32 }),
  read: (serverId: string, id: string) =>
    request<WorkflowDefinition>(serverId, 'workflow/read', { id }),
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
