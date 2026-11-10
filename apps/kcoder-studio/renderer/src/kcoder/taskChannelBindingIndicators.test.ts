import { afterEach, expect, test, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { channelFixture, channelTarget } from './channels.test-fixtures'
import { invalidateChannelBindings } from './channelBindingEvents'
import { notifyAccountContextChange } from './accountContextEvents'
import { readTaskChannelIndicator, subscribeTaskChannelIndicator, taskChannelIndicators } from './taskChannelBindingIndicators'
const api = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./channels', () => ({ channelInventory: api.read }))
const target = { serverId: channelTarget.serverId, workspacePath: channelTarget.workspacePath! }
function page() {
  const value = channelFixture()
  value.chats[0].bindingRevision = 1
  value.chats[0].binding = { chatId: value.chats[0].id, target: channelTarget, revision: 1 }
  return value
}
const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.clearAllMocks(); vi.useRealTimers() })

test('the task indicator uses the exact Gateway connection and target/workspace/task route', () => {
  expect(taskChannelIndicators(page(), target, [channelTarget.threadId]).get(channelTarget.threadId)).toMatchObject({
    platform: 'feishu', connectionId: 'connection', connectionLabel: 'Original connection', chatId: 'platform-chat',
  })
  expect(taskChannelIndicators(page(), { ...target, serverId: 'another-server' }, [channelTarget.threadId]).size).toBe(0)
  expect(taskChannelIndicators(page(), { ...target, workspacePath: '/other' }, [channelTarget.threadId]).size).toBe(0)
  expect(taskChannelIndicators(page(), target, ['another-task']).size).toBe(0)
})

test('multiple observed chats may route to one task without conflating their platform identities', () => {
  const value = page()
  value.chats.push({ ...value.chats[0], id: 'second', range: { ...value.chats[0].range, chatId: 'other-chat' },
    binding: { chatId: 'second', target: channelTarget, revision: 1 } })
  expect(taskChannelIndicators(value, target, [channelTarget.threadId]).get(channelTarget.threadId)?.chatId).toBe('platform-chat')
  value.chats[0].range.platform = 'qq'
  expect(() => taskChannelIndicators(value, target, [channelTarget.threadId])).toThrow('CHANNEL_INVENTORY_INVALID')
})

test('mounted rows share one inventory request; an unbind refreshes the original indicator', async () => {
  let value = page(); api.read.mockImplementation(async () => value)
  const changed = vi.fn()
  stops.push(subscribeTaskChannelIndicator(target, channelTarget.threadId, changed))
  stops.push(subscribeTaskChannelIndicator(target, 'other-task', changed))
  await waitFor(() => expect(readTaskChannelIndicator(target, channelTarget.threadId)).not.toBeNull())
  expect(api.read).toHaveBeenCalledOnce()
  expect(readTaskChannelIndicator(target, 'other-task')).toBeNull()
  value = channelFixture(); invalidateChannelBindings('gateway-channels')
  await waitFor(() => expect(readTaskChannelIndicator(target, channelTarget.threadId)).toBeNull())
  expect(changed).toHaveBeenCalledTimes(2)
})

test('account invalidation rejects a late read from the old client context', async () => {
  let resolve: ((value: ReturnType<typeof page>) => void) | undefined
  api.read.mockImplementation(() => new Promise(done => { resolve = done }))
  const changed = vi.fn()
  stops.push(subscribeTaskChannelIndicator(target, channelTarget.threadId, changed))
  await waitFor(() => expect(resolve).toBeDefined())
  const old = resolve!
  notifyAccountContextChange(target.serverId); old(page())
  await waitFor(() => expect(api.read.mock.calls.length).toBeGreaterThanOrEqual(2))
  expect(readTaskChannelIndicator(target, channelTarget.threadId)).toBeNull()
  expect(changed).not.toHaveBeenCalled()
})

test('slow inventory reads do not turn timer ticks into a continuous polling loop', async () => {
  vi.useFakeTimers()
  let resolve: ((value: ReturnType<typeof page>) => void) | undefined
  api.read.mockImplementation(() => new Promise(done => { resolve = done }))
  stops.push(subscribeTaskChannelIndicator(target, channelTarget.threadId, vi.fn()))
  await vi.advanceTimersByTimeAsync(0)
  expect(api.read).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(15000)
  resolve!(page()); await vi.advanceTimersByTimeAsync(0)
  expect(api.read).toHaveBeenCalledOnce()
  expect(readTaskChannelIndicator(target, channelTarget.threadId)).not.toBeNull()
})
