import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { KnowledgeIntegrationClient } from './client'
import { BusinessSubscriptions } from './BusinessSubscriptions'
import { KnowledgePublications } from './KnowledgePublications'
import { AutomationArtifactClaims } from './AutomationArtifactClaims'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope: IntegrationScope = {
  accountId: 'fixture-account',
  targetId: 'fixture-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const response = (
  request: IntegrationRequest,
  result: Record<string, unknown>,
  status = 'completed'
) => ({
  contractVersion: 'parallel-v1',
  requestId: request.requestId,
  operationId: request.operationId ?? null,
  entityRevision: null,
  observedAt: '2026-10-24T00:00:00Z',
  status,
  result,
  error: null,
})
const emptyManagement = vi.fn(
  async (_domain: unknown, _method: unknown, request: IntegrationRequest) =>
    response(request, { page: { items: [], nextCursor: null } })
)

it('does not silently switch a disappearing shared audience to personal publication', async () => {
  const call = vi.fn()
  const client = new KnowledgeIntegrationClient(scope, { call, management: emptyManagement })
  const sources = [
    {
      title: 'Actual fixed Wiki revision',
      source: fixtures.KnowledgePublication.valid[0].value.draft.sources[0],
    },
  ]
  const { rerender } = render(
    <KnowledgePublications
      client={client}
      sourcePages={sources}
      audiences={[
        {
          visibility: 'organization',
          audienceId: 'authorized-audience',
          label: 'Authorized organization',
        },
      ]}
    />
  )
  fireEvent.click(screen.getByTestId('publication-create-toggle'))
  fireEvent.change(screen.getByTestId('publication-title'), {
    target: { value: 'Explicit shared publication' },
  })
  fireEvent.change(screen.getByTestId('publication-purpose'), {
    target: { value: 'Shared task context' },
  })
  fireEvent.click(screen.getByTestId('publication-source-checkbox'))
  fireEvent.change(screen.getByTestId('publication-audience'), {
    target: { value: 'organization:authorized-audience' },
  })
  expect(screen.getByTestId('knowledge-publish')).not.toBeDisabled()
  rerender(<KnowledgePublications client={client} sourcePages={sources} audiences={[]} />)
  expect(screen.getByTestId('knowledge-publish')).toBeDisabled()
  await screen.findByText('audienceUnavailable')
  expect(screen.getByTestId('publication-title')).toHaveValue('Explicit shared publication')
  expect(call).not.toHaveBeenCalled()
  client.dispose()
})

