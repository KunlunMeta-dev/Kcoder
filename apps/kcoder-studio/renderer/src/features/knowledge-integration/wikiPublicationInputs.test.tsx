import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type {
  IntegrationRequest,
  IntegrationScope,
  KnowledgePublication,
} from '../../../../shared/generated/contracts'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { KnowledgeIntegrationClient } from './client'
import { KnowledgePublications, type PublishableWikiPage } from './KnowledgePublications'
import type { NativeWikiMetadataPage, NativeWikiPublicationInputs } from './wikiPublicationInputs'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope: IntegrationScope = {
  accountId: 'fixture-account',
  targetId: 'fixture-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const response = (request: IntegrationRequest, result: Record<string, unknown>) => ({
  contractVersion: 'parallel-v1',
  requestId: request.requestId,
  operationId: request.operationId ?? null,
  entityRevision: null,
  observedAt: '2026-10-24T00:00:00Z',
  status: 'completed',
  result,
  error: null,
})
function setup() {
  const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
    response(request, {
      publication: {
        ...fixtures.KnowledgePublication.valid[0].value,
        draft: request.payload.draft,
      } as KnowledgePublication,
    })
  )
  const management = vi.fn(
    async (_domain: unknown, _method: unknown, request: IntegrationRequest) =>
      response(request, { page: { items: [], nextCursor: null } })
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  return { call, client }
}
const item = (libraryId: string, index: number, revision = 'r1'): PublishableWikiPage => ({
  title: `${libraryId} page ${index} ${revision}`,
  source: { libraryId, pageId: `page-${index}`, pageRevision: revision },
})
const libraries = [
  { id: 'library-a', title: 'Library A' },
  { id: 'library-b', title: 'Library B' },
]
function openEditor() {
  fireEvent.click(screen.getByTestId('publication-create-toggle'))
  fireEvent.change(screen.getByTestId('publication-title'), {
    target: { value: 'Explicit fixed selection' },
  })
  fireEvent.change(screen.getByTestId('publication-purpose'), {
    target: { value: 'Selected original revisions only' },
  })
}

it('loads actual-provider metadata lazily and retains explicit revisions across pages, library switches and newer refreshes', async () => {
  const { client, call } = setup()
  let revision = 'r1'
  const listLibraries = vi.fn<NativeWikiPublicationInputs['listLibraries']>(async () => ({
    items: libraries,
    nextCursor: null,
  }))
  const listPages = vi.fn<NativeWikiPublicationInputs['listPages']>(
    async ({ libraryId, after }) => ({
      items:
        libraryId === 'library-a'
          ? after
            ? [item(libraryId, 10)]
            : Array.from({ length: 10 }, (_, n) => item(libraryId, n, revision))
          : [item(libraryId, 0)],
      nextCursor: libraryId === 'library-a' && !after ? 'actual-page-ten' : null,
    })
  )
  const provider: NativeWikiPublicationInputs = {
    ownerKey: client.ownerKey,
    listLibraries,
    listPages,
  }
  render(<KnowledgePublications client={client} wikiInputs={provider} />)
  expect(listLibraries).not.toHaveBeenCalled()
  openEditor()
  await screen.findByRole('button', { name: 'Library A' })
  expect(listPages).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Library A' }))
  await screen.findByText('library-a page 0 r1')
  const pages = screen.getByTestId('publication-library-pages')
  expect(within(pages).getAllByTestId('publication-source-checkbox')).toHaveLength(10)
  fireEvent.click(within(pages).getAllByTestId('publication-source-checkbox')[0])
  fireEvent.click(within(pages).getByTestId('knowledge-page-next'))
  await screen.findByText('library-a page 10 r1')
  fireEvent.click(within(pages).getByTestId('publication-source-checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Library B' }))
  await screen.findByText('library-b page 0 r1')
  fireEvent.click(within(pages).getByTestId('publication-source-checkbox'))
  revision = 'r2'
  fireEvent.click(screen.getByRole('button', { name: 'Library A' }))
  await screen.findByText('library-a page 0 r2')
  expect(within(pages).getAllByTestId('publication-source-checkbox')[0]).not.toBeChecked()
  fireEvent.click(within(pages).getByTestId('knowledge-refresh'))
  await waitFor(() => expect(within(pages).getByTestId('knowledge-refresh')).not.toBeDisabled())
  expect(screen.getAllByTestId('publication-selected-source')).toHaveLength(3)
  expect(screen.getByTestId('publication-selected-sources')).toHaveTextContent(
    'library-a page 0 r1'
  )
  expect(call).not.toHaveBeenCalled()
  expect(
    listLibraries.mock.calls.every(
      ([input]) => input.limit === 10 && input.signal instanceof AbortSignal
    )
  ).toBe(true)
  expect(
    listPages.mock.calls.every(
      ([input]) => input.limit === 10 && input.signal instanceof AbortSignal
    )
  ).toBe(true)
  expect(listPages.mock.calls.some(([input]) => input.after === 'actual-page-ten')).toBe(true)
  fireEvent.click(screen.getByTestId('knowledge-publish'))
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  expect(call.mock.calls[0][2].payload.draft).toMatchObject({
    sources: [
      item('library-a', 0).source,
      item('library-a', 10).source,
      item('library-b', 0).source,
    ],
  })
  client.dispose()
})

