import { act, render, screen, waitFor } from '@testing-library/react'
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
  expect(screen.getByTestId('config-templates-default').textContent).toContain('Fast local')

  await user.click(screen.getByTestId('config-template-actions-fast-local'))
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

  await waitFor(() => expect(screen.queryByTestId('config-templates-editor')).toBeNull())
  vi.mocked(deleteSettingsTemplate).mockRejectedValueOnce(new Error('delete unavailable'))
  await user.click(screen.getByTestId('config-template-actions-fast-local'))
  await user.click(screen.getByTestId('config-template-delete-fast-local'))
  expect(deleteSettingsTemplate).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('config-template-delete-dialog-confirm'))
  expect(await screen.findByText('delete unavailable')).toBeTruthy()
  expect(screen.getByTestId('config-template-delete-dialog')).toBeTruthy()
  expect(screen.getByTestId('config-template-fast-local')).toBeTruthy()
  await user.click(screen.getByTestId('config-template-delete-dialog-confirm'))
  await waitFor(() => expect(deleteSettingsTemplate).toHaveBeenCalledWith('server-1', 'fast-local'))
  await waitFor(() => expect(screen.queryByTestId('config-template-delete-dialog')).toBeNull())
  expect(screen.queryByTestId('config-template-fast-local')).toBeNull()
  expect(listSettingsTemplates).toHaveBeenCalledTimes(1)
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('blocks a new draft while an existing template is loading', async () => {
  const pending = deferred<Awaited<ReturnType<typeof readSettingsTemplate>>>()
  vi.mocked(readSettingsTemplate).mockReturnValue(pending.promise)
  const user = userEvent.setup()
  render(<ConfigTemplatesSection serverId="server-1" />)
  await screen.findByText('Fast local')
  await user.click(screen.getByTestId('config-template-edit-fast-local'))
  expect(screen.getByTestId('config-templates-new')).toBeDisabled()
  await act(async () => pending.resolve({ summary, content: '{}' }))
  expect((screen.getByTestId('config-templates-name') as HTMLInputElement).value).toBe('Fast local')
})

test('ignores an old catalog after switching runtime targets', async () => {
  const pending = deferred<Awaited<ReturnType<typeof listSettingsTemplates>>>()
  vi.mocked(listSettingsTemplates).mockReturnValueOnce(pending.promise)
  vi.mocked(listSettingsTemplates).mockResolvedValue({
    templates: [{ ...summary, id: 'other', name: 'Other target' }],
  })
  const view = render(<ConfigTemplatesSection serverId="server-1" />)
  await waitFor(() => expect(listSettingsTemplates).toHaveBeenCalledTimes(1))
  view.rerender(<ConfigTemplatesSection serverId="server-2" />)
  await screen.findByText('Other target')
  await act(async () => pending.resolve({ templates: [summary], defaultId: summary.id }))
  expect(screen.queryByText('Fast local')).toBeNull()
  expect(screen.getByText('Other target')).toBeTruthy()
})

test('shows a read failure instead of a false empty catalog and retries', async () => {
  vi.mocked(listSettingsTemplates).mockRejectedValueOnce(new Error('catalog unavailable'))
  const user = userEvent.setup()
  render(<ConfigTemplatesSection serverId="server-1" />)
  expect(await screen.findByText('catalog unavailable')).toBeTruthy()
  expect(screen.queryByTestId('config-templates-empty')).toBeNull()
  expect(screen.getByTestId('config-templates-new')).toBeDisabled()
  await user.click(screen.getByTestId('config-templates-retry'))
  await screen.findByText('Fast local')
  expect(screen.queryByTestId('config-templates-error')).toBeNull()
  expect(screen.getByTestId('config-templates-new')).toBeEnabled()
})

