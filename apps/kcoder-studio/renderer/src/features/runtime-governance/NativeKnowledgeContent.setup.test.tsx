import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  KnowledgeIntegrationClient,
  KnowledgeOperationError,
} from '@/features/knowledge-integration/client'
import { NativeKnowledgeContent } from './NativeKnowledgeContent'
const fixture = vi.hoisted(() => ({ request: vi.fn(), workflows: vi.fn(), navigate: vi.fn() }))
vi.mock('@/lib/navigation', () => ({ navigateTo: fixture.navigate }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('./nativeAutomationWorkflows', () => ({ nativeAutomationWorkflows: fixture.workflows }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const flags = {
  memoryCenterEnabled: false,
  publicationsEnabled: false,
  businessAutomationEnabled: false,
}
const settings = {
  persisted: {
    memoryCenterEnabled: null,
    publicationsEnabled: null,
    businessAutomationEnabled: null,
  },
  effective: flags,
  connection: flags,
  revision: 'a'.repeat(64),
  restartRequired: false,
}
const scope = {
  accountId: 'owned',
  targetId: 'owned-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
it('does not load templates, workflows, subscriptions or runs when subscriptions are disabled', async () => {
  fixture.request.mockReset().mockResolvedValue(settings)
  fixture.workflows.mockReset()
  const call = vi.fn()
  const management = vi.fn()
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  render(
    <NativeKnowledgeContent
      client={client}
      serverId="owned"
      isCurrent={() => true}
      onReconnect={vi.fn()}
    />
  )
  await screen.findByText('setupDisabled')
  expect(screen.queryByTestId('knowledge-section-automation')).not.toBeInTheDocument()
  expect(screen.queryByTestId('schedule-plain-task')).not.toBeInTheDocument()
  expect(fixture.request).toHaveBeenCalledTimes(1)
  expect(call).not.toHaveBeenCalled()
  expect(management).not.toHaveBeenCalled()
  expect(fixture.workflows).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  client.dispose()
})
it('shows one metadata failure before mounting subscription and run lists', async () => {
  const enabled = { ...flags, businessAutomationEnabled: true }
  fixture.request
    .mockReset()
    .mockResolvedValue({ ...settings, effective: enabled, connection: enabled })
  fixture.workflows.mockReset().mockResolvedValue([])
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management: vi.fn() })
  const templates = vi
    .spyOn(client, 'listTemplates')
    .mockRejectedValue(new KnowledgeOperationError('AUTOMATION_NATIVE_FEATURE_UNAVAILABLE'))
  const subscriptions = vi.spyOn(client, 'listSubscriptions')
  const runs = vi.spyOn(client, 'listRuns')
  render(
    <NativeKnowledgeContent
      automationOnly
      includeBuiltinTemplates
      client={client}
      serverId="owned"
      isCurrent={() => true}
      onReconnect={vi.fn()}
    />
  )
  await screen.findByTestId('native-template-failure')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(templates).toHaveBeenCalledOnce()
  expect(subscriptions).not.toHaveBeenCalled()
  expect(runs).not.toHaveBeenCalled()
  client.dispose()
})
it.each(['manage', 'inbox'] as const)('enabled %s reads only metadata consumed by that view', async view => {
  const enabled = { ...flags, businessAutomationEnabled: true }
  fixture.request.mockReset().mockResolvedValue({ ...settings, effective: enabled, connection: enabled })
  fixture.workflows.mockReset().mockResolvedValue([])
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management: vi.fn() })
  const templates = vi.spyOn(client, 'listTemplates').mockResolvedValue([])
  const subscriptions = vi.spyOn(client, 'listSubscriptions').mockResolvedValue({ items: [], nextCursor: null })
  const runs = vi.spyOn(client, 'listRuns').mockResolvedValue({ items: [], nextCursor: null })
  try {
    render(<NativeKnowledgeContent automationOnly automationView={view} client={client}
      serverId="owned" isCurrent={() => true} onReconnect={vi.fn()} />)
    await screen.findByTestId('business-subscriptions')
    await waitFor(() => expect(runs).toHaveBeenCalledOnce())
    expect(templates).not.toHaveBeenCalled()
    expect(fixture.workflows).toHaveBeenCalledTimes(view === 'manage' ? 1 : 0)
    expect(subscriptions).toHaveBeenCalledTimes(view === 'manage' ? 1 : 0)
    expect(screen.queryByTestId('native-template-failure')).not.toBeInTheDocument()
  } finally { client.dispose() }
})
it('switching to the inbox retires pending management metadata and returning reads it again', async () => {
  const enabled = { ...flags, businessAutomationEnabled: true }
  fixture.request.mockReset().mockResolvedValue({ ...settings, effective: enabled, connection: enabled })
  let fail!: (error: Error) => void
  fixture.workflows.mockReset().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    .mockResolvedValue([])
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management: vi.fn() })
  vi.spyOn(client, 'listRuns').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(client, 'listSubscriptions').mockResolvedValue({ items: [], nextCursor: null })
  const props = { client, serverId: 'owned', isCurrent: () => true, onReconnect: vi.fn() }
  const view = render(<NativeKnowledgeContent {...props} automationOnly automationView="manage" />)
  try {
    await waitFor(() => expect(fixture.workflows).toHaveBeenCalledOnce())
    const signal = fixture.workflows.mock.calls[0][2] as AbortSignal
    view.rerender(<NativeKnowledgeContent {...props} automationOnly automationView="inbox" />)
    await screen.findByTestId('business-subscriptions')
    expect(signal.aborted).toBe(true)
    await act(async () => { fail(new Error('old management metadata failed')) })
    expect(screen.queryByTestId('native-template-failure')).not.toBeInTheDocument()
    expect(screen.getByTestId('business-subscriptions')).toBeInTheDocument()
    view.rerender(<NativeKnowledgeContent {...props} automationOnly automationView="manage" />)
    await waitFor(() => expect(fixture.workflows).toHaveBeenCalledTimes(2))
    await screen.findByTestId('business-subscriptions')
  } finally { view.unmount(); client.dispose() }
})
