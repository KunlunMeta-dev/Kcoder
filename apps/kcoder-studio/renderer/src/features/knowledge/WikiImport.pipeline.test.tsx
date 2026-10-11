import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WikiImport } from './WikiImport'
import { knowledgeApi } from '@/kcoder/knowledgeApi'
import { pipelineJob } from './wikiPipeline.test-support'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? ` ${JSON.stringify(values)}` : ''}`,
    i18n: { language: 'zh-CN' },
  }),
}))
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: {
    fileCapabilities: vi.fn(async () => ({ items: [] })),
    jobs: vi.fn(),
    resumeJob: vi.fn(async () => ({})),
    pauseJob: vi.fn(async () => ({})),
    cancelJob: vi.fn(async () => ({})),
    startJob: vi.fn(async () => ({})),
  },
}))

const current = () => true
function props() {
  return {
    serverId: 'target',
    libraryId: 'library',
    isCurrent: current,
    onChanged: vi.fn(),
    sources: [
      { sourceId: 'source', revisionId: 'revision', title: 'Protocol source', bodyHash: 'hash' },
    ],
    refreshSignal: 0,
    canOrganize: true,
    onJobsChanged: vi.fn(),
  }
}

// QA: persisted stage failure -> exact job resume, organization gating, polling interruption
// -> retained records -> authority recovery. Fixtures isolate UI/RPC orchestration from models.
describe('Wiki stage recovery controls', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })
  test('a job outside the loaded source page can inspect and reorganize its recorded revision', async () => {
    const job = pipelineJob({
      status: 'failed',
      errorCode: 'repair_budget_exceeded',
      sourceId: 'source-11',
      sourceRevision: 'revision-11',
      sourceTitle: 'Source 11',
    })
    vi.mocked(knowledgeApi.jobs).mockResolvedValue({ items: [job] })
    const inspect = vi.fn()
    render(<WikiImport {...props()} onInspectSource={inspect} />)
    const viewSource = await screen.findByTestId('wiki-job-view-source')
    expect(viewSource).toBeEnabled()
    fireEvent.click(viewSource)
    const recordedSource = {
      sourceId: 'source-11',
      revisionId: 'revision-11',
      title: 'Source 11',
      bodyHash: '',
    }
    expect(inspect).toHaveBeenCalledWith(recordedSource)
    fireEvent.click(screen.getByTestId('wiki-job-control'))
    await waitFor(() =>
      expect(knowledgeApi.startJob).toHaveBeenCalledWith(
        'target',
        'library',
        recordedSource,
        'zh-CN',
        'reorganize:job'
      )
    )
    expect(knowledgeApi.cancelJob).toHaveBeenCalledWith('target', 'library', 'job')
  })
  test('the failure names its recorded topic/stage and continues the existing job', async () => {
    const job = pipelineJob({ status: 'failed', errorCode: 'invalid_evidence' })
    job.pipeline!.records[4].status = 'failed'
    job.pipeline!.resumeStage = job.pipeline!.records[4]
    vi.mocked(knowledgeApi.jobs).mockResolvedValue({ items: [job] })
    render(<WikiImport {...props()} />)
    await waitFor(() => expect(screen.getByTestId('wiki-job-control')).toBeEnabled())
    expect(screen.getByTestId('wiki-pipeline-unit-label')).toHaveTextContent(
      'Protocol compatibility'
    )
    expect(screen.getByTestId('wiki-job-control')).toHaveTextContent(
      'pipeline.resume {"stage":"pipeline.stage.verify"}'
    )
    fireEvent.click(screen.getByTestId('wiki-job-control'))
    await waitFor(() =>
      expect(knowledgeApi.resumeJob).toHaveBeenCalledWith('target', 'library', 'job')
    )
    expect(knowledgeApi.resumeJob).toHaveBeenCalledTimes(1)
    expect(knowledgeApi.cancelJob).not.toHaveBeenCalled()
  })

  test('a legacy review without a prepared candidate resumes instead of opening an empty review', async () => {
    const job = pipelineJob({ status: 'awaiting_review', reviewAvailable: false })
    vi.mocked(knowledgeApi.jobs).mockResolvedValue({ items: [job] })
    render(<WikiImport {...props()} />)
    await waitFor(() => expect(screen.getByTestId('wiki-job-control')).toBeEnabled())
    expect(screen.queryByTestId('wiki-review-open')).toBeNull()
    fireEvent.click(screen.getByTestId('wiki-job-control'))
    await waitFor(() =>
      expect(knowledgeApi.resumeJob).toHaveBeenCalledWith('target', 'library', 'job')
    )
  })

  test('a real prepared review still requires the review dialog', async () => {
    const job = pipelineJob({ status: 'awaiting_review', reviewAvailable: true })
    vi.mocked(knowledgeApi.jobs).mockResolvedValue({ items: [job] })
    render(<WikiImport {...props()} />)
    await waitFor(() => expect(screen.getByTestId('wiki-review-open')).toBeEnabled())
    expect(screen.queryByTestId('wiki-job-control')).toBeNull()
    expect(knowledgeApi.resumeJob).not.toHaveBeenCalled()
  })

  test('organization remains independently gated and opening an old completed task does not announce new work', async () => {
    const job = pipelineJob({ status: 'completed' })
    vi.mocked(knowledgeApi.jobs).mockResolvedValue({ items: [job] })
    const host = props()
    render(<WikiImport {...host} canOrganize={false} />)
    await waitFor(() => expect(host.onJobsChanged).toHaveBeenCalledWith([job], false))
    expect(screen.getByTestId('wiki-file-import')).toBeDisabled()
    expect(screen.queryByText('organizationFinished')).toBeNull()
    expect(knowledgeApi.resumeJob).not.toHaveBeenCalled()
  })

  test('an old target without file descriptors retains the explicit Wiki v1 import fallback', async () => {
    vi.mocked(knowledgeApi.fileCapabilities).mockResolvedValueOnce({
      supported: false,
      items: [],
      batchMaxFiles: 10,
      batchMaxBytes: 128 * 1024 * 1024,
    })
    vi.mocked(knowledgeApi.jobs).mockResolvedValue({ items: [] })
    render(<WikiImport {...props()} />)
    await waitFor(() => expect(knowledgeApi.fileCapabilities).toHaveBeenCalled())
    expect(screen.getByTestId('wiki-import-files')).toHaveAttribute(
      'accept',
      expect.stringContaining('.md')
    )
  })

  test('the authority labels jobs whose sources are outside the loaded source page', async () => {
    const job = pipelineJob({
      sourceId: 'outside-first-source-page',
      sourceTitle: 'Unloaded source.pdf',
    })
    vi.mocked(knowledgeApi.jobs).mockResolvedValue({ items: [job] })
    render(<WikiImport {...props()} sources={[]} />)
    await waitFor(() =>
      expect(screen.getByTestId('wiki-job-row-job')).toHaveTextContent('Unloaded source.pdf')
    )
  })

  test('a lost status connection preserves records and disables actions until authoritative recovery', async () => {
    vi.useFakeTimers()
    const job = pipelineJob()
    vi.mocked(knowledgeApi.jobs)
      .mockResolvedValueOnce({ items: [job] })
      .mockRejectedValueOnce(new Error('transport interrupted'))
      .mockResolvedValue({ items: [{ ...job, status: 'completed' }] })
    const host = props()
    const { container } = render(<WikiImport {...host} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('wiki-pipeline-step-check')).toHaveAttribute('data-state', 'running')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByText('statusRetrying')).toBeVisible()
    expect(screen.getByTestId('wiki-pipeline-step-check')).toHaveAttribute('data-state', 'running')
    expect(screen.getByTestId('wiki-job-control')).toBeDisabled()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(host.onJobsChanged).toHaveBeenLastCalledWith([job], true)
    expect(screen.queryByText('organizationFinished')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByText('organizationFinished')).toBeVisible()
    expect(host.onJobsChanged).toHaveBeenLastCalledWith([{ ...job, status: 'completed' }], false)
    expect(knowledgeApi.resumeJob).not.toHaveBeenCalled()
  })

  test('a refreshed observation discards an older in-flight round without announcing completion', async () => {
    vi.useFakeTimers()
    const first = pipelineJob()
    const latest = pipelineJob({ id: 'newest-job' })
    let oldRound: (value: { items: (typeof first)[] }) => void = () => {}
    vi.mocked(knowledgeApi.jobs)
      .mockResolvedValueOnce({ items: [first] })
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            oldRound = resolve
          })
      )
      .mockResolvedValue({ items: [latest] })
    const host = props()
    const view = render(<WikiImport {...host} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    view.rerender(<WikiImport {...host} refreshSignal={1} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('wiki-job-row-newest-job')).toBeInTheDocument()
    await act(async () => {
      oldRound({ items: [{ ...first, status: 'completed' }] })
    })
    expect(screen.getByTestId('wiki-job-row-newest-job')).toBeInTheDocument()
    expect(screen.queryByText('organizationFinished')).toBeNull()
    expect(host.onJobsChanged).toHaveBeenLastCalledWith([latest], false)
  })

  test('an idle view discovers a job completed outside this view without manual refresh', async () => {
    vi.useFakeTimers()
    const job = pipelineJob({ status: 'completed' })
    vi.mocked(knowledgeApi.jobs)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [job] })
    const host = props()
    render(<WikiImport {...host} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(knowledgeApi.jobs).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(screen.getByText('organizationFinished')).toBeVisible()
    expect(host.onChanged).toHaveBeenCalledTimes(1)
    expect(host.onJobsChanged).toHaveBeenLastCalledWith([job], false)
  })

  test('hidden observations stop and a foreground view rejects a late old snapshot', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const first = pipelineJob()
    const currentJob = pipelineJob({ id: 'current-job' })
    let finish!: (value: { items: (typeof first)[] }) => void
    vi.mocked(knowledgeApi.jobs)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      .mockResolvedValue({ items: [currentJob] })
    const host = props()
    render(<WikiImport {...host} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
    })
    expect(knowledgeApi.jobs).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { value: 'visible' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('wiki-job-row-current-job')).toBeInTheDocument()
    await act(async () => finish({ items: [{ ...first, status: 'completed' }] }))
    expect(host.onJobsChanged).toHaveBeenLastCalledWith([currentJob], false)
    expect(host.onChanged).not.toHaveBeenCalled()
    expect(knowledgeApi.pauseJob).not.toHaveBeenCalled()
  })

  test('returning online refreshes an idle view immediately', async () => {
    vi.useFakeTimers()
    vi.mocked(knowledgeApi.jobs)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [pipelineJob()] })
    render(<WikiImport {...props()} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(knowledgeApi.jobs).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('wiki-job-row-job')).toBeInTheDocument()
  })
})
