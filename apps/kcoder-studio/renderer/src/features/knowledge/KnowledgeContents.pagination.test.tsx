import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { KnowledgeContents } from './KnowledgeContents'
import {
  knowledgeApi,
  type WikiPageList,
  type WikiPageSummary,
  type WikiSource,
} from '@/kcoder/knowledgeApi'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { number?: number }) =>
      values?.number ? `${key}-${values.number}` : key,
  }),
}))
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: { pages: vi.fn(), sources: vi.fn(), removedSources: vi.fn(), page: vi.fn() },
}))
vi.mock('./WikiImport', () => ({
  WikiImport: ({ onChanged }: { onChanged: () => void }) => (
    <button onClick={onChanged}>completed-job-refresh</button>
  ),
}))
vi.mock('./WikiSearch', () => ({
  WikiSearch: ({ onQueryChange }: { onQueryChange: () => void }) => (
    <button onClick={onQueryChange}>wiki-search-changed</button>
  ),
}))
vi.mock('./WikiSourceReader', () => ({
  WikiSourceReader: ({
    source,
    onChanged,
    onClose,
  }: {
    source: WikiSource
    onChanged: () => void
    onClose: () => void
  }) => (
    <button
      onClick={() => {
        sourceRows = sourceRows.filter(item => item.sourceId !== source.sourceId)
        onChanged()
        onClose()
      }}
    >
      remove-source
    </button>
  ),
}))

