import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ToolProfileSettings } from './ToolProfileSettings'
import {
  readToolProfile,
  saveToolProfile,
  type ToolProfileSettings as Profile,
} from '@/kcoder/toolProfiles'
vi.mock('@/kcoder/toolProfiles', () => ({
  TOOL_PROFILES: ['full', 'core', 'nano', 'none'],
  readToolProfile: vi.fn(),
  saveToolProfile: vi.fn(),
}))
const translate = vi.hoisted(() =>
  vi.fn((key: string, options?: { profile?: string }) =>
    options?.profile ? `${key}: ${options.profile}` : key
  )
)
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: translate }) }))
const read = vi.mocked(readToolProfile)
const save = vi.mocked(saveToolProfile)
const full: Profile = { profile: 'full', effectiveProfile: 'full', cliOverride: null }
beforeEach(() => {
  read.mockReset()
  save.mockReset()
  read.mockResolvedValue(full)
  save.mockResolvedValue({ ...full, profile: 'core', effectiveProfile: 'core' })
})
test('reads selected target, offers four profiles, and saves only the chosen profile', async () => {
  render(<ToolProfileSettings serverId="remote" />)
  await waitFor(() => expect(screen.getByTestId('tool-profile-select')).not.toBeDisabled())
  expect(read).toHaveBeenCalledWith('remote')
  expect(screen.getByTestId('tool-profile-select').querySelectorAll('option')).toHaveLength(4)
  expect(screen.getByTestId('tool-profile-select')).toHaveValue('full')
  fireEvent.change(screen.getByTestId('tool-profile-select'), { target: { value: 'core' } })
  fireEvent.click(screen.getByTestId('tool-profile-save'))
  await waitFor(() => expect(save).toHaveBeenCalledWith('remote', 'core'))
  expect(await screen.findByRole('status')).toHaveTextContent('toolProfile.saved')
})
test('failed saves retain the choice and explicit command-line overrides stay visible', async () => {
  read.mockResolvedValue({ ...full, effectiveProfile: 'nano', cliOverride: 'nano' })
  save.mockRejectedValueOnce(new Error('fixture save failed'))
  render(<ToolProfileSettings serverId="local" />)
  expect(await screen.findByTestId('tool-profile-cli-override')).toHaveTextContent('nano')
  expect(screen.getByTestId('tool-profile-select')).toHaveValue('full')
  fireEvent.change(screen.getByTestId('tool-profile-select'), { target: { value: 'none' } })
  fireEvent.click(screen.getByTestId('tool-profile-save'))
  expect(await screen.findByRole('alert')).toHaveTextContent('fixture save failed')
  expect(screen.getByTestId('tool-profile-select')).toHaveValue('none')
  expect(screen.queryByRole('status')).toBeNull()
})
test('late reads and saves never replace a newly selected target', async () => {
  let finishRead!: (value: Profile) => void
  read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishRead = resolve
      })
  )
  const { rerender } = render(<ToolProfileSettings serverId="old" />)
  rerender(<ToolProfileSettings serverId="new" />)
  await waitFor(() => expect(screen.getByTestId('tool-profile-select')).not.toBeDisabled())
  await act(async () => finishRead({ ...full, profile: 'none' }))
  expect(screen.getByTestId('tool-profile-select')).toHaveValue('full')
  let finishSave!: (value: Profile) => void
  save.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishSave = resolve
      })
  )
  fireEvent.change(screen.getByTestId('tool-profile-select'), { target: { value: 'core' } })
  fireEvent.click(screen.getByTestId('tool-profile-save'))
  rerender(<ToolProfileSettings serverId="third" />)
  await waitFor(() => expect(read).toHaveBeenLastCalledWith('third'))
  await act(async () => finishSave({ ...full, profile: 'core' }))
  expect(screen.getByTestId('tool-profile-select')).toHaveValue('full')
  expect(screen.queryByRole('status')).toBeNull()
})
test('an unavailable target does not permit saving or fall back to a local target', async () => {
  read.mockRejectedValue(new Error('unsupported target'))
  const { rerender } = render(<ToolProfileSettings serverId="old-server" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('unsupported target')
  expect(screen.getByTestId('tool-profile-save')).toBeDisabled()
  rerender(<ToolProfileSettings serverId="" />)
  expect(screen.getByTestId('tool-profile-select')).toBeDisabled()
  expect(save).not.toHaveBeenCalled()
})
