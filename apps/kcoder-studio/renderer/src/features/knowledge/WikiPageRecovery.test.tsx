import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { WikiPageEditor } from './WikiPageEditor'
import { WikiPageHistory } from './WikiPageHistory'
import { knowledgeApi, type WikiPage } from '@/kcoder/knowledgeApi'
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: { editPage: vi.fn(), restorePage: vi.fn(), page: vi.fn(), history: vi.fn() },
}))
vi.mock('@/components/chat/AssistantMarkdown', () => ({
  AssistantMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}))
const page: WikiPage = {
  revisionId: 'r2',
  humanEdited: true,
  draft: { pageId: 'page', title: 'Current page', markdown: 'Current body', citations: [] },
}
const saved = { ...page, revisionId: 'r3' }
const props = {
  page,
  serverId: 'local',
  libraryId: 'library',
  isCurrent: () => true,
  onClose: vi.fn(),
}
beforeEach(() => vi.clearAllMocks())
test('editor retries only reading after the write succeeded and loading failed', async () => {
  vi.mocked(knowledgeApi.editPage).mockResolvedValue({ pageId: 'page', revisionId: 'r3' } as never)
  vi.mocked(knowledgeApi.page)
    .mockRejectedValueOnce(new Error('read unavailable'))
    .mockResolvedValue(saved)
  const onSaved = vi.fn()
  render(<WikiPageEditor {...props} onSaved={onSaved} />)
  fireEvent.click(screen.getByTestId('wiki-edit-save'))
  const retry = await screen.findByTestId('wiki-edit-reload')
  expect(screen.getByTestId('wiki-edit-save')).toBeDisabled()
  expect(screen.getByTestId('wiki-edit-body')).toBeDisabled()
  fireEvent.click(retry)
  await screen.findByTestId('wiki-page-editor')
  expect(await vi.waitFor(() => onSaved.mock.calls.length)).toBe(1)
  expect(knowledgeApi.editPage).toHaveBeenCalledTimes(1)
  expect(knowledgeApi.page).toHaveBeenCalledTimes(2)
  expect(onSaved).toHaveBeenCalledWith(saved)
})
test('history retries only reading the acknowledged restored revision', async () => {
  vi.mocked(knowledgeApi.history).mockResolvedValue({
    items: [{ revisionId: 'r1', sequence: 1, author: 'human' }],
  } as never)
  vi.mocked(knowledgeApi.page)
    .mockResolvedValueOnce({ ...page, revisionId: 'r1' })
    .mockRejectedValueOnce(new Error('restore read unavailable'))
    .mockResolvedValue(saved)
  vi.mocked(knowledgeApi.restorePage).mockResolvedValue({
    pageId: 'page',
    revisionId: 'r3',
  } as never)
  const onRestored = vi.fn()
  render(<WikiPageHistory {...props} onRestored={onRestored} canOrganize />)
  fireEvent.click(await screen.findByTestId('wiki-history-version-1'))
  await vi.waitFor(() => expect(screen.getByTestId('wiki-history-restore')).toBeEnabled())
  fireEvent.click(screen.getByTestId('wiki-history-restore'))
  fireEvent.click(await screen.findByTestId('wiki-history-reload'))
  await vi.waitFor(() => expect(onRestored).toHaveBeenCalledWith(saved))
  expect(knowledgeApi.restorePage).toHaveBeenCalledTimes(1)
  expect(knowledgeApi.page).toHaveBeenLastCalledWith('local', 'library', 'page', 'r3')
})
