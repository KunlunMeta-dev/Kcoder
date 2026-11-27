import { captureAccountContextRevision } from '../../accountContextEvents'
import { sessionAddressExpectation } from '../../../../../shared/sessionAddressExpectation.mjs'
import type { SessionAddress } from '../../../../../shared/peerAgentMessage'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayRuntimeCore } from './core'
import type { GatewayTask } from './contracts'
import { record, text } from './contracts'

type TaskSelector = Pick<GatewayTask, 'taskId' | 'serverId' | 'threadId'>
type AccountFence = ReturnType<typeof captureAccountContextRevision>

interface ExpectedTask {
  address: Readonly<SessionAddress>
  currentAccount: (serverId: string) => boolean
}
const expectations = new WeakMap<GatewayRuntimeCore, Map<string, ExpectedTask>>()

/** Remember only a narrowing selector; the Gateway verifies the actual Native identity. */
export function rememberSessionAddressExpectation(runtime: GatewayRuntimeCore, task: TaskSelector, value: unknown,
  currentAccount: AccountFence = captureAccountContextRevision()) {
  if (value === undefined) return
  if (runtime.disposed || !currentAccount(task.serverId))
    throw new Error('SESSION_ADDRESS_EXPECTATION_OWNER_CHANGED')
  const expected = sessionAddressExpectation(value, task.threadId)
  let tasks = expectations.get(runtime)
  if (!tasks) expectations.set(runtime, tasks = new Map())
  const previous = tasks.get(task.taskId)
  if (previous?.currentAccount(task.serverId) &&
      (previous.address.targetId !== expected.targetId || previous.address.workspaceId !== expected.workspaceId ||
        previous.address.threadId !== expected.threadId))
    throw new Error('SESSION_ADDRESS_EXPECTATION_CONFLICT')
  if (previous?.currentAccount(task.serverId)) return
  tasks.set(task.taskId, { address: expected, currentAccount })
}

/** Capture synchronously before discovery can publish a task to a concurrent attachment. */
export function captureRequestSessionAddressExpectation(runtime: GatewayRuntimeCore, params: Record<string, unknown>,
  currentAccount: AccountFence = captureAccountContextRevision()): (() => void) | undefined {
  const address = record(params.address)
  const values = [params.expectedSessionAddress, address.expectedSessionAddress].filter(value => value !== undefined)
  if (!values.length) return
  const requested = text(params.taskId) ?? text(address.taskId)
  const threadId = text(record(values[0]).threadId)
  if (!requested || !threadId || !runtime.compatibility.isRuntimeTaskId(requested))
    throw new Error('SESSION_ADDRESS_EXPECTATION_INVALID')
  const expected = sessionAddressExpectation(values[0], threadId)
  for (const value of values.slice(1)) {
    const nested = sessionAddressExpectation(value, threadId)
    if (nested.targetId !== expected.targetId || nested.workspaceId !== expected.workspaceId)
      throw new Error('SESSION_ADDRESS_EXPECTATION_CONFLICT')
  }
  const prefix = requested.startsWith('kcoder:') ? 'kcoder:' : 'codex:'
  const suffix = `:${threadId}`
  if (!requested.startsWith(prefix) || !requested.endsWith(suffix))
    throw new Error('SESSION_ADDRESS_EXPECTATION_INVALID')
  const serverId = requested.slice(prefix.length, -suffix.length)
  const selectors = [params.deviceId, params.device_id, address.deviceId, address.device_id].map(text).filter(Boolean)
  const threads = [params.threadId, address.threadId].map(text).filter(Boolean)
  if (!serverId || selectors.some(value => value !== serverId) || threads.some(value => value !== threadId))
    throw new Error('SESSION_ADDRESS_EXPECTATION_INVALID')
  // This identity has no cwd, connection or permission. It can only narrow the
  // eventual independently authenticated task lookup and Native resume/read.
  rememberSessionAddressExpectation(runtime, {
    taskId: runtime.resolveTaskId(requested) ?? requested, serverId, threadId,
  }, expected, currentAccount)
  return () => {
    if (runtime.disposed || !currentAccount(serverId))
      throw new Error('SESSION_ADDRESS_EXPECTATION_OWNER_CHANGED')
  }
}

export function bindSessionAddressExpectation(runtime: GatewayRuntimeCore, task: TaskSelector, client: GatewayClient) {
  const expected = expectations.get(runtime)?.get(task.taskId)
  if (!expected) return
  if (!expected.currentAccount(task.serverId)) {
    expectations.get(runtime)?.delete(task.taskId)
    throw new Error('SESSION_ADDRESS_EXPECTATION_OWNER_CHANGED')
  }
  if (task.threadId !== expected.address.threadId || !client.expectSessionAddress)
    throw new Error('SESSION_ADDRESS_EXPECTATION_UNSUPPORTED')
  client.expectSessionAddress(expected.address)
}
