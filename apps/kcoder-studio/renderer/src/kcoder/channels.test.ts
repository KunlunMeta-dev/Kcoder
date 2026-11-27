import { afterEach, expect, test, vi } from 'vitest'
import { channelAction, channelInventory, channelChatDetails, ChannelRequestError, readChannelInventory, sameChannelTask } from './channels'
import { channelFixture, channelTarget } from './channels.test-fixtures'
import { notifyAccountContextChange } from './accountContextEvents'
import { invalidateChannelBindings, listenChannelBindingChanges } from './channelBindingEvents'
import { navigateGatewayLogin } from './gatewayLoginNavigation'
import { readTaskChannelIndicator, subscribeTaskChannelIndicator } from './taskChannelBindingIndicators'
const runtime = vi.hoisted(() => ({ appBasePath: '/g/owned' }))
vi.mock('@/config/runtime', () => ({ getRuntimeConfig: () => runtime, joinAppPath: (base: string, path: string) => base + path }))
vi.mock('./gatewayLoginNavigation', () => ({ navigateGatewayLogin: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); runtime.appBasePath = '/g/owned' })

test('task indicators in separate workspaces share one GET and retain their original bindings', async () => {
  const first = { serverId: channelTarget.serverId, workspacePath: channelTarget.workspacePath! }
  const second = { ...first, workspacePath: '/owned/another-workspace' }
  const page = channelFixture()
  page.chats[0].binding = { chatId: page.chats[0].id, target: channelTarget, revision: 0 }
  page.chats.push({ ...page.chats[0], id: 'second-chat',
    binding: { chatId: 'second-chat', target: { ...channelTarget, workspacePath: second.workspacePath }, revision: 0 } })
  let finish!: (response: Response) => void
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetch)
  const stopFirst = subscribeTaskChannelIndicator(first, channelTarget.threadId, vi.fn())
  const stopSecond = subscribeTaskChannelIndicator(second, channelTarget.threadId, vi.fn())
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    finish(Response.json(page))
    await vi.waitFor(() => {
      expect(readTaskChannelIndicator(first, channelTarget.threadId)?.bindingId).toBe('observed-chat')
      expect(readTaskChannelIndicator(second, channelTarget.threadId)?.bindingId).toBe('second-chat')
    })
  } finally { stopFirst(); stopSecond() }
})

test('concurrent workspace inventory readers share transport work and receive separate DTOs', async () => {
  let finish!: (response: Response) => void
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetch)
  const first = channelInventory(), second = channelInventory()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  finish(Response.json(channelFixture()))
  const [left, right] = await Promise.all([first, second])
  left.connections[0].label = 'Changed by the first consumer'
  expect(right.connections[0].label).toBe('Original connection')
  const next = channelInventory()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  finish(Response.json(channelFixture()))
  await next
})

test('one inventory subscriber can cancel while its peer still receives the original response', async () => {
  let finish!: (response: Response) => void
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  const cancelled = channelInventory(controller.signal), peer = channelInventory()
  const outcome = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  controller.abort()
  await outcome
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false)
  finish(Response.json(channelFixture()))
  expect((await peer).installationId).toBe('fixture-gateway')
})

