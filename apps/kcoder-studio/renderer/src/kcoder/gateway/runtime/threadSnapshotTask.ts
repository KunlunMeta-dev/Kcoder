import { isContract } from '../../../../../shared/generated/validator.mjs'
import { studioWorkMode } from '@/features/workbench/studioWorkMode'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { applyThreadModelSelection, threadModelSelectionMode } from '../../modelSelectionMode'
import { parseThreadRunSummary, threadRunActivity } from '../../threadRunSummary'
import type { GatewayServer } from '../../gatewayRpc'
import {
  authoritativeThreadMetadata,
  metadataTimestamp,
  taskParent,
  text,
  type GatewayTask,
} from './contracts'
import type { GatewayRuntimeCore } from './core'

/** One projection for indexed history and a verified creation receipt. */
export function projectPersistedThread(
  runtime: GatewayRuntimeCore,
  workspace: {
    server: GatewayServer
    workspacePath: string
    projectKey?: string
    projectName?: string
  },
  thread: Record<string, unknown>,
  taskId: string,
  existing?: GatewayTask,
  goalStatusObservation?: GatewayTask['goalStatusObservation']
): { task: GatewayTask; archived: boolean } {
  const { server, workspacePath } = workspace
  const threadId = text(thread.id)!
  const now = Date.now()
  const updatedAt = Number(thread.updatedAt ?? thread.updated_at)
  const createdAt = Number(thread.createdAt ?? thread.created_at)
  const localMetadata = runtime.taskMetadata.get(runtime.threadKey(server.id, threadId))
  const runSummary = parseThreadRunSummary(thread.runSummary)
  const serverMetadata = authoritativeThreadMetadata(thread.metadata)
  const model = serverMetadata
    ? (serverMetadata.model ?? undefined)
    : (text(thread.model) ?? localMetadata?.model)
  const archivedAt = serverMetadata
    ? metadataTimestamp(serverMetadata.archivedAt)
    : (metadataTimestamp(thread.archivedAt) ?? localMetadata?.archivedAt)
  const parent = serverMetadata
    ? (serverMetadata.parent ?? undefined)
    : (taskParent(thread.parent) ?? localMetadata?.parent)
  const task: GatewayTask = {
    scheduled: existing?.scheduled,
    serverId: server.id,
    taskId,
    threadId,
    workspacePath: sameWorkspacePath(text(thread.cwd), workspacePath)
      ? workspacePath
      : (text(thread.cwd) ?? workspacePath),
    projectKey: workspace.projectKey,
    projectName: workspace.projectName,
    title:
      (serverMetadata
        ? (serverMetadata.title ?? undefined)
        : (text(thread.title) ?? localMetadata?.title)) ?? `KCoder 会话 ${threadId.slice(0, 8)}`,
    runtime: 'kcoder',
    ...(model ? { model } : {}),
    modelSelectionMode: threadModelSelectionMode(thread),
    ...(parent ? { parent } : {}),
    persisted: true,
    // The coarse status cannot express a pending approval, background
    // work or pending delivery; the shared derivation keeps every
    // surface on the same authoritative facts.
    running: runSummary && runSummary.mainTurn !== 'unknown'
      ? runSummary.mainTurn === 'running'
      : runtime.compatibility.hydratedRunning(
          thread.status,
          existing ? runtime.activeTurnByTask.has(existing.taskId) : false
        ),
    turnStatus: runSummary?.latestTurnStatus ?? existing?.turnStatus,
    completedAt: existing?.completedAt,
    runSummary,
    ...(goalStatusObservation ? { goalStatusObservation } : {}),
    ...(goalStatusObservation?.availability === 'available'
      ? { goalStatus: goalStatusObservation.status }
      : {}),
    runActivity: threadRunActivity(thread.status, runSummary),
    createdAt: localMetadata?.createdAt ?? (Number.isFinite(createdAt) ? createdAt : now),
    updatedAt:
      (serverMetadata ? undefined : localMetadata?.updatedAt) ??
      (Number.isFinite(updatedAt) ? updatedAt : now),
    ...(isContract('ChannelTaskSource', thread.channelTaskSource)
      ? {
          channelTaskSource:
            thread.channelTaskSource as import('../../../../../shared/generated/contracts').ChannelTaskSource,
        }
      : {}),
    ...(isContract('AgentTaskBinding', thread.agentDefinition)
      ? {
          agentDefinition:
            thread.agentDefinition as import('../../../../../shared/generated/contracts').AgentTaskBinding,
        }
      : {}),
    studioWorkMode: studioWorkMode(thread.studioWorkMode),
    runtimeHandle: {
      threadId,
      ...(isContract('ChannelTaskSource', thread.channelTaskSource)
        ? {
            channelTaskSource:
              thread.channelTaskSource as import('../../../../../shared/generated/contracts').ChannelTaskSource,
          }
        : {}),
      ...(isContract('AgentTaskBinding', thread.agentDefinition)
        ? {
            agentDefinition:
              thread.agentDefinition as import('../../../../../shared/generated/contracts').AgentTaskBinding,
          }
        : {}),
      studioWorkMode: studioWorkMode(thread.studioWorkMode),
      ...(existing?.threadId === threadId && existing.runtimeHandle.memoryTaskSnapshot
        ? { memoryTaskSnapshot: existing.runtimeHandle.memoryTaskSnapshot }
        : {}),
    },
  }
  applyThreadModelSelection(task, thread)
  return { task, archived: Boolean(archivedAt) }
}