it('pages libraries ten at a time without choosing the first library or submitting the publication form', async () => {
  const { client, call } = setup()
  const listLibraries = vi.fn<NativeWikiPublicationInputs['listLibraries']>(async ({ after }) => ({
    items: after
      ? [{ id: 'last-library', title: 'Last actual library' }]
      : Array.from({ length: 10 }, (_, n) => ({ id: `library-${n}`, title: `Library ${n}` })),
    nextCursor: after ? null : 'real-library-cursor',
  }))
  const listPages = vi.fn<NativeWikiPublicationInputs['listPages']>(async () => ({
    items: [],
    nextCursor: null,
  }))
  render(
    <KnowledgePublications
      client={client}
      wikiInputs={{ ownerKey: client.ownerKey, listLibraries, listPages }}
    />
  )
  openEditor()
  await waitFor(() => expect(screen.getAllByTestId('publication-library-choice')).toHaveLength(10))
  expect(listPages).not.toHaveBeenCalled()
  const picker = screen.getByTestId('native-wiki-publication-inputs')
  fireEvent.click(within(picker).getByTestId('knowledge-page-next'))
  await screen.findByText('Last actual library')
  expect(screen.getAllByTestId('publication-library-choice')).toHaveLength(1)
  expect(listLibraries.mock.calls[1][0].after).toBe('real-library-cursor')
  expect(listPages).not.toHaveBeenCalled()
  expect(call).not.toHaveBeenCalled()
  client.dispose()
})

it('preserves fixed selection while metadata is unavailable and keeps failure distinct from an empty page', async () => {
  const { client, call } = setup()
  let fail = false
  const listPages = vi.fn<NativeWikiPublicationInputs['listPages']>(async () => {
    if (fail) throw new Error('PRIVATE_PATH_OR_TOKEN')
    return { items: [item('library-a', 0, 'r2')], nextCursor: null }
  })
  const provider: NativeWikiPublicationInputs = {
    ownerKey: client.ownerKey,
    listLibraries: async () => ({ items: libraries, nextCursor: null }),
    listPages,
  }
  render(<KnowledgePublications client={client} wikiInputs={provider} />)
  openEditor()
  await screen.findByRole('button', { name: 'Library A' })
  fireEvent.click(screen.getByRole('button', { name: 'Library A' }))
  await screen.findByText('library-a page 0 r2')
  const pages = screen.getByTestId('publication-library-pages')
  fireEvent.click(within(pages).getByTestId('publication-source-checkbox'))
  fail = true
  fireEvent.click(within(pages).getByTestId('knowledge-refresh'))
  await screen.findByText('sourceSelectionAwaitingRead')
  expect(within(pages).queryByText('noPages')).not.toBeInTheDocument()
  expect(screen.queryByTestId('publication-selected-sources')).not.toBeInTheDocument()
  expect(screen.getByTestId('knowledge-publish')).toBeDisabled()
  expect(document.body.textContent).not.toContain('PRIVATE_PATH_OR_TOKEN')
  expect(call).not.toHaveBeenCalled()
  fail = false
  fireEvent.click(within(pages).getByTestId('knowledge-refresh'))
  await screen.findByTestId('publication-selected-sources')
  expect(screen.getAllByTestId('publication-selected-source')).toHaveLength(1)
  expect(within(pages).getByTestId('publication-source-checkbox')).toBeChecked()
  expect(screen.getByTestId('knowledge-publish')).not.toBeDisabled()
  client.dispose()
})

