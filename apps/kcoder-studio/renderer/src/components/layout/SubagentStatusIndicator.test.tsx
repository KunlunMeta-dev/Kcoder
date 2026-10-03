import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SubagentStatusIndicator } from './SubagentStatusIndicator'
import type { RuntimeSubagentStatus } from '@/types/workbench'

const statuses: RuntimeSubagentStatus[] = [
  {
    id: '019f17ae-8295-7072-84e0-94ca0ffa96e5',
    agentId: '019f17ae-8295-7072-84e0-94ca0ffa96e5',
    agentPath: 'thread:019f17ae-8295-7072-84e0-94ca0ffa96e5',
    agentName: 'worker',
    status: 'running',
    updatedAtMs: 12345,
  },
]

describe('SubagentStatusIndicator', () => {
  test('shows a paused agent without a running spinner or completion label', () => {
    const { container } = render(
      <SubagentStatusIndicator
        statuses={[{ ...statuses[0], status: 'paused' }]}
        availableWidth={900}
      />
    )
    expect(screen.getByText(/subagent_paused/)).toBeInTheDocument()
    expect(container.querySelector('svg.animate-spin')).toBeNull()
  })

  test('expands automatically when title space is available', () => {
    render(<SubagentStatusIndicator statuses={statuses} availableWidth={900} />)

    expect(screen.getByTestId('subagent-status-panel')).toBeInTheDocument()
    expect(screen.getByText('worker')).toBeInTheDocument()
    expect(screen.getByText('0ffa96e5')).toBeInTheDocument()
  })

  test('collapses when title space is constrained and opens on hover', () => {
    render(<SubagentStatusIndicator statuses={statuses} availableWidth={360} />)

    expect(screen.queryByTestId('subagent-status-panel')).not.toBeInTheDocument()

    fireEvent.mouseEnter(screen.getByTestId('subagent-status-hover-region'))

    expect(screen.getByTestId('subagent-status-panel')).toBeInTheDocument()

    fireEvent.mouseLeave(screen.getByTestId('subagent-status-hover-region'))

    expect(screen.queryByTestId('subagent-status-panel')).not.toBeInTheDocument()
  })

  test('sends a targeted instruction and renders queued or applied status', async () => {
    const onSteer = vi.fn().mockResolvedValue(true)
    const { rerender } = render(
      <SubagentStatusIndicator statuses={statuses} availableWidth={900} onSteer={onSteer} />
    )

    fireEvent.click(screen.getByTestId('subagent-steer-open'))
    fireEvent.change(screen.getByTestId('subagent-steer-input'), {
      target: { value: 'change only this agent' },
    })
    fireEvent.click(screen.getByTestId('subagent-steer-submit'))

    await waitFor(() =>
      expect(onSteer).toHaveBeenCalledWith(
        '019f17ae-8295-7072-84e0-94ca0ffa96e5',
        'change only this agent'
      )
    )
    rerender(
      <SubagentStatusIndicator
        statuses={[{ ...statuses[0], steerStatus: 'applied' }]}
        availableWidth={900}
        onSteer={onSteer}
      />
    )
    expect(screen.getByText(/subagent_steer_applied/)).toBeInTheDocument()
  })
})
