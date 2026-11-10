import { installTestTransport, clearTestTransports } from '@/test/runtime-transport'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import {
  connectLocalExecutorToBackend,
  copyLocalExecutorDebugInfo,
  disconnectLocalExecutorFromBackend,
  ensureLocalExecutorStarted,
  readLocalExecutorLog,
  type LocalExecutorLog,
} from '@/host/localExecutor'
import { LocalRuntimeInitializer } from './LocalRuntimeInitializer'

const startDragging = vi.fn().mockResolvedValue(undefined)
vi.mock('@/kcoder/KCoderAccountStartup', () => ({
  KCoderAccountStartup: ({ onChanged }: { onChanged: () => Promise<void> }) => (
    <button data-testid="account-startup" onClick={() => void onChanged()}>
      Sign in
    </button>
  ),
}))

vi.mock('@/host/localExecutor', () => ({
  connectLocalExecutorToBackend: vi.fn(),
  copyLocalExecutorDebugInfo: vi.fn(),
  disconnectLocalExecutorFromBackend: vi.fn(),
  ensureLocalExecutorStarted: vi.fn(),
  readLocalExecutorLog: vi.fn(),
}))


const copyDebugMock = vi.mocked(copyLocalExecutorDebugInfo)
const connectMock = vi.mocked(connectLocalExecutorToBackend)
const disconnectMock = vi.mocked(disconnectLocalExecutorFromBackend)
const ensureMock = vi.mocked(ensureLocalExecutorStarted)
const readLogMock = vi.mocked(readLocalExecutorLog)
const SLOW_STARTUP_WARNING_MS = 10000

function enableGateway() {
  installTestTransport(() => null)
}

function MountProbe({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount()
  }, [onMount])

  return <div data-testid="main-app">Main app</div>
}

function diagnosticLog(path: string): LocalExecutorLog {
  return {
    path, content: 'DIAGNOSTIC_BODY_NOT_FOR_ERROR_SCREEN', truncated: false, lineCount: 1,
    transport: 'stdio', transportConnected: false, processPids: [], processPaths: [],
    sidecarSource: '', sidecarPath: '', currentDir: '', executorHome: '', backendUrl: null,
    hasBackendAuthToken: false, pendingRequestCount: 0, status: { running: false, ready: false },
  }
}

