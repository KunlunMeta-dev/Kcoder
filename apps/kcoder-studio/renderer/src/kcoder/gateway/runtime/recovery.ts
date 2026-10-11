import { computerUseStates } from '../../computerUseState'
import { safeGatewayFailureDiagnostic } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import { applyThreadModelSelection } from '../../modelSelectionMode'
import {
  parseThreadRunSummary,
  threadRunActivity,
  transcriptSnapshotRunning,
} from '../../threadRunSummary'
import {
  EXECUTOR_EVENT,
  finiteNumber,
  type GatewayBackgroundJob,
  type GatewayTask,
  MAX_INTERRUPTED_BACKGROUND_TOOL_TOMBSTONES,
  record,
  text,
} from './contracts'
import type { GatewayRuntimeCore } from './core'
import { createRandomUuid } from '@/lib/random-id'

export async function resumeTaskOnce(
  this: GatewayRuntimeCore,
  task: GatewayTask
): Promise<GatewayClient> {
  if (task.ephemeral) throw new Error('临时会话连接已结束，请重新打开临时聊天')
  const server = (await this.servers()).find(item => item.id === task.serverId)
  if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
  const client = await this.connectClient(server, 'runtime', task.workspacePath)
  try {
    const result = await client.request<{ thread?: Record<string, unknown> }>('thread/resume', {
      threadId: task.threadId,
    })
    if (text(result.thread?.id) !== task.threadId) {
      throw new Error('KCoder app-server 恢复了错误的 thread')
    }
    if (this.disposed) throw new Error('KCoder 网关运行时已关闭')
    if (this.isRestartingServer(task.serverId))
      throw new Error('KCoder app-server restart is in progress')
    const snapshot = record(result.thread)
    const summary = parseThreadRunSummary(snapshot.runSummary)
    const activity = threadRunActivity(snapshot.status, summary)
    if (!this.activeTurnByTask.has(task.taskId)) {
      task.runSummary = summary
      task.runActivity = activity
      task.running = transcriptSnapshotRunning(snapshot, task.running) ?? task.running
      const current = this.tasks.get(task.taskId)
      if (current && current !== task) {
        current.runSummary = summary
        current.runActivity = activity
        current.running = task.running
      }
    }
    applyThreadModelSelection(task, record(result.thread))
    const currentTask = this.tasks.get(task.taskId)
    if (currentTask && currentTask !== task)
      applyThreadModelSelection(currentTask, record(result.thread))
  } catch (error) {
    client.close()
    throw error
  }
  this.bindTaskClient(task.taskId, client)
  this.threadByTask.set(task.taskId, task.threadId)
  this.taskByThread.set(this.threadKey(task.serverId, task.threadId), task.taskId)
  await this.emitSubagentSnapshot(task, client)
  return client
}

