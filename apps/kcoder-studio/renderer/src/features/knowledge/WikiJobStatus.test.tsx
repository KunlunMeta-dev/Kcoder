import examples from '../../../../shared/generated/examples.json'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WikiJobStatus } from './WikiJobStatus'
import type { WikiObservedJob } from './wikiJobProgress'

// Model-independent status presentation; these fixtures do not establish
// model quality, latency or gateway/native end-to-end behavior.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
describe('Wiki stage feedback', () => {
  const job: WikiObservedJob = {
    id: 'job',
    sourceId: 'source',
    status: 'running',
    afterChunk: 0,
    progress: {
      phase: 'generation',
      startedAtMs: 1,
      phaseStartedAtMs: 1,
      heartbeatAtMs: Date.now(),
      modelProgressAtMs: null,
      model: 'target/model',
      textBytes: 0,
      reasoningBytes: 0,
      reservedCalls: 1,
      repairCalls: 0,
      usageReportedCalls: 0,
    },
  }
  it('keeps unknown usage explicit and details collapsed', () => {
    const { container } = render(<WikiJobStatus job={job} disconnected={false} />)
    expect(container.querySelector('details')).toBeNull()
    expect(screen.queryByTestId('wiki-job-details-dialog')).toBeNull()
    expect(screen.queryByText('jobUsageUnknown')).toBeNull()
    fireEvent.click(screen.getByTestId('wiki-job-details'))
    expect(screen.getByText('jobUsageUnknown')).toBeInTheDocument()
    expect(screen.getByText('jobNoModelActivity')).toBeInTheDocument()
    expect(screen.getByText('jobWaitingForModel')).toBeVisible()
  })
  it('renders the frozen safe model summary while older progress stays unknown', () => {
    const { rerender } = render(<WikiJobStatus job={job} disconnected={false} />)
    fireEvent.click(screen.getByTestId('wiki-job-details'))
    expect(screen.getByText('modelConfiguration.snapshotUnknown')).toBeInTheDocument()
    rerender(
      <WikiJobStatus
        job={{
          ...job,
          progress: {
            ...job.progress!,
            modelConfiguration: examples.WorkflowAgentConfigurationSummary[0].value.configuration,
          },
        }}
        disconnected={false}
      />
    )
    expect(screen.getByTestId('frozen-model-configuration')).toHaveTextContent('provider / model')
    expect(screen.getByTestId('frozen-model-configuration')).toHaveTextContent('64000')
  })
  it('distinguishes interrupted status connection from slow model output', () => {
    const { rerender } = render(<WikiJobStatus job={job} disconnected />)
    expect(screen.getByText('jobConnectionLost')).toBeVisible()
    expect(screen.queryByText('jobWaitingForModel')).toBeNull()
    rerender(<WikiJobStatus job={{ ...job, status: 'paused' }} disconnected={false} />)
    expect(screen.getByText(/jobPhase.paused/)).toBeVisible()
    expect(screen.queryByText('jobConnectionLost')).toBeNull()
  })
  it('shows an unknown stage without loading or model activity claims', () => {
    const { rerender } = render(
      <WikiJobStatus job={{ ...job, status: 'future_status' }} disconnected={false} />
    )
    expect(screen.getByText(/^jobPhase\.unknown\b/)).toBeVisible()
    expect(screen.queryByText('jobWaitingForModel')).toBeNull()
    rerender(
      <WikiJobStatus
        job={{ ...job, progress: { ...job.progress!, phase: 'future_phase' } }}
        disconnected
      />
    )
    expect(screen.getByText(/^jobPhase\.unknown\b/)).toBeVisible()
    expect(screen.queryByText('jobConnectionLost')).toBeNull()
  })
})
