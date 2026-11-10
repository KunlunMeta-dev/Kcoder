import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useState } from 'react'
import type {
  IntegrationRequest,
  IntegrationScope,
  KnowledgePublication,
} from '../../../../shared/generated/contracts'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { KnowledgeIntegrationClient } from './client'
import { AdoptedPublicationInputs } from './AdoptedPublicationInputs'
import { BusinessSubscriptions } from './BusinessSubscriptions'
import {
  listAdoptedPublicationInputs,
  verifyAdoptedPublicationInputs,
} from './adopted-publication-inputs'
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }),
}))
afterEach(cleanup)
const scope: IntegrationScope = {
  accountId: 'fixture-account',
  targetId: 'fixture-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const owner = { accountId: scope.accountId, targetId: scope.targetId, workspaceId: null }
function reply(request: IntegrationRequest, result: unknown, status = 'completed') {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    entityRevision: null,
    observedAt: '2026-10-25T00:00:00Z',
    status,
    result,
    error:
      status === 'completed'
        ? null
        : {
            code: 'KNOWLEDGE_PUBLICATION_REVOKED',
            messageKey: 'safe',
            recovery: 'request_authorization',
          },
  }
}
function adoption(id = 'fixed-publication', version = 1) {
  return {
    ...fixtures.KnowledgeAdoption.valid[0].value,
    id: `adoption-${id}-${version}`,
    owner,
    publicationOwner: owner,
    publicationId: id,
    publicationVersion: version,
    enabled: true,
  }
}
function publication(id = 'fixed-publication', version = 1): KnowledgePublication {
  return {
    ...fixtures.KnowledgePublication.valid[0].value,
    owner,
    version,
    draft: {
      ...fixtures.KnowledgePublication.valid[0].value.draft,
      publicationId: id,
      title: `Fixed ${id}`,
      visibility: 'personal',
      audienceId: null,
    },
  } as KnowledgePublication
}
function fixture() {
  let rows = Array.from({ length: 11 }, (_, index) => adoption(`pub-${index}`))
  let revoked = false
  const calls = vi.fn(async (_port, method, request: IntegrationRequest) =>
    method === 'resolvePublication'
      ? revoked
        ? reply(request, null, 'rejected')
        : reply(request, {
            publication: publication(
              String(request.payload.publicationId),
              Number(request.payload.version)
            ),
          })
      : reply(request, { nextFireAtMs: 2_000_000_000_000 })
  )
  const management = vi.fn(async (_domain, method, request: IntegrationRequest) =>
    reply(request, {
      page: {
        items:
          method === 'listAdoptions'
            ? request.payload.after
              ? rows.slice(10)
              : rows.slice(0, 10)
            : [],
        nextCursor:
          method === 'listAdoptions' && !request.payload.after && rows.length > 10
            ? 'original-page-2'
            : null,
      },
    })
  )
  const client = new KnowledgeIntegrationClient(scope, { call: calls, management })
  return {
    client,
    calls,
    management,
    setRows: (next: typeof rows) => {
      rows = next
    },
    revoke: () => {
      revoked = true
    },
  }
}
test('native adopted input pages preserve the exact enabled personal fixed version and only read it', async () => {
  const f = fixture()
  f.setRows([
    adoption('fixed', 1),
    { ...adoption('disabled'), enabled: false },
    { ...adoption('foreign'), publicationOwner: { ...owner, accountId: 'foreign' } },
  ])
  const page = await listAdoptedPublicationInputs(f.client)
  expect(page.items).toEqual([
    {
      reference: { kind: 'publication', id: 'fixed', revision: '1', title: 'Fixed fixed' },
      available: true,
    },
  ])
  expect(f.calls).toHaveBeenCalledWith(
    'P-KNOWLEDGE',
    'resolvePublication',
    expect.objectContaining({
      operationId: undefined,
      payload: { owner, publicationId: 'fixed', version: 1 },
    }),
    expect.any(AbortSignal)
  )
  expect(f.management.mock.calls.every(call => call[1] === 'listAdoptions')).toBe(true)
  f.client.dispose()
})
test('keeps explicit source revisions across native pages without replacing them with a later version', async () => {
  const f = fixture()
  function Inputs() {
    const [selected, setSelected] = useState<Array<{ kind: string; id: string; revision: string }>>(
      []
    )
    return (
      <>
        <AdoptedPublicationInputs
          client={f.client}
          selected={selected}
          disabled={false}
          onChange={setSelected}
        />
        <output data-testid="selection">{JSON.stringify(selected)}</output>
      </>
    )
  }
  render(<Inputs />)
  await waitFor(() => expect(screen.getAllByTestId('adopted-template-input-row')).toHaveLength(10))
  fireEvent.click(screen.getAllByTestId('subscription-input-source')[0])
  fireEvent.click(screen.getByTestId('knowledge-page-next'))
  await waitFor(() => expect(screen.getAllByTestId('adopted-template-input-row')).toHaveLength(1))
  fireEvent.click(screen.getByTestId('subscription-input-source'))
  expect(JSON.parse(screen.getByTestId('selection').textContent!)).toEqual([
    { kind: 'publication', id: 'pub-0', revision: '1' },
    { kind: 'publication', id: 'pub-10', revision: '1' },
  ])
  f.setRows([adoption('pub-0', 2)])
  fireEvent.click(screen.getByTestId('knowledge-page-previous'))
  await screen.findByText(/Fixed pub-0/)
  expect(screen.getByTestId('subscription-input-source')).not.toBeChecked()
  expect(screen.getByTestId('selection')).toHaveTextContent('"revision":"1"')
  f.client.dispose()
})
test('revocation hides the previously readable candidate title and blocks exact source verification', async () => {
  const f = fixture()
  f.setRows([adoption('private-title')])
  render(
    <AdoptedPublicationInputs client={f.client} selected={[]} disabled={false} onChange={vi.fn()} />
  )
  await screen.findByText(/Fixed private-title/)
  f.revoke()
  fireEvent.click(screen.getByTestId('knowledge-refresh'))
  await screen.findByText(/adoptedTemplateInputUnavailable/)
  expect(screen.queryByText(/Fixed private-title/)).not.toBeInTheDocument()
  expect(screen.getByTestId('subscription-input-source')).toBeDisabled()
  await expect(
    verifyAdoptedPublicationInputs(f.client, [
      { kind: 'publication', id: 'private-title', revision: '1' },
    ])
  ).rejects.toMatchObject({ code: 'KNOWLEDGE_PUBLICATION_REVOKED' })
  f.client.dispose()
})
test('removing the explicit adoption or using unsupported kinds cannot be repaired by latest lookup', async () => {
  const f = fixture()
  f.setRows([])
  await expect(
    verifyAdoptedPublicationInputs(f.client, [{ kind: 'publication', id: 'absent', revision: '1' }])
  ).rejects.toMatchObject({ code: 'AUTOMATION_SOURCE_NOT_ADOPTED' })
  await expect(
    verifyAdoptedPublicationInputs(f.client, [
      { kind: 'artifact', id: 'unprovided-artifact', revision: '1' },
    ])
  ).rejects.toMatchObject({ code: 'AUTOMATION_SOURCE_PROVIDER_UNAVAILABLE' })
  expect(f.calls).not.toHaveBeenCalled()
  f.client.dispose()
})
test('an adopted template source flows to exact preview and still needs explicit save consent', async () => {
  const f = fixture()
  f.setRows([adoption('fixed')])
  const template = fixtures.AutomationTemplate.valid[0].value
  render(<BusinessSubscriptions client={f.client} templates={[template]} />)
  const details = screen.getByTestId('subscription-form-toggle').closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  fireEvent.change(screen.getByTestId('subscription-template'), { target: { value: template.id } })
  fireEvent.change(screen.getByTestId('subscription-input-period'), {
    target: { value: '2026-W43' },
  })
  fireEvent.click(await screen.findByTestId('subscription-input-source'))
  expect(screen.getByTestId('subscription-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('subscription-consent')).not.toBeDisabled())
  const preview = f.calls.mock.calls.find(call => call[1] === 'previewSubscription')![2]
  expect(preview.payload.draft.inputs.sourceRefs).toEqual([
    { kind: 'publication', id: 'fixed', revision: '1' },
  ])
  expect(f.calls.mock.calls.filter(call => call[1] === 'saveSubscription')).toHaveLength(0)
  fireEvent.click(screen.getByTestId('subscription-consent'))
  expect(screen.getByTestId('subscription-save')).not.toBeDisabled()
  fireEvent.change(screen.getByTestId('subscription-input-period'), {
    target: { value: 'updated' },
  })
  expect(screen.getByTestId('subscription-save')).toBeDisabled()
  f.client.dispose()
})

test('native adoption list failures stay visible and do not masquerade as an empty source list', async () => {
  const client = new KnowledgeIntegrationClient(scope, {
    call: vi.fn(),
    management: vi.fn(async () => {
      throw new Error('PRIVATE_BODY_OR_PATH')
    }),
  })
  render(
    <AdoptedPublicationInputs client={client} selected={[]} disabled={false} onChange={vi.fn()} />
  )
  await screen.findByRole('alert')
  expect(screen.queryByText('noAdoptedTemplateInputs')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).not.toHaveTextContent('PRIVATE_BODY_OR_PATH')
  client.dispose()
})

test('new subscription hides budget controls without submitting changes', () => {
  const f = fixture()
  render(<BusinessSubscriptions client={f.client} />)
  expect(screen.queryByTestId('subscription-tokens')).not.toBeInTheDocument()
  expect(f.calls).not.toHaveBeenCalled()
  f.client.dispose()
})

test('shows the authoritative run budget reason without relabelling it as permission denial or retrying work', async () => {
  const run = {
    ...fixtures.AutomationRun.valid[0].value,
    status: 'failed',
    errorCode: 'AUTOMATION_BUDGET_EXHAUSTED',
    output: null,
  }
  const call = vi.fn()
  const client = new KnowledgeIntegrationClient(scope, {
    call,
    management: vi.fn(async (_domain, method, request) =>
      reply(request, {
        page: { items: method === 'listAutomationRuns' ? [run] : [], nextCursor: null },
      })
    ),
  })
  render(<BusinessSubscriptions client={client} />)
  const detail = await screen.findByTestId('automation-run')
  detail.open = true
  fireEvent(detail, new Event('toggle'))
  expect(await screen.findByTestId('automation-budget-exhausted')).toHaveTextContent(
    'automationBudgetExhausted'
  )
  expect(detail).toHaveTextContent('runState.failed')
  expect(screen.queryByText('permissionDenied')).not.toBeInTheDocument()
  expect(call).not.toHaveBeenCalled()
  client.dispose()
})
