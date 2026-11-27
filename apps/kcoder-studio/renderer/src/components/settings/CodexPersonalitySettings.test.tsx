import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { CodexPersonalitySettings } from './CodexPersonalitySettings'
import {
  getLocalCodexPersonality,
  saveLocalCodexPersonality,
} from '@/features/model-settings/localCodexSettings'
import '@/i18n'

vi.mock('@/features/model-settings/localCodexSettings', () => ({
  DEFAULT_CODEX_PERSONALITY: 'pragmatic',
  getLocalCodexPersonality: vi.fn(),
  saveLocalCodexPersonality: vi.fn(),
}))
beforeEach(() => {
  vi.clearAllMocks()
})

test('a failed load is visible and can be retried instead of exposing an invented default', async () => {
  vi.mocked(getLocalCodexPersonality)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue('friendly')
  render(<CodexPersonalitySettings deviceId="target" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('无法读取')
  expect(screen.getByTestId('codex-personality-select')).toBeDisabled()
  await userEvent.click(screen.getByTestId('interaction-style-retry'))
  await waitFor(() => expect(screen.getByTestId('codex-personality-select')).toBeEnabled())
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(getLocalCodexPersonality).toHaveBeenLastCalledWith('target', undefined)
})

test('failed saves restore the previous selection and report failure', async () => {
  vi.mocked(getLocalCodexPersonality).mockResolvedValue('friendly')
  vi.mocked(saveLocalCodexPersonality).mockRejectedValue(new Error('offline'))
  render(<CodexPersonalitySettings deviceId="target" />)
  const trigger = screen.getByTestId('codex-personality-select')
  await waitFor(() => expect(trigger).toBeEnabled())
  const original = trigger.textContent
  await userEvent.click(trigger)
  await userEvent.click(screen.getByTestId('codex-personality-option-pragmatic'))
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
  expect(trigger).toHaveTextContent(original ?? '')
})

test('same-device profile replacement retires an old read', async () => {
  let finish!: (value: 'friendly') => void
  vi.mocked(getLocalCodexPersonality).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue('pragmatic')
  const view = render(<CodexPersonalitySettings deviceId="target" targetScope="original" />)
  view.rerender(<CodexPersonalitySettings deviceId="target" targetScope="replacement" />)
  await waitFor(() => expect(getLocalCodexPersonality).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByTestId('codex-personality-select')).toBeEnabled())
  finish('friendly')
  await waitFor(() => expect(screen.getByTestId('codex-personality-select')).toHaveTextContent('务实'))
  expect(getLocalCodexPersonality).toHaveBeenLastCalledWith('target', { targetScope: 'replacement' })
})

test('same-device account replacement cannot publish a late save', async () => {
  let finish!: (value: 'pragmatic') => void
  vi.mocked(getLocalCodexPersonality).mockResolvedValue('friendly')
  vi.mocked(saveLocalCodexPersonality).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<CodexPersonalitySettings deviceId="target" targetScope="original-account" />)
  await waitFor(() => expect(screen.getByTestId('codex-personality-select')).toBeEnabled())
  await userEvent.click(screen.getByTestId('codex-personality-select'))
  await userEvent.click(screen.getByTestId('codex-personality-option-pragmatic'))
  view.rerender(<CodexPersonalitySettings deviceId="target" targetScope="replacement-account" />)
  await waitFor(() => expect(getLocalCodexPersonality).toHaveBeenCalledTimes(2))
  finish('pragmatic')
  await waitFor(() => expect(screen.getByTestId('codex-personality-select')).toBeEnabled())
  expect(screen.getByTestId('codex-personality-select')).toHaveTextContent('亲和')
  expect(saveLocalCodexPersonality).toHaveBeenCalledTimes(1)
  expect(saveLocalCodexPersonality).toHaveBeenCalledWith('pragmatic', 'target', { targetScope: 'original-account' })
})
