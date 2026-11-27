import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { GatewayRpcError } from '../../gatewayRpc'
import type { GatewayRuntimeCore } from './core'
import type { GatewayTask } from './contracts'

interface OriginalHistoryOwner {
  serverId: string
  threadId: string
  workspacePath: string
  accountCurrent: (targetId: string) => boolean
}

// This records only a refusal to own execution, never a read authorization.
// Every snapshot still goes through the current target's ordinary thread/read.
const owners = new WeakMap<GatewayRuntimeCore, Map<string, OriginalHistoryOwner>>()

export class NativeHistoryOnlyError extends Error {
  constructor() { super('NATIVE_SESSION_OWNED_ELSEWHERE'); this.name = 'NativeHistoryOnlyError' }
}

/** Call only on the error from the actual thread/resume request. */
export function isNativeSessionOwnerConflict(error: unknown): boolean {
  return error instanceof GatewayRpcError && error.code === -32022 &&
    error.message.startsWith('session is already active in another app-server: ')
}

export function rememberHistoryOnlyTask(
  runtime: GatewayRuntimeCore,
  task: GatewayTask,
  accountCurrent: (targetId: string) => boolean
) {
  let tasks = owners.get(runtime)
  if (!tasks) owners.set(runtime, tasks = new Map())
  tasks.set(task.taskId, { serverId: task.serverId, threadId: task.threadId,
    workspacePath: task.workspacePath, accountCurrent })
}

export function isHistoryOnlyTask(runtime: GatewayRuntimeCore, task: GatewayTask): boolean {
  const tasks = owners.get(runtime)
  const original = tasks?.get(task.taskId)
  if (!original) return false
  if (!original.accountCurrent(original.serverId) || original.serverId !== task.serverId ||
      original.threadId !== task.threadId || !sameWorkspacePath(original.workspacePath, task.workspacePath)) {
    tasks?.delete(task.taskId)
    return false
  }
  return true
}

export function releaseHistoryOnlyTask(runtime: GatewayRuntimeCore, taskId: string) {
  owners.get(runtime)?.delete(taskId)
}
