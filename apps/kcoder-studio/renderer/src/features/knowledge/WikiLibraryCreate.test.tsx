import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { knowledgeApi } from '@/kcoder/knowledgeApi'
import { WikiLibraryCreate } from './WikiLibraryCreate'
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: { create: vi.fn(), selectLibrary: vi.fn() },
}))
beforeEach(() => vi.resetAllMocks())
test('requires a name and reuses the successful creation when selection fails', async () => {
  vi.mocked(knowledgeApi.create).mockResolvedValue({ id: 'new-wiki' } as never)
  vi.mocked(knowledgeApi.selectLibrary)
    .mockRejectedValueOnce(new Error('network failure'))
    .mockResolvedValueOnce({} as never)
  const onCreated = vi.fn()
  render(
    <WikiLibraryCreate
      serverId="local"
      isCurrent={() => true}
      onClose={vi.fn()}
      onCreated={onCreated}
    />
  )
  expect(screen.getByTestId('wiki-create-confirm')).toBeDisabled()
  await userEvent.type(screen.getByTestId('wiki-create-input'), '  Research  {enter}')
  await screen.findByText('network failure')
  await userEvent.click(screen.getByTestId('wiki-create-confirm'))
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
  expect(knowledgeApi.create).toHaveBeenCalledExactlyOnceWith(
    'local',
    expect.any(String),
    'Research'
  )
  expect(knowledgeApi.selectLibrary).toHaveBeenCalledTimes(2)
})
test('does not select a library after the target changes during creation', async () => {
  let finish!: (value: never) => void
  vi.mocked(knowledgeApi.create).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  let current = true
  const onCreated = vi.fn()
  render(
    <WikiLibraryCreate
      serverId="old"
      isCurrent={() => current}
      onClose={vi.fn()}
      onCreated={onCreated}
    />
  )
  await userEvent.type(screen.getByTestId('wiki-create-input'), 'Research')
  await userEvent.click(screen.getByTestId('wiki-create-confirm'))
  current = false
  finish({ id: 'old-library' } as never)
  await waitFor(() => expect(knowledgeApi.create).toHaveBeenCalledOnce())
  expect(knowledgeApi.selectLibrary).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
})
