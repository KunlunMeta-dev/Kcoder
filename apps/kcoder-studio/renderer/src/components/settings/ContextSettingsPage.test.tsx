import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppPreferences } from '@/host/appPreferences'
import { GatewayRpcError, type GatewayServer } from '@/kcoder/gatewayRpc'
import { ContextSettingsPage } from './ContextSettingsPage'

const defaultPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  experimentalFeaturesEnabled: false,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'studio',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
}

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const getLocalCodexInstructionsMock = vi.hoisted(() => vi.fn())
const saveLocalCodexInstructionsMock = vi.hoisted(() => vi.fn())
const getLocalCodexPersonalityMock = vi.hoisted(() => vi.fn())
const saveLocalCodexPersonalityMock = vi.hoisted(() => vi.fn())
const ensureLocalExecutorStartedMock = vi.hoisted(() => vi.fn())
const requestLocalExecutorMock = vi.hoisted(() => vi.fn())
const translateMock = vi.hoisted(() => (key: string, fallback?: string) => fallback ?? key)

const targetCatalog = vi.hoisted(() => ({ targets: [] as GatewayServer[], loading: false,
  error: null as string | null, refresh: vi.fn() }))
vi.mock('@/features/runtime-target/useRuntimeSettingsTargets', () => ({ useRuntimeSettingsTargets: () => targetCatalog }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => {
    resolve = next
  })
  return { promise, resolve }
}

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translateMock,
  }),
}))

// Notes directory ownership is covered by its component suite and browser integration.
vi.mock('./ImportedMemorySettings', () => ({ ImportedMemorySettings: () => null }))

vi.mock('@/kcoder/toolProfiles', () => ({
  TOOL_PROFILES: ['full', 'core', 'nano', 'none'],
  readToolProfile: vi.fn(async () => ({
    profile: 'full',
    effectiveProfile: 'full',
    cliOverride: null,
  })),
  saveToolProfile: vi.fn(),
}))

vi.mock('@/host/appPreferences', () => ({
  defaultAppPreferences: {
    closeToTrayEnabled: true,
    showMainWindowOnLaunch: true,
    preventSleepWhileTasksRunning: true,
    closeToTrayHintSeen: false,
    language: 'zh-CN',
    terminalContextInjectionEnabled: true,
    experimentalFeaturesEnabled: false,
    taskCompletionNotificationsEnabled: false,
    trayUnreadEnabled: true,
    trayRunningEnabled: true,
    trayUsageEnabled: true,
    appshotsPlaySound: true,
  },
  getAppPreferences: getAppPreferencesMock,
  updateAppPreferences: updateAppPreferencesMock,
}))

vi.mock('@/api/local/codexInstructions', () => ({
  getLocalCodexInstructions: getLocalCodexInstructionsMock,
  saveLocalCodexInstructions: saveLocalCodexInstructionsMock,
}))

vi.mock('@/host/localExecutor', () => ({
  ensureLocalExecutorStarted: ensureLocalExecutorStartedMock,
  requestLocalExecutor: requestLocalExecutorMock,
}))

vi.mock('@/features/model-settings/localCodexSettings', () => ({
  DEFAULT_CODEX_PERSONALITY: 'pragmatic',
  getLocalCodexPersonality: getLocalCodexPersonalityMock,
  saveLocalCodexPersonality: saveLocalCodexPersonalityMock,
}))

