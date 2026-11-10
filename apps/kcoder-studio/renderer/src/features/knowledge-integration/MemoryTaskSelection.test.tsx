import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { KnowledgeIntegrationClient } from './client'
import { MemoryTaskSelection } from './MemoryTaskSelection'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
const scope: IntegrationScope = {
  accountId: 'fixture-account',
  targetId: 'fixture-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const snapshot = () => structuredClone(fixtures.MemoryTaskSnapshot.valid[0].value)
function reply(request: IntegrationRequest, value: unknown, status = 'completed') {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: null,
    entityRevision: null,
    observedAt: '2026-10-24T00:00:00Z',
    status,
    result: value,
    error:
      status === 'completed'
        ? null
        : { code: 'MEMORY_SNAPSHOT_DENIED', messageKey: 'safe', recovery: 'ask_user' },
  }
}
function open() {
  const panel = screen.getByTestId('memory-task-selection') as HTMLDetailsElement
  panel.open = true
  fireEvent(panel, new Event('toggle'))
  return panel
}

test('reads only on explicit expansion and pages the original snapshot with its actual thread', async () => {
  const frozen = snapshot()
  frozen.memories = Array.from({ length: 11 }, (_, n) => ({
    ...frozen.memories[0],
    id: `memory-${n}`,
    reviewStatus: 'confirmed',
    enabled: true,
    proposal: { ...frozen.memories[0].proposal, title: `Frozen ${n}` },
  }))
  const management = vi.fn(async (_domain, _method, request: IntegrationRequest) =>
    reply(request, { snapshot: frozen })
  )
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  render(<MemoryTaskSelection client={client} taskId="fixture-task" threadId="real-thread" />)
  expect(management).not.toHaveBeenCalled()
  const panel = open()
  await within(panel).findByText('Frozen 0')
  expect(within(panel).getAllByRole('heading')).toHaveLength(10)
  fireEvent.click(within(panel).getByTestId('knowledge-page-next'))
  await within(panel).findByText('Frozen 10')
  expect(within(panel).getAllByRole('heading')).toHaveLength(1)
  expect(management).toHaveBeenLastCalledWith(
    'memory',
    'readMemoryTaskSnapshot',
    expect.objectContaining({
      payload: { threadId: 'real-thread', taskId: 'fixture-task' },
      operationId: undefined,
    }),
    expect.any(AbortSignal)
  )
  client.dispose()
})

test('rejects another owner, another snapshot ID or a foreign memory nested in the reply', async () => {
  for (const mutate of [
    (value: ReturnType<typeof snapshot>) => {
      value.owner.accountId = 'another-owner'
    },
    (value: ReturnType<typeof snapshot>) => {
      value.taskId = 'another-snapshot'
    },
    (value: ReturnType<typeof snapshot>) => {
      value.memories[0].owner.targetId = 'another-target'
    },
  ]) {
    const wrong = snapshot()
    mutate(wrong)
    const client = new KnowledgeIntegrationClient(scope, {
      call: vi.fn(),
      management: vi.fn(async (_domain, _method, request) => reply(request, { snapshot: wrong })),
    })
    await expect(
      client.readMemoryTaskSnapshot('fixture-task', undefined, 'real-thread')
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_RECEIPT' })
    client.dispose()
  }
})

test('hides old frozen content while rechecking and refuses it after current authorization is revoked', async () => {
  let settle!: (value: unknown) => void
  const frozen = snapshot()
  frozen.memories[0].proposal.title = 'Private frozen memory'
  const management = vi
    .fn()
    .mockImplementationOnce(async (_domain, _method, request) =>
      reply(request, { snapshot: frozen })
    )
    .mockImplementationOnce(
      (_domain, _method, request: IntegrationRequest) =>
        new Promise(resolve => {
          settle = () => resolve(reply(request, null, 'denied'))
        })
    )
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  render(<MemoryTaskSelection client={client} taskId="fixture-task" threadId="real-thread" />)
  const panel = open()
  await within(panel).findByText('Private frozen memory')
  fireEvent.click(within(panel).getByTestId('knowledge-refresh'))
  await waitFor(() => expect(management).toHaveBeenCalledTimes(2))
  expect(screen.queryByText('Private frozen memory')).not.toBeInTheDocument()
  settle(null)
  await within(panel).findByRole('alert')
  expect(screen.queryByText('Private frozen memory')).not.toBeInTheDocument()
  expect(screen.queryByText('noTaskSelection')).not.toBeInTheDocument()
  client.dispose()
})
