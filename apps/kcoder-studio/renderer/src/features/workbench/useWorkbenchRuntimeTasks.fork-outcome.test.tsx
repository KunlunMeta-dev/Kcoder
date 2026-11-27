import { renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'

type Options = Parameters<typeof useWorkbenchRuntimeTasks>[0]
const source = { deviceId: 'fork-target', taskId: 'parent', workspacePath: '/workspace' }
const target = { deviceId: source.deviceId, workspacePath: source.workspacePath }
const accepted = { accepted: true, target: { ...source, taskId: 'fork' } }

function setup() {
  const forkRuntimeTask = vi.fn(async () => accepted)
  const refreshWorkLists = vi.fn(async () => undefined)
  const dispatch = vi.fn()
  const options = {
    user: { id: 1 },
    state: { currentRuntimeTask: source, currentProject: null, projects: [], runtimeWork: { projects: [], chats: [] } },
    executorClient: { runtime: { forkRuntimeTask } },
    refreshWorkLists, dispatch, services: { chatStream: {} },
  } as unknown as Options
  const hook = renderHook(({ options }) => useWorkbenchRuntimeTasks(options), { initialProps: { options } })
  return { ...hook, options, forkRuntimeTask, refreshWorkLists, dispatch }
}
beforeEach(() => window.history.replaceState({}, '', '/'))

test('fork retry keeps its request identity after a lost response and does not set a global error', async () => {
  const f = setup()
  f.forkRuntimeTask.mockRejectedValue(new Error('lost response'))
  await expect(f.result.current.forkCurrentRuntimeTask({ workspacePath: target.workspacePath, deviceId: target.deviceId }, { lastTurnId: 'turn' })).rejects.toThrow('lost response')
  await expect(f.result.current.forkCurrentRuntimeTask(target, { lastTurnId: 'turn' })).rejects.toThrow('lost response')
  expect(f.forkRuntimeTask.mock.calls[0]).toEqual(f.forkRuntimeTask.mock.calls[1])
  expect(f.forkRuntimeTask.mock.calls[0]).toEqual([expect.objectContaining({ clientRequestId: expect.any(String) })])
  expect(f.dispatch).not.toHaveBeenCalled()
})

test('a refused fork rejects to its dialog instead of reporting success', async () => {
  const f = setup()
  f.forkRuntimeTask.mockResolvedValue({ accepted: false, error: 'fork refused' } as never)
  await expect(f.result.current.forkCurrentRuntimeTask(target)).rejects.toThrow('fork refused')
  expect(f.dispatch).not.toHaveBeenCalled()
})

test('an accepted fork survives refresh failure; a subsequent operation gets a new identity', async () => {
  const f = setup()
  f.refreshWorkLists.mockRejectedValue(new Error('index unavailable'))
  await expect(f.result.current.forkCurrentRuntimeTask(target)).resolves.toBeUndefined()
  await expect(f.result.current.forkCurrentRuntimeTask(target)).resolves.toBeUndefined()
  expect(f.forkRuntimeTask.mock.calls[0]).not.toEqual(f.forkRuntimeTask.mock.calls[1])
  expect(f.dispatch.mock.calls.some(([action]) => action.type === 'error_set')).toBe(false)
})

test('a response from a retired account cannot open a fork', async () => {
  const f = setup()
  let accept!: (value: typeof accepted) => void
  f.forkRuntimeTask.mockImplementation(() => new Promise(resolve => { accept = resolve }))
  const pending = f.result.current.forkCurrentRuntimeTask(target)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  notifyAccountContextChange(source.deviceId)
  accept(accepted)
  await rejected
  expect(f.dispatch).not.toHaveBeenCalled()
})

test('a same-intent retry after account context changes reuses the fork receipt identity', async () => {
  const f = setup()
  const receipts = new Map<string, typeof accepted>()
  let createdForks = 0
  let acceptFirst!: (value: typeof accepted) => void
  f.forkRuntimeTask.mockImplementation((...args: unknown[]) => {
    const request = args[0] as { clientRequestId: string }
    let receipt = receipts.get(request.clientRequestId)
    if (!receipt) {
      receipt = accepted
      receipts.set(request.clientRequestId, receipt)
      createdForks += 1
    }
    if (f.forkRuntimeTask.mock.calls.length === 1)
      return new Promise(resolve => { acceptFirst = resolve }) as never
    return Promise.resolve(receipt) as never
  })

  const first = f.result.current.forkCurrentRuntimeTask(target, { lastTurnId: 'turn' })
  const firstRequestId = f.forkRuntimeTask.mock.calls[0][0].clientRequestId
  notifyAccountContextChange(source.deviceId)
  acceptFirst(receipts.get(firstRequestId)!)
  await expect(first).rejects.toMatchObject({ name: 'AbortError' })

  await f.result.current.forkCurrentRuntimeTask(target, { lastTurnId: 'turn' })
  expect(f.forkRuntimeTask.mock.calls[1][0].clientRequestId).toBe(firstRequestId)
  expect(createdForks).toBe(1)
})

test('an accepted fork cannot navigate after its user has opened another task', async () => {
  const f = setup()
  let accept!: (value: typeof accepted) => void
  f.forkRuntimeTask.mockImplementation(() => new Promise(resolve => { accept = resolve }))
  const pending = f.result.current.forkCurrentRuntimeTask(target)
  f.rerender({ options: { ...f.options, state: { ...f.options.state,
    currentRuntimeTask: { ...source, taskId: 'different-task' },
  } } })
  accept(accepted)
  await pending
  expect(f.refreshWorkLists).not.toHaveBeenCalled()
  expect(f.dispatch).not.toHaveBeenCalled()
})
