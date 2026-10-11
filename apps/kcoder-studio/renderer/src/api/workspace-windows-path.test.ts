import { expect, test, vi } from 'vitest'
import { createDeviceApi } from './devices'
import { createLocalAppServices } from './local/localServices'

test.each(['relay', 'local'] as const)(
  '%s file tree accepts native Windows namespaces and rejects escaped entries',
  async mode => {
    const response = {
      success: true,
      stdout: {
        path: '\\\\?\\D:\\slime',
        entries: [
          {
            name: 'file.txt',
            path: '\\\\?\\D:\\slime\\file.txt',
            is_directory: false,
            size: 3,
            modified_at: null,
          },
        ],
      },
      stderr: '',
    }
    const call = vi.fn().mockImplementation(async () => response)
    const api =
      mode === 'relay'
        ? createDeviceApi({ post: call } as never)
        : createLocalAppServices({
            ensure: async () => ({ running: true, ready: true, deviceId: 'device' }),
            request: call,
            subscribe: async () => () => {},
          }).deviceApi
    const result = await api.listWorkspaceEntries('device', '\\\\?\\D:\\slime')
    expect(result.path).toBe('D:/slime')
    expect(result.entries[0].path).toBe('D:/slime/file.txt')
    expect(call.mock.calls[0][1]).toMatchObject({ path: 'D:/slime' })
    response.stdout.entries[0].path = 'D:\\slime\\..\\secret.txt'
    await expect(api.listWorkspaceEntries('device', 'D:\\slime')).rejects.toThrow(
      'Invalid workspace tree response'
    )
  }
)

test.each(['relay', 'local'] as const)(
  '%s file reads preserve absolute drive-root parent',
  async mode => {
    const call = vi.fn().mockResolvedValue({
      success: true,
      stdout: {
        path: '\\\\?\\D:\\file.txt',
        name: 'file.txt',
        content: 'abc',
        truncated: false,
        size: 3,
        modified_at: null,
      },
      stderr: '',
    })
    const api =
      mode === 'relay'
        ? createDeviceApi({ post: call } as never)
        : createLocalAppServices({
            ensure: async () => ({ running: true, ready: true, deviceId: 'device' }),
            request: call,
            subscribe: async () => () => {},
          }).deviceApi
    const result = await api.readWorkspaceTextFile('device', '\\\\?\\D:\\file.txt')
    expect(result.content).toBe('abc')
    expect(call.mock.calls[0][1]).toMatchObject({ path: 'D:/', args: ['file.txt'] })
  }
)
