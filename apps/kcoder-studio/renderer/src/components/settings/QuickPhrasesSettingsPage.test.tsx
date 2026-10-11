import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { QuickPhrasesSettingsPage } from './QuickPhrasesSettingsPage'

const getAppPreferences = vi.hoisted(() => vi.fn())
const updateAppPreferences = vi.hoisted(() => vi.fn())

vi.mock('@/tauri/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/tauri/appPreferences')>()
  return { ...actual, getAppPreferences, updateAppPreferences }
})

beforeEach(() => {
  getAppPreferences.mockReset().mockResolvedValue({ quickPhrases: [] })
  updateAppPreferences
    .mockReset()
    .mockImplementation(async patch => ({ quickPhrases: patch.quickPhrases }))
})

describe('QuickPhrasesSettingsPage', () => {
  beforeEach(() => {
    getAppPreferences.mockResolvedValue({ quickPhrases: [] })
    updateAppPreferences.mockImplementation(async patch => ({ quickPhrases: patch.quickPhrases }))
  })

  test('creates a plan-mode phrase', async () => {
    render(<QuickPhrasesSettingsPage />)
    await waitFor(() => expect(screen.getByTestId('add-quick-phrase-button')).toBeEnabled())
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
  await waitFor(() => expect(screen.getByTestId('add-quick-phrase-button')).toBeEnabled())
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
  await waitFor(() => expect(trigger).toBeEnabled())
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

test('unknown preferences cannot be overwritten while their initial read is pending', async () => {
  let finish!: (value: object) => void
  getAppPreferences.mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve
    })
  )
  render(<QuickPhrasesSettingsPage />)
  expect(screen.getByTestId('add-quick-phrase-button')).toBeDisabled()
  expect(updateAppPreferences).not.toHaveBeenCalled()
  await act(async () =>
    finish({
      quickPhrases: [
        { id: 'kept', title: 'Kept phrase', content: 'Original content', mode: 'normal' },
      ],
    })
  )
  expect(screen.getByText('Kept phrase')).toBeInTheDocument()
  expect(screen.getByTestId('add-quick-phrase-button')).toBeEnabled()
})

test('failed preference reads show a retry instead of an editable empty list', async () => {
  getAppPreferences.mockRejectedValueOnce(new Error('owned load failure')).mockResolvedValueOnce({
    quickPhrases: [
      { id: 'kept', title: 'Kept phrase', content: 'Original content', mode: 'normal' },
    ],
  })
  render(<QuickPhrasesSettingsPage />)
  await screen.findByRole('alert')
  expect(screen.getByTestId('add-quick-phrase-button')).toBeDisabled()
  fireEvent.click(screen.getByTestId('quick-phrases-retry'))
  await screen.findByText('Kept phrase')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(updateAppPreferences).not.toHaveBeenCalled()
})

test('row actions reorder the saved list and deletion still requires confirmation', async () => {
  const one = { id: 'one', title: 'One', content: 'First owned text', mode: 'normal' }
  const two = { id: 'two', title: 'Two', content: 'Second owned text', mode: 'goal' }
  getAppPreferences.mockResolvedValueOnce({ quickPhrases: [one, two] })
  render(<QuickPhrasesSettingsPage />)
  await screen.findByText('Two')
  fireEvent.click(screen.getByTestId('quick-phrase-actions-two'))
  fireEvent.click(screen.getByTestId('quick-phrase-move-up-two'))
  await waitFor(() =>
    expect(updateAppPreferences).toHaveBeenLastCalledWith({ quickPhrases: [two, one] })
  )
  await waitFor(() => expect(screen.getByTestId('quick-phrase-actions-two')).toBeEnabled())
  fireEvent.click(screen.getByTestId('quick-phrase-actions-two'))
  fireEvent.click(screen.getByTestId('quick-phrase-delete-two'))
  await screen.findByTestId('quick-phrase-delete-dialog')
  expect(updateAppPreferences).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByText('Two')).toBeInTheDocument()
  expect(screen.getByTestId('quick-phrase-actions-two')).toHaveFocus()
})
