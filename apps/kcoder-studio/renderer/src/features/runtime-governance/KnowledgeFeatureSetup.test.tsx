import { KnowledgeIntegrationClient } from '@/features/knowledge-integration/client'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { KnowledgeFeatureSetup } from './KnowledgeFeatureSetup'
const fixture = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
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
it('keeps domain work unmounted until an explicit enable and confirmed reconnect', async () => {
  const enabled = { ...flags, businessAutomationEnabled: true }
  fixture.request
    .mockReset()
    .mockResolvedValueOnce(settings)
    .mockResolvedValueOnce({ ...settings, effective: enabled, restartRequired: true })
    .mockResolvedValueOnce({ restarted: true, requiresConfirmation: false })
  const domain = vi.fn(() => <div>owned domain</div>)
  const onReconnect = vi.fn()
  render(
    <KnowledgeFeatureSetup
      serverId="owned"
      feature="subscriptions"
      isCurrent={() => true}
      onReconnect={onReconnect}
    >
      {domain}
    </KnowledgeFeatureSetup>
  )
  await screen.findByText('setupDisabled')
  expect(domain).not.toHaveBeenCalled()
  expect(fixture.request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('knowledge-feature-enable'))
  await waitFor(() => expect(onReconnect).toHaveBeenCalledOnce())
  expect(fixture.request.mock.calls[1][1]).toMatchObject({
    method: 'settings/integrations/knowledge/save',
    params: { feature: 'subscriptions', enabled: true, expectedRevision: settings.revision },
  })
  expect(domain).not.toHaveBeenCalled()
})
it('does not replay an uncertain save or mount a disabled domain', async () => {
  fixture.request
    .mockReset()
    .mockResolvedValueOnce(settings)
    .mockRejectedValueOnce(new Error('private path secret'))
  const domain = vi.fn(() => <div>owned domain</div>)
  render(
    <KnowledgeFeatureSetup
      serverId="owned"
      feature="subscriptions"
      isCurrent={() => true}
      onReconnect={vi.fn()}
    >
      {domain}
    </KnowledgeFeatureSetup>
  )
  await screen.findByText('setupDisabled')
  fireEvent.click(screen.getByTestId('knowledge-feature-enable'))
  await screen.findByText('setupUnconfirmed')
  expect(domain).not.toHaveBeenCalled()
  expect(screen.queryByTestId('knowledge-feature-enable')).not.toBeInTheDocument()
  expect(fixture.request).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('private path secret')).not.toBeInTheDocument()
})

it('replaces a busy old owner and ignores its late mutation result', async () => {
  let settle!: (value: unknown) => void
  fixture.request
    .mockReset()
    .mockResolvedValueOnce(settings)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          settle = resolve
        })
    )
    .mockResolvedValueOnce(settings)
  const reconnect = vi.fn()
  const view = render(
    <KnowledgeFeatureSetup
      serverId="old-owned"
      feature="subscriptions"
      isCurrent={() => true}
      onReconnect={reconnect}
    >
      {() => <div>old domain</div>}
    </KnowledgeFeatureSetup>
  )
  await screen.findByText('setupDisabled')
  fireEvent.click(screen.getByTestId('knowledge-feature-enable'))
  await waitFor(() => expect(screen.getByTestId('knowledge-feature-enable')).toBeDisabled())
  view.rerender(
    <KnowledgeFeatureSetup
      serverId="new-owned"
      feature="subscriptions"
      isCurrent={() => true}
      onReconnect={reconnect}
    >
      {() => <div>new domain</div>}
    </KnowledgeFeatureSetup>
  )
  await screen.findByText('setupDisabled')
  expect(screen.getByTestId('knowledge-feature-enable')).not.toBeDisabled()
  settle({
    ...settings,
    effective: { ...flags, businessAutomationEnabled: true },
    connection: { ...flags, businessAutomationEnabled: true },
  })
  await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(3))
  expect(screen.getByText('setupDisabled')).toBeInTheDocument()
  expect(screen.getByTestId('knowledge-feature-enable')).not.toBeDisabled()
  expect(reconnect).not.toHaveBeenCalled()
  expect(screen.queryByText('old domain')).not.toBeInTheDocument()
})

