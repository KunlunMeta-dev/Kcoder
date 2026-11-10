import { installTestTransport, clearTestTransports } from '@/test/runtime-transport'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke } from '@/lib/runtime-commands'
import { listen } from '@/lib/runtime-events'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  isLocalTerminalAvailable,
  listenLocalTerminalExit,
  listenLocalTerminalOutput,
  getLocalPathKind,
  localPathExists,
  openLocalFile,
  openLocalWorkspace,
  resizeLocalTerminal,
  startLocalTerminal,
  writeLocalTerminal,
} from './local-terminal'

vi.mock('@/lib/runtime-commands', () => ({
  isGateway: vi.fn(() => false),
  invoke: vi.fn(),
}))

vi.mock('@/lib/runtime-events', () => ({
  listen: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)

function setNavigatorValue<K extends keyof Navigator>(key: K, value: Navigator[K]) {
  Object.defineProperty(navigator, key, {
    configurable: true,
    value,
  })
}

describe('local-terminal', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  afterEach(() => {
    clearTestTransports()
  })

  test('is available only with an active desktop Gateway', () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    installTestTransport(() => null)

    expect(isLocalTerminalAvailable()).toBe(true)
  })

  test('is unavailable for regular browsers even on macOS', () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)

    expect(isLocalTerminalAvailable()).toBe(false)
  })

  test('is unavailable on iOS even with a Gateway transport', () => {
    setNavigatorValue('userAgent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
    setNavigatorValue('platform', 'iPhone')
    installTestTransport(() => null)

    expect(isLocalTerminalAvailable()).toBe(false)
  })

  test('reads the local executor device id from the native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    installTestTransport(() => null)
    invokeMock.mockResolvedValue(' local-device-1 ')

    await expect(getLocalExecutorDeviceId(' http://localhost:8000/api ')).resolves.toBe(
      'local-device-1'
    )
    expect(invokeMock).toHaveBeenCalledWith('get_local_executor_device_id', {
      expectedBackendUrl: 'http://localhost:8000/api',
    })
  })

  test('does not read the local executor device id in regular browsers', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)

    await expect(getLocalExecutorDeviceId()).resolves.toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('checks local project path existence through the native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    installTestTransport(() => null)
    invokeMock.mockResolvedValue(true)

    await expect(localPathExists(' /Users/me/project ')).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('local_path_exists', {
      path: '/Users/me/project',
    })
  })

  test('does not check local project paths in regular browsers', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)

    await expect(localPathExists('/Users/me/project')).resolves.toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('reads local path kinds through the native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    installTestTransport(() => null)
    invokeMock.mockResolvedValue('directory')

    await expect(getLocalPathKind(' /Users/me/tmp ')).resolves.toBe('directory')
    expect(invokeMock).toHaveBeenCalledWith('get_local_path_kind', {
      path: '/Users/me/tmp',
    })
  })

  test('starts an embedded local terminal session through the native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    installTestTransport(() => null)
    invokeMock.mockResolvedValue('local-terminal-1')

    await expect(
      startLocalTerminal({ cwd: ' /Users/me/project ', rows: 30, cols: 100 })
    ).resolves.toBe('local-terminal-1')
    expect(invokeMock).toHaveBeenCalledWith('start_local_terminal', {
      cwd: '/Users/me/project',
      rows: 30,
      cols: 100,
    })
  })

  test('passes sanitized context env when starting an embedded local terminal', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    installTestTransport(() => null)
    invokeMock.mockResolvedValue('local-terminal-1')

    await expect(
      startLocalTerminal({
        cwd: '/Users/me/project',
        env: {
          KCODER_STUDIO_PARENT_TITLE: 'Task A',
          ' BAD=KEY ': 'ignored',
          EMPTY_VALUE: null,
        },
      })
    ).resolves.toBe('local-terminal-1')
    expect(invokeMock).toHaveBeenCalledWith('start_local_terminal', {
      cwd: '/Users/me/project',
      rows: undefined,
      cols: undefined,
      env: {
        KCODER_STUDIO_PARENT_TITLE: 'Task A',
      },
    })
  })

  test('opens a local workspace through the selected native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    installTestTransport(() => null)
    invokeMock.mockResolvedValue(undefined)

    await openLocalWorkspace({ opener: 'vscode', path: ' /Users/me/project ' })

    expect(invokeMock).toHaveBeenCalledWith('open_local_workspace', {
      opener: 'vscode',
      path: '/Users/me/project',
    })
  })

  test('opens a local file with the native default app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    installTestTransport(() => null)
    invokeMock.mockResolvedValue(undefined)

    await openLocalFile(' /Users/me/project/.wegent/attachments/draft/1/paste.txt ')

    expect(invokeMock).toHaveBeenCalledWith('open_local_file', {
      path: '/Users/me/project/.wegent/attachments/draft/1/paste.txt',
    })
  })

  test('does not open a local workspace without an active Gateway connection', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)

    await expect(
      openLocalWorkspace({ opener: 'vscode', path: '/Users/me/project' })
    ).rejects.toThrow('Local workspace opening is unavailable without an active Gateway connection')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('writes, resizes, and closes embedded local terminal sessions', async () => {
    invokeMock.mockResolvedValue(undefined)

    await writeLocalTerminal('local-terminal-1', 'pwd\r')
    await resizeLocalTerminal('local-terminal-1', 40, 120)
    await closeLocalTerminal('local-terminal-1')

    expect(invokeMock).toHaveBeenCalledWith('write_local_terminal', {
      sessionId: 'local-terminal-1',
      data: 'pwd\r',
    })
    expect(invokeMock).toHaveBeenCalledWith('resize_local_terminal', {
      sessionId: 'local-terminal-1',
      rows: 40,
      cols: 120,
    })
    expect(invokeMock).toHaveBeenCalledWith('close_local_terminal', {
      sessionId: 'local-terminal-1',
    })
  })

  test('listens to embedded local terminal native events', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    const outputHandler = vi.fn()
    const exitHandler = vi.fn()

    await listenLocalTerminalOutput(outputHandler)
    await listenLocalTerminalExit(exitHandler)

    expect(listenMock).toHaveBeenCalledWith('local-terminal-output', expect.any(Function))
    expect(listenMock).toHaveBeenCalledWith('local-terminal-exit', expect.any(Function))
  })
})
