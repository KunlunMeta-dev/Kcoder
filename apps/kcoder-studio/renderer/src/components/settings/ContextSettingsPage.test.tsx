import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppPreferences } from '@/tauri/appPreferences'
import { ContextSettingsPage } from './ContextSettingsPage'

const defaultPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  systemDragEnabled: true,
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
const translateMock = vi.hoisted(() => (key: string, fallback?: string) => fallback ?? key)

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

vi.mock('@/tauri/appPreferences', () => ({
  defaultAppPreferences: {
    closeToTrayEnabled: true,
    showMainWindowOnLaunch: true,
    systemDragEnabled: true,
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

vi.mock('@/features/model-settings/localCodexSettings', () => ({
  DEFAULT_CODEX_PERSONALITY: 'pragmatic',
  getLocalCodexPersonality: getLocalCodexPersonalityMock,
  saveLocalCodexPersonality: saveLocalCodexPersonalityMock,
}))

describe('ContextSettingsPage', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    getLocalCodexInstructionsMock.mockReset()
    saveLocalCodexInstructionsMock.mockReset()
    getLocalCodexPersonalityMock.mockReset()
    saveLocalCodexPersonalityMock.mockReset()
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
    saveLocalCodexPersonalityMock.mockImplementation(personality =>
      Promise.resolve(personality)
    )
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
            is_default: true,
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
    expect(getLocalCodexPersonalityMock).toHaveBeenCalledWith('server-a')

    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    await waitFor(() => {
      expect(screen.getByTestId('context-studio-instructions-textarea')).toHaveValue(
        'instructions-server-b'
      )
    })
    expect(getLocalCodexInstructionsMock).toHaveBeenCalledWith('server-b')
    expect(getLocalCodexPersonalityMock).toHaveBeenCalledWith('server-b')

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
    saveLocalCodexInstructionsMock.mockImplementation(
      (_instructions: string, deviceId?: string) =>
        deviceId === 'server-a'
          ? saveA.promise
          : Promise.resolve({ instructions: 'saved-b', configPath: null })
    )
    render(
      <ContextSettingsPage
        devices={[
          { id: 1, device_id: 'server-a', name: 'Server A', status: 'online', is_default: true },
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
    await waitFor(() => expect(saveLocalCodexInstructionsMock).toHaveBeenCalledWith('pending A', 'server-a'))
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
          { id: 1, device_id: 'server-a', name: 'Server A', status: 'online', is_default: true },
          { id: 2, device_id: 'server-b', name: 'Server B', status: 'online', is_default: false },
        ]}
      />
    )

    const personality = await screen.findByTestId('codex-personality-select')
    await waitFor(() => expect(personality).toHaveTextContent('workbench.codex_personality_friendly'))
    await userEvent.click(personality)
    await userEvent.click(screen.getByTestId('codex-personality-option-pragmatic'))
    await userEvent.selectOptions(screen.getByTestId('context-runtime-target-select'), 'server-b')
    await waitFor(() => expect(personality).toHaveTextContent('workbench.codex_personality_pragmatic'))

    saveA.resolve('friendly')
    await saveA.promise
    await Promise.resolve()
    await waitFor(() => expect(saveLocalCodexPersonalityMock).toHaveBeenCalledWith('pragmatic', 'server-a'))
    expect(personality).toHaveTextContent('workbench.codex_personality_pragmatic')
  })
})
