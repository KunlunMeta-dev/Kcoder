import { isRuntimeDebugEnabled } from '@/lib/diagnosticPreferences'
import { studioWorkMode } from '@/features/workbench/studioWorkMode'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { hookTargetScope } from '../../gatewayHookConfiguration'
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
import { taskConnectionStatus } from '../../taskConnectionStatus'
import { redeliverUnsettledSteers } from './turnSteer'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'

interface SubagentSnapshotOwner {
  readonly taskId: string
  readonly serverId: string
  readonly threadId: string
  readonly workspacePath: string
  readonly accountCurrent: (targetId: string) => boolean
  readonly targetScope: string
}

export async function resumeTaskOnce(
  this: GatewayRuntimeCore,
  task: GatewayTask
): Promise<GatewayClient> {
  if (task.ephemeral) throw new Error('临时会话连接已结束，请重新打开临时聊天')
  const identity = {
    taskId: task.taskId,
    serverId: task.serverId,
    threadId: task.threadId,
    workspacePath: task.workspacePath,
  }
  const retirePreviousTurn = () => {
    const previous = this.activeTurnByTask.get(identity.taskId)
    if (!previous) return
    previous.complete()
    this.activeTurnByTask.delete(identity.taskId)
    this.turnText.delete(`${identity.taskId}:${previous.turnId}`)
    this.turnAttemptIds.delete(`${identity.taskId}:${previous.turnId}`)
  }
  const accountCurrent = captureAccountContextRevision()
  const server = (await this.servers()).find(item => item.id === identity.serverId)
  if (!server) throw new Error(`任务服务器已不存在：${identity.serverId}`)
  const targetScope = hookTargetScope(server)
  const client = await this.connectClient(server, 'runtime', identity.workspacePath)
  const assertResumeOwner = async () => {
    const currentTarget = await this.serverForParams({ deviceId: identity.serverId })
    const currentTask = this.tasks.get(identity.taskId)
    if (
      this.disposed ||
      !accountCurrent(identity.serverId) ||
      hookTargetScope(currentTarget) !== targetScope ||
      this.appServerDisconnectedClients.has(client) ||
      !this.connectionsByClient.has(client) ||
      this.isRestartingServer(identity.serverId) ||
      currentTask?.taskId !== identity.taskId ||
      currentTask.serverId !== identity.serverId ||
      currentTask.threadId !== identity.threadId ||
      !sameWorkspacePath(currentTask.workspacePath, identity.workspacePath)
    )
      throw new Error('KCoder task ownership changed during resume')
  }
  const preceding = this.notificationQueueByClient.get(client) ?? Promise.resolve()
  let releaseNotifications!: () => void
  const admission = new Promise<void>(resolve => {
    releaseNotifications = resolve
  })
  this.notificationQueueByClient.set(
    client,
    preceding.then(() => admission)
  )
  try {
    await assertResumeOwner()
    const result = await client.request<{
      thread?: Record<string, unknown>
      streamContext?: unknown
    }>('thread/resume', {
      threadId: identity.threadId,
    })
    if (text(result.thread?.id) !== identity.threadId) {
      throw new Error('KCoder app-server 恢复了错误的 thread')
    }
    if (this.disposed) throw new Error('KCoder 网关运行时已关闭')
    if (this.isRestartingServer(identity.serverId))
      throw new Error('KCoder app-server restart is in progress')
    await preceding
    await assertResumeOwner()
    const snapshot = record(result.thread)
    task.studioWorkMode = studioWorkMode(snapshot.studioWorkMode)
    task.runtimeHandle = { ...task.runtimeHandle, studioWorkMode: task.studioWorkMode }
    const modeTask = this.tasks.get(identity.taskId)
    if (modeTask) {
      modeTask.studioWorkMode = task.studioWorkMode
      modeTask.runtimeHandle = task.runtimeHandle
    }
    const summary = parseThreadRunSummary(snapshot.runSummary)
    const activity = threadRunActivity(snapshot.status, summary)
    const snapshotRunning = transcriptSnapshotRunning(snapshot, undefined)
    if (summary?.mainTurn === 'idle' || snapshotRunning === false) retirePreviousTurn()
    if (!this.activeTurnByTask.has(identity.taskId)) {
      task.runSummary = summary
      task.runActivity = activity
      task.running = snapshotRunning ?? task.running
      const current = this.tasks.get(identity.taskId)
      if (current && current !== task) {
        current.runSummary = summary
        current.runActivity = activity
        current.running = task.running
      }
    }
    applyThreadModelSelection(task, record(result.thread))
    const currentTask = this.tasks.get(identity.taskId)
    if (currentTask && currentTask !== task)
      applyThreadModelSelection(currentTask, record(result.thread))
    this.bindTaskClient(identity.taskId, client)
    const view = [...this.taskViewGenerations].find(([key]) => this.resolveTaskId(key) === identity.taskId)
    if (view && client.supportsExperimental?.('sessionLifetimeV1') === true) {
      await client.request('gateway/thread/attach', { threadId: identity.threadId, viewId: view[1].generation })
      await assertResumeOwner()
      if (this.taskViewGenerations.get(view[0]) !== view[1]) {
        await client.request('gateway/thread/detach', { threadId: identity.threadId, viewId: view[1].generation })
      }
    }

    this.threadByTask.set(identity.taskId, identity.threadId)
    this.taskByThread.set(this.threadKey(identity.serverId, identity.threadId), identity.taskId)
    if (
      client.supportsExperimental?.('threadStreamContextV1') === true &&
      this.toolPathPreviews.seedResume(
        result.streamContext,
        identity.serverId,
        identity.taskId,
        identity.threadId,
        client
      )
    ) {
      const active = record(record(result.streamContext).activeTurn)
      const turnId = text(active.id)
      if (turnId) {
        const attemptId = String(active.attemptId)
        if (this.activeTurnByTask.get(identity.taskId)?.turnId !== turnId) {
          retirePreviousTurn()
          this.trackActiveTurn(identity.taskId, turnId)
        }
        this.turnAttemptIds.set(`${identity.taskId}:${turnId}`, attemptId)
        await emit(EXECUTOR_EVENT, {
          event: 'response.created',
          payload: {
            taskId: identity.taskId,
            subtaskId: attemptId,
            turnId,
            attemptId,
            deviceId: identity.serverId,
            data: {},
          },
        })
      } else {
        retirePreviousTurn()
      }
    }
  } catch (error) {
    client.close()
    throw error
  } finally {
    releaseNotifications()
  }
  const snapshotTask = {
    ...task,
    ...identity,
    runtimeHandle: { ...task.runtimeHandle },
  }
  const snapshotOwner: SubagentSnapshotOwner = {
    ...identity,
    accountCurrent,
    targetScope,
  }
  const snapshot = new Promise<void>(resolve => window.setTimeout(resolve, 0))
    .then(() => this.emitSubagentSnapshot(snapshotTask, client, snapshotOwner))
    .catch(error => {
      console.warn('[KCoder] 无法恢复子代理快照', safeGatewayFailureDiagnostic(error))
    })
  this.trackAsyncJob(snapshot)
  if (this.clientByTask.get(identity.taskId) === client) {
    taskConnectionStatus.clear(this, identity.serverId, identity.taskId, true)
  }
  return client
}

