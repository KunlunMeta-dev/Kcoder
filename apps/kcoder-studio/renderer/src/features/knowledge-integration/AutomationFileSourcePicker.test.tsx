import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { StrictMode } from 'react'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { KnowledgeIntegrationClient } from './client'
import { BusinessSubscriptions } from './BusinessSubscriptions'
import { AutomationFileSourcePicker } from './AutomationFileSourcePicker'
import type { NativeAutomationFileInputs } from './automationFileInputs'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
const scope: IntegrationScope = {
  accountId: 'fixture-account',
  targetId: 'fixture-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
function reply(
  request: IntegrationRequest,
  result: unknown,
  status = 'completed',
  code = 'AUTOMATION_FILE_SELECTION_UNCONFIRMED'
) {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    entityRevision: null,
    observedAt: '2026-10-25T00:00:00Z',
    status,
    result,
    error:
      status === 'completed' ? null : { code, messageKey: 'safe', recovery: 'reconcile_original' },
  }
}
function selection(request: IntegrationRequest) {
  return {
    owner: { accountId: scope.accountId, targetId: scope.targetId, workspaceId: null },
    sourceRef: 'actual-native-source',
    selectionRevision: 'native-fixed-identity',
    items: (request.payload.fileNames as string[]).map(name => ({
      name,
      resourceRef: `native-${name}`,
      identityRevision: `identity-${name}`,
    })),
  }
}
function createClient(
  handler?: (method: string, request: IntegrationRequest) => unknown | Promise<unknown>
) {
  const call = vi.fn(async (_port, method, request: IntegrationRequest) =>
    handler ? handler(method, request) : reply(request, { nextFireAtMs: null })
  )
  const management = vi.fn(async (_domain, method, request: IntegrationRequest) =>
    method === 'selectFileEventSource'
      ? handler
        ? handler(method, request)
        : reply(request, selection(request))
      : reply(request, { page: { items: [], nextCursor: null } })
  )
  return { client: new KnowledgeIntegrationClient(scope, { call, management }), call, management }
}
function provider(client: KnowledgeIntegrationClient, count = 11): NativeAutomationFileInputs {
  return {
    ownerKey: client.ownerKey,
    workspaceLabel: '/actual-workspace',
    listDirectory: vi.fn(async () =>
      Array.from({ length: count }, (_, n) => ({
        name: `file-${String(n).padStart(2, '0')}.txt`,
        size: 12,
        isDirectory: false,
      }))
    ),
  }
}
function openForm() {
  fireEvent.change(screen.getByTestId('subscription-schedule-mode'), { target: { value: 'files' } })
  const details = screen.getByTestId('subscription-form-toggle').closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
}

