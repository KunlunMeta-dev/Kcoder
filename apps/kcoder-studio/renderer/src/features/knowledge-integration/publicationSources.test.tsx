import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type {
  IntegrationRequest,
  IntegrationScope,
  KnowledgePublication,
  KnowledgeSourceObservation,
} from '../../../../shared/generated/contracts'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { KnowledgeIntegrationClient } from './client'
import { KnowledgePublications } from './KnowledgePublications'
import { PublicationSources } from './PublicationSources'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const scope: IntegrationScope = {
  accountId: 'fixture-account',
  targetId: 'fixture-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const publication = fixtures.KnowledgePublication.valid[0].value as KnowledgePublication
const observation = fixtures.KnowledgeSourceObservation.valid[0].value as KnowledgeSourceObservation
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

it('reads exact publication sources through the read-only management route and validates fixed references', async () => {
  const management = vi.fn(
    async (_domain: unknown, _method: unknown, request: IntegrationRequest) =>
      response(request, { page: { items: [observation], nextCursor: 'native-next' } })
  )
  const call = vi.fn()
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  expect((await client.readPublicationSources(publication, 'native-before')).nextCursor).toBe(
    'native-next'
  )
  expect(management).toHaveBeenCalledWith(
    'knowledge',
    'readPublicationSources',
    expect.objectContaining({
      operationId: undefined,
      expectedRevision: undefined,
      payload: {
        owner: publication.owner,
        publicationId: publication.draft.publicationId,
        version: publication.version,
        after: 'native-before',
      },
    }),
    expect.any(AbortSignal)
  )
  management.mockImplementation(async (_domain, _method, request) =>
    response(request, {
      page: {
        items: [
          { ...observation, source: { ...observation.source, pageRevision: 'unexpected-latest' } },
        ],
        nextCursor: null,
      },
    })
  )
  await expect(client.readPublicationSources(publication)).rejects.toMatchObject({
    code: 'KNOWLEDGE_INVALID_RECEIPT',
  })
  expect(call).not.toHaveBeenCalled()
  client.dispose()
})

it('rejects a latest-version or different-owner body returned for an explicitly requested fixed publication', async () => {
  const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
    response(request, { publication: { ...publication, version: 2 } })
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management: vi.fn() })
  await expect(client.resolvePublication(publication, 1)).rejects.toMatchObject({
    code: 'KNOWLEDGE_INVALID_RECEIPT',
  })
  call.mockImplementation(async (_port, _method, request) =>
    response(request, {
      publication: { ...publication, owner: { ...publication.owner, accountId: 'another-owner' } },
    })
  )
  await expect(client.resolvePublication(publication, 1)).rejects.toMatchObject({
    code: 'KNOWLEDGE_INVALID_RECEIPT',
  })
  client.dispose()
})

it('loads source lifecycle only on demand and pages ten fixed revisions without replacing snapshots', async () => {
  const pages = Array.from({ length: 11 }, (_, index) => ({
    ...publication.pages[0],
    title: `Fixed source ${index}`,
    source: { ...publication.pages[0].source, pageId: `page-${index}` },
  }))
  const selected: KnowledgePublication = {
    ...publication,
    draft: { ...publication.draft, sources: pages.map(page => page.source) },
    pages,
  }
  const management = vi.fn(
    async (_domain: unknown, _method: unknown, request: IntegrationRequest) => {
      const second = request.payload.after === 'native-page-two'
      return response(request, {
        page: {
          items: (second ? pages.slice(10) : pages.slice(0, 10)).map(page => ({
            ...observation,
            source: page.source,
            available: !second,
            removed: !second,
            archived: !second,
          })),
          nextCursor: second ? null : 'native-page-two',
        },
      })
    }
  )
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  render(<PublicationSources client={client} publication={selected} onError={vi.fn()} />)
  expect(management).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('publication-source-status-toggle'))
  await waitFor(() =>
    expect(screen.getAllByTestId('publication-source-observation')).toHaveLength(10)
  )
  expect(screen.getAllByText('publicationSourceRemoved')).toHaveLength(10)
  expect(screen.getAllByText('publicationSourceArchived')).toHaveLength(10)
  fireEvent.click(screen.getByTestId('knowledge-page-next'))
  await screen.findByText('Fixed source 10')
  expect(screen.getAllByTestId('publication-source-observation')).toHaveLength(1)
  expect(screen.getByText('publicationSourceMissing')).toBeInTheDocument()
  expect(screen.queryByText('Fixed source 0')).not.toBeInTheDocument()
  expect(screen.getByTestId('knowledge-page-next')).toBeDisabled()
  expect(management.mock.calls[1][2].payload).toMatchObject({
    version: selected.version,
    after: 'native-page-two',
  })
  expect(selected.pages[10].markdown).toBe(publication.pages[0].markdown)
  client.dispose()
})

