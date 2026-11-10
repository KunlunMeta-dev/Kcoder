import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { KCODER_RUNTIME_METHODS } from '@/kcoder/legacyRuntimeAbi'
import type { IntegrationRequest } from '../../../../shared/generated/contracts'
import { ScheduledWorkflowTasks } from './ScheduledWorkflowTasks'
const fixture = vi.hoisted(() => ({
  request: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  current: () => true,
}))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (server: string, workspace: string) => ({
    key: JSON.stringify([server, workspace]),
    isCurrent: fixture.current,
  }),
}))
vi.mock('@/features/runtime-governance/nativeAutomationWorkflows', () => ({
  nativeAutomationWorkflows: fixture.list,
}))
vi.mock('@/features/workflows/workflowApi', () => ({
  workflowApi: { exportDefinition: fixture.read },
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const flags = {
  memoryCenterEnabled: true,
  publicationsEnabled: false,
  businessAutomationEnabled: false,
}
const saved = { id: 'saved-workflow', title: 'Original saved workflow', version: 1 }
const definition = {
  id: saved.id,
  title: saved.title,
  savedVersion: 1,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { focus: { type: 'string', title: 'Review focus', default: 'summary' } },
    required: ['focus'],
  },
}
function reply(request: IntegrationRequest, result: Record<string, unknown>) {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    entityRevision: null,
    observedAt: '2026-10-29T00:00:00Z',
    status: 'completed',
    result,
    error: null,
  }
}
beforeEach(() => {
  fixture.list.mockReset().mockResolvedValue([saved])
  fixture.read.mockReset().mockResolvedValue(definition)
  let enabled = false,
    connected = false
  fixture.request.mockReset().mockImplementation(async (method, params) => {
    if (method === KCODER_RUNTIME_METHODS.appServerRestart) {
      connected = true
      return { restarted: true, requiresConfirmation: false }
    }
    if (params.method === 'integrations/scope/read')
      return {
        accountId: 'owned',
        targetId: params.serverId,
        workspaceId: params.workspacePath,
        identityGeneration: '1',
        targetRevision: '1',
      }
    if (params.method === 'settings/integrations/knowledge/save') enabled = true
    if (params.method?.startsWith('settings/integrations/knowledge/'))
      return {
        persisted: {
          memoryCenterEnabled: true,
          publicationsEnabled: null,
          businessAutomationEnabled: enabled,
        },
        effective: { ...flags, businessAutomationEnabled: enabled },
        connection: { ...flags, businessAutomationEnabled: connected },
        revision: 'a'.repeat(64),
        restartRequired: enabled !== connected,
      }
    const request = params.params as IntegrationRequest
    if (params.method === 'integrations/automation/previewSubscription')
      return reply(request, { nextFireAtMs: 2_000_000_000_000 })
    if (params.method === 'integrations/automation/saveSubscription')
      return reply(request, {
        subscription: {
          ...fixtures.AutomationSubscription.valid[0].value,
          draft: request.payload.draft,
        },
      })
    throw new Error('Unexpected bounded test request')
  })
})
it('lists saved workflows while disabled, reads the selected version schema, and enables only after an explicit action', async () => {
  render(<ScheduledWorkflowTasks serverId="owned-target" workspacePath="/selected" view="create" />)
  const choice = await screen.findByTestId('scheduled-workflow-choice')
  await screen.findByRole('option', { name: 'Original saved workflow · v1' })
  expect(choice).not.toBeDisabled()
  expect(choice).toHaveValue('')
  expect(
    fixture.request.mock.calls.some(
      ([, params]) => params.method === 'settings/integrations/knowledge/save'
    )
  ).toBe(false)
  fireEvent.change(choice, { target: { value: JSON.stringify([saved.id, 1]) } })
  await screen.findByText('setupDisabled')
  expect(fixture.read).toHaveBeenCalledWith(
    'owned-target',
    saved.id,
    1,
    expect.objectContaining({ workspacePath: '/selected' })
  )
  fireEvent.click(screen.getByTestId('knowledge-feature-enable'))
  const focus = await screen.findByTestId('workflow-arg-focus')
  expect(focus).toHaveValue('summary')
  fireEvent.change(focus, { target: { value: 'decisions' } })
  expect(screen.queryByTestId('subscription-workflow')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('subscription-consent')).not.toBeDisabled())
  const preview = fixture.request.mock.calls.find(
    ([, params]) => params.method === 'integrations/automation/previewSubscription'
  )![1]
  expect(preview.params.payload.draft).toMatchObject({
    workflowId: saved.id,
    workflowVersion: 1,
    inputs: { focus: 'decisions' },
  })
  expect(
    fixture.request.mock.calls.some(
      ([, params]) => params.method === 'integrations/automation/saveSubscription'
    )
  ).toBe(false)
  fireEvent.click(screen.getByTestId('subscription-consent'))
  fireEvent.click(screen.getByTestId('subscription-save'))
  await waitFor(() =>
    expect(
      fixture.request.mock.calls.filter(
        ([, params]) => params.method === 'integrations/automation/saveSubscription'
      )
    ).toHaveLength(1)
  )
})
it('does not let an old target saved-version response populate the new target', async () => {
  let finish!: (value: unknown) => void
  fixture.list
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce([{ ...saved, id: 'new-owned', title: 'New target workflow' }])
  const view = render(
    <ScheduledWorkflowTasks serverId="old-target" workspacePath="/old" view="create" />
  )
  await waitFor(() => expect(fixture.list).toHaveBeenCalledOnce())
  view.rerender(<ScheduledWorkflowTasks serverId="new-target" workspacePath="/new" view="create" />)
  await screen.findByRole('option', { name: 'New target workflow · v1' })
  finish([saved])
  await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(2))
  expect(
    screen.queryByRole('option', { name: 'Original saved workflow · v1' })
  ).not.toBeInTheDocument()
})