it('revalidates a new client instance with the exact same ownerKey while preserving its draft', async () => {
  const scope = {
    accountId: 'owned',
    targetId: 'target',
    workspaceId: null,
    identityGeneration: '1',
    targetRevision: '1',
  }
  const first = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management: vi.fn() })
  const next = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management: vi.fn() })
  expect(next).not.toBe(first)
  expect(next.ownerKey).toBe(first.ownerKey)
  const enabled = { ...flags, businessAutomationEnabled: true }
  const available = { ...settings, effective: enabled, connection: enabled }
  let finish!: (value: unknown) => void
  fixture.request
    .mockReset()
    .mockResolvedValueOnce(available)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  const current = () => true
  const content = () => <input aria-label="retained draft" defaultValue="" />
  const view = render(
    <KnowledgeFeatureSetup
      serverId="owned"
      feature="subscriptions"
      connection={first}
      isCurrent={current}
      onReconnect={vi.fn()}
    >
      {content}
    </KnowledgeFeatureSetup>
  )
  const input = await screen.findByLabelText('retained draft')
  fireEvent.change(input, { target: { value: 'Unsent parameters' } })
  view.rerender(
    <KnowledgeFeatureSetup
      serverId="owned"
      feature="subscriptions"
      connection={next}
      isCurrent={current}
      onReconnect={vi.fn()}
    >
      {content}
    </KnowledgeFeatureSetup>
  )
  expect(screen.getByLabelText('retained draft')).toHaveValue('Unsent parameters')
  expect(screen.getByLabelText('retained draft')).toBeDisabled()
  finish(available)
  await waitFor(() => expect(screen.getByLabelText('retained draft')).not.toBeDisabled())
  expect(screen.getByLabelText('retained draft')).toHaveValue('Unsent parameters')
  expect(fixture.request).toHaveBeenCalledTimes(2)
  first.dispose()
  next.dispose()
})

it('ignores an old connection save receipt after the new same-owner connection is verified', async () => {
  const scope = {
    accountId: 'owned',
    targetId: 'target',
    workspaceId: null,
    identityGeneration: '1',
    targetRevision: '1',
  }
  const first = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management: vi.fn() })
  const next = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management: vi.fn() })
  const enabled = { ...flags, businessAutomationEnabled: true }
  let finish!: (value: unknown) => void
  fixture.request
    .mockReset()
    .mockResolvedValueOnce(settings)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce({ ...settings, effective: enabled, connection: enabled })
  const current = () => true,
    reconnect = vi.fn()
  const view = render(
    <KnowledgeFeatureSetup
      serverId="owned"
      feature="subscriptions"
      connection={first}
      isCurrent={current}
      onReconnect={reconnect}
    >
      {() => <div>fresh verified connection</div>}
    </KnowledgeFeatureSetup>
  )
  await screen.findByText('setupDisabled')
  fireEvent.click(screen.getByTestId('knowledge-feature-enable'))
  view.rerender(
    <KnowledgeFeatureSetup
      serverId="owned"
      feature="subscriptions"
      connection={next}
      isCurrent={current}
      onReconnect={reconnect}
    >
      {() => <div>fresh verified connection</div>}
    </KnowledgeFeatureSetup>
  )
  await screen.findByText('fresh verified connection')
  finish(settings)
  await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(3))
  expect(screen.getByText('fresh verified connection')).toBeInTheDocument()
  expect(screen.queryByText('setupDisabled')).not.toBeInTheDocument()
  expect(reconnect).not.toHaveBeenCalled()
  first.dispose()
  next.dispose()
})

it('does not apply a late read from the previous same-owner client', async () => {
  const scope = {
    accountId: 'owned',
    targetId: 'target',
    workspaceId: null,
    identityGeneration: '1',
    targetRevision: '1',
  }
  const first = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management: vi.fn() })
  const next = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management: vi.fn() })
  let finish!: (value: unknown) => void
  const enabled = { ...flags, businessAutomationEnabled: true }
  fixture.request
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce({ ...settings, effective: enabled, connection: enabled })
  const current = () => true
  const view = render(
    <KnowledgeFeatureSetup
      serverId="owned"
      feature="subscriptions"
      connection={first}
      isCurrent={current}
      onReconnect={vi.fn()}
    >
      {() => <div>verified new read</div>}
    </KnowledgeFeatureSetup>
  )
  await waitFor(() => expect(fixture.request).toHaveBeenCalledOnce())
  view.rerender(
    <KnowledgeFeatureSetup
      serverId="owned"
      feature="subscriptions"
      connection={next}
      isCurrent={current}
      onReconnect={vi.fn()}
    >
      {() => <div>verified new read</div>}
    </KnowledgeFeatureSetup>
  )
  await screen.findByText('verified new read')
  finish(settings)
  await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2))
  expect(screen.getByText('verified new read')).toBeInTheDocument()
  expect(screen.queryByText('setupDisabled')).not.toBeInTheDocument()
  first.dispose()
  next.dispose()
})
