import { expect, it } from 'vitest'
import { isTransientTaskExpertFailure, taskExpertFailureCode, taskExpertFailureReason } from './taskExpertFailure'

it.each([
  // Live commits from a running or compacting original task.
  ['CHAT_TASK_LIFECYCLE_BUSY', 'busy'],
  ['history source changed during resume preparation; prepare it again', 'busy'],
  ['history commit is in progress; retry session preparation', 'busy'],
  // Transport replaced or recovering for the same original task.
  ['AGENT_TASK_CONNECTION_CHANGED', 'connection'],
  ['AGENT_TASK_APP_SERVER_BUSY', 'busy'],
  ['KCoder app-server restart is in progress', 'connection'],
])('treats %s as a transient %s failure', (message, reason) => {
  expect(taskExpertFailureReason(new Error(message))).toBe(reason)
  expect(isTransientTaskExpertFailure(new Error(message))).toBe(true)
})

it('treats stalled and aborted shared reads as transient', () => {
  expect(taskExpertFailureReason(Object.assign(new Error('timed out'), { name: 'GatewayRpcTimeoutError' }))).toBe('timeout')
  expect(taskExpertFailureReason(Object.assign(new Error('closed'), { reason: 'connection' }))).toBe('connection')
  expect(isTransientTaskExpertFailure(new DOMException('Aborted', 'AbortError'))).toBe(true)
})

it.each([
  ['AGENT_ORIGINAL_TASK_CHANGED', 'taskChanged'],
  ['AGENT_ORIGINAL_RESPONSE_REQUIRED', 'taskChanged'],
  ['threadId does not match the active thread', 'taskChanged'],
  ['AGENT_ORIGINAL_TASK_UNAVAILABLE', 'taskUnavailable'],
  ['thread/start or thread/resume is required', 'taskUnavailable'],
  ['CHAT_TASK_WORKSPACE_CHANGED', 'workspaceChanged'],
  ['CHAT_TASK_LEGACY_SOURCE_MIGRATION_REQUIRED', 'legacySource'],
  ['AGENT_TURN_CONFIGURATION_UNSUPPORTED', 'unsupported'],
  ['Target unavailable', 'unknown'],
])('keeps %s failing closed as %s', (message, reason) => {
  expect(taskExpertFailureReason(new Error(message))).toBe(reason)
  expect(isTransientTaskExpertFailure(new Error(message))).toBe(false)
})

it('keeps only a bounded code for the copyable detail', () => {
  expect(taskExpertFailureCode(new Error('Error: CHAT_TASK_WORKSPACE_CHANGED'))).toBe('CHAT_TASK_WORKSPACE_CHANGED')
  expect(taskExpertFailureCode(new Error('persisted thread not found: private-thread'))).toBe('PERSISTED_THREAD_NOT_FOUND')
  expect(taskExpertFailureCode(new Error('failed to open /home/user/private'))).toBe('UNKNOWN')
  expect(taskExpertFailureCode(Object.assign(new Error('x'), { name: 'GatewayRpcTimeoutError' }))).toBe('GATEWAY_TIMEOUT')
})

test('structured expert failures survive server wording changes', () => {
  const busy = Object.assign(new Error('请稍后再次尝试'), { data: { kind: 'HISTORY_COMMIT_IN_PROGRESS' } })
  expect(taskExpertFailureReason(busy)).toBe('busy')
  expect(isTransientTaskExpertFailure(busy)).toBe(true)
  expect(taskExpertFailureCode(busy)).toBe('HISTORY_COMMIT_IN_PROGRESS')
})
