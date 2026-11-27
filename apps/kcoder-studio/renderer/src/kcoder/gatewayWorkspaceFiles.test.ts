import { expect, test, vi } from 'vitest'
import { requestWorkspaceFiles } from './gatewayWorkspaceFiles'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

test.each([false, true])(
  'workspace receipt stays bound to target identity (changed=%s)',
  async changed => {
    let target = {
      id: 'upload-remote',
      transport: 'ssh' as const,
      host: 'original-host',
      user: 'original-user',
      workspacePath: '/workspace',
    }
    const client = {
      supportsExperimental: () => true,
      request: async () => {
        target = { ...target, host: changed ? 'new-host' : target.host }
        return { receipt: 'original-owner' }
      },
    }
    const scope = {
      disposed: false,
      serverForParams: vi.fn(async () => target),
      commandClient: vi.fn(async () => client),
    } as unknown as GatewayRuntimeCore
    const result = requestWorkspaceFiles.call(
      scope,
      {
        deviceId: target.id,
        workspacePath: '/workspace',
        method: 'attachment/upload/start',
        params: {},
      },
      () => true
    )
    if (changed) await expect(result).rejects.toThrow(/changed|切换/)
    else
      await expect(result).resolves.toMatchObject({
        receipt: 'original-owner',
        scopeToken: expect.any(String),
      })
  }
)

test('client replacement between chunks rejects the old scope before sending resource identities', async () => {
  const first = {
    supportsExperimental: () => true,
    request: vi.fn(async () => ({ upload_id: 'owned-id' })),
  }
  const second = { supportsExperimental: () => true, request: vi.fn(async () => ({})) }
  let client: object = first
  const scope = {
    disposed: false,
    serverForParams: async () => ({ id: 'remote', transport: 'ssh', host: 'same-host' }),
    commandClient: async () => client,
  } as unknown as GatewayRuntimeCore
  const params = {
    deviceId: 'remote',
    workspacePath: '/workspace',
    method: 'attachment/upload/start',
    params: {},
  }
  const started = (await requestWorkspaceFiles.call(scope, params, () => true)) as {
    scopeToken: string
  }
  client = second
  await expect(
    requestWorkspaceFiles.call(
      scope,
      {
        ...params,
        method: 'attachment/upload/chunk',
        expectedScopeToken: started.scopeToken,
        params: { upload_id: 'owned-id' },
      },
      () => true
    )
  ).rejects.toThrow(/changed|切换/)
  expect(second.request).not.toHaveBeenCalled()
})