const props = {
  serverId: 'local',
  libraryId: 'wiki',
  isCurrent: () => true,
  canRetrieve: false,
  canOrganize: true,
}
const page = (index: number): WikiPageSummary => ({
  pageId: `p${String(index).padStart(3, '0')}`,
  title: `Page ${String(index).padStart(3, '0')}`,
  revisionId: 'v1',
  kind: 'topic',
  humanEdited: false,
})
const source = (index: number): WikiSource => ({
  sourceId: `s${String(index).padStart(3, '0')}`,
  title: `Source ${String(index).padStart(3, '0')}`,
  revisionId: 'v1',
  bodyHash: 'body',
})
let pageRows: WikiPageSummary[]
let sourceRows: WikiSource[]
function batch<T>(
  items: T[],
  id: (item: T) => string,
  afterId?: string,
  limit = 50
): WikiPageList<T> {
  expect(limit).toBe(10)
  const found = items.filter(item => !afterId || id(item) > afterId).slice(0, limit)
  return { items: found, nextAfterId: found.length === limit ? id(found[found.length - 1]) : null }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const next = () => fireEvent.click(screen.getByTestId('wiki-content-next'))
const tab = (value: 'pages' | 'sources') =>
  fireEvent.click(screen.getByTestId(`knowledge-tab-${value}`))
const rows = (value: 'page' | 'source') => screen.getAllByTestId(new RegExp(`^wiki-${value}-row-`))
const atPage = (number: number) =>
  waitFor(() =>
    expect(screen.getByTestId('wiki-content-page')).toHaveTextContent(`catalogPage-${number}`)
  )

beforeEach(() => {
  vi.resetAllMocks()
  pageRows = Array.from({ length: 21 }, (_, index) => page(index + 1))
  sourceRows = Array.from({ length: 11 }, (_, index) => source(index + 1))
  vi.mocked(knowledgeApi.pages).mockImplementation(async (_server, _library, cursor, limit) =>
    batch(pageRows, item => item.pageId, cursor, limit)
  )
  vi.mocked(knowledgeApi.sources).mockImplementation(async (_server, _library, cursor, limit) =>
    batch(sourceRows, item => item.sourceId, cursor, limit)
  )
  vi.mocked(knowledgeApi.removedSources).mockResolvedValue({ items: [source(99)] })
})

test('21 pages and 11 sources use independent ten-row pages and fetch only on demand', async () => {
  render(<KnowledgeContents {...props} />)
  await screen.findByTestId('wiki-page-row-p001')
  expect(rows('page')).toHaveLength(10)
  expect(knowledgeApi.pages).toHaveBeenCalledTimes(1)
  expect(knowledgeApi.sources).toHaveBeenCalledTimes(1)
  next()
  await atPage(2)
  expect(rows('page')).toHaveLength(10)
  expect(screen.getByTestId('wiki-page-row-p011')).toBeVisible()
  next()
  await atPage(3)
  expect(rows('page')).toHaveLength(1)
  expect(screen.getByTestId('wiki-page-row-p021')).toBeVisible()
  expect(screen.getByTestId('wiki-content-next')).toBeDisabled()
  tab('sources')
  expect(rows('source')).toHaveLength(10)
  next()
  await atPage(2)
  expect(rows('source')).toHaveLength(1)
  expect(screen.getByTestId('wiki-source-row-s011')).toBeVisible()
  tab('pages')
  await atPage(3)
  fireEvent.click(screen.getByTestId('wiki-content-previous'))
  await atPage(2)
  expect(knowledgeApi.pages).toHaveBeenCalledTimes(3)
})

test.each([17, 50])(
  'retains all %i items from an oversized batch before consuming its cursor',
  async size => {
    pageRows = Array.from({ length: size + 4 }, (_, index) => page(index + 1))
    vi.mocked(knowledgeApi.pages).mockResolvedValueOnce({
      items: pageRows.slice(0, size),
      nextAfterId: page(size).pageId,
    })
    render(<KnowledgeContents {...props} />)
    await screen.findByTestId('wiki-page-row-p001')
    const visited: string[] = []
    for (let index = 0; index < Math.ceil(pageRows.length / 10); index++) {
      await atPage(index + 1)
      visited.push(...rows('page').map(element => element.dataset.testid!))
      expect(rows('page').length).toBeLessThanOrEqual(10)
      if (index < Math.ceil(pageRows.length / 10) - 1) next()
    }
    expect(visited).toEqual(pageRows.map(item => `wiki-page-row-${item.pageId}`))
    expect(knowledgeApi.pages).toHaveBeenCalledTimes(2)
    expect(knowledgeApi.pages).toHaveBeenLastCalledWith('local', 'wiki', page(size).pageId, 10)
  }
)

test('an empty next probe keeps the final full page and disables Next', async () => {
  pageRows = pageRows.slice(0, 20)
  render(<KnowledgeContents {...props} />)
  await screen.findByTestId('wiki-page-row-p001')
  next()
  await atPage(2)
  expect(screen.getByTestId('wiki-content-next')).toBeEnabled()
  next()
  await waitFor(() => expect(screen.getByTestId('wiki-content-next')).toBeDisabled())
  await atPage(2)
  expect(rows('page')).toHaveLength(10)
  expect(screen.getByTestId('wiki-page-row-p020')).toBeVisible()
})

test('search and sort reset both positions while reusing loaded entries', async () => {
  render(<KnowledgeContents {...props} />)
  await screen.findByTestId('wiki-page-row-p001')
  next()
  await atPage(2)
  tab('sources')
  next()
  await atPage(2)
  tab('pages')
  fireEvent.change(screen.getByTestId('wiki-content-sort'), { target: { value: 'name-desc' } })
  await atPage(1)
  expect(rows('page')[0]).toHaveAttribute('data-testid', 'wiki-page-row-p020')
  tab('sources')
  await atPage(1)
  tab('pages')
  next()
  await atPage(2)
  fireEvent.change(screen.getByTestId('wiki-title-search'), { target: { value: 'Page 011' } })
  await atPage(1)
  expect(rows('page')).toHaveLength(1)
  expect(screen.getByTestId('wiki-content-loaded-hint')).toBeVisible()
  fireEvent.change(screen.getByTestId('wiki-title-search'), { target: { value: 'Page 01' } })
  expect(knowledgeApi.pages).toHaveBeenCalledTimes(2)
})

test('refresh rebuilds visited cursors and preserves the current page after insertion', async () => {
  render(<KnowledgeContents {...props} />)
  await screen.findByTestId('wiki-page-row-p001')
  next()
  await atPage(2)
  next()
  await atPage(3)
  pageRows.unshift(page(0))
  fireEvent.click(screen.getByText('completed-job-refresh'))
  await screen.findByTestId('wiki-page-row-p020')
  await atPage(3)
  expect(rows('page')).toHaveLength(2)
  expect(knowledgeApi.pages).toHaveBeenNthCalledWith(4, 'local', 'wiki', undefined, 10)
  fireEvent.click(screen.getByTestId('wiki-content-previous'))
  fireEvent.click(screen.getByTestId('wiki-content-previous'))
  await atPage(1)
  expect(screen.getByTestId('wiki-page-row-p000')).toBeVisible()
})

test('removing the only source on the last page clamps to the previous nonempty page', async () => {
  render(<KnowledgeContents {...props} />)
  await screen.findByTestId('wiki-page-row-p001')
  tab('sources')
  next()
  await atPage(2)
  fireEvent.click(screen.getByTestId('wiki-source-row-s011'))
  fireEvent.click(screen.getByText('remove-source'))
  await atPage(1)
  await waitFor(() => expect(screen.getByTestId('wiki-content-next')).toBeDisabled())
  expect(rows('source')).toHaveLength(10)
  expect(screen.queryByTestId('wiki-source-row-s011')).not.toBeInTheDocument()
})

test.each(['success', 'failure'] as const)(
  'switching Wiki rejects a late pagination %s',
  async outcome => {
    const old = deferred<WikiPageList<WikiPageSummary>>()
    vi.mocked(knowledgeApi.pages)
      .mockResolvedValueOnce({ items: pageRows.slice(0, 10), nextAfterId: 'p010' })
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ items: [page(99)] })
    const view = render(<KnowledgeContents {...props} />)
    await screen.findByTestId('wiki-page-row-p001')
    next()
    await waitFor(() => expect(knowledgeApi.pages).toHaveBeenCalledTimes(2))
    view.rerender(<KnowledgeContents {...props} libraryId="new-wiki" />)
    await screen.findByTestId('wiki-page-row-p099')
    await act(async () => {
      if (outcome === 'success') old.resolve({ items: [page(88)] })
      else old.reject(new Error('obsolete-error'))
    })
    await atPage(1)
    expect(screen.queryByTestId('wiki-page-row-p088')).not.toBeInTheDocument()
    expect(screen.queryByText('obsolete-error')).not.toBeInTheDocument()
  }
)