export async function emitSubagentSnapshot(
  this: GatewayRuntimeCore,
  task: GatewayTask,
  client: GatewayClient
): Promise<void> {
  if (client.supportsExperimental?.('agentSteering') !== true) return
  const result = await client
    .request<{ agents?: Array<Record<string, unknown>> }>('agent/list', {
      threadId: task.threadId,
    })
    .catch(() => ({ agents: [] }))
  for (const rawAgent of Array.isArray(result.agents) ? result.agents : []) {
    const agent = record(rawAgent)
    const agentId = text(agent.agentId)
    const status = text(agent.status) ?? 'failed'
    const run = record(agent.backgroundRun)
    if (!this.notificationReplayGuard.canSeedBackgroundRun(run, status, task.serverId)) continue
    const queueDepth = finiteNumber(agent.queueDepth)
    if (!agentId) {
      continue
    }
    const agentName = text(agent.agentName) ?? 'spawn_agent'
    const existingJob = this.backgroundJobById.get(agentId, task.taskId, task.serverId)
    // A reconnect snapshot adds steering state, not a new tool-call identity.
    // Keep the original message target so terminal events update its visible block.
    let job: GatewayBackgroundJob =
      existingJob?.taskId === task.taskId
        ? existingJob
        : {
            taskId: task.taskId,
            turnId: this.activeTurnByTask.get(task.taskId)?.turnId ?? `${task.threadId}:reconnect`,
            toolCallId: text(agent.parentToolCallId) ?? `recovered-${agentId}`,
            toolName: agentName,
            serverId: task.serverId,
          }
    job = { ...job, runId: text(run.runId) ?? existingJob?.runId }
    this.backgroundJobById.set(agentId, job)
    const terminal = ['completed', 'failed', 'cancelled', 'halted'].includes(status)
    if (terminal && (existingJob || text(agent.parentToolCallId))) {
      await this.emitBackgroundToolLifecycle(
        agentId,
        job,
        status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted'
      )
    } else if (status === 'paused') {
      await this.emitBackgroundToolLifecycle(agentId, job, 'paused')
    }
    const turnId = job.turnId
    const headStatus = text(agent.headStatus)
    const steerStatus =
      queueDepth === 0
        ? undefined
        : headStatus === 'blocked'
          ? 'queued_behind_blocked'
          : status === 'paused'
            ? 'queued_paused'
            : ['failed', 'completed', 'cancelled', 'halted'].includes(status)
              ? 'resuming'
              : 'queued_live'
    await emit(EXECUTOR_EVENT, {
      event: 'response.subagent.activity',
      payload: {
        taskId: task.taskId,
        subtaskId: turnId,
        deviceId: task.serverId,
        data: {
          agent_path: agentId,
          agent_id: agentId,
          agent_name: agentName,
          kind: 'background',
          status: status === 'cancelled' ? 'interrupted' : status,
          steer_status: steerStatus,
          retained_runs: finiteNumber(agent.retainedRuns),
          retained_run_limit: finiteNumber(agent.retainedRunLimit),
          capacity_warning: agent.capacityWarning === true,
          message_id: text(agent.headMessageId),
          occurred_at_ms: Date.now(),
        },
      },
    })
    if (terminal) this.backgroundJobById.delete(agentId, job)
    this.notificationReplayGuard.seedBackgroundRun(run, status, task.serverId)
  }
}

export function recoverTaskAfterDisconnect(
  this: GatewayRuntimeCore,
  task: GatewayTask,
  disconnectProjection: Promise<void>
): void {
  if (this.disposed || this.isRestartingServer(task.serverId)) return
  const previousRecovery = this.disconnectRecoveryByTask.get(task.taskId)
  const reconnectBlockId = `runtime-reconnecting-${task.threadId}-${createRandomUuid()}`
  const reconnectSubtaskId = reconnectBlockId
  const recovery = Promise.resolve().then(async () => {
    await disconnectProjection
    if (previousRecovery) await previousRecovery.catch(() => undefined)
    if (
      this.disposed ||
      this.isRestartingServer(task.serverId) ||
      !this.tasks.has(task.taskId) ||
      this.disconnectRecoveryByTask.get(task.taskId) !== recovery
    ) {
      return
    }
    await emit(EXECUTOR_EVENT, {
      event: 'response.block.created',
      payload: {
        taskId: task.taskId,
        subtaskId: reconnectSubtaskId,
        deviceId: task.serverId,
        data: {
          block: {
            id: reconnectBlockId,
            type: 'tool',
            tool_name: 'runtime_reconnecting',
            toolName: 'runtime_reconnecting',
            status: 'pending',
            timestamp: Date.now(),
          },
        },
      },
    }).catch(error =>
      console.warn('[KCoder] 无法报告任务重连状态', safeGatewayFailureDiagnostic(error))
    )
    const delays = [0, 250, 750, 1_500]
    let lastError: unknown
    for (const delay of delays) {
      if (
        this.disposed ||
        this.isRestartingServer(task.serverId) ||
        !this.tasks.has(task.taskId) ||
        this.disconnectRecoveryByTask.get(task.taskId) !== recovery
      ) {
        return
      }
      if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay))
      if (this.isRestartingServer(task.serverId)) return
      try {
        const client = await this.resumeTask(task)
        if (
          this.clientByTask.get(task.taskId) !== client ||
          this.disconnectRecoveryByTask.get(task.taskId) !== recovery
        ) {
          return
        }
        await emit(EXECUTOR_EVENT, {
          event: 'response.block.updated',
          payload: {
            taskId: task.taskId,
            subtaskId: reconnectSubtaskId,
            deviceId: task.serverId,
            data: { blockId: reconnectBlockId, updates: { status: 'done' } },
          },
        }).catch(error =>
          console.warn('[KCoder] 无法报告任务重连成功', safeGatewayFailureDiagnostic(error))
        )
        return
      } catch (error) {
        lastError = error
      }
    }
    console.warn(`[KCoder] 无法自动恢复任务连接 当前任务`, safeGatewayFailureDiagnostic(lastError))
    await emit(EXECUTOR_EVENT, {
      event: 'response.block.updated',
      payload: {
        taskId: task.taskId,
        subtaskId: reconnectSubtaskId,
        deviceId: task.serverId,
        data: {
          blockId: reconnectBlockId,
          updates: {
            status: 'error',
            tool_output: '自动重连失败，请手动重新打开任务。',
            toolOutput: '自动重连失败，请手动重新打开任务。',
          },
        },
      },
    }).catch(error =>
      console.warn('[KCoder] 无法报告任务重连失败', safeGatewayFailureDiagnostic(error))
    )
    throw new Error(
      `自动恢复任务连接失败：${lastError instanceof Error ? lastError.message : String(lastError)}`
    )
  })
  this.disconnectRecoveryByTask.set(task.taskId, recovery)
  this.trackAsyncJob(recovery)
  const clearRecovery = () => {
    if (this.disconnectRecoveryByTask.get(task.taskId) === recovery) {
      this.disconnectRecoveryByTask.delete(task.taskId)
    }
  }
  void recovery.then(clearRecovery, clearRecovery)
}

