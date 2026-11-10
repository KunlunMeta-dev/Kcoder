import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { KnowledgeIntegrationClient } from './client'
import { MemoryCenter } from './MemoryCenter'
import { KnowledgePublications } from './KnowledgePublications'
import { BusinessSubscriptions } from './BusinessSubscriptions'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope: IntegrationScope = {
  accountId: 'fixture-account',
  targetId: 'fixture-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
function response(
  request: IntegrationRequest,
  result: Record<string, unknown>,
  status = 'completed'
) {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    entityRevision: null,
    observedAt: '2026-10-24T00:00:00Z',
    status,
    result,
    error: null,
  }
}
it('keeps lists to ten rows and requests a native next cursor', async () => {
  const records = Array.from({ length: 11 }, (_, n) => ({
    ...fixtures.ReviewedMemory.valid[0].value,
    id: `memory-${n}`,
  }))
  const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
    response(request, {
      page: { items: records, nextCursor: request.payload.after ? null : 'native-page-2' },
    })
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management: vi.fn() })
  render(<MemoryCenter client={client} />)
  await waitFor(() => expect(screen.getAllByTestId('reviewed-memory-row')).toHaveLength(10))
  fireEvent.click(screen.getByTestId('knowledge-page-next'))
  await waitFor(() =>
    expect(call).toHaveBeenLastCalledWith(
      'P-MEMORY',
      'listMemories',
      expect.objectContaining({ payload: { after: 'native-page-2', includeCandidates: true } }),
      expect.any(AbortSignal)
    )
  )
  client.dispose()
})
it('keeps search backend failures separate from genuine no-match results', async () => {
  const publication = fixtures.KnowledgePublication.valid[0].value
  const client = new KnowledgeIntegrationClient(scope, {
    management: vi.fn(async (_domain, method, request) =>
      response(request, {
        page: { items: method === 'listAdoptions' ? [] : [publication], nextCursor: null },
      })
    ),
    call: vi.fn(async (_port, _method, request) => ({
      ...response(request, {}, 'unavailable'),
      result: null,
      error: { code: 'KNOWLEDGE_INDEX_STALE', messageKey: 'safe', recovery: 'retry_read' },
    })),
  })
  render(<KnowledgePublications client={client} />)
  await screen.findByTestId('knowledge-query')
  fireEvent.change(screen.getByTestId('knowledge-query'), { target: { value: 'policy' } })
  fireEvent.click(screen.getByTestId('knowledge-search'))
  await screen.findByRole('alert')
  expect(screen.queryByTestId('knowledge-no-match')).not.toBeInTheDocument()
  client.dispose()
})
it('requires an exact preview plus explicit consent before subscription creation', async () => {
  const call = vi.fn(async (_port: unknown, method: unknown, request: IntegrationRequest) =>
    method === 'previewSubscription'
      ? response(request, { nextFireAtMs: 2_000_000_000_000 })
      : response(request, { subscription: fixtures.AutomationSubscription.valid[0].value })
  )
  const client = new KnowledgeIntegrationClient(scope, {
    call,
    management: vi.fn(async (_domain, _method, request) =>
      response(request, { page: { items: [], nextCursor: null } })
    ),
  })
  render(
    <BusinessSubscriptions
      client={client}
      workflows={[{ id: 'flow', title: 'Synthetic report', version: 1 }]}
    />
  )
  fireEvent.click(screen.getByTestId('subscription-form-toggle'))
  expect(screen.queryByTestId('subscription-tokens')).not.toBeInTheDocument()
  expect(screen.queryByTestId('subscription-runtime')).not.toBeInTheDocument()
  expect(screen.queryByTestId('period-budget-enabled')).not.toBeInTheDocument()
  fireEvent.change(screen.getByTestId('subscription-title'), {
    target: { value: 'Synthetic daily report' },
  })
  fireEvent.change(screen.getByTestId('subscription-workflow'), { target: { value: 'flow@1' } })
  expect(screen.getByTestId('subscription-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('subscription-consent')).not.toBeDisabled())
  fireEvent.click(screen.getByTestId('subscription-consent'))
  expect(screen.getByTestId('subscription-save')).not.toBeDisabled()
  fireEvent.change(screen.getByTestId('subscription-title'), {
    target: { value: 'Changed explicit task' },
  })
  expect(screen.getByTestId('subscription-save')).toBeDisabled()
  expect(screen.getByTestId('subscription-consent')).not.toBeChecked()
  const previewed = call.mock.calls.find(call => call[1] === 'previewSubscription')![2].payload
    .draft
  expect(previewed).toMatchObject({ maximumTokens: 1_000_000, maximumRuntimeSeconds: 300 })
  expect(previewed).not.toHaveProperty('periodBudget')
  expect(call.mock.calls.filter(call => call[1] === 'saveSubscription')).toHaveLength(0)
  client.dispose()
})
it('withdraws cached body after a native ACL rejection', async () => {
  let denied = false
  const client = new KnowledgeIntegrationClient(scope, {
    call: vi.fn(async (_port, _method, request) =>
      denied
        ? {
            ...response(request, {}, 'rejected'),
            result: null,
            error: {
              code: 'KNOWLEDGE_RESOURCE_DENIED',
              messageKey: 'safe',
              recovery: 'request_authorization',
            },
          }
        : response(request, {
            page: { items: [fixtures.ReviewedMemory.valid[0].value], nextCursor: null },
          })
    ),
    management: vi.fn(),
  })
  render(<MemoryCenter client={client} />)
  await screen.findByTestId('reviewed-memory-row')
  denied = true
  fireEvent.click(screen.getByTestId('knowledge-refresh'))
  await screen.findByRole('alert')
  expect(screen.queryByTestId('reviewed-memory-row')).not.toBeInTheDocument()
  client.dispose()
})
it('preserves an unsaved memory draft and its original CAS revision across a refresh', async () => {
  let revision = 1
  const memory = fixtures.ReviewedMemory.valid[0].value
  const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
    response(request, {
      page: {
        items: [
          {
            ...memory,
            revision,
            reviewStatus: 'confirmed',
            enabled: true,
            proposal: {
              ...memory.proposal,
              content: revision === 1 ? 'Initial source' : 'Remote changed source',
            },
          },
        ],
        nextCursor: null,
      },
    })
  )
  const management = vi.fn(
    async (_domain: unknown, _method: unknown, request: IntegrationRequest) => ({
      ...response(request, {}, 'rejected'),
      result: null,
      error: {
        code: 'MEMORY_REVISION_CONFLICT',
        messageKey: 'safe',
        recovery: 'repair_configuration',
      },
    })
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  render(<MemoryCenter client={client} />)
  await screen.findByTestId('memory-content')
  fireEvent.change(screen.getByTestId('memory-content'), {
    target: { value: 'Unsent human draft' },
  })
  revision = 2
  fireEvent.click(screen.getByTestId('knowledge-refresh'))
  await screen.findByTestId('memory-load-current')
  expect(screen.getByTestId('memory-content')).toHaveValue('Unsent human draft')
  fireEvent.click(screen.getByTestId('memory-save'))
  await waitFor(() =>
    expect(management).toHaveBeenCalledWith(
      'memory',
      'editMemory',
      expect.objectContaining({
        expectedRevision: '1',
        payload: { memoryId: memory.id, content: 'Unsent human draft' },
      }),
      expect.any(AbortSignal)
    )
  )
  await screen.findByRole('alert')
  expect(screen.getByTestId('memory-server-content')).toHaveTextContent('Remote changed source')
  fireEvent.click(screen.getByTestId('memory-merge-current'))
  expect(screen.getByTestId('memory-content')).toHaveValue('Unsent human draft')
  fireEvent.click(screen.getByTestId('memory-save'))
  await waitFor(() =>
    expect(management).toHaveBeenLastCalledWith(
      'memory',
      'editMemory',
      expect.objectContaining({
        expectedRevision: '2',
        payload: { memoryId: memory.id, content: 'Unsent human draft' },
      }),
      expect.any(AbortSignal)
    )
  )
  client.dispose()
})
it('blocks a repeated uncertain mutation until the original receipt is inspected', async () => {
  const call = vi.fn(async (_port: unknown, method: unknown, request: IntegrationRequest) =>
    method === 'listMemories'
      ? response(request, {
          page: { items: [fixtures.ReviewedMemory.valid[0].value], nextCursor: null },
        })
      : {
          ...response(request, {}, 'unknown'),
          result: null,
          error: {
            code: 'MEMORY_WRITE_UNCONFIRMED',
            messageKey: 'safe',
            recovery: 'reconcile_original',
          },
        }
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management: vi.fn() })
  render(<MemoryCenter client={client} />)
  await screen.findByTestId('memory-accept')
  fireEvent.click(screen.getByTestId('memory-accept'))
  await screen.findByTestId('knowledge-inspect-operation')
  expect(screen.getByTestId('memory-accept')).toBeDisabled()
  fireEvent.click(screen.getByTestId('memory-accept'))
  expect(call.mock.calls.filter(call => call[1] === 'reviewMemory')).toHaveLength(1)
  client.dispose()
})
it('deletes memory only after explicit confirmation with the current revision', async () => {
  const memory = fixtures.ReviewedMemory.valid[0].value
  const management = vi.fn(
    async (_domain: unknown, _method: unknown, request: IntegrationRequest) =>
      response(request, { memory: { ...memory, revision: 2, deleted: true, enabled: false } })
  )
  const client = new KnowledgeIntegrationClient(scope, {
    call: vi.fn(async (_port, _method, request) =>
      response(request, { page: { items: [memory], nextCursor: null } })
    ),
    management,
  })
  render(<MemoryCenter client={client} />)
  await screen.findByTestId('memory-delete')
  fireEvent.click(screen.getByTestId('memory-delete'))
  expect(management).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('memory-confirm-delete'))
  await waitFor(() =>
    expect(management).toHaveBeenCalledWith(
      'memory',
      'removeMemory',
      expect.objectContaining({ expectedRevision: '1', payload: { memoryId: memory.id } }),
      expect.any(AbortSignal)
    )
  )
  client.dispose()
})
it('reads the exact task preparation snapshot without creating a new snapshot', async () => {
  const management = vi.fn(
    async (_domain: unknown, method: unknown, request: IntegrationRequest) =>
      method === 'readMemoryTaskSnapshot'
        ? response(request, { snapshot: fixtures.MemoryTaskSnapshot.valid[0].value })
        : response(request, { page: { items: [], nextCursor: null } })
  )
  const client = new KnowledgeIntegrationClient(scope, {
    call: vi.fn(async (_port, _method, request) =>
      response(request, { page: { items: [], nextCursor: null } })
    ),
    management,
  })
  render(<MemoryCenter client={client} taskId="fixture-task" />)
  await screen.findByTestId('memory-task-selection')
  const snapshotPanel = screen.getByTestId('memory-task-selection') as HTMLDetailsElement
  snapshotPanel.open = true
  fireEvent(snapshotPanel, new Event('toggle'))
  await waitFor(() =>
    expect(management).toHaveBeenCalledWith(
      'memory',
      'readMemoryTaskSnapshot',
      expect.objectContaining({ payload: { taskId: 'fixture-task' }, operationId: undefined }),
      expect.any(AbortSignal)
    )
  )
  expect(management.mock.calls.every(call => call[1] !== 'captureTaskSnapshot')).toBe(true)
  client.dispose()
})
it('loads and adopts the selected fixed version rather than silently choosing latest', async () => {
  const original = fixtures.KnowledgePublication.valid[0].value
  const latest = {
    ...original,
    version: 2,
    pages: original.pages.map(page => ({ ...page, markdown: 'Current native revision' })),
  }
  const old = {
    ...original,
    version: 1,
    pages: original.pages.map(page => ({ ...page, markdown: 'Old native revision' })),
  }
  let adoption: unknown[] = []
  const management = vi.fn(
    async (_domain: unknown, method: unknown, request: IntegrationRequest) => {
      if (method === 'listAdoptions')
        return response(request, { page: { items: adoption, nextCursor: null } })
      if (method === 'listPublications')
        return response(request, { page: { items: [latest], nextCursor: null } })
      if (method === 'adoptPublication') {
        const selected = {
          ...fixtures.KnowledgeAdoption.valid[0].value,
          publicationOwner: old.owner,
          publicationId: old.draft.publicationId,
          publicationVersion: 1,
        }
        adoption = [selected]
        return response(request, { adoption: selected })
      }
      throw new Error('unexpected fixture management method')
    }
  )
  const client = new KnowledgeIntegrationClient(scope, {
    call: vi.fn(async (_port, method, request) => {
      if (method !== 'resolvePublication') throw new Error('unexpected fixture port method')
      return response(request, { publication: old })
    }),
    management,
  })
  render(<KnowledgePublications client={client} />)
  await screen.findByTestId('publication-version')
  fireEvent.change(screen.getByTestId('publication-version'), { target: { value: 1 } })
  fireEvent.click(screen.getByTestId('publication-load-version'))
  await screen.findByTestId('publication-compare-toggle')
  fireEvent.click(screen.getByTestId('publication-adopt'))
  await waitFor(() =>
    expect(management).toHaveBeenCalledWith(
      'knowledge',
      'adoptPublication',
      expect.objectContaining({
        expectedRevision: '0',
        payload: { owner: old.owner, publicationId: old.draft.publicationId, version: 1 },
      }),
      expect.any(AbortSignal)
    )
  )
  client.dispose()
})
it('template selection binds a built-in fixed workflow and preserves explicit scheduling consent', async () => {
  const template = fixtures.AutomationTemplate.valid[0].value
  const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
    response(request, { nextFireAtMs: 2_000_000_000_000 })
  )
  const client = new KnowledgeIntegrationClient(scope, {
    call,
    management: vi.fn(async (_domain, _method, request) =>
      response(request, { page: { items: [], nextCursor: null } })
    ),
  })
  render(<BusinessSubscriptions client={client} templates={[template]} />)
  fireEvent.click(screen.getByTestId('subscription-form-toggle'))
  fireEvent.change(screen.getByTestId('subscription-template'), { target: { value: template.id } })
  expect(screen.getByTestId('subscription-title')).toHaveValue(template.title)
  expect(screen.getByTestId('subscription-workflow')).toHaveValue(
    `${template.workflowId}@${template.workflowVersion}`
  )
  expect(screen.getByTestId('subscription-save')).toBeDisabled()
  expect(call).not.toHaveBeenCalled()
  client.dispose()
})

