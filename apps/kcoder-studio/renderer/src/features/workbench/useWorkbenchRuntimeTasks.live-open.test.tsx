import { renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import * as navigation from '@/lib/navigation'
import '@/i18n'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'

const address = { deviceId: 'local', taskId: 'kcoder:local:original', threadId: 'original', workspacePath: '/owned' }
afterEach(() => vi.restoreAllMocks())
function fixture(running: boolean, indexed = true, indexedThreadId = address.threadId) {
  const replies: Array<(value: { messages: []; rangeStart: number }) => void> = []
  const getRuntimeTranscript = vi.fn(() => new Promise(resolve => replies.push(resolve)))
  const hook = renderHook(() => useWorkbenchRuntimeTasks({
    user: { id: 1 },
    state: { currentRuntimeTask: null, projects: [], runtimeWork: { projects: [], chats: [{ deviceId: 'local', workspacePath: '/owned', tasks: indexed ? [{ ...address, threadId: indexedThreadId, title: 'Original', runtime: 'kcoder', running }] : [] }] } },
    dispatch: vi.fn(), executorClient: { runtime: { getRuntimeTranscript } }, services: {},
    lifecycleStore: new RuntimeTaskLifecycleStore('explicit-live-open'), markRuntimeTasksArchived: vi.fn(), refreshWorkLists: vi.fn(),
  } as unknown as Parameters<typeof useWorkbenchRuntimeTasks>[0]))
  return { hook, getRuntimeTranscript, replies }
}
test('only explicitly opened live conversation asks to attach its exact original task', async () => {
  const f = fixture(true)
  const history = f.hook.result.current.loadRuntimeTranscriptForPane(address)
  expect(f.getRuntimeTranscript).toHaveBeenNthCalledWith(1, address)
  await f.hook.result.current.openRuntimeTask(address)
  const live = f.hook.result.current.loadRuntimeTranscriptForPane(address)
  expect(f.getRuntimeTranscript).toHaveBeenNthCalledWith(2, { ...address, attachToLiveTurn: true })
  f.replies[0]({ messages: [], rangeStart: 1 }); f.replies[1]({ messages: [], rangeStart: 2 })
  expect((await history).rangeStart).toBe(1); expect((await live).rangeStart).toBe(2)
})
test('an explicitly opened idle conversation stays subscribed before an external turn starts', async () => {
  const f = fixture(false)
  await f.hook.result.current.openRuntimeTask(address)
  const history = f.hook.result.current.loadRuntimeTranscriptForPane(address)
  expect(f.getRuntimeTranscript).toHaveBeenCalledWith({ ...address, attachToLiveTurn: true })
  f.replies[0]({ messages: [], rangeStart: 1 }); await history
})
test('background history reads stay detached even when the task is idle', async () => {
  const f = fixture(false)
  const history = f.hook.result.current.loadRuntimeTranscriptForPane(address)
  expect(f.getRuntimeTranscript).toHaveBeenCalledWith(address)
  f.replies[0]({ messages: [], rangeStart: 1 }); await history
})
test('an original task opened before list refresh retains its existing owner', async () => {
  const f = fixture(false, false)
  await f.hook.result.current.openRuntimeTask(address)
  const transcript = f.hook.result.current.loadRuntimeTranscriptForPane(address)
  expect(f.getRuntimeTranscript).toHaveBeenCalledWith({ ...address, attachToLiveTurn: true })
  f.replies[0]({ messages: [], rangeStart: 1 }); await transcript
})
test('an incomplete list projection cannot detach the canonical original task', async () => {
  const f = fixture(false, true, '')
  await f.hook.result.current.openRuntimeTask(address)
  const transcript = f.hook.result.current.loadRuntimeTranscriptForPane(address)
  expect(f.getRuntimeTranscript).toHaveBeenCalledWith({ ...address, attachToLiveTurn: true })
  f.replies[0]({ messages: [], rangeStart: 1 }); await transcript
})
test('a new task route without a redundant threadId subscribes using its canonical task identity', async () => {
  const f = fixture(false, false)
  const route = { deviceId: address.deviceId, taskId: address.taskId, workspacePath: address.workspacePath }
  await f.hook.result.current.openRuntimeTask(route)
  const transcript = f.hook.result.current.loadRuntimeTranscriptForPane(route)
  expect(f.getRuntimeTranscript).toHaveBeenCalledWith({ ...route, threadId: address.threadId, attachToLiveTurn: true })
  f.replies[0]({ messages: [], rangeStart: 1 }); await transcript
})
test.each(['runtime-creating-task', 'kcoder:other:original', 'kcoder:local:another'])(
  'does not infer a live owner for a mismatched unindexed task: %s', async taskId => {
    const f = fixture(false, false)
    const target = { ...address, taskId }
    await f.hook.result.current.openRuntimeTask(target)
    const transcript = f.hook.result.current.loadRuntimeTranscriptForPane(target)
    expect(f.getRuntimeTranscript).toHaveBeenCalledWith(target)
    f.replies[0]({ messages: [], rangeStart: 1 }); await transcript
  }
)

const owner = { accountId: 'owner', targetId: 'target', workspaceId: null }
const agentDefinition = {
  owner, definition: { id: 'personal.expert', version: '1', definitionSha256: 'a'.repeat(64) },
  title: 'Expert', source: 'expert',
}
const channelTaskSource = { owner, channelId: 'original-feishu' }
test.each([
  ['ordinary', {}],
  ['expert', { agentDefinition }],
  ['channel', { channelTaskSource }],
  ['expert and channel', { agentDefinition, channelTaskSource }],
])('opening a %s task retains the original task page', async (_kind, runtimeHandle) => {
  const navigate = vi.spyOn(navigation, 'navigateTo').mockImplementation(() => {})
  const f = fixture(false)
  const target = { ...address, runtimeHandle }
  await f.hook.result.current.openRuntimeTask(target)
  expect(navigate).toHaveBeenCalledExactlyOnceWith(navigation.buildRuntimeTaskRoute(target))
})
test('explicit expert entry can open the same task without replacing its chosen route', async () => {
  const navigate = vi.spyOn(navigation, 'navigateTo').mockImplementation(() => {})
  const f = fixture(false)
  await f.hook.result.current.openRuntimeTask({ ...address, runtimeHandle: { agentDefinition } }, { navigate: false })
  expect(navigate).not.toHaveBeenCalled()
})