export function bindTaskClient(this: GatewayRuntimeCore, taskId: string, client: GatewayClient) {
  const previousClient = this.clientByTask.get(taskId)
  this.clientByTask.set(taskId, client)
  if (previousClient && previousClient !== client) previousClient.close()
  client.addEventListener(
    'close',
    () => {
      if (this.clientByTask.get(taskId) !== client) return
      this.clientByTask.delete(taskId)
      const task = this.tasks.get(taskId)
      if (!task || this.disposed || this.isRestartingServer(task.serverId)) return
      const disconnectProjection = this.projectTaskClientDisconnect(taskId, client)
      if (task.ephemeral) {
        void disconnectProjection.finally(() => {
          this.tasks.delete(taskId)
          this.threadByTask.delete(taskId)
          this.taskByThread.delete(this.threadKey(task.serverId, task.threadId))
        })
        return
      }
      this.recoverTaskAfterDisconnect(task, disconnectProjection)
    },
    { once: true }
  )
}

export async function projectTaskClientDisconnect(
  this: GatewayRuntimeCore,
  taskId: string,
  client: GatewayClient
) {
  // WebSocket close guarantees only that earlier messages entered listeners, not that
  // asynchronous UI projection finished. Drain the queue before closing background
  // agents from final association state so an associated event cannot restore running after cleanup.
  await this.notificationQueueByClient.get(client)?.catch(error => {
    console.warn('[KCoder] 断线前通知投影失败', safeGatewayFailureDiagnostic(error))
  })
  if (this.disposed) return

  const desktopTask = this.tasks.get(taskId)
  // bindTaskClient removes the closed client before invoking this projection.
  // Do not let an older disconnect overwrite a newly rebound connection.
  const currentDesktopClient = this.clientByTask.get(taskId)
  if (desktopTask && (!currentDesktopClient || currentDesktopClient === client)) {
    computerUseStates.unconfirmed(this, desktopTask.serverId, taskId)
  }

  if (globalThis.localStorage?.getItem('wework:debug-runtime') === '1') {
    console.debug('[KCoder] Background disconnect projection', {
      taskId,
      jobs: [...this.backgroundJobById.entries()]
        .filter(([, job]) => job.taskId === taskId)
        .map(([jobId, job]) => ({
          jobId,
          turnId: job.turnId,
          toolCallId: job.toolCallId,
        })),
    })
  }

  for (const [key, pending] of this.pendingQuestionByKey) {
    if (pending.taskId !== taskId || pending.client !== client) continue
    this.pendingQuestionByKey.delete(key)
    if (pending.autoResolutionTimer !== undefined) {
      window.clearTimeout(pending.autoResolutionTimer)
    }
    await emit(EXECUTOR_EVENT, {
      event: 'response.block.updated',
      payload: {
        taskId,
        subtaskId: pending.turnId,
        deviceId: this.tasks.get(taskId)?.serverId,
        data: {
          blockId: pending.block.id,
          updates: { status: 'error' },
        },
      },
    }).catch(error =>
      console.warn('[KCoder] 无法关闭已断线的交互请求', safeGatewayFailureDiagnostic(error))
    )
  }

  if (this.appServerDisconnectedClients.has(client)) {
    for (const [jobId, job] of this.backgroundJobById) {
      if (job.taskId !== taskId) continue
      this.backgroundJobById.delete(jobId, job)
      this.toolNameByCall.delete(`${job.taskId}\0${job.toolCallId}`)
      const output = {
        agent_id: jobId,
        status: 'interrupted',
        output: 'app-server 已退出，后台子 Agent 已中止。',
      }
      this.rememberInterruptedBackgroundTool(jobId, job, output)
      const jobBase = {
        taskId: job.taskId,
        subtaskId: job.turnId,
        deviceId: job.serverId,
      }
      await emit(EXECUTOR_EVENT, {
        event: 'response.output_item.done',
        payload: {
          ...jobBase,
          data: {
            item: {
              type: 'function_call',
              call_id: job.toolCallId,
              name: job.toolName,
              status: 'failed',
              output,
            },
          },
        },
      }).catch(error =>
        console.warn(
          '[KCoder] 无法结束已退出 app-server 的后台子 Agent 工具块',
          safeGatewayFailureDiagnostic(error)
        )
      )
      await emit(EXECUTOR_EVENT, {
        event: 'response.subagent.activity',
        payload: {
          ...jobBase,
          data: {
            agent_path: jobId,
            agent_name: job.toolName,
            kind: 'background',
            status: 'interrupted',
          },
        },
      }).catch(error =>
        console.warn(
          '[KCoder] 无法结束已退出 app-server 的后台子 Agent 状态',
          safeGatewayFailureDiagnostic(error)
        )
      )
    }
  }

  const active = this.activeTurnByTask.get(taskId)
  const preserveInternalTurn =
    active?.internal === true && !this.appServerDisconnectedClients.has(client)
  if (active && !preserveInternalTurn) {
    active.complete()
    this.activeTurnByTask.delete(taskId)
  }
  const task = this.tasks.get(taskId)
  if (!task) return
  this.tasks.set(taskId, { ...task, running: preserveInternalTurn, updatedAt: Date.now() })
  if (active && !preserveInternalTurn) {
    this.turnText.delete(`${taskId}:${active.turnId}`)
    this.turnAttemptIds.delete(`${taskId}:${active.turnId}`)
    await emit(EXECUTOR_EVENT, {
      event: 'response.failed',
      payload: {
        taskId,
        subtaskId: active.turnId,
        deviceId: task.serverId,
        data: { message: 'KCoder app-server 连接已断开，已停止当前任务' },
      },
    }).catch(error => {
      console.warn('[KCoder] 无法报告任务连接中断', safeGatewayFailureDiagnostic(error))
    })
  }
}

