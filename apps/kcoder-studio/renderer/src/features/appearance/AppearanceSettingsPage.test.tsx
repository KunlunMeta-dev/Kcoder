import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { AppearanceSettingsPage } from './AppearanceSettingsPage'

describe('AppearanceSettingsPage', () => {
  test('edits theme-specific terminal colors without replacing the other theme', () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )
    fireEvent.change(screen.getByTestId('appearance-terminal-foreground-light'), {
      target: { value: '#123456' },
    })
    fireEvent.change(screen.getByTestId('appearance-terminal-foreground-dark'), {
      target: { value: '#abcdef' },
    })
    expect(screen.getByTestId('appearance-terminal-foreground-light')).toHaveValue('#123456')
    expect(screen.getByTestId('appearance-terminal-foreground-dark')).toHaveValue('#abcdef')
    fireEvent.click(screen.getByTestId('appearance-terminal-reset-light'))
    expect(screen.getByTestId('appearance-terminal-reset-light')).toBeDisabled()
    expect(screen.getByTestId('appearance-terminal-foreground-dark')).toHaveValue('#abcdef')
  })
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('style')
  })

  test('uses neutral controls and a blue default accent instead of green', () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )

    const systemMode = screen.getByTestId('appearance-mode-system')
    expect(systemMode).toHaveClass('bg-text-primary', 'text-background')
    expect(systemMode).not.toHaveClass('bg-primary', 'text-primary-contrast')

    expect(screen.getByTestId('appearance-accent-input')).toHaveValue('#2563eb')
    expect(screen.getByTestId('appearance-background-select-button')).toBeInTheDocument()
    expect(screen.queryByTestId('appearance-background-select-button-dark')).not.toBeInTheDocument()
    expect(screen.getByTestId('appearance-background-visibility-slider')).not.toBeDisabled()
    expect(screen.getByTestId('appearance-background-blur-slider')).not.toBeDisabled()

    const blurSlider = screen.getByTestId('appearance-background-blur-slider')
    const areaSelector = screen.getByTestId('appearance-background-area-main')
    expect(blurSlider.compareDocumentPosition(areaSelector)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  test('contrast and sidebar opacity change the actual applied palette', () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )
    fireEvent.click(screen.getByTestId('appearance-mode-light'))
    const original = document.documentElement.style.getPropertyValue('--color-border')
    fireEvent.change(screen.getByTestId('appearance-contrast-slider'), { target: { value: '100' } })
    expect(document.documentElement.style.getPropertyValue('--color-border')).not.toBe(original)
    fireEvent.click(screen.getByTestId('appearance-sidebar-translucent-toggle'))
    expect(document.documentElement.style.getPropertyValue('--color-sidebar')).not.toContain('/')
  })

  test('commits UI and code font sizes on Enter or blur', async () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )

    const uiInput = screen.getByTestId('appearance-ui-font-size-input')
    const codeInput = screen.getByTestId('appearance-code-font-size-input')
    expect(uiInput).toHaveValue(14)
    expect(codeInput).toHaveValue(12)

    await userEvent.clear(uiInput)
    await userEvent.type(uiInput, '16{Enter}')
    expect(document.documentElement.style.getPropertyValue('--text-base')).toBe('16px')

    await userEvent.clear(codeInput)
    await userEvent.type(codeInput, '15')
    fireEvent.blur(codeInput)
    expect(document.documentElement.style.getPropertyValue('--text-code')).toBe('15px')
  })

  test('clamps out-of-range values and restores invalid input', () => {
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )

    const uiInput = screen.getByTestId('appearance-ui-font-size-input') as HTMLInputElement
    fireEvent.change(uiInput, { target: { value: '99' } })
    fireEvent.blur(uiInput)
    expect(uiInput.value).toBe('16')

    const codeInput = screen.getByTestId('appearance-code-font-size-input') as HTMLInputElement
    fireEvent.change(codeInput, { target: { value: '' } })
    fireEvent.blur(codeInput)
    expect(codeInput.value).toBe('12')
  })

  test('lets users choose which interface areas show the background', async () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({ backgroundImagePath: '/app-data/background.png' })
    )
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )

    const main = screen.getByTestId('appearance-background-area-main')
    const sidebar = screen.getByTestId('appearance-background-area-sidebar')
    const topbar = screen.getByTestId('appearance-background-area-topbar')
    expect(main).toBeChecked()
    expect(sidebar).toBeChecked()
    expect(topbar).toBeChecked()

    await userEvent.click(sidebar)

    expect(sidebar).not.toBeChecked()
    expect(localStorage.getItem('wework.appearance')).toContain('"backgroundInSidebar":false')
  })

  test('preserves common and themed settings when switching modes', async () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({
        backgroundImagePath: '/app-data/common.png',
        backgroundBlur: 6,
        backgroundVisibility: 40,
      })
    )
    render(
      <AppearanceProvider>
        <AppearanceSettingsPage />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('appearance-background-separate-toggle'))

    expect(screen.getByTestId('appearance-background-editor-light')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-background-editor-dark')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-background-blur-slider-light')).toHaveValue('6')
    expect(screen.getByTestId('appearance-background-visibility-slider-dark')).toHaveValue('40')

    fireEvent.change(screen.getByTestId('appearance-background-blur-slider-dark'), {
      target: { value: '12' },
    })
    await userEvent.click(screen.getByTestId('appearance-background-separate-toggle'))

    expect(screen.getByTestId('appearance-background-blur-slider')).toHaveValue('6')

    await userEvent.click(screen.getByTestId('appearance-background-separate-toggle'))
    expect(screen.getByTestId('appearance-background-blur-slider-dark')).toHaveValue('12')
  })
})

test('font dropdown applies code font immediately without changing the UI font', () => {
  localStorage.clear()
  render(
    <AppearanceProvider>
      <AppearanceSettingsPage />
    </AppearanceProvider>
  )
  const ui = screen.getByTestId('appearance-ui-font-input') as HTMLSelectElement
  const code = screen.getByTestId('appearance-code-font-input') as HTMLSelectElement
  const previousUi = ui.value
  const chosen = Array.from(code.options).find(option => option.textContent === 'Consolas')!.value
  fireEvent.change(code, { target: { value: chosen } })
  expect(code).toHaveValue(chosen)
  expect(ui).toHaveValue(previousUi)
  expect(document.documentElement.style.getPropertyValue('--font-code')).toBe(chosen)
})
