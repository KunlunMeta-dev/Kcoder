import { act, renderHook, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useTaskMemberControls } from './useTaskMemberControls'

const address = { runtime: 'kcoder' as const, deviceId: 'local', taskId: 'parent-task',
  threadId: 'parent', workspacePath: '/owned' }
const run = { parentSessionId: 'parent', agentId: 'member', runId: 'original-run' }
const isCurrent = () => true
function fixture() {
  return {
    readRuntimeSubagentCommand: vi.fn(async (input: {clientMessageId: string}) => ({
      threadId: 'parent', agentId: 'member', clientMessageId: input.clientMessageId, receiptEpoch: 2,
    })),
    steerRuntimeSubagent: vi.fn(async (input: {clientMessageId?: string}) => ({
      agentId: 'member', clientMessageId: input.clientMessageId, accepted: true, status: 'queued_live',
      queued: true, messageId: 'native-message', expectedBackgroundRun: run,
    })),
    stopRuntimeSubagent: vi.fn(async () => ({ stopped: true, status: 'stopped', expectedBackgroundRun: run })),
  }
}
beforeEach(() => localStorage.clear())
afterEach(cleanup)

test('only a native epoch enables exact member commands and both actions preserve the full original run', async () => {
  const api = fixture()
  const { result } = renderHook(() => useTaskMemberControls({ api, address, run, isCurrent,
    supported: true, journalScope: 'actual-native-account-target-parent' }))
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.commandEpoch).toBe(2)
  await act(async () => { await result.current.onSteer('member', 'bounded instruction', 'cmd:2:one') })
  expect(api.steerRuntimeSubagent).toHaveBeenCalledWith({ address, agentId: 'member',
    message: 'bounded instruction', clientMessageId: 'cmd:2:one', expectedBackgroundRun: run })
  await act(async () => { await result.current.onStop('member') })
  expect(api.stopRuntimeSubagent).toHaveBeenCalledWith({ address, agentId: 'member', expectedBackgroundRun: run })
  await act(async () => { await result.current.onSteer('member', 'continue only the original member', 'cmd:2:continue', true) })
  expect(api.steerRuntimeSubagent).toHaveBeenLastCalledWith({ address, agentId: 'member',
    message: 'continue only the original member', clientMessageId: 'cmd:2:continue',
    expectedBackgroundRun: run, continueOriginalRun: true })
})

test('unknown command keeps only a recovery handle and mounting never replays the operation', async () => {
  const api = fixture()
  api.steerRuntimeSubagent.mockRejectedValue(new Error('response lost after possible enqueue'))
  const input = { api, address, run, isCurrent, supported: true, journalScope: 'original-native-scope' }
  const first = renderHook(() => useTaskMemberControls(input))
  await waitFor(() => expect(first.result.current.ready).toBe(true))
  const intent = { clientMessageId: 'cmd:2:unknown', message: 'private instruction body', status: 'sending', createdAtMs: 1 }
  await act(async () => { first.result.current.onCommandIntent(intent) })
  await expect(first.result.current.onSteer('member', intent.message, intent.clientMessageId)).rejects.toThrow('lost')
  expect(JSON.stringify(localStorage)).not.toContain(intent.message)
  first.unmount()
  const reopened = renderHook(() => useTaskMemberControls(input))
  await waitFor(() => expect(reopened.result.current.ready).toBe(true))
  expect(reopened.result.current.commandHistory).toMatchObject([{ clientMessageId: intent.clientMessageId, status: 'unknown' }])
  expect(api.steerRuntimeSubagent).toHaveBeenCalledTimes(1)
  await expect(reopened.result.current.onSteer('other-member', 'wrong target', 'cmd:2:wrong')).rejects.toThrow('unavailable')
  expect(api.steerRuntimeSubagent).toHaveBeenCalledTimes(1)
})

test('a target without the exact control capability remains an observer', async () => {
  const api = fixture()
  const { result } = renderHook(() => useTaskMemberControls({ api, address, run, isCurrent,
    supported: false, journalScope: 'native-scope' }))
  expect(result.current.ready).toBe(false)
  expect(api.readRuntimeSubagentCommand).not.toHaveBeenCalled()
  await expect(result.current.onStop('member')).rejects.toThrow('unavailable')
  expect(api.stopRuntimeSubagent).not.toHaveBeenCalled()
})
