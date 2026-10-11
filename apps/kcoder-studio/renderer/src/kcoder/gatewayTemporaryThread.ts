import type { GatewayClient } from './gatewayRuntimeTypes'
import { startThreadWithReceipt } from './gatewayThreadReceipt'
import { executionModeParams } from './gatewayExecutionModes'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function isTemporaryTaskCreate(params: Record<string, unknown>): boolean {
  return params.ephemeral === true || object(params.executionRequest).ephemeral === true
}

export async function startTaskThread(
  client: GatewayClient,
  options: {
    serverId: string
    workspacePath: string
    params: Record<string, unknown>
    model?: string | null
    creationRequestId?: string
    recoverClient?: () => Promise<GatewayClient>
    onRecoveredClient?: (client: GatewayClient) => void
  }
): Promise<{ thread?: { id?: string }; ephemeral?: boolean }> {
  const { serverId, workspacePath, params, model } = options
  const { sessionMode } = executionModeParams(params, client)
  const workflowDefinitionId = typeof params.workflowDefinitionId === 'string' ? params.workflowDefinitionId : undefined
  if (workflowDefinitionId && (sessionMode !== 'workflow_draft' || client.supportsExperimental?.('workflowConversationV1') !== true)) {
    throw new Error('Workflow conversations require workflowConversationV1 and workflow_draft mode')
  }
  const ephemeral = isTemporaryTaskCreate(params)
  const settingsTemplate =
    typeof params.settingsTemplate === 'string' && params.settingsTemplate.trim()
      ? params.settingsTemplate.trim()
      : undefined
  if (!ephemeral) {
    if (params.sideSource) throw new Error('临时聊天必须使用临时会话协议')
    if (
      settingsTemplate &&
      client.supportsExperimental?.('settingsTemplatesV1') !== true
    )
      throw new Error('请升级目标 KCoder 以使用会话配置模板')
    const startParams = {
      cwd: workspacePath,
      ...(workflowDefinitionId ? { workflowDefinitionId } : {}),
      ...(model ? { model } : {}),
      ...(sessionMode ? { sessionMode } : {}),
      ...(settingsTemplate ? { settingsTemplate } : {}),
    }
    if (options.creationRequestId && options.recoverClient && client.supportsExperimental?.('threadCreationReceiptsV1')) {
      const started = await startThreadWithReceipt(client, {
        ...startParams, clientRequestId: options.creationRequestId,
      }, options.recoverClient)
      options.onRecoveredClient?.(started.client)
      return started.result
    }
    return client.request('thread/start', startParams)
  }
  if (client.supportsExperimental?.('ephemeralThreads') !== true) {
    throw new Error('目标 KCoder 不支持临时会话分叉，请升级目标后重试')
  }
  const source = object(params.sideSource)
  if (sessionMode && sessionMode !== 'default') {
    throw new Error('临时聊天继承原会话模式，不能切换为 Orchestrate')
  }
  const handle = object(source.runtimeHandle)
  const threadId = source.threadId ?? handle.threadId ?? handle.sessionId ?? handle.session_id
  if (
    source.deviceId !== serverId ||
    typeof threadId !== 'string' ||
    !threadId.trim() ||
    (source.workspacePath &&
      (typeof source.workspacePath !== 'string' ||
        !sameWorkspacePath(source.workspacePath, workspacePath)))
  ) {
    throw new Error('临时聊天必须保留源会话的服务器和工作区，并提供有效源 thread')
  }
  const result = await client.request<{ thread?: { id?: string }; ephemeral?: boolean }>(
    'thread/fork',
    {
      threadId,
      cwd: workspacePath,
      ...(workflowDefinitionId ? { workflowDefinitionId } : {}),
      ephemeral: true,
    }
  )
  if (result.ephemeral !== true || !result.thread?.id || result.thread.id === threadId) {
    if (result.thread?.id && result.thread.id !== threadId) {
      await client.request('thread/dispose', { threadId: result.thread.id }).catch(() => undefined)
    }
    throw new Error('目标未创建独立临时会话，已拒绝继续发送')
  }
  return result
}