it.each([
  ['Use concise Chinese replies.', 'Use concise Chinese replies.'],
  ['First line\nSecond line', 'First line'],
  ['a'.repeat(255) + '😀tail', 'a'.repeat(255) + '😀'],
])(
  'saves a sentence with an intact title and enables the exact returned memory revision',
  async (content, expectedTitle) => {
    const candidate = {
      ...fixtures.ReviewedMemory.valid[0].value,
      reviewStatus: 'candidate',
      enabled: false,
      revision: 3,
    }
    const call = vi.fn(async (_port: unknown, method: unknown, request: IntegrationRequest) => {
      if (method === 'listMemories')
        return response(request, { page: { items: [], nextCursor: null } })
      return response(request, {
        memory:
          method === 'proposeMemory'
            ? candidate
            : { ...candidate, reviewStatus: 'confirmed', enabled: true, revision: 4 },
      })
    })
    const client = new KnowledgeIntegrationClient(scope, { call, management: vi.fn() })
    render(<MemoryCenter client={client} />)
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByTestId('memory-new-content'), {
      target: { value: content },
    })
    expect(call).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('memory-propose'))
    await waitFor(() =>
      expect(call.mock.calls.filter(item => item[1] === 'reviewMemory')).toHaveLength(1)
    )
    const proposed = call.mock.calls.find(item => item[1] === 'proposeMemory')![2]
    expect(proposed.payload.proposal).toMatchObject({
      title: expectedTitle,
      content,
    })
    const reviewed = call.mock.calls.find(item => item[1] === 'reviewMemory')![2]
    expect(reviewed).toMatchObject({
      expectedRevision: '3',
      payload: { memoryId: candidate.id, review: { action: 'accept' } },
    })
    client.dispose()
  }
)

it('stops memory enablement when the original proposal receipt is unknown', async () => {
  const call = vi.fn(async (_port: unknown, method: unknown, request: IntegrationRequest) => {
    if (method === 'listMemories')
      return response(request, { page: { items: [], nextCursor: null } })
    throw new Error('private transport details')
  })
  const client = new KnowledgeIntegrationClient(scope, { call, management: vi.fn() })
  render(<MemoryCenter client={client} />)
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByTestId('memory-new-content'), {
    target: { value: 'A memory to save.' },
  })
  fireEvent.click(screen.getByTestId('memory-propose'))
  await screen.findByText('uncertain')
  expect(screen.getByTestId('memory-propose')).toBeDisabled()
  expect(call.mock.calls.filter(item => item[1] === 'proposeMemory')).toHaveLength(1)
  expect(call.mock.calls.filter(item => item[1] === 'reviewMemory')).toHaveLength(0)
  fireEvent.click(screen.getByTestId('memory-propose'))
  expect(call.mock.calls.filter(item => item[1] === 'proposeMemory')).toHaveLength(1)
  client.dispose()
})