describe('ContextSettingsPage', () => {
  beforeEach(() => {
    targetCatalog.targets = ['custom-host', 'gateway-a', 'peer', 'server-a', 'server-b'].map(id => ({
      id, label: id, transport: 'local', profile: 'first',
      accountIdentity: { principalId: 'account-a', username: 'fixture-a', role: 'user' },
    }))
    targetCatalog.loading = false
    targetCatalog.error = null
    targetCatalog.refresh.mockReset().mockResolvedValue(undefined)
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    getLocalCodexInstructionsMock.mockReset()
    saveLocalCodexInstructionsMock.mockReset()
    getLocalCodexPersonalityMock.mockReset()
    saveLocalCodexPersonalityMock.mockReset()
    ensureLocalExecutorStartedMock.mockReset().mockResolvedValue({ running: true })
    requestLocalExecutorMock.mockReset()
    document.head.querySelector('meta[name="kcoder-rpc-token"]')?.remove()
    getAppPreferencesMock.mockResolvedValue(defaultPreferences)
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...defaultPreferences, ...patch })
    )
    getLocalCodexInstructionsMock.mockResolvedValue({
      instructions: 'Always answer in concise Chinese.',
      configPath: '/Users/example/.codex/config.toml',
    })
    saveLocalCodexInstructionsMock.mockImplementation((instructions: string) =>
      Promise.resolve({ instructions, configPath: '/Users/example/.codex/config.toml' })
    )
    getLocalCodexPersonalityMock.mockResolvedValue('pragmatic')
    saveLocalCodexPersonalityMock.mockImplementation(personality => Promise.resolve(personality))
  })

  test('saves terminal context injection preference', async () => {
    render(<ContextSettingsPage />)

    const toggle = await screen.findByTestId('context-terminal-injection-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        terminalContextInjectionEnabled: false,
      })
    })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  test('waits for actual local host metadata and then loads its configuration without a target click', async () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="kcoder-rpc-token" content="test-token">')
    requestLocalExecutorMock.mockResolvedValue({ instructions: 'Current host instructions', configPath: null })
    const remote = { id: 1, device_id: 'peer', name: 'Peer', status: 'online' as const, is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway'] }
    const view = render(<ContextSettingsPage devices={[remote]} />)
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toBeDisabled())
    expect(requestLocalExecutorMock).not.toHaveBeenCalled()
    expect(getLocalCodexPersonalityMock).not.toHaveBeenCalled()
    view.rerender(<ContextSettingsPage devices={[remote, { ...remote, id: 2, device_id: 'custom-host', name: 'Current computer', is_default: false, capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] }]} />)
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('Current host instructions'))
    expect(screen.getByTestId('context-runtime-target-select')).toHaveValue('custom-host')
    expect(requestLocalExecutorMock).toHaveBeenCalledWith('runtime.instructions.read', expect.objectContaining({ deviceId: 'custom-host', targetScope: expect.any(String) }))
    expect(getLocalCodexPersonalityMock).toHaveBeenCalledWith('custom-host', { targetScope: expect.any(String) })
  })

  test('loads and saves Wework custom instructions', async () => {
    render(<ContextSettingsPage />)

    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    expect(textarea).toHaveValue('Always answer in concise Chinese.')
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()

    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'Prefer TypeScript examples.')
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeEnabled()

    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))

    await waitFor(() => {
      expect(saveLocalCodexInstructionsMock).toHaveBeenCalledWith('Prefer TypeScript examples.')
    })
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()
  })

  test('checks the UTF-8 byte limit in the editor before sending custom instructions', async () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="kcoder-rpc-token" content="test-token">')
    requestLocalExecutorMock.mockResolvedValue({ instructions: 'saved', configPath: null })
    render(<ContextSettingsPage devices={[{
      id: 1, device_id: 'gateway-a', name: 'Gateway A', status: 'online', is_default: true,
      device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'],
    }]} />)
    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    await waitFor(() => expect(textarea).toHaveValue('saved'))
    const save = screen.getByTestId('context-studio-instructions-save-button')
    const atLimit = '中'.repeat(21_845) + 'a'
    fireEvent.change(textarea, { target: { value: atLimit + 'b' } })
    expect(textarea).toHaveAttribute('aria-invalid', 'true')
    expect(textarea).toHaveAccessibleDescription('workbench.context_settings_instructions_too_long')
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(requestLocalExecutorMock.mock.calls.some(([method]) => method === 'runtime.instructions.write')).toBe(false)
    fireEvent.change(textarea, { target: { value: atLimit } })
    expect(textarea).not.toHaveAttribute('aria-invalid')
    expect(save).toBeEnabled()
  })

  test('confirms a timed-out Gateway write by reading the selected target', async () => {
    const submitted = 'Prefer TypeScript examples.'
    let current = 'Always answer in concise Chinese.'
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    requestLocalExecutorMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.instructions.read')
          return { instructions: current, configPath: null }
        if (method === 'runtime.instructions.write') {
          current = String(params.instructions)
          throw new GatewayRpcError(
            'request timed out',
            -1,
            undefined,
            'runtime-session',
            'timeout'
          )
        }
        throw new Error(`Unexpected Gateway method: ${method}`)
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'gateway-a', name: 'Gateway A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
        ]}
      />
    )

    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, submitted)
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))

    expect(await screen.findByTestId('context-studio-instructions-saved')).toBeInTheDocument()
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(submitted)
    expect(
      requestLocalExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.instructions.write'
      )
    ).toHaveLength(1)
    expect(
      requestLocalExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.instructions.read'
      )
    ).toHaveLength(2)
  })

  test('keeps the draft after a mismatching readback and waits for explicit save', async () => {
    const submitted = 'Keep the original draft for review.'
    let writeCount = 0
    let current = 'Always answer in concise Chinese.'
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    requestLocalExecutorMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.instructions.read')
          return { instructions: current, configPath: null }
        if (method === 'runtime.instructions.write') {
          writeCount += 1
          if (writeCount === 1) {
            throw new GatewayRpcError(
              'connection lost',
              -1,
              undefined,
              'runtime-session',
              'connection'
            )
          }
          current = String(params.instructions)
          return { instructions: current, configPath: null }
        }
        throw new Error(`Unexpected Gateway method: ${method}`)
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'gateway-a', name: 'Gateway A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
        ]}
      />
    )

    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, submitted)
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))

    expect(await screen.findByTestId('context-studio-instructions-reconciled')).toBeInTheDocument()
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(submitted)
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeEnabled()
    expect(writeCount).toBe(1)

    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await waitFor(() => expect(writeCount).toBe(2))
    expect(await screen.findByTestId('context-studio-instructions-save-button')).toBeDisabled()
  })

  test('keeps an unknown Gateway write blocked when readback fails, then allows a read-only check', async () => {
    const submitted = 'Read before allowing another write.'
    let readCount = 0
    let writeCount = 0
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    requestLocalExecutorMock.mockImplementation(
      async (method: string) => {
        if (method === 'runtime.instructions.read') {
          readCount += 1
          if (readCount === 2)
            throw new GatewayRpcError(
              'connection lost',
              -1,
              undefined,
              'runtime-session',
              'connection'
            )
          return {
            instructions: readCount === 3 ? submitted : 'Always answer in concise Chinese.',
            configPath: null,
          }
        }
        if (method === 'runtime.instructions.write') {
          writeCount += 1
          throw new GatewayRpcError(
            'request timed out',
            -1,
            undefined,
            'runtime-session',
            'timeout'
          )
        }
        throw new Error(`Unexpected Gateway method: ${method}`)
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'gateway-a', name: 'Gateway A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
        ]}
      />
    )

    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, submitted)
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))

    expect(
      await screen.findByTestId('context-studio-instructions-outcome-unknown')
    ).toBeInTheDocument()
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(submitted)
    expect(writeCount).toBe(1)

    await userEvent.click(screen.getByTestId('context-studio-instructions-check-current'))
    expect(await screen.findByTestId('context-studio-instructions-saved')).toBeInTheDocument()
    expect(writeCount).toBe(1)
    expect(readCount).toBe(3)
  })

  test('treats an invalid Gateway write receipt as unknown and reconciles by readback', async () => {
    const submitted = 'Confirm malformed receipts from the target.'
    let current = 'Always answer in concise Chinese.'
    let readCount = 0
    let writeCount = 0
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    requestLocalExecutorMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.instructions.read') {
          readCount += 1
          return { instructions: readCount === 1 ? current : submitted, configPath: null }
        }
        if (method === 'runtime.instructions.write') {
          writeCount += 1
          current = String(params.instructions)
          return { instructions: 123, configPath: null }
        }
        throw new Error(`Unexpected Gateway method: ${method}`)
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'gateway-a', name: 'Gateway A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
        ]}
      />
    )

    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, submitted)
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))

    expect(await screen.findByTestId('context-studio-instructions-saved')).toBeInTheDocument()
    expect(writeCount).toBe(1)
    expect(readCount).toBe(2)
  })

  test('guards same-tick Gateway saves against a second write', async () => {
    const submitted = 'Only one request should be sent.'
    const save = deferred<{ instructions: string; configPath: null }>()
    let writeCount = 0
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    requestLocalExecutorMock.mockImplementation(
      (method: string) => {
        if (method === 'runtime.instructions.read') {
          return Promise.resolve({
            instructions: 'Always answer in concise Chinese.',
            configPath: null,
          })
        }
        if (method === 'runtime.instructions.write') {
          writeCount += 1
          return save.promise
        }
        return Promise.reject(new Error(`Unexpected Gateway method: ${method}`))
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'gateway-a', name: 'Gateway A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
        ]}
      />
    )

    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, submitted)
    const saveButton = screen.getByTestId('context-studio-instructions-save-button')
    fireEvent.click(saveButton)
    fireEvent.click(saveButton)
    await waitFor(() => expect(writeCount).toBe(1))

    save.resolve({ instructions: submitted, configPath: null })
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()
    )
  })

  test('does not surface a stale unknown-write result after the selected Gateway target changes', async () => {
    let rejectSave!: (reason: unknown) => void
    const saveA = new Promise<{ instructions: string; configPath: null }>((_resolve, reject) => {
      rejectSave = reject
    })
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    requestLocalExecutorMock.mockImplementation(
      (method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.instructions.read') {
          return Promise.resolve({
            instructions: `instructions-${params.deviceId}`,
            configPath: null,
          })
        }
        if (method === 'runtime.instructions.write' && params.deviceId === 'server-a') return saveA
        if (method === 'runtime.instructions.write') {
          return Promise.resolve({ instructions: String(params.instructions), configPath: null })
        }
        return Promise.reject(new Error(`Unexpected Gateway method: ${method}`))
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'server-a', name: 'Server A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
          { id: 2, device_id: 'server-b', name: 'Server B', status: 'online', is_default: false },
        ]}
      />
    )

    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'pending A')
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    expect(await screen.findByTestId('context-studio-instructions-textarea')).toHaveValue(
      'instructions-server-b'
    )

    rejectSave(
      new GatewayRpcError('connection lost', -1, undefined, 'runtime-session', 'connection')
    )
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(
        'instructions-server-b'
      )
    )
    expect(
      screen.queryByTestId('context-studio-instructions-outcome-unknown')
    ).not.toBeInTheDocument()
  })

  test('keeps unknown writes and newer drafts isolated across Gateway targets', async () => {
    const readCounts = new Map<string, number>()
    let writeCount = 0
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    requestLocalExecutorMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        const targetId = String(params.deviceId)
        if (method === 'runtime.instructions.read') {
          const readCount = (readCounts.get(targetId) ?? 0) + 1
          readCounts.set(targetId, readCount)
          if (
            (targetId === 'server-a' && (readCount === 2 || readCount === 3)) ||
            (targetId === 'server-b' && readCount === 2)
          ) {
            throw new GatewayRpcError(
              'connection lost',
              -1,
              undefined,
              'runtime-session',
              'connection'
            )
          }
          const instructions =
            targetId === 'server-a'
              ? readCount >= 4
                ? 'current A value'
                : 'saved A value'
              : readCount >= 3
                ? 'current B value'
                : 'saved B value'
          return { instructions, configPath: null }
        }
        if (method === 'runtime.instructions.write') {
          writeCount += 1
          throw new GatewayRpcError(
            'connection lost',
            -1,
            undefined,
            'runtime-session',
            'connection'
          )
        }
        throw new Error(`Unexpected Gateway method: ${method}`)
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'server-a', name: 'Server A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
          { id: 2, device_id: 'server-b', name: 'Server B', status: 'online', is_default: false },
        ]}
      />
    )

    let textarea = await screen.findByTestId('context-studio-instructions-textarea')
    expect(textarea).toHaveValue('saved A value')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'submitted A value')
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    expect(
      await screen.findByTestId('context-studio-instructions-outcome-unknown')
    ).toBeInTheDocument()
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(
      'submitted A value'
    )

    textarea = screen.getByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'newer A draft')
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    textarea = await screen.findByTestId('context-studio-instructions-textarea')
    expect(textarea).toHaveValue('saved B value')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'draft B')
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await waitFor(() => expect(writeCount).toBe(2))
    expect(
      await screen.findByTestId('context-studio-instructions-outcome-unknown')
    ).toBeInTheDocument()
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('draft B')

    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-a')
    textarea = await screen.findByTestId('context-studio-instructions-textarea')
    expect(textarea).toHaveValue('newer A draft')
    expect(
      await screen.findByTestId('context-studio-instructions-outcome-unknown')
    ).toBeInTheDocument()
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()
    await userEvent.click(screen.getByTestId('context-studio-instructions-check-current'))
    expect(await screen.findByTestId('context-studio-instructions-reconciled')).toBeInTheDocument()
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('newer A draft')

    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    textarea = await screen.findByTestId('context-studio-instructions-textarea')
    expect(textarea).toHaveValue('draft B')
    expect(await screen.findByTestId('context-studio-instructions-reconciled')).toBeInTheDocument()
    expect(writeCount).toBe(2)
    expect(readCounts.get('server-a')).toBe(4)
    expect(readCounts.get('server-b')).toBe(3)
  })

  test('refreshes clean Gateway instructions after switching targets', async () => {
    let currentA = 'A version 1'
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    requestLocalExecutorMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.instructions.read') {
          return {
            instructions: params.deviceId === 'server-a' ? currentA : 'B saved value',
            configPath: null,
          }
        }
        if (method === 'runtime.instructions.write') {
          currentA = String(params.instructions)
          return { instructions: currentA, configPath: null }
        }
        throw new Error(`Unexpected Gateway method: ${method}`)
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'server-a', name: 'Server A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
          { id: 2, device_id: 'server-b', name: 'Server B', status: 'online', is_default: false },
        ]}
      />
    )

    expect(await screen.findByTestId('context-studio-instructions-textarea')).toHaveValue(
      'A version 1'
    )
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    expect(await screen.findByTestId('context-studio-instructions-textarea')).toHaveValue(
      'B saved value'
    )

    currentA = 'A version 2 from another client'
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-a')
    let textarea = await screen.findByTestId('context-studio-instructions-textarea')
    expect(textarea).toHaveValue('A version 2 from another client')

    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'A value saved here')
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await waitFor(() => {
      expect(
        requestLocalExecutorMock.mock.calls.filter(
          ([method]) => method === 'runtime.instructions.write'
        )
      ).toHaveLength(1)
    })
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(
      'A value saved here'
    )

    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    expect(await screen.findByTestId('context-studio-instructions-textarea')).toHaveValue(
      'B saved value'
    )
    currentA = 'A version 3 from another client'
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-a')
    textarea = await screen.findByTestId('context-studio-instructions-textarea')
    expect(textarea).toHaveValue('A version 3 from another client')
  })

  test('records a late successful Gateway save for its target before switching back', async () => {
    const saveA = deferred<{ instructions: string; configPath: null }>()
    let currentA = 'A initial value'
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    requestLocalExecutorMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.instructions.read') {
          return {
            instructions: params.deviceId === 'server-a' ? currentA : 'B saved value',
            configPath: null,
          }
        }
        if (method === 'runtime.instructions.write') {
          currentA = String(params.instructions)
          return saveA.promise
        }
        throw new Error(`Unexpected Gateway method: ${method}`)
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'server-a', name: 'Server A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
          { id: 2, device_id: 'server-b', name: 'Server B', status: 'online', is_default: false },
        ]}
      />
    )

    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'A saved value')
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await waitFor(() => {
      expect(
        requestLocalExecutorMock.mock.calls.filter(
          ([method]) => method === 'runtime.instructions.write'
        )
      ).toHaveLength(1)
    })

    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    expect(await screen.findByTestId('context-studio-instructions-textarea')).toHaveValue(
      'B saved value'
    )
    await act(async () => {
      saveA.resolve({ instructions: 'A saved value', configPath: null })
      await saveA.promise
    })

    currentA = 'A updated by another client'
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-a')
    expect(await screen.findByTestId('context-studio-instructions-textarea')).toHaveValue(
      'A updated by another client'
    )
  })

  test('loads and saves context against the explicitly selected runtime target', async () => {
    getLocalCodexInstructionsMock.mockImplementation((deviceId?: string) =>
      Promise.resolve({ instructions: `instructions-${deviceId}`, configPath: null })
    )
    render(
      <ContextSettingsPage
        devices={[
          {
            id: 1,
            device_id: 'server-a',
            name: 'Server A',
            status: 'online',
            is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'],
          },
          {
            id: 2,
            device_id: 'server-b',
            name: 'Server B',
            status: 'online',
            is_default: false,
          },
        ]}
      />
    )

    expect(await screen.findByTestId('context-studio-instructions-textarea')).toHaveValue(
      'instructions-server-a'
    )
    expect(getLocalCodexInstructionsMock).toHaveBeenCalledWith('server-a')
    expect(getLocalCodexPersonalityMock).toHaveBeenCalledWith('server-a', undefined)

    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    await waitFor(() => {
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(
        'instructions-server-b'
      )
    })
    expect(getLocalCodexInstructionsMock).toHaveBeenCalledWith('server-b')
    expect(getLocalCodexPersonalityMock).toHaveBeenCalledWith('server-b', undefined)

    const textarea = screen.getByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'only server b')
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await waitFor(() => {
      expect(saveLocalCodexInstructionsMock).toHaveBeenCalledWith('only server b', 'server-b')
    })
  })

  test('does not let a completed save for target A overwrite target B instructions', async () => {
    const saveA = deferred<{ instructions: string; configPath: null }>()
    getLocalCodexInstructionsMock.mockImplementation((deviceId?: string) =>
      Promise.resolve({ instructions: `instructions-${deviceId}`, configPath: null })
    )
    saveLocalCodexInstructionsMock.mockImplementation((_instructions: string, deviceId?: string) =>
      deviceId === 'server-a'
        ? saveA.promise
        : Promise.resolve({ instructions: 'saved-b', configPath: null })
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'server-a', name: 'Server A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
          { id: 2, device_id: 'server-b', name: 'Server B', status: 'online', is_default: false },
        ]}
      />
    )

    const textarea = await screen.findByTestId('context-studio-instructions-textarea')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'pending A')
    await userEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(
        'instructions-server-b'
      )
    )

    saveA.resolve({ instructions: 'saved A response', configPath: null })
    await waitFor(() =>
      expect(saveLocalCodexInstructionsMock).toHaveBeenCalledWith('pending A', 'server-a')
    )
    await saveA.promise
    await Promise.resolve()
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(
      'instructions-server-b'
    )
  })

  test('does not let a completed save for target A overwrite target B personality', async () => {
    const saveA = deferred<'friendly'>()
    getLocalCodexInstructionsMock.mockImplementation((deviceId?: string) =>
      Promise.resolve({ instructions: `instructions-${deviceId}`, configPath: null })
    )
    getLocalCodexPersonalityMock.mockImplementation((deviceId?: string) =>
      Promise.resolve(deviceId === 'server-a' ? 'friendly' : 'pragmatic')
    )
    saveLocalCodexPersonalityMock.mockReturnValue(saveA.promise)
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'server-a', name: 'Server A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
          { id: 2, device_id: 'server-b', name: 'Server B', status: 'online', is_default: false },
        ]}
      />
    )

    const personality = await screen.findByTestId('codex-personality-select')
    await waitFor(() =>
      expect(personality).toHaveTextContent('workbench.codex_personality_friendly')
    )
    await userEvent.click(personality)
    await userEvent.click(screen.getByTestId('codex-personality-option-pragmatic'))
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    await waitFor(() =>
      expect(personality).toHaveTextContent('workbench.codex_personality_pragmatic')
    )

    saveA.resolve('friendly')
    await saveA.promise
    await Promise.resolve()
    await waitFor(() =>
      expect(saveLocalCodexPersonalityMock).toHaveBeenCalledWith('pragmatic', 'server-a', undefined)
    )
    expect(personality).toHaveTextContent('workbench.codex_personality_pragmatic')
  })
  test('keeps a clean cached target read failure unavailable for saving', async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    let readsA = 0
    let allowRead = false
    requestLocalExecutorMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.instructions.read') {
          if (params.deviceId === 'server-a' && ++readsA > 1 && !allowRead)
            throw new Error('read unavailable')
          return {
            instructions: params.deviceId === 'server-a' ? 'A saved' : 'B saved',
            configPath: null,
          }
        }
        throw new Error('unexpected write')
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'server-a', name: 'A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
          { id: 2, device_id: 'server-b', name: 'B', status: 'online', is_default: false },
        ]}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A saved')
    )
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('B saved')
    )
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-a')
    await screen.findByTestId('context-studio-instructions-error')
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A saved')
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()
    fireEvent.change(screen.getByTestId('context-studio-instructions-textarea'), {
      target: { value: 'A newer draft' },
    })
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()
    expect(
      requestLocalExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.instructions.write'
      )
    ).toHaveLength(0)
    allowRead = true
    fireEvent.click(screen.getByTestId('context-studio-instructions-retry'))
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-save-button')).not.toBeDisabled()
    )
    expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A newer draft')
  })

  test('waits for an in-flight Gateway write after A/B/A and refreshes after its late ACK', async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-token">'
    )
    const writeA = deferred<{ instructions: string; configPath: null }>()
    let readsA = 0
    requestLocalExecutorMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.instructions.read') {
          if (params.deviceId === 'server-b') return { instructions: 'B saved', configPath: null }
          readsA += 1
          return {
            instructions: readsA === 1 ? 'A initial' : 'A external latest',
            configPath: null,
          }
        }
        if (method === 'runtime.instructions.write') return writeA.promise
        throw new Error('unexpected method')
      }
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'server-a', name: 'A', status: 'online', is_default: true, device_type: 'remote', capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] },
          { id: 2, device_id: 'server-b', name: 'B', status: 'online', is_default: false },
        ]}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A initial')
    )
    fireEvent.change(screen.getByTestId('context-studio-instructions-textarea'), {
      target: { value: 'A submitted' },
    })
    fireEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('B saved')
    )
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-a')
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A submitted')
    )
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()
    expect(readsA).toBe(1)
    await act(async () => {
      writeA.resolve({ instructions: 'A submitted', configPath: null })
      await writeA.promise
    })
    await waitFor(() =>
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(
        'A external latest'
      )
    )
    expect(readsA).toBe(2)
    expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()
    expect(
      requestLocalExecutorMock.mock.calls.filter(
        ([method]) => method === 'runtime.instructions.write'
      )
    ).toHaveLength(1)
  })
  function scopedContext() {
    document.head.insertAdjacentHTML('beforeend', '<meta name="kcoder-rpc-token" content="test-token">')
    const props = { devices: [{ id: 1, device_id: 'gateway-a', name: 'Gateway A', status: 'online' as const,
      is_default: true, capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] }] }
    let account = 'a'
    const saved: Record<string, string> = { a: 'A saved', b: 'B saved' }
    requestLocalExecutorMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'runtime.instructions.read') return { instructions: saved[account], configPath: null }
      if (method === 'runtime.instructions.write') {
        saved[account] = String(params.instructions)
        return { instructions: saved[account], configPath: null }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const view = render(<ContextSettingsPage {...props} />)
    return { ...view, saved, async select(next: string, boundary: 'account' | 'profile' = 'account') {
      account = boundary === 'profile' && next === 'first' ? 'a' : next
      targetCatalog.targets = targetCatalog.targets.map(target => ({ ...target,
        ...(boundary === 'profile' ? { profile: next } : {
          accountIdentity: { principalId: `account-${next}`, username: `fixture-${next}`, role: 'user' as const },
        }),
      }))
      view.rerender(<ContextSettingsPage {...props} />)
      await act(async () => {})
    } }
  }

  test.each(['account', 'profile'] as const)('same-ID %s replacement isolates drafts and restores only the original scope', async boundary => {
    const view = scopedContext()
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A saved'))
    fireEvent.change(screen.getByTestId('context-studio-instructions-textarea'), { target: { value: 'A draft' } })
    await view.select('b', boundary)
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('B saved'))
    fireEvent.change(screen.getByTestId('context-studio-instructions-textarea'), { target: { value: 'B draft' } })
    await view.select(boundary === 'profile' ? 'first' : 'a', boundary)
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A draft'))
    expect(getAppPreferencesMock).toHaveBeenCalledTimes(1)
    expect(requestLocalExecutorMock.mock.calls.filter(([method]) => method === 'runtime.instructions.write')).toHaveLength(0)
  })

  test('a late original-scope save cannot lock or overwrite the replacement account', async () => {
    const view = scopedContext()
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A saved'))
    const write = deferred<{ instructions: string; configPath: null }>()
    requestLocalExecutorMock.mockImplementation(async (method: string) => {
      if (method === 'runtime.instructions.write') return write.promise
      return { instructions: 'B saved', configPath: null }
    })
    fireEvent.change(screen.getByTestId('context-studio-instructions-textarea'), { target: { value: 'A submitted' } })
    fireEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await view.select('b')
    try {
      await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('B saved'))
      expect(screen.getByTestId('context-studio-instructions-textarea')).toBeEnabled()
      await act(async () => { write.resolve({ instructions: 'A submitted', configPath: null }) })
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('B saved')
      expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled()
    } finally { await act(async () => { write.resolve({ instructions: 'A submitted', configPath: null }) }) }
  })

  test('an unknown original-scope write is reconciled only when returning to that account', async () => {
    const view = scopedContext()
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A saved'))
    let rejectWrite!: (error: Error) => void
    const write = new Promise((_resolve, reject) => { rejectWrite = reject })
    const original = requestLocalExecutorMock.getMockImplementation()!
    requestLocalExecutorMock.mockImplementation((method, params) => method === 'runtime.instructions.write'
      ? write : original(method, params))
    fireEvent.change(screen.getByTestId('context-studio-instructions-textarea'), { target: { value: 'A submitted' } })
    fireEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await view.select('b')
    try {
      await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('B saved'))
      await act(async () => { rejectWrite(new GatewayRpcError('lost receipt', -1, undefined, 'fixture', 'timeout')) })
      expect(screen.queryByTestId('context-studio-instructions-outcome-unknown')).not.toBeInTheDocument()
      await view.select('a')
      await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A submitted'))
      expect(screen.getByTestId('context-studio-instructions-reconciled')).toBeInTheDocument()
      expect(requestLocalExecutorMock.mock.calls.filter(([method]) => method === 'runtime.instructions.write')).toHaveLength(1)
    } finally { await act(async () => { rejectWrite(new Error('fixture complete')) }) }
  })

  test('browser preference loading does not block the target instructions read', async () => {
    const preferences = deferred<AppPreferences>()
    getAppPreferencesMock.mockReturnValue(preferences.promise)
    const view = scopedContext()
    try {
      await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A saved'))
    } finally { await act(async () => { preferences.resolve(defaultPreferences) }); view.unmount() }
  })

  test('Gateway instruction reads and writes use the scoped Runtime without a global executor preflight', async () => {
    scopedContext()
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A saved'))
    fireEvent.change(screen.getByTestId('context-studio-instructions-textarea'), { target: { value: 'A submitted' } })
    fireEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-save-button')).toBeDisabled())
    expect(ensureLocalExecutorStartedMock).not.toHaveBeenCalled()
  })

  test('a late original-account read cannot publish into the replacement account', async () => {
    const pending = deferred<{ instructions: string; configPath: null }>()
    requestLocalExecutorMock.mockImplementationOnce(() => pending.promise)
    const view = scopedContext()
    await waitFor(() => expect(requestLocalExecutorMock).toHaveBeenCalled())
    await view.select('b')
    try {
      await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('B saved'))
      await act(async () => { pending.resolve({ instructions: 'A stale', configPath: null }) })
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('B saved')
    } finally { await act(async () => { pending.resolve({ instructions: 'A stale', configPath: null }) }) }
  })

  test('missing owner metadata cannot read instructions and retries only the catalog', async () => {
    targetCatalog.targets = []
    targetCatalog.error = 'load_failed'
    scopedContext()
    await screen.findByTestId('context-studio-instructions-error')
    expect(requestLocalExecutorMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('context-studio-instructions-retry'))
    expect(targetCatalog.refresh).toHaveBeenCalledTimes(1)
    expect(requestLocalExecutorMock).not.toHaveBeenCalled()
  })

  test('same-turn checks of an unknown write share the existing read effect without replay', async () => {
    scopedContext()
    await waitFor(() => expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue('A saved'))
    const check = deferred<{ instructions: string; configPath: null }>()
    let allowRead = false, reads = 0, writes = 0
    requestLocalExecutorMock.mockImplementation(async (method: string) => {
      if (method === 'runtime.instructions.write') { writes++; throw new GatewayRpcError('lost receipt', -1, undefined, 'fixture', 'timeout') }
      reads++
      if (!allowRead) throw new Error('Read unavailable')
      return check.promise
    })
    fireEvent.change(screen.getByTestId('context-studio-instructions-textarea'), { target: { value: 'A submitted' } })
    fireEvent.click(screen.getByTestId('context-studio-instructions-save-button'))
    const button = await screen.findByTestId('context-studio-instructions-check-current')
    allowRead = true
    act(() => { button.click(); button.click() })
    await waitFor(() => expect(reads).toBe(2))
    await act(async () => { check.resolve({ instructions: 'A submitted', configPath: null }) })
    expect(await screen.findByTestId('context-studio-instructions-saved')).toBeInTheDocument()
    expect(writes).toBe(1)
    expect(getAppPreferencesMock).toHaveBeenCalledTimes(1)
  })

})
