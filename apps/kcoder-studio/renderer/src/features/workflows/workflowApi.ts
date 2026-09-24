import { requestLocalExecutor } from '@/tauri/localExecutor'

export interface WorkflowNode {
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
export const workflowApi = {
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
  return !current || current.id !== next.id || next.revision > current.revision ? next : current
}
export async function launchWorkflowConversation(args: {
  serverId: string
  workspacePath: string
  definition: WorkflowDefinition
  generate: boolean
  request?: string
  conversationTitle?: string
}) {
  const { definition, generate, serverId, workspacePath } = args
  if (!generate && !definition.savedVersion)
    throw new Error('A published workflow version is required')
  const prompt = generate
    ? `Use WorkflowDraft to build draft ${JSON.stringify(definition.id)}. Read its current revision first. Add exactly one node per upsert_node call so the canvas updates incrementally. Do not execute Workflow, shell commands, or agents. Do not publish automatically; the user reviews and saves the DAG. User request:\n${args.request || definition.description}`
    : `Run the saved workflow using Workflow with exactly ${JSON.stringify({ definition_id: definition.id, version: definition.savedVersion })}. Use this immutable published version, not its editable draft. Report progress and the result in this conversation.`
  return requestLocalExecutor<{ accepted: boolean; taskId: string; deviceId: string }>(
    'runtime.tasks.create',
    {
      deviceId: serverId,
      workspacePath,
      title: args.conversationTitle || definition.title,
      sessionMode: generate ? 'workflow_draft' : 'default',
      executionRequest: { prompt },
    }
  )
}