test('retains the last catalog and default when refresh fails', async () => {
  const user = userEvent.setup()
  render(<ConfigTemplatesSection serverId="server-1" />)
  await screen.findByText('Fast local')
  vi.mocked(listSettingsTemplates).mockRejectedValueOnce(new Error('refresh unavailable'))
  await user.click(screen.getByTestId('config-templates-refresh'))
  await screen.findByText('refresh unavailable')
  expect(screen.getByTestId('config-template-fast-local')).toBeTruthy()
  expect(screen.getByTestId('config-templates-default')).toHaveTextContent('Fast local')
  await user.click(screen.getByTestId('config-templates-retry'))
  await waitFor(() => expect(screen.queryByTestId('config-templates-error')).toBeNull())
  expect(screen.getByTestId('config-template-edit-fast-local')).toBeEnabled()
})

test('keeps failed edits for retry and locks all controls while saving', async () => {
  const user = userEvent.setup()
  const pending = deferred<Awaited<ReturnType<typeof saveSettingsTemplate>>>()
  vi.mocked(readSettingsTemplate).mockResolvedValue({
    summary,
    content: '{"permission_mode":"ask"}',
  })
  vi.mocked(saveSettingsTemplate)
    .mockRejectedValueOnce(new Error('save unavailable'))
    .mockReturnValueOnce(pending.promise)
  render(<ConfigTemplatesSection serverId="server-1" />)
  await screen.findByText('Fast local')
  await user.click(screen.getByTestId('config-template-edit-fast-local'))
  await screen.findByTestId('config-templates-editor')
  await user.type(screen.getByTestId('config-templates-description'), 'Preserve this draft')
  await user.click(screen.getByTestId('config-templates-save'))
  await screen.findByText('save unavailable')
  expect(screen.getByTestId('config-templates-description')).toHaveValue('Preserve this draft')
  await user.click(screen.getByTestId('config-templates-save'))
  expect(screen.getByTestId('config-templates-name')).toBeDisabled()
  expect(screen.getByTestId('config-templates-cancel')).toBeDisabled()
  expect(screen.getByTestId('config-templates-save')).toBeDisabled()
  await user.keyboard('{Escape}')
  expect(screen.getByTestId('config-templates-editor')).toBeTruthy()
  await act(async () =>
    pending.resolve({
      template: { ...summary, description: 'Preserve this draft' },
      defaultId: summary.id,
    })
  )
  await waitFor(() => expect(screen.queryByTestId('config-templates-editor')).toBeNull())
  expect(screen.getByText('Preserve this draft')).toBeTruthy()
  expect(listSettingsTemplates).toHaveBeenCalledTimes(1)
})

test('serializes file reads with editing and recovers after an import failure', async () => {
  const user = userEvent.setup()
  const pending = deferred<string>()
  render(<ConfigTemplatesSection serverId="server-1" />)
  await screen.findByText('Fast local')
  const slow = new File(['{}'], 'slow.jsonc')
  Object.defineProperty(slow, 'text', { value: () => pending.promise })
  await user.upload(screen.getByTestId('config-templates-import'), slow)
  expect(screen.getByTestId('config-templates-new')).toBeDisabled()
  expect(screen.getByTestId('config-template-edit-fast-local')).toBeDisabled()
  expect(screen.getByTestId('config-templates-import')).toBeDisabled()
  await act(async () => pending.resolve('{"tools":{"profile":"core"}}'))
  expect(screen.getByTestId('config-templates-name')).toHaveValue('slow')
  expect(screen.getByTestId('config-templates-content')).toHaveValue('{"tools":{"profile":"core"}}')
  await user.click(screen.getByTestId('config-templates-cancel'))
  const failed = new File(['{}'], 'failed.jsonc')
  Object.defineProperty(failed, 'text', {
    value: () => Promise.reject(new Error('file unavailable')),
  })
  await user.upload(screen.getByTestId('config-templates-import'), failed)
  await screen.findByText('file unavailable')
  expect(screen.getByTestId('config-templates-new')).toBeEnabled()
  await user.click(screen.getByTestId('config-templates-new'))
  expect(screen.queryByTestId('config-templates-error')).toBeNull()
  expect(screen.getByTestId('config-templates-name')).toHaveValue('')
  expect(saveSettingsTemplate).not.toHaveBeenCalled()
})
