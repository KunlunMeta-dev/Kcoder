import { expect, test, vi } from 'vitest'
import type { GatewayClient } from './gatewayRuntimeTypes'
import { startTaskThread } from './gatewayTemporaryThread'

test('temporary creation requests a real ephemeral fork without UI transcript text', async () => {
  const request = vi.fn().mockResolvedValue({ thread: { id: 'child' }, ephemeral: true })
  const client = { request, supportsExperimental: () => true } as unknown as GatewayClient
  await startTaskThread(client, {
    serverId: 'local',
    workspacePath: '/workspace',
    params: {
      ephemeral: true,
      sideSource: {
        deviceId: 'local',
        workspacePath: '/workspace',
        runtimeHandle: { threadId: 'source' },
      },
    },
  })
  expect(request).toHaveBeenCalledExactlyOnceWith('thread/fork', {
    threadId: 'source',
    cwd: '/workspace',
    ephemeral: true,
  })
})

test('unsupported temporary forks fail closed rather than creating blank threads', async () => {
  const request = vi.fn()
  const client = { request, supportsExperimental: () => false } as unknown as GatewayClient
  await expect(
    startTaskThread(client, {
      serverId: 'local',
      workspacePath: '/workspace',
      params: {
        ephemeral: true,
        sideSource: { deviceId: 'local', threadId: 'source' },
      },
    })
  ).rejects.toThrow('临时')
  expect(request).not.toHaveBeenCalled()
})

test('temporary forks accept Windows aliases without changing the requested path or server boundary', async () => {
  const request = vi.fn().mockResolvedValue({ thread: { id: 'child' }, ephemeral: true })
  const client = { request, supportsExperimental: () => true } as unknown as GatewayClient
  const workspacePath = String.raw`\\?\D:\project`
  await startTaskThread(client, {
    serverId: 'local',
    workspacePath,
    params: {
      ephemeral: true,
      sideSource: { deviceId: 'local', threadId: 'source', workspacePath: 'd:/project' },
    },
  })
  expect(request).toHaveBeenCalledWith('thread/fork', {
    threadId: 'source',
    cwd: workspacePath,
    ephemeral: true,
  })
  request.mockClear()
  for (const [deviceId, path] of [
    ['other', 'd:/project'],
    ['local', 'd:/other'],
    ['local', '/srv/project'],
  ]) {
    await expect(
      startTaskThread(client, {
        serverId: 'local',
        workspacePath,
        params: {
          ephemeral: true,
          sideSource: { deviceId, threadId: 'source', workspacePath: path },
        },
      })
    ).rejects.toThrow()
  }
  expect(request).not.toHaveBeenCalled()
})

test('temporary forks cannot silently cross servers or discard the source', async () => {
  const request = vi.fn()
  const client = { request, supportsExperimental: () => true } as unknown as GatewayClient
  for (const sideSource of [undefined, { deviceId: 'other', threadId: 'source' }]) {
    await expect(
      startTaskThread(client, {
        serverId: 'local',
        workspacePath: '/workspace',
        params: { ephemeral: true, sideSource },
      })
    ).rejects.toThrow()
  }
  expect(request).not.toHaveBeenCalled()
})

test('new sessions carry the chosen settings template into thread/start', async () => {
  const request = vi.fn().mockResolvedValue({ thread: { id: 'thread-1' } })
  const client = { request, supportsExperimental: () => true } as unknown as GatewayClient
  await startTaskThread(client, {
    serverId: 'local',
    workspacePath: '/workspace',
    params: { settingsTemplate: 'fast-local' },
  })
  expect(request).toHaveBeenCalledExactlyOnceWith('thread/start', {
    cwd: '/workspace',
    settingsTemplate: 'fast-local',
  })

  request.mockClear()
  await startTaskThread(client, {
    serverId: 'local',
    workspacePath: '/workspace',
    params: {},
  })
  expect(request).toHaveBeenCalledExactlyOnceWith('thread/start', { cwd: '/workspace' })
})

test('unsupported settings templates fail closed instead of silently ignoring the choice', async () => {
  const request = vi.fn()
  const client = {
    request,
    supportsExperimental: (flag: string) => flag !== 'settingsTemplatesV1',
  } as unknown as GatewayClient
  await expect(
    startTaskThread(client, {
      serverId: 'local',
      workspacePath: '/workspace',
      params: { settingsTemplate: 'fast-local' },
    })
  ).rejects.toThrow('会话配置模板')
  expect(request).not.toHaveBeenCalled()
})