export function rememberInterruptedBackgroundTool(
  this: GatewayRuntimeCore,
  jobId: string,
  job: GatewayBackgroundJob,
  output: Record<string, unknown>
) {
  const key = `${job.taskId}\0${job.toolCallId}`
  this.interruptedBackgroundToolByKey.delete(key)
  this.interruptedBackgroundToolByKey.set(key, {
    taskId: job.taskId,
    toolCallId: job.toolCallId,
    agentId: jobId,
    output,
  })
  while (this.interruptedBackgroundToolByKey.size > MAX_INTERRUPTED_BACKGROUND_TOOL_TOMBSTONES) {
    const oldest = this.interruptedBackgroundToolByKey.keys().next().value
    if (typeof oldest !== 'string') break
    this.interruptedBackgroundToolByKey.delete(oldest)
  }
}

export async function emitBackgroundToolLifecycle(
  this: GatewayRuntimeCore,
  jobId: string,
  job: GatewayBackgroundJob,
  status: 'running' | 'paused' | 'completed' | 'failed' | 'interrupted',
  outputText = ''
) {
  await emit(EXECUTOR_EVENT, {
    event: 'response.output_item.done',
    payload: {
      taskId: job.taskId,
      subtaskId: job.turnId,
      deviceId: job.serverId,
      data: {
        item: {
          type: 'function_call',
          call_id: job.toolCallId,
          name: job.toolName,
          status: status === 'failed' || status === 'interrupted' ? 'failed' : 'completed',
          output: {
            agent_id: jobId,
            status,
            ...(outputText ? { output: outputText } : {}),
          },
        },
      },
    },
  })
}
