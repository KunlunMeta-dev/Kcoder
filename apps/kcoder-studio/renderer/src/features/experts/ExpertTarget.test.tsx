import { act, render, screen } from '@testing-library/react'
import { Activity } from 'react'
import { expect, test, vi } from 'vitest'
import { ExpertLoading } from './ExpertLoading'
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
  fixture.read.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
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
  const settings = { effectiveEnabled: true, connectionEnabled: true, restartRequired: false }
  const scope = { accountId: 'account', targetId: 'target', workspaceId: null,
    identityGeneration: 'generation', targetRevision: 'revision' }
  fixture.request.mockResolvedValue(scope)
  fixture.read.mockResolvedValueOnce(settings)
  let reject!: (error: Error) => void
  fixture.read.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
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
  fixture.read.mockResolvedValueOnce(settings)
  rendered.rerender(view(false))
  rendered.rerender(view(true))
  await screen.findByText('catalog')
})
