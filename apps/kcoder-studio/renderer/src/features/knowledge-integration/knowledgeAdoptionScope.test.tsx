import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type {
  IntegrationRequest,
  IntegrationScope,
  KnowledgeAdoption,
  KnowledgePublication,
} from '../../../../shared/generated/contracts'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { KnowledgeIntegrationClient } from './client'
import { KnowledgePublications } from './KnowledgePublications'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const owner = {
  accountId: 'fixture-account',
  targetId: 'fixture-target',
  workspaceId: null,
  organizationId: 'fixture-organization',
}
const scope: IntegrationScope = { ...owner, identityGeneration: '1', targetRevision: '1' }
const publication: KnowledgePublication = {
  ...fixtures.KnowledgePublication.valid[0].value,
  owner: { ...owner, accountId: 'publisher-account' },
}
const legacy: KnowledgeAdoption = {
  ...fixtures.KnowledgeAdoption.valid[0].value,
  owner: { ...owner, organizationId: null },
  publicationOwner: publication.owner,
  publicationId: publication.draft.publicationId,
  publicationVersion: publication.version,
  revision: 7,
  enabled: true,
}
function reply(request: IntegrationRequest, result: Record<string, unknown>) {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    entityRevision: null,
    observedAt: '2026-10-26T00:00:00Z',
    status: 'completed',
    result,
    error: null,
  }
}
function setup(adoptions: KnowledgeAdoption[], publications = [publication]) {
  const management = vi.fn(
    async (_domain: unknown, method: unknown, request: IntegrationRequest) => {
      if (method === 'listPublications')
        return reply(request, { page: { items: publications, nextCursor: null } })
      if (method === 'listAdoptions')
        return reply(request, { page: { items: adoptions, nextCursor: null } })
      if (method === 'adoptPublication')
        return reply(request, {
          adoption: {
            ...legacy,
            owner,
            revision: 1,
          },
        })
      if (method === 'setAdoptionEnabled')
        return reply(request, {
          adoption: {
            ...legacy,
            owner,
            revision: 10,
          },
        })
      throw new Error('Unexpected synthetic management method')
    }
  )
  const client = new KnowledgeIntegrationClient(scope, { management, call: vi.fn() })
  render(<KnowledgePublications client={client} />)
  return { client, management }
}

it('adopts a previous personal reference in the current organization with revision zero', async () => {
  const { client, management } = setup([legacy])
  const row = await screen.findByTestId('knowledge-adoption-row')
  expect(within(row).getByText(/previousScopeAdoption/)).toBeInTheDocument()
  fireEvent.click(within(row).getByRole('button', { name: 'adoptInCurrentScope' }))
  await waitFor(() =>
    expect(management).toHaveBeenCalledWith(
      'knowledge',
      'adoptPublication',
      expect.objectContaining({
        scope,
        expectedRevision: '0',
        payload: {
          owner: publication.owner,
          publicationId: publication.draft.publicationId,
          version: publication.version,
        },
      }),
      expect.any(AbortSignal)
    )
  )
  expect(management.mock.calls.some(call => call[1] === 'setAdoptionEnabled')).toBe(false)
  client.dispose()
})

it('does not treat a previous-scope enabled adoption as current execution adoption', async () => {
  const { client, management } = setup([legacy])
  const button = await screen.findByTestId('publication-adopt')
  expect(button).toBeEnabled()
  fireEvent.click(button)
  await waitFor(() =>
    expect(management).toHaveBeenCalledWith(
      'knowledge',
      'adoptPublication',
      expect.objectContaining({ expectedRevision: '0' }),
      expect.any(AbortSignal)
    )
  )
  client.dispose()
})

it('uses the current disabled adoption revision even when an older enabled record is present', async () => {
  const current = { ...legacy, owner, enabled: false, revision: 9 }
  const { client, management } = setup([legacy, current])
  fireEvent.click(await screen.findByTestId('publication-adopt'))
  await waitFor(() =>
    expect(management).toHaveBeenCalledWith(
      'knowledge',
      'adoptPublication',
      expect.objectContaining({ expectedRevision: '9' }),
      expect.any(AbortSignal)
    )
  )
  client.dispose()
})

it('matches adoption display titles by publication owner and ID', async () => {
  const other = {
    ...publication,
    owner: { ...publication.owner, accountId: 'other-publisher' },
    draft: { ...publication.draft, title: 'Wrong publisher title' },
  }
  const correct = {
    ...publication,
    draft: { ...publication.draft, title: 'Original publisher title' },
  }
  const { client } = setup([legacy], [other, correct])
  const row = await screen.findByTestId('knowledge-adoption-row')
  expect(row).toHaveTextContent('Original publisher title')
  expect(row).not.toHaveTextContent('Wrong publisher title')
  client.dispose()
})

it('rejects attempts to toggle the original personal adoption through the current owner', async () => {
  const management = vi.fn()
  const client = new KnowledgeIntegrationClient(scope, { management, call: vi.fn() })
  await expect(client.setAdoptionEnabled(legacy, false)).rejects.toMatchObject({
    code: 'KNOWLEDGE_OWNER_CHANGED',
  })
  expect(management).not.toHaveBeenCalled()
  client.dispose()
})

it('rejects an adoption receipt with a different current owner or publication reference', async () => {
  for (const changed of [
    { owner: legacy.owner },
    { publicationOwner: { ...publication.owner, accountId: 'wrong' } },
    { publicationId: 'wrong-publication' },
    { publicationVersion: publication.version + 1 },
  ]) {
    const management = vi.fn(
      async (_domain: unknown, _method: unknown, request: IntegrationRequest) =>
        reply(request, { adoption: { ...legacy, owner, ...changed } })
    )
    const client = new KnowledgeIntegrationClient(scope, { management, call: vi.fn() })
    await expect(
      client.adoptPublicationReference({
        owner: publication.owner,
        publicationId: publication.draft.publicationId,
        version: publication.version,
      })
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_RECEIPT' })
    client.dispose()
  }
})

it('withdraws row and adoption titles when fixed-version access becomes unavailable', async () => {
  let denied = false
  const management = vi.fn(async (_domain: unknown, method: unknown, request: IntegrationRequest) =>
    reply(request, {
      page: {
        items: denied ? [] : method === 'listAdoptions' ? [{ ...legacy, owner }] : [publication],
        nextCursor: null,
      },
    })
  )
  const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) => {
    denied = true
    return {
      ...reply(request, {}),
      status: 'unavailable',
      result: null,
      error: {
        code: 'KNOWLEDGE_OPERATION_UNAVAILABLE',
        messageKey: 'safe',
        recovery: 'retry_read',
      },
    }
  })
  const client = new KnowledgeIntegrationClient(scope, { management, call })
  render(<KnowledgePublications client={client} />)
  await screen.findByTestId('knowledge-publication-row')
  expect(await screen.findByTestId('knowledge-adoption-row')).toHaveTextContent(
    publication.draft.title
  )
  fireEvent.click(screen.getByTestId('publication-load-version'))
  await waitFor(() =>
    expect(screen.queryByTestId('knowledge-publication-row')).not.toBeInTheDocument()
  )
  await waitFor(() =>
    expect(screen.queryByTestId('knowledge-adoption-row')).not.toBeInTheDocument()
  )
  expect(screen.queryByText(publication.draft.title)).not.toBeInTheDocument()
  client.dispose()
})
