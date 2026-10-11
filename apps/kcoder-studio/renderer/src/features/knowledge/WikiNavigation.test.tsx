import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { WikiSearch } from './WikiSearch'
import { WikiReader } from './WikiReader'
import { knowledgeApi, type WikiPage } from '@/kcoder/knowledgeApi'

vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: { search: vi.fn(), page: vi.fn(), citation: vi.fn(), links: vi.fn() },
}))
vi.mock('@/components/chat/AssistantMarkdown', () => ({
  AssistantMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const page = (id: string, revisionId = 'r1'): WikiPage => ({
  revisionId,
  humanEdited: false,
  draft: {
    pageId: id,
    title: id,
    markdown: id,
    citations: [{ sourceId: 'source', revisionId: 'source-r1', chunkId: 'chunk', quote: 'quote' }],
  },
})
const current = () => true
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(knowledgeApi.links).mockResolvedValue({ outgoing: [], incoming: [] } as never)
  vi.mocked(knowledgeApi.search).mockResolvedValue({
    items: ['A', 'B'].map(documentId => ({
      documentId,
      revisionId: 'r1',
      title: documentId,
      excerpt: 'match',
    })),
  } as never)
})
test('a citation opens its recorded revision when its source is outside the loaded catalog', async () => {
  const reference = {
    sourceId: 'source-11',
    revisionId: 'revision-11',
    chunkId: 'chunk',
    quote: 'quote',
  }
  const document = page('A')
  document.draft.citations = [reference]
  vi.mocked(knowledgeApi.citation).mockResolvedValue({
    source: { title: 'Source 11' },
    chunk: { text: 'Evidence from source 11', firstLine: 1, lastLine: 1 },
  } as never)
  render(
    <WikiReader
      page={document}
      serverId="local"
      libraryId="library"
      sources={[]}
      isCurrent={current}
      onBack={vi.fn()}
      onUpdated={vi.fn()}
      canOrganize
    />
  )
  fireEvent.click(screen.getByTestId('wiki-citation-0'))
  expect(await screen.findByTestId('wiki-source-preview')).toHaveTextContent('Source 11')
  expect(knowledgeApi.citation).toHaveBeenCalledWith('local', 'library', reference)
})
test('search only opens the most recently selected result, even when the earlier request finishes after unmount', async () => {
  const first = deferred<WikiPage>(),
    second = deferred<WikiPage>()
  vi.mocked(knowledgeApi.page)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const onPage = vi.fn()
  const view = render(
    <WikiSearch
      serverId="local"
      libraryId="library"
      isCurrent={current}
      onPage={onPage}
      onSource={vi.fn()}
    />
  )
  fireEvent.change(screen.getByTestId('wiki-search'), { target: { value: 'match' } })
  fireEvent.click(await screen.findByRole('button', { name: /A/ }))
  fireEvent.click(screen.getByRole('button', { name: /B/ }))
  await act(async () => second.resolve(page('B')))
  expect(onPage).toHaveBeenCalledWith(page('B'))
  view.unmount()
  await act(async () => first.resolve(page('A')))
  expect(onPage).toHaveBeenCalledTimes(1)
})
test('a new search invalidates a late open error', async () => {
  const first = deferred<WikiPage>()
  vi.mocked(knowledgeApi.page).mockReturnValue(first.promise)
  render(
    <WikiSearch
      serverId="local"
      libraryId="library"
      isCurrent={current}
      onPage={vi.fn()}
      onSource={vi.fn()}
    />
  )
  fireEvent.change(screen.getByTestId('wiki-search'), { target: { value: 'match' } })
  fireEvent.click(await screen.findByRole('button', { name: /A/ }))
  fireEvent.change(screen.getByTestId('wiki-search'), { target: { value: 'different' } })
  await act(async () => first.reject(new Error('old open failure')))
  expect(screen.queryByText('old open failure')).not.toBeInTheDocument()
})
test.each([
  ['B', 'r1'],
  ['A', 'r2'],
])('reader resets citations when page identity changes to %s/%s', async (id, revisionId) => {
  const oldRequest = deferred<Awaited<ReturnType<typeof knowledgeApi.citation>>>()
  vi.mocked(knowledgeApi.citation)
    .mockResolvedValueOnce({
      source: { title: 'old source' },
      chunk: { text: 'old evidence', firstLine: 1, lastLine: 1 },
    } as never)
    .mockReturnValueOnce(oldRequest.promise)
  const props = {
    serverId: 'local',
    libraryId: 'library',
    sources: [],
    isCurrent: current,
    onBack: vi.fn(),
    onUpdated: vi.fn(),
    canOrganize: true,
  }
  const view = render(<WikiReader page={page('A')} {...props} />)
  fireEvent.click(screen.getByTestId('wiki-citation-0'))
  await screen.findByTestId('wiki-source-preview')
  fireEvent.click(screen.getByTestId('wiki-citation-0'))
  expect(screen.getByTestId('wiki-citation-0')).toBeDisabled()
  view.rerender(<WikiReader page={page(id, revisionId)} {...props} />)
  expect(screen.queryByTestId('wiki-source-preview')).not.toBeInTheDocument()
  expect(screen.getByTestId('wiki-citation-0')).toBeEnabled()
  await act(async () =>
    oldRequest.resolve({
      source: { title: 'late source' },
      chunk: { text: 'late evidence' },
    } as never)
  )
  await waitFor(() => expect(screen.queryByText('late evidence')).not.toBeInTheDocument())
})