test('selects explicit files across ten-row pages, then previews and explicitly saves only the native source ref', async () => {
  const instance = createClient((method, request) =>
    method === 'selectFileEventSource'
      ? reply(request, selection(request))
      : method === 'saveSubscription'
        ? reply(request, {
            subscription: {
              ...fixtures.AutomationSubscription.valid[0].value,
              draft: request.payload.draft,
            },
          })
        : reply(request, { nextFireAtMs: null })
  )
  const files = provider(instance.client)
  render(
    <BusinessSubscriptions
      client={instance.client}
      fileInputs={files}
      workflows={[{ id: 'real-code', title: 'Saved Code', version: 1 }]}
    />
  )
  openForm()
  const picker = screen.getByTestId('automation-file-picker')
  await waitFor(() => expect(within(picker).getAllByTestId('automation-file-row')).toHaveLength(10))
  fireEvent.click(within(picker).getByRole('checkbox', { name: 'file-00.txt' }))
  fireEvent.click(within(picker).getByTestId('knowledge-page-next'))
  expect(within(picker).getAllByTestId('automation-file-row')).toHaveLength(1)
  fireEvent.click(within(picker).getByRole('checkbox', { name: 'file-10.txt' }))
  fireEvent.click(within(picker).getByTestId('automation-file-confirm'))
  await within(picker).findByTestId('automation-file-ready')
  expect(
    instance.management.mock.calls.filter(call => call[1] === 'saveSubscription')
  ).toHaveLength(0)
  expect(
    instance.management.mock.calls.find(call => call[1] === 'selectFileEventSource')![2].payload
  ).toEqual({ relativeDirectory: '.', fileNames: ['file-00.txt', 'file-10.txt'] })
  fireEvent.change(screen.getByTestId('subscription-title'), {
    target: { value: 'Explicit file subscription' },
  })
  fireEvent.change(screen.getByTestId('subscription-workflow'), {
    target: { value: 'real-code@1' },
  })
  expect(screen.getByTestId('subscription-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('subscription-consent')).not.toBeDisabled())
  fireEvent.click(screen.getByTestId('subscription-consent'))
  fireEvent.click(screen.getByTestId('subscription-save'))
  await waitFor(() =>
    expect(instance.call.mock.calls.some(call => call[1] === 'saveSubscription')).toBe(true)
  )
  const saved = instance.call.mock.calls.find(call => call[1] === 'saveSubscription')![2]
  expect(saved.payload.draft).toMatchObject({ schedule: null, eventSource: 'actual-native-source' })
  expect(JSON.stringify(saved.payload.draft)).not.toContain('relativeDirectory')
  expect(JSON.stringify(saved.payload.draft)).not.toContain('/actual-workspace')
  instance.client.dispose()
})

test('keeps unknown selection blocked until the exact original native operation is read', async () => {
  let operation = ''
  const instance = createClient((method, request) => {
    if (method === 'selectFileEventSource') {
      operation = request.operationId!
      return reply(request, null, 'unknown')
    }
    expect(method).toBe('readOperation')
    expect(request.payload).toEqual({ operationId: operation })
    return reply(request, {
      receipt: {
        operationId: operation,
        scope,
        port: 'P-AUTOMATION',
        method: 'selectFileEventSource',
        revision: 2,
        phase: 'completed',
        createdAtMs: 1,
        updatedAtMs: 2,
        entityRef: {
          kind: 'input',
          id: 'canonical-recovered-source',
          revision: 'canonical-fixed-identity',
        },
        error: null,
      },
    })
  })
  const changed = vi.fn()
  render(
    <AutomationFileSourcePicker
      client={instance.client}
      provider={provider(instance.client, 1)}
      active
      disabled={false}
      onSelection={changed}
    />
  )
  await screen.findByTestId('automation-file-checkbox')
  fireEvent.click(screen.getByTestId('automation-file-checkbox'))
  fireEvent.click(screen.getByTestId('automation-file-confirm'))
  await screen.findByTestId('knowledge-inspect-operation')
  expect(screen.getByTestId('automation-file-confirm')).toBeDisabled()
  fireEvent.click(screen.getByTestId('knowledge-inspect-operation'))
  await screen.findByTestId('automation-file-ready')
  expect(changed).toHaveBeenLastCalledWith({
    sourceRef: 'canonical-recovered-source',
    selectionRevision: 'canonical-fixed-identity',
    fileNames: ['file-00.txt'],
  })
  expect(
    instance.management.mock.calls.filter(call => call[1] === 'selectFileEventSource')
  ).toHaveLength(1)
  instance.client.dispose()
})

test('shows actual Read authorization required without saving or approving a grant', async () => {
  const instance = createClient((_method, request) =>
    reply(request, null, 'rejected', 'AUTOMATION_FILE_READ_AUTHORIZATION_REQUIRED')
  )
  const changed = vi.fn()
  render(
    <AutomationFileSourcePicker
      client={instance.client}
      provider={provider(instance.client, 1)}
      active
      disabled={false}
      onSelection={changed}
    />
  )
  fireEvent.click(await screen.findByTestId('automation-file-checkbox'))
  fireEvent.click(screen.getByTestId('automation-file-confirm'))
  await screen.findByTestId('automation-file-authorization-required')
  expect(changed.mock.calls.every(call => call[0] === undefined)).toBe(true)
  expect(instance.client.pendingFileSelection()).toBeUndefined()
  expect(instance.call).not.toHaveBeenCalled()
  instance.client.dispose()
})

test('closing an in-flight picker drops late selection and retains its original operation for reconciliation', async () => {
  let settle!: (value: unknown) => void
  let captured!: IntegrationRequest
  const instance = createClient((_method, request) => {
    captured = request
    return new Promise(resolve => {
      settle = resolve
    })
  })
  const files = provider(instance.client, 1),
    changed = vi.fn()
  const view = render(
    <AutomationFileSourcePicker
      client={instance.client}
      provider={files}
      active
      disabled={false}
      onSelection={changed}
    />
  )
  fireEvent.click(await screen.findByTestId('automation-file-checkbox'))
  fireEvent.click(screen.getByTestId('automation-file-confirm'))
  await waitFor(() => expect(captured).toBeDefined())
  view.rerender(
    <AutomationFileSourcePicker
      client={instance.client}
      provider={files}
      active={false}
      disabled={false}
      onSelection={changed}
    />
  )
  await act(async () => settle(reply(captured, selection(captured))))
  expect(screen.queryByTestId('automation-file-ready')).not.toBeInTheDocument()
  expect(changed.mock.calls.every(call => call[0] === undefined)).toBe(true)
  expect(instance.client.pendingFileSelection()?.operationId).toBe(captured.operationId)
  view.rerender(
    <AutomationFileSourcePicker
      client={instance.client}
      provider={files}
      active
      disabled={false}
      onSelection={changed}
    />
  )
  await screen.findByTestId('knowledge-inspect-operation')
  expect(screen.getByTestId('automation-file-confirm')).toBeDisabled()
  instance.client.dispose()
})

test('rejects a receipt belonging to another owner and never adopts it as a source', async () => {
  const instance = createClient((_method, request) =>
    reply(request, {
      ...selection(request),
      owner: { accountId: 'other', targetId: scope.targetId, workspaceId: null },
    })
  )
  const changed = vi.fn()
  render(
    <AutomationFileSourcePicker
      client={instance.client}
      provider={provider(instance.client, 1)}
      active
      disabled={false}
      onSelection={changed}
    />
  )
  fireEvent.click(await screen.findByTestId('automation-file-checkbox'))
  fireEvent.click(screen.getByTestId('automation-file-confirm'))
  await screen.findByTestId('knowledge-inspect-operation')
  expect(changed.mock.calls.every(call => call[0] === undefined)).toBe(true)
  expect(screen.queryByTestId('automation-file-ready')).not.toBeInTheDocument()
  instance.client.dispose()
})

test('keeps a live owned reader after React StrictMode setup and cleanup', async () => {
  const instance = createClient(),
    files = provider(instance.client, 1),
    changed = vi.fn()
  render(
    <StrictMode>
      <AutomationFileSourcePicker
        client={instance.client}
        provider={files}
        active
        disabled={false}
        onSelection={changed}
      />
    </StrictMode>
  )
  fireEvent.click(await screen.findByTestId('automation-file-checkbox'))
  fireEvent.click(screen.getByTestId('automation-file-confirm'))
  await screen.findByTestId('automation-file-ready')
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceRef: 'actual-native-source' })
  )
  instance.client.dispose()
})

test('an accepted selection acknowledgement does not become completed source authority', async () => {
  const instance = createClient((_method, request) => ({
      ...reply(request, selection(request)),
      status: 'accepted',
    })),
    changed = vi.fn()
  render(
    <AutomationFileSourcePicker
      client={instance.client}
      provider={provider(instance.client, 1)}
      active
      disabled={false}
      onSelection={changed}
    />
  )
  fireEvent.click(await screen.findByTestId('automation-file-checkbox'))
  fireEvent.click(screen.getByTestId('automation-file-confirm'))
  await screen.findByTestId('knowledge-inspect-operation')
  expect(screen.queryByTestId('automation-file-ready')).not.toBeInTheDocument()
  expect(changed.mock.calls.every(call => call[0] === undefined)).toBe(true)
  instance.client.dispose()
})
