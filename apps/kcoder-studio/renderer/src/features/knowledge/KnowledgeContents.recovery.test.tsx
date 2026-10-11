import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { KnowledgeContents } from './KnowledgeContents'
import { knowledgeApi, type WikiPage, type WikiPageSummary } from '@/kcoder/knowledgeApi'

// Model-independent component recovery: deferred read/list replies and the
// existing child completion callback, without simulating model output.
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: {
    pages: vi.fn(),
    sources: vi.fn(async () => ({ items: [] })),
    removedSources: vi.fn(async () => ({ items: [] })),
    page: vi.fn(),
  },
}))
vi.mock('./WikiImport', () => ({
  WikiImport: ({ onChanged }: { onChanged: () => void }) => (
    <button onClick={onChanged}>completed-job-refresh</button>
  ),
}))
vi.mock('./WikiSearch', () => ({ WikiSearch: () => null }))
vi.mock('./WikiReader', () => ({
  WikiReader: ({ page }: { page: WikiPage }) => <div>{`reader-${page.draft.title}`}</div>,
}))

const props = {
  serverId: 'local',
  libraryId: 'wiki',
  isCurrent: () => true,
  canRetrieve: true,
  canOrganize: true,
}
const page = (pageId: string): WikiPageSummary => ({
  pageId,
  title: pageId,
  revisionId: 'v1',
  kind: 'topic',
  humanEdited: false,
})
const firstPage = () => Array.from({ length: 10 }, (_, index) => page(`initial-${index}`))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
beforeEach(() => vi.clearAllMocks())

test('title filtering works with retrieval disabled and the content tabs support arrow keys', async () => {
  vi.mocked(knowledgeApi.pages).mockResolvedValue({ items: [page('Zebra'), page('Alpha')] })
  render(<KnowledgeContents {...props} canRetrieve={false} />)
  await screen.findByTestId('wiki-page-row-Alpha')
  fireEvent.change(screen.getByTestId('wiki-content-sort'), { target: { value: 'name' } })
  expect(screen.getAllByTestId(/^wiki-page-row-/).map(element => element.dataset.testid)).toEqual([
    'wiki-page-row-Alpha',
    'wiki-page-row-Zebra',
  ])
  fireEvent.change(screen.getByTestId('wiki-title-search'), { target: { value: 'alp' } })
  expect(screen.getByTestId('wiki-page-row-Alpha')).toBeVisible()
  expect(screen.queryByTestId('wiki-page-row-Zebra')).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByTestId('knowledge-tab-pages'), { key: 'ArrowRight' })
  expect(screen.getByTestId('knowledge-tab-sources')).toHaveFocus()
  expect(screen.getByTestId('knowledge-tab-sources')).toHaveAttribute('aria-selected', 'true')
})

test.each(['success', 'failure'] as const)(
  'a late %s from old pagination cannot change a refreshed list',
  async outcome => {
    const old = deferred<{ items: WikiPageSummary[]; nextAfterId: string | null }>()
    vi.mocked(knowledgeApi.pages)
      .mockResolvedValueOnce({ items: firstPage(), nextAfterId: 'cursor' })
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ items: [page('fresh')] })
    render(<KnowledgeContents {...props} />)
    await screen.findByText('initial-0')
    fireEvent.click(screen.getByTestId('wiki-content-next'))
    await waitFor(() => expect(knowledgeApi.pages).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByText('completed-job-refresh'))
    await screen.findByText('fresh')
    await act(async () => {
      if (outcome === 'success')
        old.resolve({ items: [page('obsolete')], nextAfterId: 'obsolete-cursor' })
      else old.reject(new Error('obsolete-pagination-error'))
    })
    expect(screen.queryByText('obsolete')).not.toBeInTheDocument()
    expect(screen.queryByText('obsolete-pagination-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('wiki-content-next')).toBeDisabled()
  }
)

test('a title filter with no loaded matches still permits loading the next catalog page', async () => {
  vi.mocked(knowledgeApi.pages)
    .mockResolvedValueOnce({
      items: [page('Alpha'), ...firstPage().slice(1)],
      nextAfterId: 'cursor',
    })
    .mockResolvedValueOnce({ items: [page('Zebra')] })
  render(<KnowledgeContents {...props} canRetrieve={false} />)
  await screen.findByTestId('wiki-page-row-Alpha')
  fireEvent.change(screen.getByTestId('wiki-title-search'), { target: { value: 'zeb' } })
  expect(screen.getByText('noSearchResults')).toBeVisible()
  fireEvent.click(screen.getByTestId('wiki-content-next'))
  expect(await screen.findByTestId('wiki-page-row-Zebra')).toBeVisible()
  expect(knowledgeApi.pages).toHaveBeenLastCalledWith('local', 'wiki', 'cursor', 10)
})

test('page row actions open the same owned reader', async () => {
  vi.mocked(knowledgeApi.pages).mockResolvedValue({ items: [page('Alpha')] })
  vi.mocked(knowledgeApi.page).mockResolvedValue({
    revisionId: 'v1',
    humanEdited: false,
    draft: { pageId: 'Alpha', title: 'Alpha', markdown: 'content', citations: [] },
  })
  render(<KnowledgeContents {...props} />)
  fireEvent.click(await screen.findByTestId('wiki-page-actions-Alpha'))
  fireEvent.click(await screen.findByTestId('wiki-page-open-Alpha'))
  expect(await screen.findByText('reader-Alpha')).toBeVisible()
  expect(knowledgeApi.page).toHaveBeenCalledTimes(1)
})

test('refreshing a list releases the old page spinner and permits reading the fresh page', async () => {
  const old = deferred<WikiPage>()
  vi.mocked(knowledgeApi.pages)
    .mockResolvedValueOnce({ items: [page('old')] })
    .mockResolvedValueOnce({ items: [page('fresh')] })
  vi.mocked(knowledgeApi.page)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({
      revisionId: 'v1',
      humanEdited: false,
      draft: { pageId: 'fresh', title: 'fresh', markdown: 'owned', citations: [] },
    })
  render(<KnowledgeContents {...props} />)
  fireEvent.click(await screen.findByText('old'))
  await waitFor(() => expect(knowledgeApi.page).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByText('completed-job-refresh'))
  await screen.findByText('fresh')
  expect(screen.getByTestId('wiki-page-row-fresh')).toBeEnabled()
  fireEvent.click(screen.getByText('fresh'))
  await screen.findByText('reader-fresh')
  await act(async () =>
    old.resolve({
      revisionId: 'v1',
      humanEdited: false,
      draft: { pageId: 'old', title: 'old', markdown: 'obsolete', citations: [] },
    })
  )
  expect(screen.getByText('reader-fresh')).toBeInTheDocument()
  expect(screen.queryByText('reader-old')).not.toBeInTheDocument()
})

test('a successful list refresh clears the earlier load error', async () => {
  vi.mocked(knowledgeApi.pages)
    .mockRejectedValueOnce(new Error('initial-load-error'))
    .mockResolvedValueOnce({ items: [page('recovered')] })
  render(<KnowledgeContents {...props} />)
  await screen.findByText('initial-load-error')
  fireEvent.click(screen.getByText('completed-job-refresh'))
  await screen.findByText('recovered')
  expect(screen.queryByText('initial-load-error')).not.toBeInTheDocument()
})
