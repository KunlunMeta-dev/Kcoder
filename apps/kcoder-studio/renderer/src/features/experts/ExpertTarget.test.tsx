import { act, render, screen } from '@testing-library/react'
import { Activity } from 'react'
import { expect, test, vi } from 'vitest'
import { ExpertLoading } from './ExpertLoading'
import type { ExpertClient } from './client'
import { ExpertTarget } from './ExpertTarget'

const fixture = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), t: (key: string) => key }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: fixture.t }) }))
vi.mock('@/features/runtime-governance/nativeOfficeSettings', () => ({
  readNativeOfficeSettings: fixture.read,
  saveNativeOfficeSettings: vi.fn(),
  applyNativeOfficeSettings: vi.fn(),
}))

test('the expert page uses its shared spinner while connecting and keeps actionable failures', async () => {
  let reject!: (error: Error) => void
  fixture.request.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
  render(
    <ExpertTarget
      serverId="local"
      isCurrent={() => true}
      onReconnect={vi.fn()}
      loadingFallback={<ExpertLoading testId="expert-target-loading" />}
    >
      {() => <div>catalog</div>}
    </ExpertTarget>
  )

  expect(screen.getByTestId('expert-target-loading')).toBeInTheDocument()
  expect(screen.queryByText('loading')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'refresh' })).not.toBeInTheDocument()

  await act(async () => { reject(new Error('unavailable')) })

  expect(screen.queryByTestId('expert-target-loading')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('unavailable')
  expect(screen.getByRole('button', { name: 'refresh' })).toBeEnabled()
})

test('returning to a retained expert page never renders its disposed client while reconnecting', async () => {
  const scope = { accountId: 'account', targetId: 'target', workspaceId: null,
    identityGeneration: 'generation', targetRevision: 'revision' }
  fixture.request.mockResolvedValueOnce(scope)
  let reject!: (error: Error) => void
  fixture.request.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
  const current = () => true
  const children = vi.fn(() => <div>catalog</div>)
  const view = (visible: boolean) => <Activity mode={visible ? 'visible' : 'hidden'}>
    <ExpertTarget serverId="local" isCurrent={current} onReconnect={vi.fn()}
      loadingFallback={<ExpertLoading testId="expert-target-loading" />}>{children}</ExpertTarget>
  </Activity>
  const rendered = render(view(true))
  await screen.findByText('catalog')
  rendered.rerender(view(false))
  children.mockClear()
  rendered.rerender(view(true))
  expect(screen.getByTestId('expert-target-loading')).toBeVisible()
  expect(screen.queryByText('catalog')).not.toBeInTheDocument()
  expect(children).not.toHaveBeenCalled()
  await act(async () => { reject(new Error('connection unavailable')) })
  expect(screen.getByRole('alert')).toHaveTextContent('unavailable')
  expect(screen.queryByText('catalog')).not.toBeInTheDocument()
  fixture.request.mockResolvedValueOnce(scope)
  rendered.rerender(view(false))
  rendered.rerender(view(true))
  await screen.findByText('catalog')
})

test.each([
  { code: 'INTEGRATION_TARGET_UPGRADE_REQUIRED' },
  { code: 'INTEGRATION_METHOD_UNSUPPORTED' },
  { code: -32601 },
  new Error('INTEGRATION_TARGET_UPGRADE_REQUIRED'),
])('an older target reports an expert upgrade requirement instead of a connection failure: %s', async reason => {
  fixture.request.mockRejectedValueOnce(reason)
  render(
    <ExpertTarget serverId="local" isCurrent={() => true} onReconnect={vi.fn()}>
      {() => <div>catalog</div>}
    </ExpertTarget>
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('upgradeRequired')
  expect(screen.queryByText('catalog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'refresh' })).toBeEnabled()
})

test('the original directory owner accompanies scope discovery and the resulting expert client', async () => {
  fixture.request.mockResolvedValueOnce({ accountId: 'account', targetId: 'target', workspaceId: null,
    identityGeneration: 'generation', targetRevision: 'revision' })
  const children = vi.fn((client: ExpertClient) => <div data-target={client.target?.serverId}>owned catalog</div>)
  render(<ExpertTarget serverId="local" targetScope="original-directory-owner" isCurrent={() => true}
    onReconnect={vi.fn()}>{children}</ExpertTarget>)
  await screen.findByText('owned catalog')
  expect(fixture.request).toHaveBeenLastCalledWith('runtime.integrations.request', {
    serverId: 'local', workspacePath: undefined, targetScope: 'original-directory-owner',
    method: 'agentDefinitions/scope/read', params: {},
  }, expect.any(Object))
  expect(children.mock.calls[0]?.[0].target).toEqual({ serverId: 'local', workspacePath: undefined,
    targetScope: 'original-directory-owner' })
})
