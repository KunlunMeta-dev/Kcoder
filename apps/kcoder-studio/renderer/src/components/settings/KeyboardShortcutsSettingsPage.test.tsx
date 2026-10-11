import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { getKeybindings, updateKeybindings, translate } = vi.hoisted(() => ({
  getKeybindings: vi.fn(),
  updateKeybindings: vi.fn(),
  translate: (_key: string, fallback?: string) => fallback ?? _key,
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translate,
  }),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: () => ({ runtimeWorkApi: { getKeybindings, updateKeybindings } }),
}))

import { KeyboardShortcutsSettingsPage } from './KeyboardShortcutsSettingsPage'

describe('KeyboardShortcutsSettingsPage', () => {
  beforeEach(() => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    getKeybindings.mockResolvedValue({ keybindings: [] })
    updateKeybindings.mockImplementation(async value => value)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  test.each(['Win32', 'Linux x86_64'])('shows platform modifiers on %s', async platform => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    render(<KeyboardShortcutsSettingsPage />)
    await waitFor(() => expect(screen.queryByText('加载中...')).not.toBeInTheDocument())
    expect(screen.getByTestId('keyboard-shortcut-record-openTerminal')).toHaveTextContent('Ctrl J')
    expect(screen.getByTestId('keyboard-shortcut-record-toggleSidePanel')).toHaveTextContent(
      'Ctrl Alt B'
    )
    expect(screen.getByTestId('keyboard-shortcut-record-toggleModelSelector')).toHaveTextContent(
      'Ctrl Shift M'
    )
    expect(screen.getByTestId('keyboard-shortcut-record-increaseFontSize')).toHaveTextContent(
      'Ctrl +'
    )
    expect(screen.getByTestId('keyboard-shortcuts-settings-page')).not.toHaveTextContent(/[⌘⌃⌥⇧]/)
  })

  test('records actual modifiers, restores the Windows default, clears and cancels', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    getKeybindings.mockResolvedValue({
      keybindings: [{ command: 'openTerminal', key: 'Command+J' }],
    })
    render(<KeyboardShortcutsSettingsPage />)
    const record = screen.getByTestId('keyboard-shortcut-record-openTerminal')
    await waitFor(() => expect(record).toHaveTextContent('Win J'))

    fireEvent.click(record)
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Alt', ctrlKey: true, altKey: true })
    fireEvent.keyDown(window, { key: 'Shift', ctrlKey: true, altKey: true, shiftKey: true })
    expect(record).toHaveTextContent('按下快捷键')
    expect(updateKeybindings).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, altKey: true, shiftKey: true })
    await waitFor(() => expect(record).toHaveTextContent('Ctrl Alt Shift K'))
    expect(updateKeybindings).toHaveBeenLastCalledWith({
      keybindings: [{ command: 'openTerminal', key: 'Control+Alt+Shift+K' }],
    })

    fireEvent.click(screen.getByTestId('keyboard-shortcut-reset-openTerminal'))
    await waitFor(() => expect(record).toHaveTextContent('Ctrl J'))
    expect(updateKeybindings).toHaveBeenLastCalledWith({ keybindings: [] })

    fireEvent.click(screen.getByTestId('keyboard-shortcut-clear-openTerminal'))
    await waitFor(() => expect(record).toHaveTextContent('未设置'))
    expect(updateKeybindings).toHaveBeenLastCalledWith({
      keybindings: [{ command: 'openTerminal', key: null }],
    })
    const saveCount = updateKeybindings.mock.calls.length
    fireEvent.click(record)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(record).toHaveTextContent('未设置')
    expect(updateKeybindings).toHaveBeenCalledTimes(saveCount)
  })

  test('failed loading cannot overwrite existing shortcuts and can retry', async () => {
    getKeybindings.mockRejectedValueOnce(new Error('Owned load failure'))
    render(<KeyboardShortcutsSettingsPage />)
    await screen.findByTestId('keyboard-shortcuts-retry')
    expect(screen.getByTestId('keyboard-shortcut-record-openTerminal')).toBeDisabled()
    expect(screen.getByTestId('keyboard-shortcut-clear-openTerminal')).toBeDisabled()
    expect(updateKeybindings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('keyboard-shortcuts-retry'))
    await waitFor(() =>
      expect(screen.getByTestId('keyboard-shortcut-record-openTerminal')).not.toBeDisabled()
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('rejects conflicts, ignores repeated save keys and preserves a failed recording', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    render(<KeyboardShortcutsSettingsPage />)
    const record = screen.getByTestId('keyboard-shortcut-record-openTerminal')
    await waitFor(() => expect(record).not.toBeDisabled())
    fireEvent.click(record)
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent('切换边栏')
    expect(updateKeybindings).not.toHaveBeenCalled()
    let rejectSave: (error: Error) => void = () => {}
    updateKeybindings.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject
        })
    )
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, altKey: true })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, altKey: true, repeat: true })
    expect(updateKeybindings).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('keyboard-shortcut-clear-toggleSidebar')).toBeDisabled()
    rejectSave(new Error('Owned save failure'))
    await waitFor(() => expect(record).not.toBeDisabled())
    expect(record).toHaveTextContent('按下快捷键')
    expect(screen.getByRole('alert')).toHaveTextContent('快捷键保存失败')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(record).toHaveFocus()
    expect(record).toHaveTextContent('Ctrl J')
  })

  test('shows the configurable model selector shortcut', () => {
    render(<KeyboardShortcutsSettingsPage />)

    const row = screen.getByTestId('keyboard-shortcut-row-toggleModelSelector')
    expect(row).toHaveTextContent('选择模型')
    expect(row).toHaveTextContent('打开或关闭当前输入区的模型选择器')
    expect(row).toHaveTextContent('⌃ ⇧ M')
  })

  test('keeps the saved binding after a failed save and allows retry on Windows', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    updateKeybindings.mockRejectedValueOnce(new Error('storage unavailable'))
    render(<KeyboardShortcutsSettingsPage />)
    await waitFor(() => expect(screen.queryByText('加载中...')).not.toBeInTheDocument())
    const record = screen.getByTestId('keyboard-shortcut-record-openTerminal')
    fireEvent.click(record)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(await screen.findByTestId('keyboard-shortcuts-error')).toHaveTextContent(
      '快捷键保存失败'
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(record).toHaveTextContent('Ctrl J')

    fireEvent.click(record)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(record).toHaveTextContent('Ctrl K'))
    expect(screen.queryByTestId('keyboard-shortcuts-error')).not.toBeInTheDocument()
  })

  test('shows font size shortcuts', () => {
    render(<KeyboardShortcutsSettingsPage />)

    expect(screen.getByTestId('keyboard-shortcut-row-increaseFontSize')).toHaveTextContent(
      '增大字号'
    )
    expect(screen.getByTestId('keyboard-shortcut-row-increaseFontSize')).toHaveTextContent('⌘ +')
    expect(screen.getByTestId('keyboard-shortcut-row-decreaseFontSize')).toHaveTextContent('⌘ −')
    expect(screen.getByTestId('keyboard-shortcut-row-resetFontSize')).toHaveTextContent('⌘ 0')
  })
})