test('trash filtering starts the sources catalog at the first page', async () => {
  render(<KnowledgeContents {...props} />)
  await screen.findByTestId('wiki-page-row-p001')
  tab('sources')
  next()
  await atPage(2)
  fireEvent.click(screen.getByTestId('wiki-trash-toggle'))
  await screen.findByTestId('wiki-source-row-s099')
  await atPage(1)
  expect(knowledgeApi.removedSources).toHaveBeenCalledWith('local', 'wiki', undefined, 10)
})

test('changing the title filter while Next is pending keeps the reset page and cached response', async () => {
  const pending = deferred<WikiPageList<WikiPageSummary>>()
  vi.mocked(knowledgeApi.pages)
    .mockResolvedValueOnce({ items: pageRows.slice(0, 10), nextAfterId: 'p010' })
    .mockReturnValueOnce(pending.promise)
  render(<KnowledgeContents {...props} />)
  await screen.findByTestId('wiki-page-row-p001')
  next()
  await waitFor(() => expect(knowledgeApi.pages).toHaveBeenCalledTimes(2))
  fireEvent.change(screen.getByTestId('wiki-title-search'), { target: { value: 'Page 011' } })
  await act(async () => pending.resolve({ items: pageRows.slice(10, 20), nextAfterId: 'p020' }))
  await atPage(1)
  expect(screen.getByTestId('wiki-page-row-p011')).toBeVisible()
  expect(rows('page')).toHaveLength(1)
  expect(knowledgeApi.pages).toHaveBeenCalledTimes(2)
})

test('Wiki retrieval search resets both catalog positions', async () => {
  render(<KnowledgeContents {...props} canRetrieve />)
  await screen.findByTestId('wiki-page-row-p001')
  next()
  await atPage(2)
  tab('sources')
  next()
  await atPage(2)
  fireEvent.click(screen.getByText('wiki-search-changed'))
  await atPage(1)
  tab('pages')
  await atPage(1)
  expect(knowledgeApi.pages).toHaveBeenCalledTimes(2)
})

test('a filtered deletion clamps the stored page so later background additions cannot restore it', async () => {
  pageRows = Array.from({ length: 30 }, (_, index) => ({
    ...page(index + 1),
    title: index < 11 ? `Match ${index + 1}` : `Other ${index + 1}`,
  }))
  render(<KnowledgeContents {...props} />)
  await screen.findByTestId('wiki-page-row-p001')
  next()
  await atPage(2)
  next()
  await atPage(3)
  fireEvent.change(screen.getByTestId('wiki-title-search'), { target: { value: 'Match' } })
  next()
  await atPage(2)
  expect(rows('page')).toHaveLength(1)
  pageRows = pageRows.filter(item => item.pageId !== 'p011')
  fireEvent.click(screen.getByText('completed-job-refresh'))
  await atPage(1)
  await waitFor(() => expect(screen.getByTestId('wiki-content-next')).toBeDisabled())
  pageRows.push({ ...page(31), title: 'Match new' })
  fireEvent.click(screen.getByText('completed-job-refresh'))
  await waitFor(() => expect(screen.getByTestId('wiki-content-next')).toBeEnabled())
  await atPage(1)
  expect(rows('page')).toHaveLength(10)
  expect(screen.queryByTestId('wiki-page-row-p031')).not.toBeInTheDocument()
})
