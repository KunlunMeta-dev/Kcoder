import { renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'

const address = { deviceId: 'scope-target', taskId: 'scope-task', workspacePath: '/owned/scope' }

function deferredClient() {
  const replies: ((response: { messages: []; rangeStart: number }) => void)[] = []
  const getRuntimeTranscript = vi.fn(() => new Promise(resolve => replies.push(resolve)))
  return { client: { runtime: { getRuntimeTranscript } }, getRuntimeTranscript, replies }
}

function renderReader(client: ReturnType<typeof deferredClient>['client']) {
  return renderHook(
    ({ client }) =>
      useWorkbenchRuntimeTasks({
        user: { id: 1 },
        state: { currentRuntimeTask: null, runtimeWork: { projects: [], chats: [] } },
        dispatch: vi.fn(),
        executorClient: client,
        services: {},
        lifecycleStore: new RuntimeTaskLifecycleStore('test'),
        markRuntimeTasksArchived: vi.fn(),
        refreshWorkLists: vi.fn(),
      } as unknown as Parameters<typeof useWorkbenchRuntimeTasks>[0]),
    { initialProps: { client } }
  )
}

test('a replacement executor reads its own transcript while the old executor request is pending', async () => {
  const previous = deferredClient()
  const current = deferredClient()
  const oldReader = renderReader(previous.client)
  const newReader = renderReader(current.client)
  const oldRequest = oldReader.result.current.loadRuntimeTranscriptForPane(address)
  const newRequest = newReader.result.current.loadRuntimeTranscriptForPane(address)
  expect(previous.getRuntimeTranscript).toHaveBeenCalledTimes(1)
  expect(current.getRuntimeTranscript).toHaveBeenCalledTimes(1)
  current.replies[0]({ messages: [], rangeStart: 9 })
  expect((await newRequest).rangeStart).toBe(9)
  previous.replies[0]({ messages: [], rangeStart: 1 })
  expect((await oldRequest).rangeStart).toBe(1)
})

test('an account change starts a new read on the same executor and old finally cannot remove it', async () => {
  const scopedAddress = { ...address, taskId: 'account-scope-task' }
  const target = deferredClient()
  const reader = renderReader(target.client)
  const oldRequest = reader.result.current.loadRuntimeTranscriptForPane(scopedAddress)
  const oldRejected = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' })
  notifyAccountContextChange(address.deviceId)
  const newRequest = reader.result.current.loadRuntimeTranscriptForPane(scopedAddress)
  expect(target.getRuntimeTranscript).toHaveBeenCalledTimes(2)
  target.replies[0]({ messages: [], rangeStart: 2 })
  await oldRejected
  const sharedCurrent = reader.result.current.loadRuntimeTranscriptForPane(scopedAddress)
  expect(target.getRuntimeTranscript).toHaveBeenCalledTimes(2)
  target.replies[1]({ messages: [], rangeStart: 10 })
  expect((await newRequest).rangeStart).toBe(10)
  expect((await sharedCurrent).rangeStart).toBe(10)
})

test('two panes on the same executor and unchanged account still share one read', async () => {
  const scopedAddress = { ...address, taskId: 'same-client-panes-task' }
  const target = deferredClient()
  const first = renderReader(target.client)
  const second = renderReader(target.client)
  const a = first.result.current.loadRuntimeTranscriptForPane(scopedAddress)
  const b = second.result.current.loadRuntimeTranscriptForPane(scopedAddress)
  expect(target.getRuntimeTranscript).toHaveBeenCalledTimes(1)
  target.replies[0]({ messages: [], rangeStart: 11 })
  expect((await a).rangeStart).toBe(11)
  expect((await b).rangeStart).toBe(11)
})

test('the same hook rejects an old executor result before its consumer can commit it', async () => {
  const scopedAddress = { ...address, taskId: 'executor-replacement-task' }
  const previous = deferredClient()
  const current = deferredClient()
  const reader = renderReader(previous.client)
  const oldRequest = reader.result.current.loadRuntimeTranscriptForPane(scopedAddress)
  const oldRejected = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' })
  reader.rerender({ client: current.client })
  const fresh = reader.result.current.loadRuntimeTranscriptForPane(scopedAddress)
  previous.replies[0]({ messages: [], rangeStart: 1 })
  await oldRejected
  current.replies[0]({ messages: [], rangeStart: 12 })
  expect((await fresh).rangeStart).toBe(12)
  expect(current.getRuntimeTranscript).toHaveBeenCalledTimes(1)
})

test('an unrelated target account change does not cancel or duplicate this target read', async () => {
  const scopedAddress = { ...address, taskId: 'unaffected-target-task' }
  const target = deferredClient()
  const reader = renderReader(target.client)
  const a = reader.result.current.loadRuntimeTranscriptForPane(scopedAddress)
  notifyAccountContextChange('unrelated-scope-target')
  const b = reader.result.current.loadRuntimeTranscriptForPane(scopedAddress)
  expect(target.getRuntimeTranscript).toHaveBeenCalledTimes(1)
  target.replies[0]({ messages: [], rangeStart: 13 })
  expect((await a).rangeStart).toBe(13)
  expect((await b).rangeStart).toBe(13)
})
