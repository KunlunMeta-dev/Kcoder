import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { WikiJobStatus } from './WikiJobStatus'
import { WikiPipelineSummary } from './WikiPipelineProgress'
import { WikiSourceJobStatus } from './WikiSourceJobStatus'
import { pipelineJob } from './wikiPipeline.test-support'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${JSON.stringify(values)}` : ''}`,
  }),
}))

// QA: compact stage rendering, missing denominators, preserved offline observations,
// per-source revision labels and progressively disclosed diagnostics. No model inference.
describe('Wiki recorded pipeline presentation', () => {
  test('shows five compact stages with actual counts and exposes seven stages in details', () => {
    const job = pipelineJob()
    job.progress = {
      phase: 'source_support',
      startedAtMs: 1000,
      phaseStartedAtMs: 1000,
      heartbeatAtMs: 2000,
      model: 'target/model',
      textBytes: 0,
      reasoningBytes: 0,
      reservedCalls: 2,
      repairCalls: 0,
      usageReportedCalls: 0,
    }
    render(<WikiJobStatus job={job} disconnected={false} />)
    const bar = screen.getByTestId('wiki-pipeline-progress')
    expect(within(bar).getAllByRole('listitem')).toHaveLength(5)
    expect(screen.getByTestId('wiki-pipeline-step-analyze')).toHaveAttribute(
      'data-state',
      'completed'
    )
    expect(screen.getByTestId('wiki-pipeline-step-analyze')).toHaveTextContent('pipeline.reused')
    expect(screen.getByTestId('wiki-pipeline-step-check')).toHaveAttribute('data-state', 'running')
    expect(screen.getByTestId('wiki-pipeline-unit-count')).toHaveTextContent(
      '"completed":1,"total":3'
    )
    expect(screen.queryByText(/jobModel /)).toBeNull()
    fireEvent.click(screen.getByTestId('wiki-job-details'))
    expect(
      within(screen.getByTestId('wiki-pipeline-details')).getAllByRole('listitem')
    ).toHaveLength(7)
    expect(screen.getByTestId('wiki-job-diagnostics')).not.toHaveAttribute('open')
    expect(screen.getByText(/jobModel /)).not.toBeVisible()
  })

  test('received responses and unknown totals cannot become completed percentages', () => {
    const job = pipelineJob()
    job.pipeline!.currentStage = 'analyze'
    job.pipeline!.records[1] = {
      ...job.pipeline!.records[1],
      status: 'received',
      reused: false,
      completedUnits: 2,
      totalUnits: undefined,
    }
    const view = render(<WikiJobStatus job={job} disconnected={false} />)
    expect(screen.getByTestId('wiki-pipeline-step-analyze')).toHaveAttribute(
      'data-state',
      'received'
    )
    expect(screen.getByTestId('wiki-pipeline-unit-count')).toHaveTextContent(
      'pipeline.completedUnits {"completed":2}'
    )
    expect(view.container.textContent).not.toContain('%')
    expect(screen.queryByRole('progressbar')).toBeNull()
    job.pipeline!.records[1] = { ...job.pipeline!.records[1], completedUnits: undefined }
    view.rerender(<WikiJobStatus job={{ ...job }} disconnected={false} />)
    expect(screen.getByTestId('wiki-pipeline-unit-count')).toHaveTextContent('pipeline.preparing')
  })

  test('a failed stage with unknown units does not claim it is still preparing', () => {
    const job = pipelineJob({ status: 'failed' })
    job.pipeline!.records[4] = {
      ...job.pipeline!.records[4],
      status: 'failed',
      completedUnits: undefined,
      totalUnits: undefined,
    }
    render(<WikiJobStatus job={job} disconnected={false} />)
    expect(screen.queryByTestId('wiki-pipeline-unit-count')).toBeNull()
    expect(screen.queryByText('pipeline.preparing')).toBeNull()
    expect(screen.getByTestId('wiki-pipeline-summary')).toHaveTextContent('jobStatus.failed')
  })

  test('disconnection keeps the recorded stage, stops spinning and does not claim completion', () => {
    const { container } = render(<WikiJobStatus job={pipelineJob()} disconnected />)
    expect(screen.getByTestId('wiki-pipeline-step-check')).toHaveAttribute('data-state', 'running')
    expect(screen.getByText('jobConnectionLost')).toBeVisible()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(screen.queryByText('jobStatus.completed')).toBeNull()
  })

  test('elapsed stage time requires an actual start and disappears when the connection is unknown', () => {
    const job = pipelineJob()
    job.pipeline!.records[4].startedAtMs = 1000
    const view = render(<WikiPipelineSummary job={job} now={5000} />)
    expect(screen.getByText('pipeline.duration {"seconds":4,"count":4}')).toBeVisible()
    view.rerender(<WikiPipelineSummary job={job} now={5000} disconnected />)
    expect(screen.queryByText(/pipeline.duration/)).toBeNull()
    job.pipeline!.records[4].startedAtMs = undefined
    view.rerender(<WikiPipelineSummary job={{ ...job }} now={5000} />)
    expect(screen.queryByText(/pipeline.duration/)).toBeNull()
    job.pipeline!.records[4].startedAtMs = 0
    view.rerender(<WikiPipelineSummary job={{ ...job }} now={5000} />)
    expect(screen.queryByText(/pipeline.duration/)).toBeNull()
  })

  test('source rows distinguish revisions and preserve explicitly marked last observations', () => {
    const source = { sourceId: 'source', revisionId: 'revision', title: 'source', bodyHash: 'hash' }
    const job = pipelineJob({ status: 'failed' })
    const view = render(<WikiSourceJobStatus source={source} jobs={[job]} disconnected />)
    expect(screen.getByTestId('wiki-source-job-source')).toHaveTextContent('pipeline.lastKnown')
    view.rerender(
      <WikiSourceJobStatus
        source={{ ...source, revisionId: 'newer' }}
        jobs={[job]}
        disconnected={false}
      />
    )
    expect(screen.getByTestId('wiki-source-job-source')).toHaveAttribute('data-state', 'updated')
    expect(screen.getByTestId('wiki-source-job-source')).toHaveTextContent('pipeline.sourceUpdated')
  })
})
