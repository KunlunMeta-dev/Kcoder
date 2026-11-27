import { expect, test, vi } from 'vitest'
import { browserProfiles } from './gatewayBrowserProfiles'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import { notifyAccountContextChange } from './accountContextEvents'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./gatewayIntegrations', () => ({ requestNativeIntegration: request }))
const scope = {
  accountId: 'account',
  targetId: 'native',
  workspaceId: null,
  identityGeneration: 'g',
  targetRevision: 'r',
}
const server = { id: 'target', label: 'Target', transport: 'local', workspacePath: '/workspace' }
const runtime = () =>
  ({
    disposed: false,
    workspaceScanGeneration: 0,
    serverForBrowserLabel: vi.fn(async () => server),
    commandClient: vi.fn(async () => ({ supportsExperimental: () => true })),
  }) as unknown as GatewayRuntimeCore

test('binds catalog reads to the actual browser label target and validates Native pages', async () => {
  request
    .mockReset()
    .mockResolvedValueOnce(scope)
    .mockResolvedValueOnce({
      status: 'completed',
      result: { page: { items: [], nextCursor: null } },
    })
  const host = runtime()
  const result = await browserProfiles.call(host, {
    label: 'owned-task-browser',
    action: 'list',
    payload: {},
  })
  expect(host.serverForBrowserLabel).toHaveBeenCalledWith('owned-task-browser')
  expect(result).toEqual({
    available: true,
    targetId: 'target',
    targetLabel: 'Target',
    scope,
    page: { items: [], nextCursor: null },
  })
  expect(request.mock.calls[1][0]).toMatchObject({
    serverId: 'target',
    workspacePath: '/workspace',
    params: { scope, payload: {} },
  })
})

test('legacy targets and stale owner drafts cannot dispatch a write', async () => {
  request.mockReset()
  const host = runtime()
  vi.mocked(host.commandClient).mockResolvedValueOnce({
    supportsExperimental: () => false,
  } as never)
  await expect(browserProfiles.call(host, { action: 'list', payload: {} })).resolves.toMatchObject({
    available: false,
  })
  expect(request).not.toHaveBeenCalled()
  request.mockResolvedValueOnce(scope)
  await expect(
    browserProfiles.call(host, {
      action: 'save',
      scope: { ...scope, identityGeneration: 'old' },
      operationId: 'save',
      payload: {},
    })
  ).rejects.toThrow('OWNER_CHANGED')
  expect(request).toHaveBeenCalledTimes(1)
})

test('an account switch during scope lookup discards its late result', async () => {
  let complete!: (value: unknown) => void
  request.mockReset().mockImplementationOnce(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  const host = runtime()
  const pending = browserProfiles.call(host, { action: 'list', payload: {} })
  const failure = expect(pending).rejects.toThrow('OWNER_CHANGED')
  while (!complete) await Promise.resolve()
  notifyAccountContextChange('target')
  complete(scope)
  await failure
  expect(request).toHaveBeenCalledTimes(1)
})