test.each(['account', 'configuration', 'binding', 'mount'])(
  'a %s change retires the old inventory read and its late 401 cannot navigate the current context', async boundary => {
    const replies: ((response: Response) => void)[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(resolve => replies.push(resolve)))
    vi.stubGlobal('fetch', fetch)
    const old = channelInventory()
    const oldOutcome = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    if (boundary === 'account') notifyAccountContextChange(channelTarget.serverId)
    if (boundary === 'configuration') window.dispatchEvent(new Event('kcoder:servers-changed'))
    if (boundary === 'binding') invalidateChannelBindings('gateway-channels')
    if (boundary === 'mount') runtime.appBasePath = '/g/current'
    const current = channelInventory()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    replies[0](new Response(null, { status: 401 }))
    await oldOutcome
    expect(navigateGatewayLogin).not.toHaveBeenCalled()
    replies[1](Response.json(channelFixture()))
    expect((await current).installationId).toBe('fixture-gateway')
    const denied = channelInventory()
    const deniedOutcome = expect(denied).rejects.toMatchObject({ code: 'GATEWAY_LOGIN_REQUIRED' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    replies[2](new Response(null, { status: 401 }))
    await deniedOutcome
    expect(navigateGatewayLogin).toHaveBeenCalledOnce()
  }
)

test('the last inventory cancellation aborts transport and rejects a late 401 without navigation', async () => {
  let finish!: (response: Response) => void
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  const pending = channelInventory(controller.signal)
  const outcome = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  controller.abort()
  await outcome
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
  finish(new Response(null, { status: 401 }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(navigateGatewayLogin).not.toHaveBeenCalled()
})

test('inventory reads keep transports separate and do not dispatch an already cancelled subscriber', async () => {
  const first = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(channelFixture()))
  const second = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(channelFixture()))
  vi.stubGlobal('fetch', first)
  const cancelled = new AbortController(); cancelled.abort()
  await expect(channelInventory(cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(first).not.toHaveBeenCalled()
  const one = channelInventory()
  vi.stubGlobal('fetch', second)
  const two = channelInventory()
  await Promise.all([one, two])
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
})

test('a lost mutation reply requires a fresh inventory instead of joining a pre-mutation read', async () => {
  const replies: ((response: Response) => void)[] = []
  const fetch = vi.fn<typeof globalThis.fetch>((_url, options) => options?.method === 'POST'
    ? Promise.reject(new TypeError('lost mutation receipt'))
    : new Promise<Response>(resolve => replies.push(resolve)))
  vi.stubGlobal('fetch', fetch)
  const before = channelInventory()
  await vi.waitFor(() => expect(replies).toHaveLength(1))
  await expect(channelAction({ action: 'disconnect', connectionId: 'connection' }))
    .rejects.toMatchObject({ code: 'CHANNEL_REQUEST_UNKNOWN', uncertain: true })
  const reconciliation = channelInventory()
  await vi.waitFor(() => expect(replies).toHaveLength(2))
  replies[1](Response.json(channelFixture()))
  await reconciliation
  replies[0](Response.json(channelFixture()))
  await before
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})

test.each(['account', 'configuration', 'mount'].flatMap(boundary =>
  ['lost', 'success'].map(outcome => [boundary, outcome])))('a mutation settling after %s changes (%s) cannot retire the current inventory', async (boundary, result) => {
  let rejectMutation!: (error: Error) => void
  let finishMutation!: (response: Response) => void
  const replies: ((response: Response) => void)[] = []
  const fetch = vi.fn<typeof globalThis.fetch>((_url, options) => options?.method === 'POST'
    ? new Promise<Response>((resolve, reject) => { finishMutation = resolve; rejectMutation = reject })
    : new Promise<Response>(resolve => replies.push(resolve)))
  vi.stubGlobal('fetch', fetch)
  const mutation = channelAction({ action: 'disconnect', connectionId: 'connection' })
  const outcome = mutation.then(() => 'success', error => error.uncertain ? 'lost' : 'unexpected')
  if (boundary === 'account') notifyAccountContextChange(channelTarget.serverId)
  if (boundary === 'configuration') window.dispatchEvent(new Event('kcoder:servers-changed'))
  if (boundary === 'mount') runtime.appBasePath = '/g/current'
  const current = channelInventory()
  await vi.waitFor(() => expect(replies).toHaveLength(1))
  if (result === 'lost') rejectMutation(new Error('old account reply lost'))
  else finishMutation(Response.json({}))
  expect(await outcome).toBe(result)
  const peer = channelInventory()
  try { await vi.waitFor(() => expect(replies).toHaveLength(1)) }
  finally {
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const reply of replies) reply(Response.json(channelFixture()))
    await Promise.all([current, peer])
  }
  expect(replies).toHaveLength(1)
})

test('identical mutations remain independent while current inventory failures are not cached', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ code: 'CHANNEL_OPERATION_FAILED' }, { status: 500 }))
  vi.stubGlobal('fetch', fetch)
  const body = { action: 'disconnect' as const, connectionId: 'connection' }
  const mutations = await Promise.allSettled([channelAction(body), channelAction(body)])
  expect(mutations.every(outcome => outcome.status === 'rejected')).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
  await expect(channelInventory()).rejects.toMatchObject({ code: 'CHANNEL_OPERATION_FAILED' })
  await expect(channelInventory()).rejects.toMatchObject({ code: 'CHANNEL_OPERATION_FAILED' })
  expect(fetch).toHaveBeenCalledTimes(4)
})

