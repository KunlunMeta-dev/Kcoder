import { registerMcpAppOperation } from './mcpAppOperationScope'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

const MCP_APP_METHODS = new Set([
  'mcp/apps/read',
  'mcp/apps/resourceRead',
  'mcp/apps/resourceContentRead',
  'mcp/apps/toolCall',
  'mcp/apps/operationRead',
])
const METHODS = new Set([
  'widget/list',
  'widget/read',
  'widget/content/read',
  'widget/render/receipt',
])

/** Widget reads stay bound to the requesting pane, even when another task becomes active. */
export async function requestWidgets(
  this: GatewayRuntimeCore,
  rawParams: Record<string, unknown>,
  options?: { signal?: AbortSignal },
  mcpApp = false
): Promise<unknown> {
  const accountValid = captureAccountContextRevision()
  const address = record(rawParams.address)
  const method = text(rawParams.method)
  if (!method || !(mcpApp ? MCP_APP_METHODS : METHODS).has(method))
    throw new Error('Unsupported widget operation')
  if (!text(address.taskId) || !text(address.deviceId))
    throw new Error('Widget requests require a task and target address')
  const { task, server } = await this.taskDescriptor({ address })
  if (
    server.id !== address.deviceId ||
    (address.threadId && address.threadId !== task.threadId) ||
    (address.workspacePath && !sameWorkspacePath(text(address.workspacePath), task.workspacePath))
  )
    throw new Error('Widget target does not match the addressed task')
  const assertScope = () => {
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!accountValid(server.id) || this.tasks.get(task.taskId)?.threadId !== task.threadId)
      throw new Error('Widget task ownership changed')
  }
  assertScope()
  const client = await this.readyTaskClient(task)
  assertScope()
  if (client.supportsExperimental?.('inlineWidgetsV1') !== true)
    throw new Error('inlineWidgetsV1 negotiation is required')
  if (
    mcpApp &&
    (task.studioWorkMode !== 'kworker' ||
      ['studioWorkModesV1', 'isolatedWidgetsV1', 'mcpAppsV1'].some(
        cap => client.supportsExperimental?.(cap) !== true
      ))
  )
    throw new Error('MCP Apps requires a capable native client and its bound KWorker task')
  const supplied = record(rawParams.params)
  const suppliedWidget = record(supplied.widget)
  for (const threadId of [supplied.threadId, suppliedWidget.threadId]) {
    if (threadId !== undefined && threadId !== task.threadId)
      throw new Error('Widget thread does not match the addressed task')
  }
  const params =
    method === 'widget/render/receipt'
      ? { ...supplied, widget: { ...suppliedWidget, threadId: task.threadId } }
      : { ...supplied, threadId: task.threadId }
  const release =
    mcpApp && method === 'mcp/apps/toolCall'
      ? registerMcpAppOperation(client, task.taskId, supplied.operationId)
      : undefined
  try {
    const result = await client.request(method, params, options)
    assertScope()
    if (this.clientByTask.get(task.taskId) !== client)
      throw new Error('Widget task connection changed')
    return result
  } finally {
    release?.()
  }
}
