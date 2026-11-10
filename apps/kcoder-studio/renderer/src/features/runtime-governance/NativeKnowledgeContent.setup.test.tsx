import { render, screen } from '@testing-library/react'
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