test('observers starting new inventory reads during invalidation share the new scope', async () => {
  const replies: ((response: Response) => void)[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(resolve => replies.push(resolve)))
  vi.stubGlobal('fetch', fetch)
  const before = channelInventory()
  await vi.waitFor(() => expect(replies).toHaveLength(1))
  const refreshed: Promise<unknown>[] = []
  const first = listenChannelBindingChanges(() => { refreshed.push(channelInventory()) })
  const second = listenChannelBindingChanges(() => { refreshed.push(channelInventory()) })
  try {
    invalidateChannelBindings('gateway-channels')
    refreshed.push(channelInventory())
    await vi.waitFor(() => expect(replies).toHaveLength(2))
  } finally {
    first(); second()
    for (const reply of replies) reply(Response.json(channelFixture()))
    await Promise.all([before, ...refreshed])
  }
})

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

test('settings publication errors stay uncertain even with an old code-only response and never retry', async () => {
  for (const extra of [{}, { externalOutcome: 'unknown', cause: 'PRIVATE_PATH_CANARY' }, { externalOutcome: 'failed' }]) {
    const fetch = vi.fn().mockResolvedValue(Response.json({ code: 'CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED', ...extra }, { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    const pending = channelAction({ action: 'settings', settings: { mirrorClientTurns: true } })
    await expect(pending).rejects.toMatchObject({ code: 'CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED', uncertain: true })
    await expect(pending).rejects.not.toThrow('PRIVATE_PATH_CANARY')
    expect(fetch).toHaveBeenCalledOnce()
  }
})

test('a definite settings rejection does not become uncertain from untrusted response metadata', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ code: 'CHANNEL_SETTINGS_INVALID', externalOutcome: 'unknown' }, { status: 409 }))
  vi.stubGlobal('fetch', fetch)
  await expect(channelAction({ action: 'settings', settings: { mirrorClientTurns: true } })).rejects.toMatchObject({ code: 'CHANNEL_SETTINGS_INVALID', uncertain: false })
  expect(fetch).toHaveBeenCalledOnce()
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

test('inventory accepts old responses and only the approved optional ingress reason', () => {
  const page = channelFixture()
  expect(readChannelInventory(page).connections[0].state).toBe('connected')
  Object.assign(page.connections[0], { reasonCode: 'CHANNEL_INGRESS_FAILED' })
  expect(readChannelInventory(page).connections[0]).toMatchObject({ state: 'connected', reasonCode: 'CHANNEL_INGRESS_FAILED' })
  for (const reasonCode of ['PRIVATE_REASON_CANARY', { packet: 'PRIVATE_PACKET_CANARY' }, 42]) {
    Object.assign(page.connections[0], { reasonCode })
    expect(() => readChannelInventory(page)).toThrow(ChannelRequestError)
  }
})

test('inventory preserves published Weixin reasons only under their platform scope', () => {
  const page = channelFixture('weixin')
  for (const reasonCode of ['PLATFORM_AUTHORIZATION_FAILED', 'PLATFORM_RATE_LIMIT', 'PLATFORM_HTTP_REJECTED', 'PLATFORM_INVALID_JSON',
    'PLATFORM_RESPONSE_TOO_LARGE', 'WEIXIN_PLATFORM_REJECTED', 'WEIXIN_METADATA_FAILED', 'WEIXIN_RECEIPT_FAILED', 'WEIXIN_CONTEXT_FAILED',
    'WEIXIN_INGRESS_FAILED', 'WEIXIN_CHECKPOINT_FAILED', 'WEIXIN_POLL_FAILED']) {
    Object.assign(page.connections[0], { reasonCode })
    expect(readChannelInventory(page).connections[0].reasonCode).toBe(reasonCode)
  }
  const foreign = channelFixture('feishu')
  Object.assign(foreign.connections[0], { reasonCode: 'WEIXIN_POLL_FAILED' })
  expect(() => readChannelInventory(foreign)).toThrow(ChannelRequestError)
})