it('discards delayed old-version observations after selecting a different fixed version', async () => {
  let complete: (value: unknown) => void = () => undefined
  let originalRequest: IntegrationRequest | undefined
  const next = {
    ...publication,
    version: 2,
    draft: {
      ...publication.draft,
      sources: [{ ...observation.source, pageRevision: 'explicit-r2' }],
    },
    pages: [
      { ...publication.pages[0], source: { ...observation.source, pageRevision: 'explicit-r2' } },
    ],
  }
  const management = vi.fn((_domain: unknown, _method: unknown, request: IntegrationRequest) => {
    if (request.payload.version === 1) {
      originalRequest = request
      return new Promise(resolve => {
        complete = resolve
      })
    }
    return Promise.resolve(
      response(request, {
        page: {
          items: [
            { ...observation, source: next.draft.sources[0], removed: false, archived: true },
          ],
          nextCursor: null,
        },
      })
    )
  })
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  const { rerender } = render(
    <PublicationSources client={client} publication={publication} onError={vi.fn()} />
  )
  fireEvent.click(screen.getByTestId('publication-source-status-toggle'))
  await waitFor(() => expect(originalRequest).toBeDefined())
  rerender(<PublicationSources client={client} publication={next} onError={vi.fn()} />)
  await screen.findByText('publicationSourceArchived')
  await act(async () => {
    complete(
      response(originalRequest!, { page: { items: [observation], nextCursor: 'old-cursor' } })
    )
  })
  await waitFor(() =>
    expect(screen.queryByText('publicationSourceRemoved')).not.toBeInTheDocument()
  )
  expect(screen.getAllByTestId('publication-source-observation')).toHaveLength(1)
  expect(screen.getByTestId('knowledge-page-next')).toBeDisabled()
  client.dispose()
})

it.each([
  'KNOWLEDGE_PUBLICATION_REVOKED',
  'KNOWLEDGE_CALLER_SCOPE_MISMATCH',
  'KNOWLEDGE_POLICY_UNAVAILABLE',
  'KNOWLEDGE_NATIVE_STORE_UNAVAILABLE',
  'KNOWLEDGE_RPC_CONFIGURATION_CHANGED',
  'KNOWLEDGE_RPC_CONFIGURATION_UNAVAILABLE',
])(
  'clears cached body for %s and keeps it hidden during authoritative reconciliation',
  async code => {
    let completeRead: (value: unknown) => void = () => undefined
    let originalRead: IntegrationRequest | undefined
    const management = vi.fn(
      async (_domain: unknown, method: unknown, request: IntegrationRequest) => {
        if (method === 'readPublicationSources')
          return {
            ...response(request, {}),
            status: 'rejected',
            result: null,
            error: { code, messageKey: 'safe', recovery: 'none' },
          }
        return response(request, {
          page: { items: method === 'listPublications' ? [publication] : [], nextCursor: null },
        })
      }
    )
    const call = vi.fn((_port: unknown, _method: unknown, request: IntegrationRequest) => {
      originalRead = request
      return new Promise(resolve => {
        completeRead = resolve
      })
    })
    const client = new KnowledgeIntegrationClient(scope, { call, management })
    render(<KnowledgePublications client={client} />)
    await screen.findByTestId('publication-source-status-toggle')
    expect(screen.getByText(publication.pages[0].markdown)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('publication-source-status-toggle'))
    await screen.findByTestId('publication-refresh-access')
    expect(screen.queryByText(publication.pages[0].markdown)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('publication-refresh-access'))
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(publication.pages[0].markdown)).not.toBeInTheDocument()
    expect(screen.getByTestId('publication-refresh-access')).toBeDisabled()
    completeRead({
      ...response(originalRead!, {}),
      status: 'rejected',
      result: null,
      error: { code, messageKey: 'safe', recovery: 'none' },
    })
    await waitFor(() => expect(screen.getByTestId('publication-refresh-access')).not.toBeDisabled())
    expect(screen.queryByText(publication.pages[0].markdown)).not.toBeInTheDocument()
    client.dispose()
  }
)

it('retains the published fixed snapshot when the original is missing and reports unavailable reads separately', async () => {
  let unavailable = false
  const management = vi.fn(
    async (_domain: unknown, method: unknown, request: IntegrationRequest) => {
      if (method !== 'readPublicationSources')
        return response(request, {
          page: { items: method === 'listPublications' ? [publication] : [], nextCursor: null },
        })
      if (unavailable)
        return {
          ...response(request, {}),
          status: 'unavailable',
          result: null,
          error: {
            code: 'KNOWLEDGE_SOURCE_UNAVAILABLE',
            messageKey: 'safe',
            recovery: 'retry_read',
          },
        }
      return response(request, {
        page: { items: [{ ...observation, available: false }], nextCursor: null },
      })
    }
  )
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  render(<KnowledgePublications client={client} />)
  await screen.findByTestId('publication-source-status-toggle')
  fireEvent.click(screen.getByTestId('publication-source-status-toggle'))
  await screen.findByText('publicationSourceMissing')
  expect(screen.getByText(publication.pages[0].markdown)).toBeInTheDocument()
  unavailable = true
  const sourcePanel = screen.getByTestId('publication-source-status-toggle').parentElement!
  fireEvent.click(within(sourcePanel).getByTestId('knowledge-refresh'))
  await within(sourcePanel).findByText('operationFailed')
  expect(within(sourcePanel).queryByText('publicationSourceMissing')).not.toBeInTheDocument()
  expect(screen.getByText(publication.pages[0].markdown)).toBeInTheDocument()
  client.dispose()
})

it('rejects malformed lifecycle observations through the generated result guard', async () => {
  const invalid: Omit<KnowledgeSourceObservation, 'available'> & { available: string } = {
    ...observation,
    available: 'true',
  }
  const management = vi.fn(
    async (_domain: unknown, _method: unknown, request: IntegrationRequest) =>
      response(request, { page: { items: [invalid], nextCursor: null } })
  )
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  await expect(client.readPublicationSources(publication)).rejects.toMatchObject({
    code: 'KNOWLEDGE_INVALID_RECEIPT',
  })
  client.dispose()
})
