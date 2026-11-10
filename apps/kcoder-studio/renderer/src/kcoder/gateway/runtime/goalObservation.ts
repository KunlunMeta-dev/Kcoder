import { RuntimeGoalScopeRetiredError } from '../../goalObservationCancellation'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import type { GatewayRuntimeCore } from './core'
import { isRetryableReadonlyTaskConnectionError, record, text } from './contracts'

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError')) }
    const timer = window.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Existing cold/resident native Goal reads only; never acquires a task execution runtime. */
export async function getTaskGoalObservation(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) {
  options?.signal?.throwIfAborted()
  const account = captureAccountContextRevision()
  const address = { ...record(params.address) }
  const input = { ...params, address }
  const requestedTaskId = text(params.taskId) ?? text(address.taskId)
  if (requestedTaskId && !this.compatibility.isRuntimeTaskId(requestedTaskId) && !this.canonicalTaskByRequested.has(requestedTaskId))
    return { accepted: false, taskId: requestedTaskId, goal: null }
  let targetScope: string | undefined
  let resolvedTargetId: string | undefined
  const requestedTargetId = text(address.deviceId) ?? text(params.deviceId) ?? undefined
  const check = (serverId = resolvedTargetId) => {
    options?.signal?.throwIfAborted()
    if (this.disposed || (serverId !== undefined && !account(serverId)) || (requestedTargetId !== undefined && !account(requestedTargetId)))
      throw new RuntimeGoalScopeRetiredError()
  }
  const retryDelays = [0, 75, 150, 300, 600]
  let lastError: unknown
  for (const milliseconds of retryDelays) {
    check()
    if (milliseconds) await delay(milliseconds, options?.signal)
    check()
    try {
      const { taskId, task, server } = await this.taskDescriptor(input)
      resolvedTargetId = server.id
      check(server.id)
      const before = hookTargetScope(server)
      const current = hookTargetScope(await this.serverForParams({ deviceId: server.id }))
      check(server.id)
      if (before !== current) throw new RuntimeGoalScopeRetiredError()
      if (targetScope !== undefined && targetScope !== before)
        throw new RuntimeGoalScopeRetiredError()
      targetScope = before
      const result = await this.withTransientClient(server, client => {
        check(server.id)
        const query = { threadId: task.threadId }
        return options?.signal
          ? client.request<{ goal?: Record<string, unknown> | null }>('thread/goal/get', query, options)
          : client.request<{ goal?: Record<string, unknown> | null }>('thread/goal/get', query)
      }, task.workspacePath)
      check(server.id)
      const after = hookTargetScope(await this.serverForParams({ deviceId: server.id }))
      check(server.id)
      if (after !== targetScope) throw new RuntimeGoalScopeRetiredError()
      return { accepted: true, taskId, goal: result.goal ?? null }
    } catch (error) {
      check()
      if (!isRetryableReadonlyTaskConnectionError(error)) throw error
      lastError = error
    }
  }
  throw lastError
}