it('previews a weekly immutable template with actual selected source revisions and invalidates changed inputs', async () => {
  const template = {
    ...fixtures.AutomationTemplate.valid[0].value,
    suggestedSchedule: {
      kind: 'zoned_cron' as const,
      expression: '0 16 * * 5',
      timezone: 'Asia/Shanghai',
    },
  }
  const owner = { accountId: scope.accountId, targetId: scope.targetId, workspaceId: null }
  const publication = {
    ...fixtures.KnowledgePublication.valid[0].value,
    owner,
    version: 7,
    draft: {
      ...fixtures.KnowledgePublication.valid[0].value.draft,
      publicationId: 'actual-selected-publication',
      title: 'Current approved policy',
      visibility: 'personal',
      audienceId: null,
    },
  }
  const call = vi.fn(async (_port: unknown, method: unknown, request: IntegrationRequest) =>
    response(
      request,
      method === 'resolvePublication' ? { publication } : { nextFireAtMs: 2_000_000_000_000 }
    )
  )
  const client = new KnowledgeIntegrationClient(scope, {
    call,
    management: vi.fn(async (_domain, method, request) =>
      response(request, {
        page: {
          items:
            method === 'listAdoptions'
              ? [
                  {
                    ...fixtures.KnowledgeAdoption.valid[0].value,
                    owner,
                    publicationOwner: owner,
                    publicationId: 'actual-selected-publication',
                    publicationVersion: 7,
                    enabled: true,
                  },
                ]
              : [],
          nextCursor: null,
        },
      })
    ),
  })
  render(
    <BusinessSubscriptions
      client={client}
      templates={[template]}
      sourceResources={[
        {
          kind: 'publication',
          id: 'actual-selected-publication',
          revision: '7',
          title: 'Current approved policy',
        },
      ]}
    />
  )
  fireEvent.click(screen.getByTestId('subscription-form-toggle'))
  fireEvent.change(screen.getByTestId('subscription-template'), { target: { value: template.id } })
  fireEvent.change(screen.getByTestId('subscription-input-period'), {
    target: { value: '2026-W43' },
  })
  fireEvent.change(screen.getByTestId('subscription-input-date'), {
    target: { value: '2026-10-24' },
  })
  fireEvent.click(await screen.findByTestId('subscription-input-source'))
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('subscription-consent')).not.toBeDisabled())
  const draft = call.mock.calls.find(call => call[1] === 'previewSubscription')?.[2].payload.draft
  expect(draft).toMatchObject({
    workflowId: template.workflowId,
    workflowVersion: template.workflowVersion,
    schedule: { kind: 'zoned_cron', expression: '0 16 * * 5', timezone: 'Asia/Shanghai' },
    inputs: {
      period: '2026-W43',
      asOfDate: '2026-10-24',
      sourceRefs: [{ kind: 'publication', id: 'actual-selected-publication', revision: '7' }],
    },
  })
  expect(JSON.stringify(draft)).not.toContain('Current approved policy')
  fireEvent.click(screen.getByTestId('subscription-consent'))
  fireEvent.change(screen.getByTestId('subscription-input-requirements'), {
    target: { value: 'Only the selected revision' },
  })
  expect(screen.getByTestId('subscription-save')).toBeDisabled()
  expect(screen.getByTestId('subscription-consent')).not.toBeChecked()
  expect(
    call.mock.calls.every(call =>
      ['previewSubscription', 'resolvePublication'].includes(String(call[1]))
    )
  ).toBe(true)
  client.dispose()
})

it('previews the selected interval or zoned cron without silently replacing it with daily scheduling', async () => {
  const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
    response(request, { nextFireAtMs: 2_000_000_000_000 })
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management: emptyManagement })
  render(
    <BusinessSubscriptions
      client={client}
      workflows={[{ id: 'flow', version: 1, title: 'Actual saved definition' }]}
    />
  )
  fireEvent.click(screen.getByTestId('subscription-form-toggle'))
  fireEvent.change(screen.getByTestId('subscription-title'), {
    target: { value: 'Interval subscription' },
  })
  fireEvent.change(screen.getByTestId('subscription-workflow'), { target: { value: 'flow@1' } })
  fireEvent.change(screen.getByTestId('subscription-schedule-mode'), { target: { value: 'every' } })
  fireEvent.change(screen.getByTestId('subscription-every-seconds'), { target: { value: '600' } })
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  expect(call.mock.calls[0][2].payload.draft).toMatchObject({
    schedule: { kind: 'every', every_seconds: 600 },
  })
  await waitFor(() => expect(screen.getByTestId('subscription-preview')).not.toBeDisabled())
  fireEvent.change(screen.getByTestId('subscription-schedule-mode'), { target: { value: 'cron' } })
  fireEvent.change(screen.getByTestId('subscription-cron'), { target: { value: '15 10 * * 1' } })
  fireEvent.change(screen.getByTestId('subscription-cron-timezone'), { target: { value: 'UTC' } })
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  expect(call.mock.calls[1][2].payload.draft).toMatchObject({
    schedule: { kind: 'zoned_cron', expression: '15 10 * * 1', timezone: 'UTC' },
  })
  client.dispose()
})