describe('LocalRuntimeInitializer', () => {
  beforeEach(() => {
    enableGateway()
    vi.stubEnv('DEV', false)
    connectMock.mockReset()
    copyDebugMock.mockReset()
    disconnectMock.mockReset()
    ensureMock.mockReset()
    readLogMock.mockReset()
    startDragging.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  test('holds the app on the initialization screen until executor is ready', async () => {
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(screen.getByTestId('local-runtime-initializer')).toBeInTheDocument()
    expect(screen.getByText('正在整理你的工作台')).toBeInTheDocument()
    expect(screen.getByText('KunlunMeta')).toBeInTheDocument()
    expect(screen.getByTestId('kcoder-startup-scene')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByText(/执行器|daemon/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('main-app')).not.toBeInTheDocument()

    expect(await screen.findByTestId('main-app')).toBeInTheDocument()
    expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
  })

  test('offers account login before runtime readiness and retries after authentication', async () => {
    ensureMock
      .mockResolvedValueOnce({ running: true, ready: false, accountLoginServerId: 'remote' })
      .mockResolvedValueOnce({ running: true, ready: true, deviceId: 'remote' })
    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )
    fireEvent.click(await screen.findByTestId('account-startup'))
    expect(await screen.findByTestId('main-app')).toBeInTheDocument()
    expect(ensureMock).toHaveBeenCalledTimes(2)
  })

  test('starts the executor before applying the initial cloud connection', async () => {
    connectMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer
        initialCloudConnection={{
          backendUrl: 'https://backend.example.com',
          isConnected: true,
          token: 'token-a',
        }}
      >
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('main-app')).toBeInTheDocument()
    await waitFor(() =>
      expect(connectMock).toHaveBeenCalledWith({
        backendUrl: 'https://backend.example.com',
        authToken: 'token-a',
      })
    )
    expect(ensureMock.mock.invocationCallOrder[0]).toBeLessThan(
      connectMock.mock.invocationCallOrder[0]
    )
  })

  test('starts the executor before applying disconnected local mode', async () => {
    disconnectMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer
        initialCloudConnection={{
          isConnected: false,
          token: null,
        }}
      >
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('main-app')).toBeInTheDocument()
    await waitFor(() => expect(disconnectMock).toHaveBeenCalledTimes(1))
    expect(ensureMock.mock.invocationCallOrder[0]).toBeLessThan(
      disconnectMock.mock.invocationCallOrder[0]
    )
  })

  test('reveals the app without waiting for initial cloud connection setup', async () => {
    connectMock.mockImplementation(() => new Promise(() => undefined))
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer
        initialCloudConnection={{
          backendUrl: 'https://backend.example.com',
          isConnected: true,
          token: 'token-a',
        }}
      >
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('main-app')).toBeInTheDocument()
    expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(connectMock).toHaveBeenCalledTimes(1)
      expect(ensureMock).toHaveBeenCalledTimes(1)
    })
  })

  test('keeps the app ready when initial cloud connection setup fails', async () => {
    connectMock.mockRejectedValue(new Error('backend setup failed'))
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer
        initialCloudConnection={{
          backendUrl: 'https://backend.example.com',
          isConnected: true,
          token: 'token-a',
        }}
      >
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('main-app')).toBeInTheDocument()
    expect(screen.queryByTestId('local-runtime-error')).not.toBeInTheDocument()
  })

  test('reveals children once executor is ready even while app startup continues', async () => {
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer startupReady={false}>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('main-app')).toBeVisible()
    expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
  })

  test('shows a quiet slow startup hint and offers diagnostics after failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-28T10:30:00Z'))
    let rejectEnsure: ((error: Error) => void) | null = null
    ensureMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectEnsure = reject
        })
    )
    readLogMock.mockResolvedValue({
      path: '~/.wegent-executor/logs/executor.log',
      content: 'executor waiting for stdio via Gateway runtime detail',
      truncated: true,
      lineCount: 20,
      transport: 'stdio',
      transportConnected: false,
      processPids: [1234],
      processPaths: ['/Applications/KCoder Studio.app/Contents/MacOS/wegent-executor'],
      sidecarSource: 'configured',
      sidecarPath: '/Applications/KCoder Studio.app/Contents/MacOS/wegent-executor',
      currentDir: '/Applications/KCoder Studio.app/Contents/MacOS',
      executorHome: '~/.wegent-executor',
      backendUrl: 'https://cloud.example.com',
      hasBackendAuthToken: true,
      pendingRequestCount: 1,
      status: {
        running: true,
        ready: true,
        deviceId: 'local-device',
        version: '1.9.0',
      },
    })
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 Electron/42.0',
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <LocalRuntimeInitializer startupReady={false}>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(screen.getByTestId('local-runtime-slow-startup-help')).toHaveAttribute('aria-hidden', 'true')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_STARTUP_WARNING_MS)
    })

    expect(screen.getByTestId('local-runtime-slow-startup-help')).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByText('仍在启动，请稍候。')).toBeVisible()
    expect(screen.queryByTestId('local-runtime-copy-debug-button')).not.toBeInTheDocument()

    await act(async () => {
      rejectEnsure?.(new Error('executor startup failed'))
    })
    const diagnostics = screen.getByText('诊断详情').closest('details')!
    expect(diagnostics).not.toHaveAttribute('open')
    diagnostics.open = true
    await act(async () => {
      fireEvent.click(screen.getByTestId('local-runtime-copy-debug-button'))
    })

    expect(readLogMock).toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Startup phase: failed'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Startup check: failed'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('IPC transport: stdio'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('IPC connected: false'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Executor PID(s): 1234'))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        'Executor process path(s): /Applications/KCoder Studio.app/Contents/MacOS/wegent-executor'
      )
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Executor launch source: configured')
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        'Executor launch path: /Applications/KCoder Studio.app/Contents/MacOS/wegent-executor'
      )
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Current working directory: /Applications/KCoder Studio.app/Contents/MacOS')
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Executor home: ~/.wegent-executor')
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Backend URL: https://cloud.example.com')
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Backend auth token configured: true')
    )
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Pending request count: 1'))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        'Local executor status: running=true ready=true deviceId=local-device version=1.9.0 error=none'
      )
    )
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Executor log lines: last 20'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('executor waiting for stdio'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('via Gateway runtime detail'))
    expect(screen.getByTestId('local-runtime-copy-debug-button')).toHaveTextContent('已复制')

  })

  test('copies debug details through native app fallback when Web Clipboard is unavailable', async () => {
    ensureMock.mockRejectedValue(new Error('connect timed out'))
    readLogMock.mockResolvedValue({
      path: '~/.wegent-executor/logs/executor.log',
      content: 'executor native clipboard path',
      truncated: false,
      lineCount: 1,
      transport: 'stdio',
      transportConnected: false,
      processPids: [],
      processPaths: [],
      sidecarSource: 'bundled',
      sidecarPath: 'wegent-executor',
      currentDir: '/tmp/wework',
      executorHome: '~/.wegent-executor',
      backendUrl: null,
      hasBackendAuthToken: false,
      pendingRequestCount: 0,
      status: {
        running: false,
        ready: false,
        error: 'connect timed out',
      },
    })
    copyDebugMock.mockResolvedValue(undefined)
    delete (navigator as unknown as { clipboard?: Clipboard }).clipboard

    render(
      <LocalRuntimeInitializer startupReady={false}>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    const summary = await screen.findByText('诊断详情')
    summary.closest('details')!.open = true
    await act(async () => {
      fireEvent.click(screen.getByTestId('local-runtime-copy-debug-button'))
    })

    expect(copyDebugMock).toHaveBeenCalledWith(
      expect.stringContaining('executor native clipboard path')
    )
    expect(screen.getByTestId('local-runtime-copy-debug-button')).toHaveTextContent('已复制')
  })

  test('keeps the startup screen titlebar draggable while executor is starting', async () => {
    ensureMock.mockImplementation(() => new Promise(() => undefined))

    render(
      <LocalRuntimeInitializer startupReady={false}>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    const dragRegion = within(screen.getByTestId('local-runtime-titlebar-drag-region')).getByTestId(
      'macos-titlebar-drag-region'
    )
    expect(dragRegion).toHaveAttribute('data-kcoder-drag-region')

    fireEvent.mouseDown(dragRegion, { button: 0 })

    expect(dragRegion).toHaveClass('[-webkit-app-region:drag]')
  })

  test('does not remount children when the startup screen is dismissed', async () => {
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })
    const onMount = vi.fn()

    const { rerender } = render(
      <LocalRuntimeInitializer startupReady={false}>
        <MountProbe onMount={onMount} />
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('main-app')).toBeVisible()
    await waitFor(() => expect(onMount).toHaveBeenCalledTimes(1))

    rerender(
      <LocalRuntimeInitializer startupReady>
        <MountProbe onMount={onMount} />
      </LocalRuntimeInitializer>
    )

    await waitFor(() =>
      expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('main-app')).toBeVisible()
    expect(onMount).toHaveBeenCalledTimes(1)
  })

  test('reveals the app immediately when the executor is ready in dev mode', async () => {
    vi.stubEnv('DEV', true)
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('main-app')).toBeVisible()
    expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
  })

  test('shows startup error and retries initialization', async () => {
    ensureMock
      .mockRejectedValueOnce(new Error('stdio unavailable'))
      .mockResolvedValueOnce({ running: true, ready: true, deviceId: 'local-device' })
    readLogMock.mockRejectedValue(new Error('app-server disconnected'))

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('local-runtime-error')).toHaveTextContent('stdio unavailable')
    expect(screen.queryByTestId('local-runtime-log-path')).not.toBeInTheDocument()
    expect(screen.queryByText('~/.wegent-executor/logs/executor.log')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('local-runtime-retry-button'))

    await waitFor(() => expect(screen.getByTestId('main-app')).toBeInTheDocument())
  })

  test('shows only the diagnostic path returned by the backend without rendering log contents', async () => {
    ensureMock.mockRejectedValue(new Error('app-server disconnected'))
    readLogMock.mockResolvedValue(diagnosticLog('D:\\KCoder Studio\\logs\\startup.log'))
    render(<LocalRuntimeInitializer><div>Main app</div></LocalRuntimeInitializer>)
    expect(await screen.findByTestId('local-runtime-log-path')).toHaveTextContent('D:\\KCoder Studio\\logs\\startup.log')
    expect(screen.getByTestId('local-runtime-error')).toHaveTextContent('app-server disconnected')
    expect(screen.queryByText('DIAGNOSTIC_BODY_NOT_FOR_ERROR_SCREEN')).not.toBeInTheDocument()
  })

  test.each(['', '   '])('omits an unavailable backend diagnostic path (%j)', async path => {
    ensureMock.mockRejectedValue(new Error('app-server disconnected'))
    readLogMock.mockResolvedValue(diagnosticLog(path))
    render(<LocalRuntimeInitializer><div>Main app</div></LocalRuntimeInitializer>)
    expect(await screen.findByTestId('local-runtime-error')).toHaveTextContent('app-server disconnected')
    await waitFor(() => expect(readLogMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('local-runtime-log-path')).not.toBeInTheDocument()
    expect(screen.queryByText('~/.wegent-executor/logs/executor.log')).not.toBeInTheDocument()
  })

  test('ignores a diagnostic path from the failed attempt after retry succeeds', async () => {
    let resolveLog!: (log: LocalExecutorLog) => void
    readLogMock.mockImplementation(() => new Promise(resolve => { resolveLog = resolve }))
    ensureMock.mockRejectedValueOnce(new Error('app-server disconnected'))
      .mockResolvedValueOnce({ running: true, ready: true, deviceId: 'local-device' })
    render(<LocalRuntimeInitializer><div data-testid="main-app">Main app</div></LocalRuntimeInitializer>)
    await screen.findByTestId('local-runtime-error')
    fireEvent.click(screen.getByTestId('local-runtime-retry-button'))
    await screen.findByTestId('main-app')
    await act(async () => { resolveLog(diagnosticLog('D:\\old-attempt\\startup.log')) })
    expect(screen.queryByTestId('local-runtime-log-path')).not.toBeInTheDocument()
    expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
  })

  test.each(['empty', 'failed'])('still copies diagnostics without inventing a log path when read is %s', async result => {
    ensureMock.mockRejectedValue(new Error('executor startup failed'))
    if (result === 'empty') readLogMock.mockResolvedValue(diagnosticLog(''))
    else readLogMock.mockRejectedValue(new Error('app-server disconnected'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<LocalRuntimeInitializer><div>Main app</div></LocalRuntimeInitializer>)
    const summary = await screen.findByText('诊断详情')
    summary.closest('details')!.open = true
    await act(async () => { fireEvent.click(screen.getByTestId('local-runtime-copy-debug-button')) })
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Startup phase: failed'))
    expect(writeText).toHaveBeenCalledWith(expect.not.stringContaining('Executor log path:'))
    expect(writeText).toHaveBeenCalledWith(expect.not.stringContaining('~/.wegent-executor/logs/executor.log'))
    if (result === 'failed') expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Failed to read executor log: app-server disconnected'))
    expect(screen.getByTestId('local-runtime-copy-debug-button')).toHaveTextContent('已复制')
  })

  test('uses friendly local runtime status errors', async () => {
    ensureMock.mockResolvedValue({ running: false, ready: false, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('local-runtime-error')).toHaveTextContent(
      '本机工作台服务还没有启动'
    )
  })

  test('does not block non-gateway runtimes', () => {
    clearTestTransports()

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(screen.getByTestId('main-app')).toBeInTheDocument()
    expect(ensureMock).not.toHaveBeenCalled()
  })
})
