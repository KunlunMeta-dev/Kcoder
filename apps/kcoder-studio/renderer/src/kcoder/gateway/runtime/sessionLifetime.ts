import { createRandomUuid } from '@/lib/random-id'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { record, text } from './contracts'
import { releaseHistoryOnlyTask } from './historyOnlyTask'
import { requestResidentTaskRpc } from './threadResidency'

export interface TaskViewGeneration {
  views: Set<string>
  generation: string
  registration?: {
    client: GatewayClient
    connectionId?: string
    result: Promise<boolean>
    release: () => Promise<unknown>
  }
}

/** Fold pending index views into the same original task before releasing any handle. */
function taskViews(runtime: GatewayRuntimeCore, requested: string) {
  const views = runtime.taskViewGenerations
  const taskId = runtime.resolveTaskId(requested)
  const key = taskId ?? requested
  let current = views.get(key)
  if (taskId) {
    for (const [candidate, pending] of views) {
      if (candidate === key || runtime.resolveTaskId(candidate) !== taskId) continue
      if (current) {
        for (const view of pending.views) current.views.add(view)
      } else {
        current = pending
        views.set(key, current)
      }
      views.delete(candidate)
    }
  }
  return { key, current }
}

/** Share the registration receipt only within its original connection and view generation. */
export async function attachTaskViews(
  runtime: GatewayRuntimeCore,
  { taskId, threadId }: { taskId: string; threadId: string },
  client: GatewayClient
): Promise<boolean> {
  const { current: view } = taskViews(runtime, taskId)
  if (!view) return false
  const connectionId = client.diagnosticConnection?.connectionId
  const current = () => taskViews(runtime, taskId).current === view &&
    runtime.clientByTask.get(taskId) === client && !runtime.disposed &&
    !runtime.appServerDisconnectedClients?.has(client) &&
    client.diagnosticConnection?.connectionId === connectionId
  if (!current()) return false
  if (client.supportsExperimental?.('sessionLifetimeV1') !== true) return true
  if (view.registration?.client === client && view.registration.connectionId === connectionId)
    return view.registration.result
  const request = (action: 'attach' | 'detach') => {
    const method = `gateway/thread/${action}`, params = { threadId, viewId: view.generation }
    return connectionId && client.requestOnConnection
      ? client.requestOnConnection(connectionId, method, params)
      : client.request(method, params)
  }
  let released: Promise<unknown> | undefined
  const release = () => released ??= request('detach')
  const result = request('attach').then(async () => {
    if (current()) return true
    await release()
    releaseUnviewedTaskClient(runtime, taskId, client)
    return false
  })
  view.registration = { client, connectionId, result, release }
  try { return await result }
  catch (error) {
    if (view.registration?.result === result) delete view.registration
    throw error
  }
}

/** A running task keeps its event connection until its authoritative terminal event. */
export function releaseUnviewedTaskClient(
  runtime: GatewayRuntimeCore,
  taskId: string,
  expectedClient?: GatewayClient
): boolean {
  if (!runtime.taskViewGenerations || !runtime.clientByTask) return false
  const task = runtime.tasks?.get(taskId)
  const client = runtime.clientByTask.get(taskId)
  if (!client || (expectedClient && client !== expectedClient) || taskViews(runtime, taskId).current)
    return false
  if (!task?.ephemeral && (
    task?.running === true || task?.goalStatus === 'active' ||
    runtime.activeTurnByTask?.has(taskId) || runtime.pendingTurnStartByTask?.has(taskId) ||
    (runtime.pendingTaskInputs?.get(taskId)?.size ?? 0) > 0 ||
    [...(runtime.backgroundJobById?.values() ?? [])].some(job => job.taskId === taskId)
  )) return false
  runtime.clientByTask.delete(taskId)
  client.close()
  return true
}

export async function sessionLifetime(
  runtime: GatewayRuntimeCore,
  method: string,
  params: Record<string, unknown>
) {
  const { task, client } = await runtime.taskConnection(params)
  if (client.supportsExperimental?.('sessionLifetimeV1') !== true)
    throw new Error('SESSION_LIFETIME_NOT_SUPPORTED')
  return requestResidentTaskRpc(runtime, task, client, method.endsWith('.set') ? 'thread/lifetime/set' : 'thread/lifetime/read', {
    ...(method.endsWith('.set') ? { mode: params.mode, expectedRevision: params.expectedRevision } : {}),
  })
}

export async function taskView(
  runtime: GatewayRuntimeCore,
  method: string,
  params: Record<string, unknown>
) {
  const address = record(params.address)
  const requested = text(params.taskId) ?? text(address.taskId)
  const viewId = text(params.viewId)
  if (!requested || !viewId) throw new Error('TASK_VIEW_ID_REQUIRED')
  const views = runtime.taskViewGenerations
  const { key } = taskViews(runtime, requested)
  if (method.endsWith('.release')) {
    const original = views.get(key)
    if (!original?.views.delete(viewId)) return { released: false }
    if (original.views.size) return { released: true, detached: false }
    views.delete(key)
    const taskId = runtime.resolveTaskId(key)
    if (taskId) releaseHistoryOnlyTask(runtime, taskId)
    const task = taskId ? runtime.tasks.get(taskId) : undefined
    const client = taskId ? runtime.clientByTask.get(taskId) : undefined
    if (task) await original.registration?.release()
    // The conversation connection owns UI resources. Keep the task and its
    // settled receipts in the app-server, not in the departing view.
    if (taskId && client) releaseUnviewedTaskClient(runtime, taskId, client)
    return { released: true }
  }
  let original = views.get(key)
  if (!original) {
    original = { views: new Set(), generation: createRandomUuid() }
    views.set(key, original)
  }
  original.views.add(viewId)
  if (params.reserveOnly === true) return { attached: false }
  const { task, client } = await runtime.taskConnection(params)
  const { current: attachment } = taskViews(runtime, task.taskId)
  if (!attachment || !attachment.views.has(viewId)) {
    if (!attachment) releaseUnviewedTaskClient(runtime, task.taskId, client)
    return { attached: false }
  }
  return { attached: await attachTaskViews(runtime, task, client) }
}
