import { afterEach, expect, test, vi } from 'vitest'
import { channelAction, channelInventory, channelChatDetails, ChannelRequestError, readChannelInventory, sameChannelTask } from './channels'
import { channelFixture, channelTarget } from './channels.test-fixtures'
vi.mock('@/config/runtime', () => ({ getRuntimeConfig: () => ({ appBasePath: '/g/owned' }), joinAppPath: (base: string, path: string) => base + path }))
vi.mock('./gatewayLoginNavigation', () => ({ navigateGatewayLogin: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

test('chat details use an encoded GET on the current mount and reject a mismatched chat identity', async () => {
  const details = { chatId: 'observed-chat', bindingRevision: 0, messages: [], bindingInfo: null }
  const fetch = vi.fn().mockImplementation(async () => Response.json(details)); vi.stubGlobal('fetch', fetch)
  expect((await channelChatDetails('observed-chat')).chatId).toBe('observed-chat')
  expect(fetch.mock.calls[0][0]).toBe('/g/owned/api/channels?chatId=observed-chat')
  expect(fetch.mock.calls[0][1].method).toBe('GET')
  await expect(channelChatDetails('foreign-chat')).rejects.toMatchObject({ code: 'CHANNEL_RESPONSE_UNKNOWN' })
})

test('uses the current Gateway mount and cookie login without a Native scope or signed payload', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(channelFixture())))
  vi.stubGlobal('fetch', fetch)
  expect((await channelInventory()).installationId).toBe('fixture-gateway')
  expect(fetch.mock.calls[0][0]).toBe('/g/owned/api/channels')
  expect(fetch.mock.calls[0][1].credentials).toBe('same-origin')
  expect(fetch.mock.calls[0][1].body).toBeUndefined()
})

test('binding includes the exact original task and observed binding revision; a lost response is never retried', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('connection lost'))
  vi.stubGlobal('fetch', fetch)
  const body = { action: 'bind' as const, chatId: 'observed-chat', target: channelTarget, expectedBindingRevision: 3 }
  await expect(channelAction(body)).rejects.toMatchObject({ code: 'CHANNEL_REQUEST_UNKNOWN', uncertain: true })
  expect(fetch).toHaveBeenCalledOnce()
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body)
})

test('inventory rejects mixed platform chats, foreign bindings and malformed deliveries', () => {
  for (const change of [
    (page: ReturnType<typeof channelFixture>) => { page.chats[0].range.platform = 'qq' },
    (page: ReturnType<typeof channelFixture>) => { page.chats[0].binding = { chatId: 'other-chat', target: channelTarget, revision: 0 } },
    (page: ReturnType<typeof channelFixture>) => { page.chats[0].deliveries = [{ deliveryId: 'send', deliveryState: 'invalid' as never, phase: 'result' }] },
  ]) {
    const page = channelFixture(); change(page)
    expect(() => readChannelInventory(page)).toThrow(ChannelRequestError)
  }
  expect(sameChannelTask(channelTarget, { ...channelTarget, serverId: 'other' })).toBe(false)
  expect(sameChannelTask(channelTarget, { ...channelTarget, workspacePath: '/other' })).toBe(false)
  expect(sameChannelTask(channelTarget, { ...channelTarget, threadId: 'other' })).toBe(false)
})
