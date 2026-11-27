import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { KCoderOrganizationExecutionSettings } from './KCoderOrganizationExecutionSettings'
import type { OrganizationExecutionPolicy } from './organizationExecutionPolicy'
import {
  organizationModelOrigin,
  validOrganizationExecutionPolicy,
} from './organizationExecutionPolicy'
import type { OrganizationResource } from './KCoderOrganizationResources'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const accounts = [{ id: 'member-one', username: 'Owned member' }]
const resources: OrganizationResource[] = [
  {
    id: 'workspace:one',
    kind: 'workspace',
    owner: 'member-one',
    visibility: 'organization',
    grants: [],
  },
]
const policy: OrganizationExecutionPolicy = {
  version: 1,
  modelRules: [
    {
      id: 'exact-route',
      members: ['member-one'],
      workspaceResourceIds: ['workspace:one'],
      provider: 'CaseProvider',
      model: 'ExactModel',
      endpointOrigin: 'https://MODEL.example:443/',
      configurationRevision: 'a'.repeat(64),
      enabled: true,
    },
  ],
  budgetPolicies: [
    {
      id: 'original-family',
      scope: { kind: 'organization', id: 'owned-org' },
      window: { id: 'original-window', startsAtMs: 1000, endsAtMs: 900000 },
      limits: { tokens: 1000000, concurrentTasks: 2 },
      currency: null,
    },
  ],
}
const label = (key: string) => `organization.execution.${key} 1`

test('editing one field preserves other rules and original budget family in the revision-bound admin request', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const original = structuredClone(policy)
  render(
    <KCoderOrganizationExecutionSettings
      organizationId="owned-org"
      revision={7}
      policy={policy}
      accounts={accounts}
      resources={resources}
      busy={false}
      save={save}
    />
  )
  fireEvent.click(screen.getByText('organization.execution.title'))
  fireEvent.change(screen.getByLabelText(label('model')), { target: { value: 'ExplicitNewModel' } })
  fireEvent.click(screen.getByTestId('organization-execution-save'))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  const request = save.mock.calls[0][0]
  expect(request.operation).toBe('organization.executionPolicy')
  expect(request.expectedRevision).toBe(7)
  expect(request.executionPolicy.modelRules[0]).toEqual({
    ...policy.modelRules[0],
    model: 'ExplicitNewModel',
    endpointOrigin: 'https://model.example',
  })
  expect(request.executionPolicy.budgetPolicies).toEqual(policy.budgetPolicies)
  expect(policy).toEqual(original)
})

test('current policy revision changes retain the draft but block stale save until explicit reload', () => {
  const save = vi.fn()
  const view = render(
    <KCoderOrganizationExecutionSettings
      organizationId="owned-org"
      revision={7}
      policy={policy}
      accounts={accounts}
      resources={resources}
      busy={false}
      save={save}
    />
  )
  fireEvent.click(screen.getByText('organization.execution.title'))
  fireEvent.change(screen.getByLabelText(label('model')), { target: { value: 'UnsavedDraft' } })
  view.rerender(
    <KCoderOrganizationExecutionSettings
      organizationId="owned-org"
      revision={8}
      policy={policy}
      accounts={accounts}
      resources={resources}
      busy={false}
      save={save}
    />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('organization.execution.changed')
  expect(screen.getByTestId('organization-execution-save')).toBeDisabled()
  expect(screen.getByLabelText(label('model'))).toHaveValue('UnsavedDraft')
  fireEvent.click(screen.getByText('organization.execution.reload'))
  expect(screen.getByLabelText(label('model'))).toHaveValue('ExactModel')
  expect(screen.getByTestId('organization-execution-save')).toBeEnabled()
  expect(save).not.toHaveBeenCalled()
})

test('empty policy does not create grants or budget automatically; existing budget identity stays immutable', () => {
  const save = vi.fn()
  const view = render(
    <KCoderOrganizationExecutionSettings
      organizationId="owned-org"
      revision={7}
      policy={null}
      accounts={accounts}
      resources={resources}
      busy={false}
      save={save}
    />
  )
  fireEvent.click(screen.getByText('organization.execution.title'))
  expect(screen.queryByTestId('organization-model-rule-0')).not.toBeInTheDocument()
  expect(screen.queryByTestId('organization-budget-policy-0')).not.toBeInTheDocument()
  view.rerender(
    <KCoderOrganizationExecutionSettings
      key="existing"
      organizationId="owned-org"
      revision={7}
      policy={policy}
      accounts={accounts}
      resources={resources}
      busy={false}
      save={save}
    />
  )
  fireEvent.click(screen.getByText('organization.execution.title'))
  expect(screen.getByLabelText(label('budgetId'))).toBeDisabled()
  expect(screen.getByLabelText(label('scope'))).toBeDisabled()
  expect(screen.queryByText('organization.execution.removeBudget')).not.toBeInTheDocument()
})

test('credential endpoints, foreign resources, invalid windows and unknown cost currency never enable a valid policy', () => {
  const valid = (value: OrganizationExecutionPolicy) =>
    validOrganizationExecutionPolicy(value, ['member-one'], ['workspace:one'], 'owned-org')
  expect(valid(policy)).toBe(true)
  for (const origin of [
    'https://user:secret@example.com',
    'https://example.com/private',
    'https://example.com/?token=secret',
    'file:///private',
  ]) {
    expect(organizationModelOrigin(origin)).toBeNull()
    const next = structuredClone(policy)
    next.modelRules[0].endpointOrigin = origin
    expect(valid(next)).toBe(false)
  }
  for (const mutate of [
    (value: OrganizationExecutionPolicy) => {
      value.modelRules[0].members = ['foreign-member']
    },
    (value: OrganizationExecutionPolicy) => {
      value.modelRules[0].workspaceResourceIds = ['foreign-workspace']
    },
    (value: OrganizationExecutionPolicy) => {
      value.budgetPolicies[0].window.endsAtMs = 0
    },
    (value: OrganizationExecutionPolicy) => {
      value.budgetPolicies[0].limits.costMicros = 1
    },
    (value: OrganizationExecutionPolicy) => {
      value.budgetPolicies[0].limits.tokens = Number.MAX_SAFE_INTEGER + 1
    },
  ]) {
    const next = structuredClone(policy)
    mutate(next)
    expect(valid(next)).toBe(false)
  }
})
