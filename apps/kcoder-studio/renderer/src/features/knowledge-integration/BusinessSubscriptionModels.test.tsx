// Model-independent UI and receipt contracts; no model request or scheduled execution.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { KnowledgeIntegrationClient, type AutomationTaskDraft } from './client'
import { BusinessSubscriptions } from './BusinessSubscriptions'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/model-policies/NativeModelPolicyWorkspace', () => ({
  NativeModelPolicyWorkspace: ({
    target,
    onSelect,
  }: {
    target: { requiredCapability?: string }
    onSelect: (selection: unknown) => void
  }) => (
    <button
      type="button"
      data-testid="choose-native-policy"
      data-required={target.requiredCapability}
      onClick={() =>
        onSelect({ kind: 'auto_policy', id: 'original-pool', version: 'fixed-revision' })
      }
    >
      Choose native policy
    </button>
  ),
}))
afterEach(cleanup)
const scope: IntegrationScope = {
  accountId: 'models-account',
  targetId: 'models-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const policy = { kind: 'auto_policy', id: 'original-pool', version: 'fixed-revision' } as const
function fixture(echo = true) {
  const call = vi.fn(
    async (_port: unknown, method: unknown, request: IntegrationRequest): Promise<unknown> => {
      const draft = request.payload.draft as AutomationTaskDraft
      const result =
        method === 'previewSubscription'
          ? {
              nextFireAtMs: 2_000_000_000_000,
              ...(echo && draft.modelSelection ? { modelSelection: draft.modelSelection } : {}),
            }
          : { subscription: { ...fixtures.AutomationSubscription.valid[0].value, draft } }
      return {
        contractVersion: 'parallel-v1',
        requestId: request.requestId,
        operationId: request.operationId ?? null,
        entityRevision: null,
        observedAt: '2026-10-25T00:00:00Z',
        status: 'completed',
        result,
        error: null,
      }
    }
  )
  const management = vi.fn(
    async (_domain: unknown, _method: unknown, request: IntegrationRequest) => ({
      contractVersion: 'parallel-v1',
      requestId: request.requestId,
      operationId: null,
      entityRevision: null,
      observedAt: '2026-10-25T00:00:00Z',
      status: 'completed',
      result: { page: { items: [], nextCursor: null } },
      error: null,
    })
  )
  return { client: new KnowledgeIntegrationClient(scope, { call, management }), call }
}
function form(client: KnowledgeIntegrationClient, target = true) {
  const view = render(
    <BusinessSubscriptions
      client={client}
      workflows={[{ id: 'original-workflow', title: 'Original saved workflow', version: 1 }]}
      {...(target ? { modelPolicyTarget: { serverId: 'owned-target' } } : {})}
    />
  )
  fireEvent.click(screen.getByTestId('subscription-form-toggle'))
  fireEvent.change(screen.getByTestId('subscription-title'), {
    target: { value: 'Explicit model task' },
  })
  fireEvent.change(screen.getByTestId('subscription-workflow'), {
    target: { value: 'original-workflow@1' },
  })
  return view
}
async function choose() {
  fireEvent.click(screen.getByTestId('subscription-model-policy-toggle'))
  const button = await screen.findByTestId('choose-native-policy')
  expect(button).toHaveAttribute('data-required', 'automationTaskModelsV1')
  fireEvent.click(button)
}
it('omits legacy intent and never opens a policy transport without an explicit user choice', async () => {
  const f = fixture()
  form(f.client, false)
  expect(screen.queryByTestId('subscription-model-policy-toggle')).toBeNull()
  expect(f.call).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('subscription-consent')).not.toBeDisabled())
  expect(f.call.mock.calls[0][2].payload.draft).not.toHaveProperty('modelSelection')
  f.client.dispose()
})
it('binds the selected fixed policy to a new preview and clears old consent before the original save', async () => {
  const f = fixture()
  form(f.client)
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('subscription-consent')).not.toBeDisabled())
  fireEvent.click(screen.getByTestId('subscription-consent'))
  await choose()
  expect(screen.getByTestId('subscription-consent')).not.toBeChecked()
  expect(screen.getByTestId('subscription-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('subscription-consent')).not.toBeDisabled())
  expect(f.call.mock.calls.at(-1)?.[2].payload.draft).toMatchObject({ modelSelection: policy })
  fireEvent.click(screen.getByTestId('subscription-consent'))
  fireEvent.click(screen.getByTestId('subscription-save'))
  await waitFor(() =>
    expect(f.call.mock.calls.filter(call => call[1] === 'saveSubscription')).toHaveLength(1)
  )
  expect(f.call.mock.calls.at(-1)?.[2].payload.draft).toMatchObject({ modelSelection: policy })
  await waitFor(() => expect(screen.getByTestId('subscription-title')).toHaveValue(''))
  f.client.dispose()
})
it('a save receipt that drops the selected policy stays unknown and is never replayed', async () => {
  const f = fixture()
  f.call.mockImplementation(async (_port, _method, request) => ({
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    entityRevision: null,
    observedAt: '2026-10-25T00:00:00Z',
    status: 'completed',
    result: { subscription: fixtures.AutomationSubscription.valid[0].value },
    error: null,
  }))
  const draft = {
    ...fixtures.AutomationSubscription.valid[0].value.draft,
    modelSelection: policy,
  } as AutomationTaskDraft
  await expect(f.client.saveSubscription(draft)).rejects.toMatchObject({
    uncertain: true,
    operationId: expect.any(String),
  })
  expect(f.call).toHaveBeenCalledTimes(1)
  f.client.dispose()
})
it('an omitted preview policy cannot confirm Auto and clearing selection restores legacy omission', async () => {
  const f = fixture(false)
  form(f.client)
  await choose()
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(f.call).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('subscription-consent')).toBeDisabled()
  expect(screen.getByTestId('subscription-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('subscription-model-inherit'))
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('subscription-consent')).not.toBeDisabled())
  expect(f.call.mock.calls.at(-1)?.[2].payload.draft).not.toHaveProperty('modelSelection')
  f.client.dispose()
})
