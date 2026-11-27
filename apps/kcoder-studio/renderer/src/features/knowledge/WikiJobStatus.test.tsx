import examples from '../../../../shared/generated/examples.json'
import { Profiler } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetainedPageActive } from '@/components/layout/retainedPageState'
import { WikiJobStatus } from './WikiJobStatus'
import type { WikiObservedJob } from './wikiJobProgress'

// Model-independent status presentation; these fixtures do not establish
// model quality, latency or gateway/native end-to-end behavior.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
describe('Wiki stage feedback', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
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
  it.each(['browser', 'retained'])('pauses hidden %s job clock commits and resumes only while running', hidden => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    let browserVisible = true
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => browserVisible ? 'visible' : 'hidden')
    const commits = vi.fn()
    const view = (active: boolean, value = job) => <RetainedPageActive.Provider value={active}>
      <Profiler id="owned-job" onRender={commits}>
        <WikiJobStatus job={value} disconnected={false} />
      </Profiler>
    </RetainedPageActive.Provider>
    const hook = render(view(true))
    try {
      act(() => vi.advanceTimersByTime(1000))
      expect(commits).toHaveBeenCalledTimes(2)
      if (hidden === 'browser') {
        browserVisible = false
        act(() => document.dispatchEvent(new Event('visibilitychange')))
      } else hook.rerender(view(false))
      const before = commits.mock.calls.length
      for (let i = 0; i < 3; i++) act(() => vi.advanceTimersByTime(1000))
      expect(commits).toHaveBeenCalledTimes(before)
      expect(vi.getTimerCount()).toBe(0)
      if (hidden === 'browser') {
        browserVisible = true
        act(() => document.dispatchEvent(new Event('visibilitychange')))
      } else hook.rerender(view(true))
      expect(vi.getTimerCount()).toBe(1)
      hook.rerender(view(true, { ...job, status: 'completed' }))
      expect(vi.getTimerCount()).toBe(0)
    } finally { hook.unmount() }
  })
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
  it('does not present a frozen display clock as the duration of a settled legacy job', () => {
    const hook = render(<WikiJobStatus job={job} disconnected={false} />)
    expect(screen.getByText(/jobElapsed/)).toBeInTheDocument()
    hook.rerender(<WikiJobStatus job={{ ...job, status: 'completed' }} disconnected={false} />)
    expect(screen.queryByText(/jobElapsed/)).not.toBeInTheDocument()
    expect(screen.getByText('jobPhase.completed')).toBeInTheDocument()
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
  it('keeps committed outcome counts separate and tool counters in diagnostics', () => {
    const outcomeJob: WikiObservedJob = {
      ...job,
      notice: 'wiki_organization_model_rebound',
      progress: { ...job.progress!, toolTurns: 3, toolCalls: 7 },
      outcome: {
        publishedPages: 2,
        verifiedUnits: 5,
        unverified: { unsupported: 1, uncertain: 2, unassessed: 0 },
        pendingUnits: 1,
        withheldUpdates: 0,
        toolTurns: 9,
        toolCalls: 20,
      },
    }
    render(<WikiJobStatus job={outcomeJob} disconnected={false} />)
    const outcome = screen.getByTestId('wiki-job-outcome')
    expect(outcome).toHaveTextContent('outcome.published')
    expect(outcome).toHaveTextContent('outcome.verified')
    expect(screen.getByTestId('wiki-job-outcome-unverified')).toHaveTextContent(
      'outcome.unverified'
    )
    expect(screen.getByTestId('wiki-job-outcome-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-job-outcome-withheld')).toBeNull()
    expect(screen.getByTestId('wiki-job-notice')).toHaveTextContent(
      'jobNotices.wiki_organization_model_rebound'
    )
    // Tool counters are diagnostics only, never in the main status row.
    expect(screen.queryByTestId('wiki-job-tools')).toBeNull()
    fireEvent.click(screen.getByTestId('wiki-job-details'))
    const details = screen.getByTestId('wiki-job-outcome-details')
    expect(details).toHaveTextContent('verification.verdict.unsupported')
    expect(details).toHaveTextContent('verification.verdict.uncertain')
    expect(details).toHaveTextContent('outcome.verifiedLabel')
    expect(screen.getByTestId('wiki-job-tools')).toHaveTextContent('toolLoop.current')
    expect(screen.getByTestId('wiki-job-tools')).toHaveTextContent('toolLoop.committed')
  })
  it('hides unknown notices and malformed outcomes', () => {
    render(
      <WikiJobStatus
        job={{
          ...job,
          notice: 'provider said something',
          outcome: { publishedPages: -1 } as never,
        }}
        disconnected={false}
      />
    )
    expect(screen.queryByTestId('wiki-job-notice')).toBeNull()
    expect(screen.queryByTestId('wiki-job-outcome')).toBeNull()
  })
})