it('creates an updated publication only after explicit form replacement and preserves fixed validity and CAS', async () => {
  const publication = {
    ...fixtures.KnowledgePublication.valid[0].value,
    owner: { accountId: scope.accountId, targetId: scope.targetId, workspaceId: null },
    draft: {
      ...fixtures.KnowledgePublication.valid[0].value.draft,
      purpose: 'Approved task context',
      validFromMs: 1_700_000_000_123,
      validUntilMs: 2_000_000_000_456,
    },
  }
  const management = vi.fn(async (_domain: unknown, method: unknown, request: IntegrationRequest) =>
    response(request, {
      page: { items: method === 'listPublications' ? [publication] : [], nextCursor: null },
    })
  )
  const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
    response(request, { publication })
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  render(
    <KnowledgePublications
      client={client}
      sourcePages={[{ title: 'Actual Wiki page', source: publication.draft.sources[0] }]}
    />
  )
  await screen.findByTestId('publication-new-version')
  fireEvent.change(screen.getByTestId('publication-title'), {
    target: { value: 'Unsent new publication' },
  })
  fireEvent.click(screen.getByTestId('publication-new-version'))
  expect(screen.getByTestId('publication-title')).toHaveValue('Unsent new publication')
  expect(call).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('publication-confirm-update'))
  expect(screen.getByTestId('publication-title')).toHaveValue(publication.draft.title)
  fireEvent.change(screen.getByTestId('publication-purpose'), {
    target: { value: 'Updated task context' },
  })
  fireEvent.click(screen.getByTestId('knowledge-publish'))
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  expect(call.mock.calls[0][2]).toMatchObject({
    expectedRevision: String(publication.version),
    payload: {
      draft: {
        publicationId: publication.draft.publicationId,
        purpose: 'Updated task context',
        validFromMs: publication.draft.validFromMs,
        validUntilMs: publication.draft.validUntilMs,
      },
    },
  })
  expect(JSON.stringify(call.mock.calls[0][2].payload)).not.toContain('publisherRole')
  client.dispose()
})

it('removes all cached publication body after a native revoke observation', async () => {
  const publication = fixtures.KnowledgePublication.valid[0].value
  const management = vi.fn(async (_domain: unknown, method: unknown, request: IntegrationRequest) =>
    response(request, {
      page: { items: method === 'listPublications' ? [publication] : [], nextCursor: null },
    })
  )
  const client = new KnowledgeIntegrationClient(scope, {
    management,
    call: vi.fn(async (_port, _method, request) => ({
      ...response(request, {}, 'rejected'),
      result: null,
      error: { code: 'KNOWLEDGE_PUBLICATION_REVOKED', messageKey: 'safe', recovery: 'none' },
    })),
  })
  render(<KnowledgePublications client={client} />)
  await screen.findByTestId('publication-sources-toggle')
  expect(screen.getByText(publication.pages[0].markdown)).toBeInTheDocument()
  fireEvent.change(screen.getByTestId('knowledge-query'), { target: { value: 'policy' } })
  fireEvent.click(screen.getByTestId('knowledge-search'))
  await screen.findByText('publicationRevoked')
  expect(screen.queryByText(publication.pages[0].markdown)).not.toBeInTheDocument()
  expect(screen.queryByTestId('knowledge-no-match')).not.toBeInTheDocument()
  client.dispose()
})

it('reads completed native collection receipts without a writable collection action', async () => {
  const claim = fixtures.AutomationArtifactClaim.valid[0].value
  const management = vi.fn(
    async (_domain: unknown, _method: unknown, request: IntegrationRequest) =>
      response(request, { page: { items: [claim], nextCursor: null } })
  )
  const call = vi.fn()
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  render(<AutomationArtifactClaims client={client} runId={claim.runId} />)
  expect(management).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('artifact-claims-toggle'))
  await screen.findByTestId('automation-artifact-claim')
  expect(management).toHaveBeenCalledWith(
    'automation',
    'readAutomationClaims',
    expect.objectContaining({
      operationId: undefined,
      payload: { id: claim.runId, after: undefined },
    }),
    expect.any(AbortSignal)
  )
  expect(call).not.toHaveBeenCalled()
  expect(
    within(screen.getByTestId('automation-artifact-claim')).queryByRole('button')
  ).not.toBeInTheDocument()
  client.dispose()
})