it('discards a late old-library response after an explicit library switch', async () => {
  const { client } = setup()
  let complete: (value: unknown) => void = () => undefined
  const listPages = vi.fn<NativeWikiPublicationInputs['listPages']>(({ libraryId }) =>
    libraryId === 'library-a'
      ? new Promise(resolve => {
          complete = resolve as (value: unknown) => void
        })
      : Promise.resolve({ items: [item('library-b', 0)], nextCursor: null })
  )
  render(
    <KnowledgePublications
      client={client}
      wikiInputs={{
        ownerKey: client.ownerKey,
        listLibraries: async () => ({ items: libraries, nextCursor: null }),
        listPages,
      }}
    />
  )
  openEditor()
  await screen.findByRole('button', { name: 'Library A' })
  fireEvent.click(screen.getByRole('button', { name: 'Library A' }))
  await waitFor(() => expect(listPages).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Library B' }))
  await screen.findByText('library-b page 0 r1')
  await act(async () => {
    complete({
      items: [{ ...item('library-a', 0), title: 'Late private A' }],
      nextCursor: 'old-library-cursor',
    })
  })
  expect(screen.queryByText('Late private A')).not.toBeInTheDocument()
  expect(
    within(screen.getByTestId('publication-library-pages')).getByTestId('knowledge-page-next')
  ).toBeDisabled()
  client.dispose()
})

it.each(['oversized', 'foreign-library', 'legacy-cursor'] as const)(
  'rejects %s metadata rather than truncating it or treating it as no pages',
  async kind => {
    const { client } = setup()
    const listPages: NativeWikiPublicationInputs['listPages'] = async () => {
      if (kind === 'legacy-cursor')
        return {
          items: [item('library-a', 0)],
          nextAfterId: 'unmapped-native-cursor',
        } as unknown as NativeWikiMetadataPage<PublishableWikiPage>
      return {
        items:
          kind === 'oversized'
            ? Array.from({ length: 11 }, (_, n) => item('library-a', n))
            : [item('another-library', 0)],
        nextCursor: 'untrusted-cursor',
      }
    }
    render(
      <KnowledgePublications
        client={client}
        wikiInputs={{
          ownerKey: client.ownerKey,
          listLibraries: async () => ({ items: libraries, nextCursor: null }),
          listPages,
        }}
      />
    )
    openEditor()
    await screen.findByRole('button', { name: 'Library A' })
    fireEvent.click(screen.getByRole('button', { name: 'Library A' }))
    await screen.findByText('sourceSelectionAwaitingRead')
    expect(screen.queryByTestId('publication-source-checkbox')).not.toBeInTheDocument()
    expect(
      within(screen.getByTestId('publication-library-pages')).queryByText('noPages')
    ).not.toBeInTheDocument()
    client.dispose()
  }
)

it('rejects a provider for a different owner before requesting metadata', async () => {
  const { client } = setup()
  const listLibraries = vi.fn<NativeWikiPublicationInputs['listLibraries']>()
  const listPages = vi.fn<NativeWikiPublicationInputs['listPages']>()
  render(
    <KnowledgePublications
      client={client}
      wikiInputs={{ ownerKey: 'another-target', listLibraries, listPages }}
    />
  )
  openEditor()
  await screen.findByText('sourceSelectionAwaitingRead')
  expect(listLibraries).not.toHaveBeenCalled()
  expect(listPages).not.toHaveBeenCalled()
  expect(screen.getByTestId('knowledge-publish')).toBeDisabled()
  client.dispose()
})
