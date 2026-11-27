import { expect, test, vi } from 'vitest'
import { readWorkspaceFileChunk } from './gatewayWorkspaceFileChunks'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type { GatewayServer } from './gatewayRpc'

function fixture(supported: boolean | undefined) {
  let server: GatewayServer = {
    id: 'remote',
    transport: 'ssh',
    label: 'Remote',
    host: 'original-host',
    workspacePath: '/workspace',
  }
  const client = {
    supportsExperimental:
      supported === undefined
        ? undefined
        : (capability: string) => (capability === 'workspaceBinaryRevisionV1' ? supported : true),
    request: vi.fn(async () => ({ success: true, stdout: { revision: 'opaque-first', size: 4 } })),
  }
  let activeClient = client
  const core = {
    disposed: false,
    compatibility: { fileWorkspace: () => '/workspace' },
    serverForParams: vi.fn(async () => server),
    commandClient: vi.fn(async () => activeClient),
  } as unknown as GatewayRuntimeCore
  const params = {
    deviceId: 'remote',
    command_key: 'workspace_read_file_chunk',
    path: '/workspace',
    args: ['preview.pdf', '0'],
  }
  return {
    core,
    client,
    params,
    server: () => server,
    changeTarget: (fields: Partial<GatewayServer>) => {
      server = { ...server, ...fields }
    },
    replaceClient: () => {
      activeClient = { ...client, request: vi.fn(client.request) }
    },
    read: (extra: Record<string, unknown> = {}) =>
      readWorkspaceFileChunk.call(core, server, { ...params, ...extra }),
  }
}

test('negotiated chunks expose the revision guarantee and send the pinned revision unchanged', async () => {
  const host = fixture(true)
  await expect(host.read({ expected_revision: 'opaque-first' })).resolves.toMatchObject({
    stdout: { revision: 'opaque-first', revision_supported: true },
  })
  expect(host.client.request).toHaveBeenCalledWith('device/execute', {
    ...host.params,
    expected_revision: 'opaque-first',
  })
})

test.each([false, undefined])(
  'an unnegotiated target cannot expose a revision or accept a pinned continuation (%s)',
  async supported => {
    const host = fixture(supported)
    const result = await host.read()
    expect(result.stdout).toMatchObject({ revision_supported: false })
    expect(result.stdout).not.toHaveProperty('revision')
    host.client.request.mockClear()
    await expect(host.read({ expected_revision: 'opaque-first' })).rejects.toThrow(
      /no longer supports|不再支持/
    )
    expect(host.client.request).not.toHaveBeenCalled()
  }
)

test.each(['opaque-replaced', '', undefined])(
  'a supported target cannot silently return a different or missing pinned revision (%s)',
  async revision => {
    const host = fixture(true)
    host.client.request.mockResolvedValueOnce({
      success: true,
      stdout: { revision, size: 4 },
    } as never)
    await expect(host.read({ expected_revision: 'opaque-first' })).rejects.toThrow(
      /workspace_file_changed:|Invalid.*revision/
    )
  }
)

test.each([
  { host: 'replacement-host' },
  { authorityId: 'replacement-authority' },
  {
    accountIdentity: {
      principalId: 'replacement-account',
      username: 'other',
      role: 'user' as const,
    },
  },
])('a target/account change while reading rejects the old receipt: %j', async change => {
  const host = fixture(true)
  host.client.request.mockImplementationOnce(async () => {
    host.changeTarget(change)
    return { success: true, stdout: { revision: 'opaque-first', size: 4 } }
  })
  await expect(host.read()).rejects.toThrow(/target changed|预览目标已变化/)
})

test('replacing the connection while a read is pending rejects its old receipt', async () => {
  const host = fixture(true)
  host.client.request.mockImplementationOnce(async () => {
    host.replaceClient()
    return { success: true, stdout: { revision: 'opaque-first', size: 4 } }
  })
  await expect(host.read()).rejects.toThrow(/target changed|预览目标已变化/)
})

test('transport failure is preserved instead of pretending the file changed', async () => {
  const host = fixture(true)
  host.client.request.mockRejectedValueOnce(new Error('Gateway connection closed'))
  await expect(host.read()).rejects.toThrow('Gateway connection closed')
})
