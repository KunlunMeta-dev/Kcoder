import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { ConfigTemplatesSection } from '@/components/settings/ConfigTemplatesSection'
import {
  deleteSettingsTemplate,
  listSettingsTemplates,
  readSettingsTemplate,
  saveSettingsTemplate,
  setDefaultSettingsTemplate,
} from '@/kcoder/configTemplates'
import '@/i18n'

vi.mock('@/kcoder/configTemplates', () => ({
  listSettingsTemplates: vi.fn(),
  readSettingsTemplate: vi.fn(),
  saveSettingsTemplate: vi.fn(),
  deleteSettingsTemplate: vi.fn(),
  setDefaultSettingsTemplate: vi.fn(),
}))

const summary = {
  id: 'fast-local',
  name: 'Fast local',
  updatedAt: '2026-09-18T00:00:00Z',
  sizeBytes: 512,
  revisionSha256: 'abc',
}

beforeEach(() => {
  vi.mocked(listSettingsTemplates).mockReset()
  vi.mocked(readSettingsTemplate).mockReset()
  vi.mocked(saveSettingsTemplate).mockReset()
  vi.mocked(deleteSettingsTemplate).mockReset()
  vi.mocked(setDefaultSettingsTemplate).mockReset()
  vi.mocked(listSettingsTemplates).mockResolvedValue({
    templates: [summary],
    defaultId: 'fast-local',
  })
  vi.mocked(saveSettingsTemplate).mockResolvedValue({ template: summary, defaultId: 'fast-local' })
  vi.mocked(deleteSettingsTemplate).mockResolvedValue({ templates: [], defaultId: undefined })
  vi.mocked(setDefaultSettingsTemplate).mockResolvedValue({
    templates: [summary],
    defaultId: 'fast-local',
  })
})

test('lists stored templates, marks the default, and switches defaults', async () => {
  const user = userEvent.setup()
  render(<ConfigTemplatesSection serverId="server-1" />)

  expect(await screen.findByText('Fast local')).toBeTruthy()
  expect(screen.getByTestId('config-template-default-fast-local')).toBeTruthy()
  expect(screen.getByTestId('config-templates-default').textContent).toContain('fast-local')

  await user.click(screen.getByTestId('config-template-clear-fast-local'))
  await waitFor(() => expect(setDefaultSettingsTemplate).toHaveBeenCalledWith('server-1', null))
})

test('saves a new template from the editor and deletes an existing one', async () => {
  const user = userEvent.setup()
  render(<ConfigTemplatesSection serverId="server-1" />)
  await screen.findByText('Fast local')

  await user.click(screen.getByTestId('config-templates-new'))
  await user.type(screen.getByTestId('config-templates-name'), 'Small ctx')
  await user.click(screen.getByTestId('config-templates-save'))
  await waitFor(() =>
    expect(saveSettingsTemplate).toHaveBeenCalledWith(
      'server-1',
      expect.objectContaining({ name: 'Small ctx' })
    )
  )

  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  await user.click(screen.getByTestId('config-template-delete-fast-local'))
  await waitFor(() => expect(deleteSettingsTemplate).toHaveBeenCalledWith('server-1', 'fast-local'))
  confirm.mockRestore()
})

test('loads an imported file into the editor instead of saving it directly', async () => {
  const user = userEvent.setup()
  render(<ConfigTemplatesSection serverId="server-1" />)
  await screen.findByText('Fast local')

  const file = new File(['{ "permission_mode": "ask" }\n'], 'team-config.jsonc', {
    type: 'application/jsonc',
  })
  await user.upload(screen.getByTestId('config-templates-import'), file)

  const editor = await screen.findByTestId('config-templates-editor')
  expect((screen.getByTestId('config-templates-name') as HTMLInputElement).value).toBe(
    'team-config'
  )
  expect((screen.getByTestId('config-templates-content') as HTMLTextAreaElement).value).toContain(
    'permission_mode'
  )
  expect(editor).toBeTruthy()
  expect(saveSettingsTemplate).not.toHaveBeenCalled()
})
