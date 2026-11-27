import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import { ExpertsPage } from './ExpertsPage'
import { PersonalizationPage } from './PersonalizationPage'
import '@/i18n'

const fixture = vi.hoisted(() => ({ target: { id: 'remote', transport: 'local' as const,
  profile: 'original', workspacePath: '/owned' }, available: true, loading: false, selected: 'remote', bound: vi.fn() }))
vi.mock('@/features/runtime-target/useRuntimeSettingsTargets', () => ({ useRuntimeSettingsTargets: () => ({
  targets: fixture.available ? [fixture.target, { id: 'local', transport: 'local', profile: 'default' }] : [],
  selectedTarget: fixture.available ? (fixture.selected === 'remote' ? fixture.target : { id: 'local', transport: 'local', profile: 'default' }) : null, selectedServerId: fixture.selected,
  loading: fixture.loading, error: null, selectTarget: vi.fn(),
}) }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({ state: {} }) }))
vi.mock('@/features/workbench/workbenchModelTarget', () => ({ workbenchModelTarget: () => ({ deviceId: 'remote', workspacePath: '/owned' }) }))
vi.mock('@/features/octop/OctopSurface', () => ({ OctopSurface: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('./ExpertTarget', () => ({ ExpertTarget: (props: unknown) => {
  fixture.bound(props)
  return <div data-testid="owned-expert-target" />
} }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); fixture.bound.mockClear(); fixture.target.profile = 'original'; fixture.available = true; fixture.loading = false; fixture.selected = 'remote' })

test.each(['catalog', 'personalization'] as const)('%s reuses the parent directory identity and forwards the same original owner', async page => {
  window.history.replaceState({}, '', '/personalization/tools?deviceId=remote&workspacePath=%2Fowned&expertId=personal.fixture')
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ servers: [fixture.target] }))
  const view = render(page === 'catalog' ? <ExpertsPage /> : <PersonalizationPage />)
  await screen.findByTestId('owned-expert-target')
  await act(async () => { await Promise.resolve() })
  expect(network).not.toHaveBeenCalled()
  expect(fixture.bound).toHaveBeenLastCalledWith(expect.objectContaining({ targetScope: hookTargetScope(fixture.target) }))
  fixture.target = { ...fixture.target, profile: 'replacement' }
  view.rerender(page === 'catalog' ? <ExpertsPage /> : <PersonalizationPage />)
  expect(fixture.bound).toHaveBeenLastCalledWith(expect.objectContaining({ targetScope: hookTargetScope(fixture.target) }))
  expect(network).not.toHaveBeenCalled()
})

test.each(['catalog', 'personalization'] as const)('%s waits for its parent directory instead of establishing an unconfirmed owner', async page => {
  fixture.available = false
  fixture.loading = true
  window.history.replaceState({}, '', '/personalization/tools?deviceId=remote&workspacePath=%2Fowned&expertId=personal.fixture')
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ servers: [fixture.target] }))
  const view = render(page === 'catalog' ? <ExpertsPage /> : <PersonalizationPage />)
  await act(async () => { await Promise.resolve() })
  expect(fixture.bound).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
  fixture.available = true
  fixture.loading = false
  view.rerender(page === 'catalog' ? <ExpertsPage /> : <PersonalizationPage />)
  await screen.findByTestId('owned-expert-target')
  expect(fixture.bound).toHaveBeenLastCalledWith(expect.objectContaining({ targetScope: hookTargetScope(fixture.target) }))
  expect(network).not.toHaveBeenCalled()
})

test('personalization takes the explicit deep-link target identity rather than the default selector choice', async () => {
  fixture.selected = 'local'
  window.history.replaceState({}, '', '/personalization/tools?deviceId=remote&workspacePath=%2Fowned&expertId=personal.fixture')
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ servers: [fixture.target] }))
  render(<PersonalizationPage />)
  await screen.findByTestId('owned-expert-target')
  await act(async () => { await Promise.resolve() })
  expect(fixture.bound).toHaveBeenLastCalledWith(expect.objectContaining({
    serverId: 'remote', workspacePath: '/owned', targetScope: hookTargetScope(fixture.target),
  }))
  expect(network).not.toHaveBeenCalled()
})