export async function emitSubagentSnapshot(
  this: GatewayRuntimeCore,
  task: GatewayTask,
  client: GatewayClient,
  owner: SubagentSnapshotOwner
): Promise<void> {
  if (
    client.supportsExperimental?.('agentSteering') !== true ||
    task.taskId !== owner.taskId ||
    task.serverId !== owner.serverId ||
    task.threadId !== owner.threadId ||
    !sameWorkspacePath(task.workspacePath, owner.workspacePath)
  ) {
    return
  }
  const isLocallyOwned = () => {
    const currentTask = this.tasks.get(owner.taskId)
    return (
      !this.disposed &&
      owner.accountCurrent(owner.serverId) &&
      this.clientByTask.get(owner.taskId) === client &&
      this.connectionsByClient.get(client)?.serverId === owner.serverId &&
      !this.appServerDisconnectedClients.has(client) &&
      !this.isRestartingServer(owner.serverId) &&
      currentTask?.taskId === owner.taskId &&
      currentTask.serverId === owner.serverId &&
      currentTask.threadId === owner.threadId &&
      sameWorkspacePath(currentTask.workspacePath, owner.workspacePath)
    )
  }
  const isCurrentOwner = async () => {
    if (!isLocallyOwned()) return false
    const currentTarget = await this.serverForParams({ deviceId: owner.serverId })
    return isLocallyOwned() && hookTargetScope(currentTarget) === owner.targetScope
  }

  if (!(await isCurrentOwner())) return
  let result: { agents?: Array<Record<string, unknown>> }
  try {
    result = await client.request<{ agents?: Array<Record<string, unknown>> }>('agent/list', {
      threadId: owner.threadId,
    })
  } catch (error) {
    console.warn('[KCoder] 无法读取子代理快照', safeGatewayFailureDiagnostic(error))
    return
  }
  if (!(await isCurrentOwner())) return
  for (const rawAgent of Array.isArray(result.agents) ? result.agents : []) {
    if (!(await isCurrentOwner())) return
    const agent = record(rawAgent)
    const agentId = text(agent.agentId)
    const status = text(agent.status) ?? 'failed'
    const run = record(agent.backgroundRun)
    if (!this.notificationReplayGuard.canSeedBackgroundRun(run, status, owner.serverId)) continue
    const queueDepth = finiteNumber(agent.queueDepth)
    if (!agentId) {
      continue
    }
    const agentName = text(agent.agentName) ?? 'spawn_agent'
    const existingJob = this.backgroundJobById.get(agentId, owner.taskId, owner.serverId)
    // A reconnect snapshot adds steering state, not a new tool-call identity.
    // Keep the original message target so terminal events update its visible block.
    let job: GatewayBackgroundJob =
      existingJob?.taskId === owner.taskId
        ? existingJob
        : {
            taskId: owner.taskId,
            turnId:
              this.activeTurnByTask.get(owner.taskId)?.turnId ?? `${owner.threadId}:reconnect`,
            toolCallId: text(agent.parentToolCallId) ?? `recovered-${agentId}`,
            toolName: agentName,
            serverId: owner.serverId,
          }
    job = { ...job, runId: text(run.runId) ?? existingJob?.runId }
    this.backgroundJobById.set(agentId, job)
    const restorePreviousJobIfStale = () => {
      if (this.backgroundJobById.get(agentId, owner.taskId, owner.serverId) !== job) return
      if (existingJob) this.backgroundJobById.set(agentId, existingJob)
      else this.backgroundJobById.delete(agentId, job)
    }
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
    if (!(await isCurrentOwner())) {
      restorePreviousJobIfStale()
      return
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
        taskId: owner.taskId,
        subtaskId: turnId,
        deviceId: owner.serverId,
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
    if (!(await isCurrentOwner())) {
      restorePreviousJobIfStale()
      return
    }
    if (terminal) this.backgroundJobById.delete(agentId, job)
    this.notificationReplayGuard.seedBackgroundRun(run, status, owner.serverId)
  }
}

export function recoverTaskAfterDisconnect(
  this: GatewayRuntimeCore,
  task: GatewayTask,
  disconnectProjection: Promise<void>
): void {
  if (this.disposed || this.isRestartingServer(task.serverId)) return
  // Recovery belongs to the disconnected address, never a later task rebind.
  task = { ...task }
  const questionOwner = {
    taskId: task.taskId, serverId: task.serverId,
    threadId: task.threadId, workspacePath: task.workspacePath,
  }
  const previousRecovery = this.disconnectRecoveryByTask.get(task.taskId)
  const previousClient = this.clientByTask.get(task.taskId)
  const mayHaveMissedTurnEvents = this.activeTurnByTask.has(task.taskId)
  const isCurrent = () => {
    const current = this.tasks.get(task.taskId)
    return !this.disposed && !this.isRestartingServer(task.serverId) &&
      this.disconnectRecoveryByTask.get(task.taskId) === recovery &&
      current?.taskId === task.taskId && current.serverId === task.serverId &&
      current.threadId === task.threadId && sameWorkspacePath(current.workspacePath, task.workspacePath)
  }
  const recovery = Promise.resolve().then(async () => {
    await disconnectProjection
    if (previousRecovery) await previousRecovery.catch(() => undefined)
    if (!isCurrent()) return
    const delays = [0, 250, 750, 1_500]
    let lastError: unknown
    for (const delay of delays) {
      if (!isCurrent()) return
      if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay))
      if (!isCurrent()) return
      try {
        const client = await this.resumeTask(task)
        if (!isCurrent() || this.clientByTask.get(task.taskId) !== client) {
          return
        }
        if (mayHaveMissedTurnEvents) {
          await emit(EXECUTOR_EVENT, {
            event: 'executor.task_stream_gap',
            payload: { taskId: task.taskId, deviceId: task.serverId },
          }).catch(error =>
            console.warn('[KCoder] 无法刷新重连后的会话记录', safeGatewayFailureDiagnostic(error))
          )
          if (!isCurrent() || this.clientByTask.get(task.taskId) !== client) return
        }
        const currentTask = this.tasks.get(questionOwner.taskId)
        if (!this.disposed && !this.appServerDisconnectedClients.has(client) &&
            currentTask?.serverId === questionOwner.serverId &&
            currentTask.threadId === questionOwner.threadId &&
            sameWorkspacePath(currentTask.workspacePath, questionOwner.workspacePath)) {
          // Changes made while disconnected are not replayed by thread/resume.
          // Recheck capability even if the new connection no longer supports
          // questions; old cards must retire without replaying an answer.
          await emit(EXECUTOR_EVENT, { event: 'async-question:refresh', payload: questionOwner })
            .catch(error => console.warn('[KCoder] 无法刷新恢复任务的提问状态', safeGatewayFailureDiagnostic(error)))
        }
        if (!isCurrent() || this.clientByTask.get(task.taskId) !== client) return
        // Only an exited app-server process can no longer settle a steer; a
        // dropped transport to a live server still delivers the settlement.
        if (previousClient && this.appServerDisconnectedClients.has(previousClient)) {
          await redeliverUnsettledSteers(this, task.taskId, task.serverId).catch(error =>
            console.warn('[KCoder] 无法重新发送未生效的引导', safeGatewayFailureDiagnostic(error))
          )
        }
        return
      } catch (error) {
        lastError = error
      }
    }
    if (!isCurrent()) return
    console.warn(`[KCoder] 无法自动恢复任务连接 当前任务`, safeGatewayFailureDiagnostic(lastError))
    throw new Error(
      `自动恢复任务连接失败：${lastError instanceof Error ? lastError.message : String(lastError)}`
    )
  })
  this.disconnectRecoveryByTask.set(task.taskId, recovery)
  const finishConnectionStatus = taskConnectionStatus.start(this, task.serverId, task.taskId)
  this.trackAsyncJob(recovery)
  const settle = (failed: boolean) => {
    finishConnectionStatus(failed && isCurrent())
    if (this.disconnectRecoveryByTask.get(task.taskId) === recovery) {
      this.disconnectRecoveryByTask.delete(task.taskId)
    }
  }
  void recovery.then(() => settle(false), () => settle(true))
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

  if (isRuntimeDebugEnabled()) {
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

  const replacement = this.clientByTask.get(taskId)
  if (replacement && replacement !== client) return
  const active = this.activeTurnByTask.get(taskId)
  const task = this.tasks.get(taskId)
  if (!task) return
  // Closing a WebSocket says nothing about whether the app-server stopped its turn.
  const stopped = task.ephemeral || this.appServerDisconnectedClients.has(client)
  if (active && !stopped) this.turnText.set(`${taskId}:${active.turnId}`, null)
  if (stopped) this.tasks.set(taskId, { ...task, running: false, updatedAt: Date.now() })
  if (active && stopped) {
    active.complete()
    this.activeTurnByTask.delete(taskId)
    const turnKey = `${taskId}:${active.turnId}`
    const attemptId = this.turnAttemptIds.get(turnKey) ?? active.turnId
    this.turnText.delete(turnKey)
    this.turnAttemptIds.delete(turnKey)
    await emit(EXECUTOR_EVENT, {
      event: 'response.failed',
      payload: {
        taskId,
        subtaskId: attemptId,
        turnId: active.turnId,
        attemptId,
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
