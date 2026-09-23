import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { QuickPhrasesSettingsPage } from './QuickPhrasesSettingsPage'

const getAppPreferences = vi.hoisted(() => vi.fn())
const updateAppPreferences = vi.hoisted(() => vi.fn())

vi.mock('@/tauri/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/tauri/appPreferences')>()
  return { ...actual, getAppPreferences, updateAppPreferences }
})

describe('QuickPhrasesSettingsPage', () => {
  beforeEach(() => {
    getAppPreferences.mockResolvedValue({ quickPhrases: [] })
    updateAppPreferences.mockImplementation(async patch => ({ quickPhrases: patch.quickPhrases }))
  })

  test('creates a plan-mode phrase', async () => {
    render(<QuickPhrasesSettingsPage />)
    fireEvent.click(screen.getByTestId('add-quick-phrase-button'))
    fireEvent.change(screen.getByTestId('quick-phrase-title-input'), {
      target: { value: '制定计划' },
    })
    fireEvent.change(screen.getByTestId('quick-phrase-content-input'), {
      target: { value: '请制定实施计划' },
    })
    fireEvent.click(screen.getByTestId('quick-phrase-mode-plan'))
    fireEvent.click(screen.getByTestId('quick-phrase-save-button'))

    await waitFor(() =>
      expect(updateAppPreferences).toHaveBeenCalledWith({
        quickPhrases: [
          expect.objectContaining({
            title: '制定计划',
            content: '请制定实施计划',
            mode: 'plan',
          }),
        ],
      })
    )
  })
})

test('failed save keeps the editor draft and old list, then retry commits once', async () => {
  getAppPreferences.mockResolvedValue({ quickPhrases: [] })
  updateAppPreferences
    .mockRejectedValueOnce(new Error('disk unavailable'))
    .mockImplementationOnce(async patch => patch)
  render(<QuickPhrasesSettingsPage />)
  await waitFor(() => expect(getAppPreferences).toHaveBeenCalled())
  fireEvent.click(screen.getByTestId('add-quick-phrase-button'))
  fireEvent.change(screen.getByTestId('quick-phrase-title-input'), {
    target: { value: 'Draft title' },
  })
  fireEvent.change(screen.getByTestId('quick-phrase-content-input'), {
    target: { value: 'Draft text' },
  })
  fireEvent.click(screen.getByTestId('quick-phrase-save-button'))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(screen.getByTestId('quick-phrase-title-input')).toHaveValue('Draft title')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('quick-phrase-save-button'))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByText('Draft title')).toBeInTheDocument()
})

test('editor contains keyboard focus and Escape restores its trigger', async () => {
  getAppPreferences.mockResolvedValue({ quickPhrases: [] })
  render(<QuickPhrasesSettingsPage />)
  const trigger = screen.getByTestId('add-quick-phrase-button')
  trigger.focus()
  fireEvent.click(trigger)
  const title = screen.getByTestId('quick-phrase-title-input')
  expect(title).toHaveFocus()
  fireEvent.keyDown(title, { key: 'Tab', shiftKey: true })
  expect(screen.getByTestId('quick-phrase-save-button')).toHaveFocus()
  fireEvent.keyDown(screen.getByTestId('quick-phrase-save-button'), { key: 'Tab' })
  expect(title).toHaveFocus()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(trigger).toHaveFocus()
})
