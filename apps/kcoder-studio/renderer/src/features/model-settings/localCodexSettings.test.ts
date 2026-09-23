import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getLocalCodexPersonality, saveLocalCodexPersonality } from './localCodexSettings'

const requestLocalExecutor = vi.fn()

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn().mockResolvedValue(undefined),
  requestLocalExecutor: (...args: unknown[]) => requestLocalExecutor(...args),
}))

describe('localCodexSettings', () => {
  beforeEach(() => requestLocalExecutor.mockReset())

  test('reads personality from Codex config', async () => {
    requestLocalExecutor.mockResolvedValue({ personality: 'friendly' })
    await expect(getLocalCodexPersonality()).resolves.toBe('friendly')
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.personality.read')
  })

  test('writes personality through Codex app-server', async () => {
    requestLocalExecutor.mockResolvedValue({ personality: 'friendly' })
    await expect(saveLocalCodexPersonality('friendly')).resolves.toBe('friendly')
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.personality.write', {
      personality: 'friendly',
    })
  })

  test('routes personality reads and writes to an explicit runtime target', async () => {
    requestLocalExecutor.mockResolvedValue({ personality: 'friendly' })
    await getLocalCodexPersonality('server-b')
    await saveLocalCodexPersonality('friendly', 'server-b')
    expect(requestLocalExecutor.mock.calls).toEqual([
      ['runtime.codex.personality.read', { deviceId: 'server-b' }],
      ['runtime.codex.personality.write', { personality: 'friendly', deviceId: 'server-b' }],
    ])
  })

  test('defaults unsupported responses to pragmatic', async () => {
    requestLocalExecutor.mockResolvedValue({ personality: 'unknown' })
    await expect(getLocalCodexPersonality()).resolves.toBe('pragmatic')
  })
})
