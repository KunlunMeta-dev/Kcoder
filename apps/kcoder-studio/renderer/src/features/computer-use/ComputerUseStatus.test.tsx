import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { computerUseStates } from '@/kcoder/computerUseState'
import { ComposerStatusRegion } from '@/components/chat/composer/ComposerStatusRegion'
import { ComputerUseStatus } from './ComputerUseStatus'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const owner = {}
afterEach(() => act(() => computerUseStates.dispose(owner)))
const publish = (state: string) =>
  act(() =>
    computerUseStates.apply(owner, 'local', 'task', 'turn', {
      state,
      target: 'local_windows_desktop',
    })
  )
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
  publish('stopping')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  publish('stopped')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
test('does not display another conversation and keeps cleanup uncertainty visible', () => {
  publish('active')
  const { rerender } = render(<ComputerUseStatus serverId="local" taskId="other" />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  rerender(<ComputerUseStatus serverId="local" taskId="task" />)
  act(() => computerUseStates.unconfirmed(owner, 'local', 'task'))
  expect(screen.getByRole('status')).toHaveTextContent('computerUse.state.unknown')
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
  expect(trigger).toHaveTextContent('computerUse.state.active')
  expect(trigger).toHaveTextContent('computerUse.recovery.cleanup.failed')

  fireEvent.click(trigger!)
  expect(screen.getByTestId('computer-use-status')).toBeVisible()
  expect(screen.getByTestId('computer-use-cleanup')).toHaveTextContent(
    'computerUse.recovery.cleanup.failed'
  )
})
