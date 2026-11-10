import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { KnowledgeIntegrationClient } from '@/features/knowledge-integration/client'
import { WikiManagedKnowledge } from './WikiManagedKnowledge'

const fixture = vi.hoisted(() => ({ request: vi.fn(), transport: vi.fn(), current: () => true }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({ state: { runtimeWork: null } }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: (id: string, path?: string) => ({ key: JSON.stringify([id, path]), isCurrent: fixture.current }) }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/features/runtime-governance/knowledgeTransport', () => ({ nativeKnowledgeTransport: fixture.transport }))
vi.mock('@/features/runtime-governance/nativeWikiPublicationInputs', () => ({ nativeWikiPublicationInputs: () => ({}) }))
vi.mock('@/features/runtime-governance/KnowledgeFeatureSetup', () => ({
  KnowledgeFeatureSetup: ({ feature, children }: { feature: string; children: () => React.ReactNode }) => <div data-testid="selected-feature" data-feature={feature}>{children()}</div>,
}))
vi.mock('@/features/knowledge-integration/MemoryCenter', () => ({
  MemoryCenter: ({ client }: { client: KnowledgeIntegrationClient }) => <p data-testid="embedded-memory">{client.ownerKey}</p>,
}))
vi.mock('@/features/knowledge-integration/KnowledgePublications', () => ({
  KnowledgePublications: ({ client }: { client: KnowledgeIntegrationClient }) => <p data-testid="embedded-publications">{client.ownerKey}</p>,
}))
const scope = (target: string) => ({ accountId: 'owned', targetId: target, workspaceId: null, identityGeneration: '1', targetRevision: '1' })
beforeEach(() => {
  vi.clearAllMocks()
  fixture.transport.mockReturnValue({ call: vi.fn(), management: vi.fn() })
})

it('uses the existing scoped client for either section without creating subscriptions or copying data', async () => {
  fixture.request.mockResolvedValue(scope('one'))
  render(<WikiManagedKnowledge serverId="one" workspacePath="/one" section="memory" />)
  await screen.findByTestId('embedded-memory')
  expect(screen.getByTestId('selected-feature')).toHaveAttribute('data-feature', 'memoryCenter')
  expect(fixture.request).toHaveBeenCalledExactlyOnceWith('runtime.integrations.request', {
    serverId: 'one', workspacePath: '/one', method: 'integrations/scope/read', params: {},
  }, { signal: expect.any(AbortSignal) })
  expect(screen.queryByTestId('embedded-publications')).not.toBeInTheDocument()
  expect(fixture.request).toHaveBeenCalledTimes(1)
})

it('ignores a late scope response from the previous target', async () => {
  let finish!: (value: unknown) => void
  fixture.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce(scope('new-target'))
  const view = render(<WikiManagedKnowledge serverId="old" section="memory" />)
  view.rerender(<WikiManagedKnowledge serverId="new" workspacePath="/new" section="memory" />)
  await screen.findByTestId('embedded-memory')
  const current = screen.getByTestId('embedded-memory').textContent
  await act(async () => finish(scope('old-target')))
  expect(screen.getByTestId('embedded-memory').textContent).toBe(current)
  expect(current).toContain('new-target')
})

it('disposes only its own client when the Wiki section closes', async () => {
  fixture.request.mockResolvedValue(scope('one'))
  const dispose = vi.spyOn(KnowledgeIntegrationClient.prototype, 'dispose')
  const view = render(<WikiManagedKnowledge serverId="one" section="memory" />)
  await screen.findByTestId('embedded-memory')
  view.unmount()
  await waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  dispose.mockRestore()
})
