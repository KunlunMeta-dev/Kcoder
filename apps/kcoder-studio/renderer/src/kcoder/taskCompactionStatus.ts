import { isContract } from '../../../shared/generated/validator.mjs'
import type { ThreadMaintenanceCancelResult, ThreadMaintenanceParams } from '../../../shared/generated/contracts'
import type { RuntimeTaskAddress } from '@/types/api'
import { captureAccountContextRevision } from './accountContextEvents'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type { GatewayClient } from './gatewayRuntimeTypes'

export interface ActiveTaskCompaction {
  readonly id: string
  readonly threadId: string
  requestCancellation(): Promise<boolean>
}

interface Entry {
  client: GatewayClient
  work: ActiveTaskCompaction
  clear(): void
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const key = (serverId: string, taskId: string) => JSON.stringify([serverId, taskId])

function notify() {
  for (const listener of listeners) listener()
}

export const taskCompactionStatus = {
  read(address: RuntimeTaskAddress): ActiveTaskCompaction | null {
    const work = entries.get(key(address.deviceId, address.taskId))?.work
    return work && (!address.threadId || work.threadId === address.threadId) ? work : null
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

/** Keep the cancellation handle tied to the socket, account and exact admitted job. */
export function observeTaskCompaction(
  runtime: GatewayRuntimeCore,
  params: Record<string, unknown>,
  serverId?: string,
  client?: GatewayClient,
): void {
  if (!serverId || !client?.supportsExperimental?.('threadMaintenanceCancelV1') ||
      !isContract('ThreadMaintenanceParams', params)) return
  const { threadId, operation, status, maintenanceId } = params as unknown as ThreadMaintenanceParams
  if (operation !== 'compact' || !maintenanceId) return
  const taskId = runtime.taskByThread.get(runtime.threadKey(serverId, threadId))
  const task = taskId ? runtime.tasks.get(taskId) : undefined
  if (!task || task.threadId !== threadId || task.serverId !== serverId ||
      runtime.clientByTask.get(task.taskId) !== client) return

  const id = key(serverId, task.taskId)
  const previous = entries.get(id)
  if (status !== 'started') {
    if (previous?.client === client && previous.work.id === maintenanceId) previous.clear()
    return
  }
  if (previous?.client === client && previous.work.id === maintenanceId) return
  previous?.clear()
  const accountCurrent = captureAccountContextRevision()
  const connectionId = client.diagnosticConnection?.connectionId
  const current = () => {
    const bound = runtime.tasks.get(task.taskId)
    return !runtime.disposed && entries.get(id) === entry && accountCurrent(serverId) &&
      runtime.clientByTask.get(task.taskId) === client && client.diagnosticConnection?.connectionId === connectionId &&
      bound?.threadId === threadId && bound.serverId === serverId && bound.workspacePath === task.workspacePath
  }
  const clear = () => {
    client.removeEventListener('close', clear)
    if (entries.get(id) !== entry) return
    entries.delete(id)
    notify()
  }
  const entry: Entry = {
    client,
    clear,
    work: {
      id: maintenanceId,
      threadId,
      async requestCancellation() {
        if (!current()) {
          clear()
          return false
        }
        const fields = { threadId, maintenanceId }
        const method = 'thread/maintenance/cancel'
        const result = connectionId && client.requestOnConnection
          ? await client.requestOnConnection<ThreadMaintenanceCancelResult>(connectionId, method, fields)
          : await client.request<ThreadMaintenanceCancelResult>(method, fields)
        if (!isContract('ThreadMaintenanceCancelResult', result))
          throw new Error('Invalid compaction cancellation response')
        if (!current()) return false
        if (!result.cancellationRequested) clear()
        return result.cancellationRequested
      },
    },
  }
  entries.set(id, entry)
  client.addEventListener('close', clear, { once: true })
  notify()
}
