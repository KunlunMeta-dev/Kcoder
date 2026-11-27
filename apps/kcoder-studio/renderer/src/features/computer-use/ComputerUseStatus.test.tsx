import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { computerUseStates } from '@/kcoder/computerUseState'
import { ComposerStatusRegion } from '@/components/chat/composer/ComposerStatusRegion'
import { ComputerUseStatus } from './ComputerUseStatus'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const owner = {}
afterEach(() => act(() => computerUseStates.dispose(owner)))
const publish = (
  state: string,
  diagnostic?: Record<string, unknown>,
  taskId = 'task',
  turnId = 'turn',
  recoveryAvailable = false
) =>
  act(() =>
    computerUseStates.apply(owner, 'local', taskId, turnId, {
      state,
      target: 'local_windows_desktop',
      ...(diagnostic ? { diagnostic } : {}),
      recoveryAvailable,
    })
  )
const activeFacts = { authorization: 'valid', channel: 'available', cleanup: 'unknown' }
const retiredFacts = { authorization: 'revoked', channel: 'unavailable', cleanup: 'confirmed' }
test('shows host state and stops through the existing turn interrupt without submitting a form', () => {
  const stop = vi.fn(),
    submit = vi.fn((event: React.FormEvent) => event.preventDefault())
  render(
    <form onSubmit={submit}>
      <ComputerUseStatus serverId="local" taskId="task" onStop={stop} />
    </form>
  )
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  publish('active')
  fireEvent.click(screen.getByRole('button', { name: 'computerUse.stop' }))
  expect(stop).toHaveBeenCalledOnce()
  expect(submit).not.toHaveBeenCalled()
  expect(screen.getByRole('status')).toHaveAttribute('data-state', 'active')
  publish('stopping', {
    authorization: 'revoked',
    channel: 'unavailable',
    cleanup: 'pending',
  })
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  publish('stopped', retiredFacts)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
test('does not display another task and keeps cleanup uncertainty visible only for its task', () => {
  publish('active')
  const { rerender } = render(<ComputerUseStatus serverId="local" taskId="other" />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  rerender(<ComputerUseStatus serverId="local" taskId="task" />)
  act(() => computerUseStates.unconfirmed(owner, 'local', 'task'))
  expect(screen.getByRole('status')).toHaveTextContent('computerUse.state.unknown')
  rerender(<ComputerUseStatus serverId="local" taskId="other" />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('registers only a real snapshot and keeps cleanup failure explicit in the embedded summary', async () => {
  render(
    <ComposerStatusRegion>
      <ComputerUseStatus
        serverId="local"
        taskId="task"
        presentation="embedded"
        diagnostics={{ authorization: 'valid', channel: 'available', cleanup: 'failed' }}
      />
    </ComposerStatusRegion>
  )
  expect(screen.queryByTestId('composer-status-region')).not.toBeInTheDocument()

  publish('active')
  const statusRegion = await screen.findByTestId('composer-status-region')
  const trigger = statusRegion.querySelector('[data-status-item="computer-use"] button')
  expect(trigger).not.toBeNull()
  expect(trigger).toHaveAttribute('title', expect.stringContaining('computerUse.state.active'))
  expect(trigger).toHaveTextContent('computerUse.recovery.cleanup.failed')

  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('computer-use-status')).toBeVisible()
  expect(screen.getByTestId('computer-use-cleanup')).toHaveTextContent(
    'computerUse.recovery.cleanup.failed'
  )
})

test('hides a normally stopped host with confirmed cleanup and retired authorization', async () => {
  render(
    <ComposerStatusRegion>
      <ComputerUseStatus serverId="local" taskId="task" presentation="embedded" />
    </ComposerStatusRegion>
  )
  publish('active', activeFacts)
  expect(await screen.findByTestId('composer-status-trigger-computer-use')).not.toHaveClass(
    'text-warning'
  )

  publish('stopped', retiredFacts)
  await waitFor(() =>
    expect(screen.queryByTestId('composer-status-region')).not.toBeInTheDocument()
  )

  publish(
    'stopped',
    { authorization: 'valid', channel: 'unavailable', cleanup: 'confirmed' },
    'task',
    'turn',
    true
  )
  expect(computerUseStates.get('local', 'task')?.recoveryAvailable).toBe(true)
  await waitFor(() =>
    expect(screen.queryByTestId('composer-status-region')).not.toBeInTheDocument()
  )
})

test('keeps a normally stopped host readable in the detail presentation', () => {
  publish('stopped', retiredFacts)
  render(<ComputerUseStatus serverId="local" taskId="task" presentation="detail" />)

  expect(screen.getByTestId('computer-use-status')).toHaveAttribute('data-state', 'stopped')
  expect(screen.getByTestId('computer-use-authorization')).toHaveTextContent(
    'computerUse.recovery.authorization.revoked'
  )
  expect(screen.getByTestId('computer-use-channel')).toHaveTextContent(
    'computerUse.recovery.channel.unavailable'
  )
})

test('keeps an abnormal stop visible until cleanup is confirmed, then removes it', async () => {
  render(
    <ComposerStatusRegion>
      <ComputerUseStatus serverId="local" taskId="task" presentation="embedded" />
    </ComposerStatusRegion>
  )
  publish(
    'stop_failed',
    {
      authorization: 'valid',
      channel: 'unavailable',
      cleanup: 'failed',
      failureCode: 'cleanup_failed',
    },
    'task',
    'turn',
    true
  )

  expect(await screen.findByTestId('computer-use-failure')).toBeInTheDocument()
  expect(screen.getByTestId('computer-use-status')).toHaveAttribute('data-state', 'stop_failed')
  expect(screen.getByTestId('composer-status-trigger-computer-use')).toHaveClass('text-warning')

  publish('stopped', retiredFacts)
  await waitFor(() =>
    expect(screen.queryByTestId('composer-status-region')).not.toBeInTheDocument()
  )
})

test('keeps a confirmed stop visible while its failure detail remains unresolved', async () => {
  render(
    <ComposerStatusRegion>
      <ComputerUseStatus serverId="local" taskId="task" presentation="embedded" />
    </ComposerStatusRegion>
  )
  publish('stopped', { ...retiredFacts, failureCode: 'worker_exited' }, 'task', 'turn', true)

  expect(await screen.findByTestId('computer-use-failure')).toBeInTheDocument()
  expect(screen.getByTestId('computer-use-status')).toHaveAttribute('data-state', 'stopped')
  expect(screen.getByTestId('composer-status-trigger-computer-use')).toHaveClass('text-warning')

  publish('stopped', retiredFacts)
  await waitFor(() =>
    expect(screen.queryByTestId('composer-status-region')).not.toBeInTheDocument()
  )
})
