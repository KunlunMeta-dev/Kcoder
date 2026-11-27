import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationRunHistory } from './AutomationRunHistory'
import { requestAutomation } from '@/kcoder/gatewayAutomationApi'
import { KCoderGatewayRuntime } from '@/kcoder/gatewayRuntime'
import { FakeGatewayClient } from '@/kcoder/gateway/runtime/contractFixture.test-support'

vi.mock('@/kcoder/gatewayAutomationApi', () => ({ requestAutomation: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      `${key}${params ? ` ${JSON.stringify(params)}` : ''}`,
    i18n: { language: 'en' },
  }),
}))
const address = { deviceId: 'fixture-device', workspacePath: '/fixture-one' }
const receipt = {
  triggerId: 'trigger',
  jobId: 'removed-one-shot',
  scheduledAt: '2026-10-03T09:00:00Z',
  recordedAt: '2026-10-03T09:00:00Z',
  status: 'failed',
  threadId: 'empty-thread',
  error: 'startup refused',
  failureStage: 'turn_start',
}
afterEach(() => vi.clearAllMocks())

it.each(['success', 'failure'] as const)('automatic history polling waits five seconds after a slow %s', async outcome => {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void
  vi.mocked(requestAutomation).mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail }))
    .mockResolvedValue({ jobs: [], executionDiagnostics: { runs: [] } })
  vi.useFakeTimers()
  const view = render(<AutomationRunHistory address={address} />)
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(4_900) })
    expect(requestAutomation).toHaveBeenCalledTimes(1)
    await act(async () => { if (outcome === 'success') resolve({ jobs: [], executionDiagnostics: { runs: [] } }); else reject(new Error('slow history read')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(requestAutomation).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(4_900) })
    expect(requestAutomation).toHaveBeenCalledTimes(2)
  } finally { view.unmount(); vi.useRealTimers() }
})

it('automatic history polling waits for the pending manual read before measuring its next interval', async () => {
  vi.mocked(requestAutomation).mockResolvedValue({ jobs: [], executionDiagnostics: { runs: [] } })
  vi.useFakeTimers()
  const view = render(<AutomationRunHistory address={address} />)
  let resolve!: (value: unknown) => void
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    vi.mocked(requestAutomation).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    fireEvent.click(screen.getByTestId('automation-runs-refresh'))
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    expect(requestAutomation).toHaveBeenCalledTimes(2)
    await act(async () => { resolve({ jobs: [], executionDiagnostics: { runs: [] } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999) })
    expect(requestAutomation).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(requestAutomation).toHaveBeenCalledTimes(3)
  } finally { view.unmount(); vi.useRealTimers() }
})

it.each(['success', 'failure'] as const)('a hidden browser tab rejects late history %s and rereads when visible', async outcome => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const onJobs = vi.fn()
  vi.mocked(requestAutomation).mockResolvedValue({ jobs: [], executionDiagnostics: { runs: [] } })
  vi.useFakeTimers()
  const view = render(<AutomationRunHistory address={address} onJobs={onJobs} />)
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(requestAutomation).toHaveBeenCalledTimes(1)
    let finish!: (value: unknown) => void, fail!: (error: Error) => void
    vi.mocked(requestAutomation).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = resolve; fail = reject
    }))
    fireEvent.click(screen.getByTestId('automation-runs-refresh'))
    expect(requestAutomation).toHaveBeenCalledTimes(2)
    act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    onJobs.mockClear()
    await act(async () => {
      if (outcome === 'failure') fail(new Error('hidden history failure'))
      else finish({ jobs: [], executionDiagnostics: { runs: [{ ...receipt, title: 'Hidden history' }] } })
    })
    expect(onJobs).not.toHaveBeenCalled()
    expect(screen.queryByText('Hidden history')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(requestAutomation).toHaveBeenCalledTimes(2)
    vi.mocked(requestAutomation).mockResolvedValue({ jobs: [],
      executionDiagnostics: { runs: [{ ...receipt, title: 'Current history' }] } })
    await act(async () => {
      visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(requestAutomation).toHaveBeenCalledTimes(3)
    expect(onJobs).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Current history')).toBeInTheDocument()
  } finally { view.unmount(); vi.useRealTimers(); visibility.mockRestore() }
})

it.each(['open', 'delete'] as const)('keeps a pending %s operation outcome when its browser tab hides', async operation => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let fail!: (error: Error) => void
  const pending = new Promise<never>((_resolve, reject) => { fail = reject })
  vi.mocked(requestAutomation).mockImplementation(async (_address, method) =>
    method === 'cron/list' ? historyRows(1) : pending)
  const open = vi.fn(() => pending)
  const view = render(<AutomationRunHistory address={address} onOpenTask={open} />)
  try {
    await screen.findByTestId('automation-run')
    fireEvent.click(screen.getByTestId(operation === 'open' ? 'automation-run-open-thread' : 'automation-run-delete'))
    act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { fail(new Error('owned operation failed')) })
    expect(screen.getByRole('alert')).toHaveTextContent(`automations.execution.${operation}Failed`)
    expect(screen.getByRole('alert')).toHaveTextContent('owned operation failed')
    expect(screen.getByTestId('automation-run-open-thread')).toBeEnabled()
    expect(screen.getByTestId('automation-run-delete')).toBeEnabled()
    expect(requestAutomation).toHaveBeenCalledTimes(operation === 'delete' ? 2 : 1)
  } finally { view.unmount(); visibility.mockRestore() }
})

describe('automation run history (model-independent persisted state projection)', () => {
  it('keeps removed one-shot history and opens its actual thread without inferring success', async () => {
    vi.mocked(requestAutomation).mockResolvedValue({
      jobs: [],
      executionDiagnostics: { runs: [receipt] },
    })
    const open = vi.fn().mockResolvedValue(undefined)
    render(<AutomationRunHistory address={address} onOpenTask={open} />)
    await waitFor(() =>
      expect(screen.getByTestId('automation-run')).toHaveAttribute('data-status', 'failed')
    )
    expect(screen.queryByText('startup refused')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('automation-run-open-thread'))
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({
        ...address,
        taskId: 'kcoder:fixture-device:empty-thread',
        threadId: 'empty-thread',
      })
    )
  })
  it('shows unknown and no-replay policy after restart; delivery alone is insufficient', async () => {
    vi.mocked(requestAutomation).mockResolvedValue({
      executionDiagnostics: { runs: [{ ...receipt, status: 'unknown', error: null }] },
    })
    render(<AutomationRunHistory address={address} />)
    expect(await screen.findByTestId('automation-run')).toHaveAttribute('data-status', 'unknown')
    expect(screen.queryByText('automations.execution.noReplay')).not.toBeInTheDocument()
    expect(screen.queryByTestId('automation-run-open-thread')).not.toBeInTheDocument()
  })
  it('ignores stale responses from a different workspace and retains known history on refresh error', async () => {
    let resolveOld!: (value: unknown) => void
    vi.mocked(requestAutomation)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveOld = resolve
          })
      )
      .mockResolvedValueOnce({
        executionDiagnostics: { runs: [{ ...receipt, triggerId: 'new-scope', jobId: 'new-job' }] },
      })
      .mockRejectedValueOnce(new Error('host offline'))
    const view = render(<AutomationRunHistory address={address} />)
    await waitFor(() => expect(requestAutomation).toHaveBeenCalledTimes(1))
    view.rerender(<AutomationRunHistory address={{ ...address, workspacePath: '/fixture-two' }} />)
    expect(await screen.findByText('new-job')).toBeInTheDocument()
    await act(async () => resolveOld({ executionDiagnostics: { runs: [receipt] } }))
    expect(screen.queryByText('removed-one-shot')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('automation-runs-refresh'))
    expect(await screen.findByText(/host offline/)).toBeInTheDocument()
    expect(screen.getByText('new-job')).toBeInTheDocument()
  })
  it('does not cancel an in-flight response when the same address object is rebuilt', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(requestAutomation).mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const view = render(<AutomationRunHistory address={address} />)
    await waitFor(() => expect(requestAutomation).toHaveBeenCalledTimes(1))
    view.rerender(<AutomationRunHistory address={{ ...address }} />)
    await act(async () => resolve({ executionDiagnostics: { runs: [receipt] } }))
    expect(await screen.findByText('removed-one-shot')).toBeInTheDocument()
    expect(requestAutomation).toHaveBeenCalledTimes(1)
  })

  it('reports conversation-open failures next to the history and permits recovery', async () => {
    vi.mocked(requestAutomation).mockResolvedValue({ executionDiagnostics: { runs: [receipt] } })
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('conversation unavailable'))
      .mockResolvedValueOnce(undefined)
    render(<AutomationRunHistory address={address} onOpenTask={open} />)
    fireEvent.click(await screen.findByTestId('automation-run-open-thread'))
    expect(await screen.findByText(/automations.execution.openFailed/)).toHaveTextContent(
      'conversation unavailable'
    )
    await waitFor(() => expect(screen.getByTestId('automation-run-open-thread')).toBeEnabled())
    fireEvent.click(screen.getByTestId('automation-run-open-thread'))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByText(/automations.execution.openFailed/)).not.toBeInTheDocument()
    )
  })
  it('opens canonical automation history through the Gateway thread/read route (model-independent routing)', async () => {
    // The fake client supplies protocol history only; no model behavior is asserted.
    localStorage.clear()
    const clients: Array<{ deviceId: string; client: FakeGatewayClient }> = []
    const workspaces: Array<string | undefined> = []
    class HistoryClient extends FakeGatewayClient {
      override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === 'thread/workspace/lookup') return {
          threadId: params.threadId,
          candidates: this.persistedThreads.filter(thread => thread.id === params.threadId)
            .map(thread => ({ workspacePath: thread.cwd })),
          scannedProjects: 1, completeness: 'complete', issueCount: 0,
        } as T
        return super.request<T>(method, params)
      }
    }
    const runtime = new KCoderGatewayRuntime('fixture-token', {
      loadServers: async () => [
        {
          id: 'other-device',
          runtime: 'kcoder',
          label: 'Other',
          description: '',
          transport: 'local',
          workspacePath: '/other-workspace',
        },
        {
          id: address.deviceId,
          runtime: 'kcoder',
          label: 'Fixture',
          description: '',
          transport: 'local',
          workspacePath: address.workspacePath,
        },
      ],
      createClient: (serverId, _token, _channel, workspacePath) => {
        workspaces.push(workspacePath)
        const client = new HistoryClient(null)
        client.threadResumeSupported = true
        client.persistedThreads =
          serverId === address.deviceId
            ? [
                {
                  id: 'empty-thread',
                  cwd: address.workspacePath,
                  title: 'Automation',
                  status: 'idle',
                },
              ]
            : [
                {
                  id: 'other-thread',
                  cwd: '/other-workspace',
                  title: 'Other conversation',
                  status: 'idle',
                },
              ]
        client.threadMessages = [
          {
            id: 'actual-reply',
            turnId: 'turn-1',
            role: 'assistant',
            content: 'persisted automation reply',
            blocks: [],
            timestampMs: 1700000000500,
          },
        ]
        clients.push({ deviceId: serverId, client })
        return client
      },
    })
    try {
      vi.mocked(requestAutomation).mockResolvedValue({ executionDiagnostics: { runs: [receipt] } })
      let transcript: { messages: Array<{ content: string }> } | undefined
      const open = vi.fn(async selectedAddress => {
        transcript = (await runtime.request('runtime.tasks.transcript', {
          address: selectedAddress,
        })) as typeof transcript
      })
      render(<AutomationRunHistory address={address} onOpenTask={open} />)
      fireEvent.click(await screen.findByTestId('automation-run-open-thread'))
      await waitFor(() =>
        expect(transcript?.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: 'persisted automation reply' }),
          ])
        )
      )
      expect(
        clients.some(
          ({ deviceId, client }) =>
            deviceId === address.deviceId &&
            client.requests.some(
              request =>
                request.method === 'thread/read' && request.params.threadId === 'empty-thread'
            )
        )
      ).toBe(true)
      expect(
        clients
          .filter(item => item.deviceId === 'other-device')
          .every(item => item.client.requests.every(request => request.method !== 'thread/read'))
      ).toBe(true)
      expect(workspaces).toContain(address.workspacePath)
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: address.deviceId,
          taskId: 'kcoder:fixture-device:empty-thread',
          workspacePath: address.workspacePath,
        })
      )
    } finally {
      await runtime.disposeAsync()
      localStorage.clear()
    }
  })
  it('never opens or displays executions returned for a different workspace', async () => {
    vi.mocked(requestAutomation).mockResolvedValue({
      executionDiagnostics: {
        runs: [
          { ...receipt, title: 'different workspace record', workspacePath: '/another-workspace' },
        ],
      },
    })
    const open = vi.fn()
    render(<AutomationRunHistory address={address} onOpenTask={open} />)
    expect(await screen.findByText('automations.execution.empty')).toBeInTheDocument()
    expect(screen.queryByText('different workspace record')).not.toBeInTheDocument()
    expect(screen.queryByTestId('automation-run-open-thread')).not.toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
  })
})

const historyRows = (count: number) => ({
  executionDiagnostics: {
    historyDeletionSupported: true,
    runs: Array.from({ length: count }, (_, index) => ({
      ...receipt,
      triggerId: `row-${index}`,
      title: `History ${index}`,
      replyPreview: 'Long intermediate output',
      error: 'Detailed failure',
    })),
  },
})

it('paginates ten title-only rows and clamps the last page after deleting its only record', async () => {
  vi.mocked(requestAutomation).mockImplementation(async (_address, method) =>
    method === 'cron/list'
      ? historyRows(21)
      : { deleted: true, historyOnly: true, schedulePreserved: true }
  )
  render(<AutomationRunHistory address={address} />)
  await screen.findByText('History 0')
  expect(screen.getAllByTestId('automation-run')).toHaveLength(10)
  expect(screen.queryByText('Long intermediate output')).not.toBeInTheDocument()
  expect(screen.queryByText('Detailed failure')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('automation-runs-next'))
  expect(screen.getByText('History 10')).toBeInTheDocument()
  expect(screen.getAllByTestId('automation-run')).toHaveLength(10)
  fireEvent.click(screen.getByTestId('automation-runs-next'))
  expect(screen.getAllByTestId('automation-run')).toHaveLength(1)
  fireEvent.click(screen.getByTestId('automation-run-delete'))
  await waitFor(() => expect(screen.queryByText('History 20')).not.toBeInTheDocument())
  expect(screen.getAllByTestId('automation-run')).toHaveLength(10)
  expect(screen.getByTestId('automation-runs-next')).toBeDisabled()
  expect(requestAutomation).toHaveBeenCalledWith(address, 'cron/delete', {
    jobId: receipt.jobId,
    triggerId: 'row-20',
    receiptsOnly: true,
    confirmed: true,
  })
})

it('does not resurrect deleted history from an older in-flight refresh', async () => {
  let resolveRefresh!: (value: unknown) => void
  vi.mocked(requestAutomation)
    .mockResolvedValueOnce(historyRows(1))
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRefresh = resolve
        })
    )
    .mockResolvedValueOnce({ deleted: true, historyOnly: true, schedulePreserved: true })
  render(<AutomationRunHistory address={address} />)
  await screen.findByText('History 0')
  fireEvent.click(screen.getByTestId('automation-runs-refresh'))
  fireEvent.click(screen.getByTestId('automation-run-delete'))
  await waitFor(() => expect(screen.queryByText('History 0')).not.toBeInTheDocument())
  await act(async () => resolveRefresh(historyRows(1)))
  expect(screen.queryByText('History 0')).not.toBeInTheDocument()
})

it('keeps the row when deletion fails and rejects deletion against an old runtime', async () => {
  vi.mocked(requestAutomation)
    .mockResolvedValueOnce(historyRows(1))
    .mockRejectedValueOnce(new Error('offline'))
  const view = render(<AutomationRunHistory address={address} />)
  await screen.findByText('History 0')
  fireEvent.click(screen.getByTestId('automation-run-delete'))
  expect(await screen.findByRole('alert')).toHaveTextContent('offline')
  expect(screen.getByText('History 0')).toBeInTheDocument()
  vi.mocked(requestAutomation).mockResolvedValue({ executionDiagnostics: { runs: [receipt] } })
  view.rerender(<AutomationRunHistory address={{ ...address, workspacePath: '/old-target' }} />)
  expect(await screen.findByText(receipt.jobId)).toBeInTheDocument()
  expect(screen.getByTestId('automation-run-delete')).toBeDisabled()
})

it('does not apply a completed deletion to a newly selected workspace', async () => {
  let resolveDelete!: (value: unknown) => void
  vi.mocked(requestAutomation)
    .mockResolvedValueOnce(historyRows(1))
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveDelete = resolve
        })
    )
    .mockResolvedValueOnce(historyRows(1))
  const view = render(<AutomationRunHistory address={address} />)
  await screen.findByText('History 0')
  fireEvent.click(screen.getByTestId('automation-run-delete'))
  view.rerender(<AutomationRunHistory address={{ ...address, workspacePath: '/peer' }} />)
  await screen.findByText('History 0')
  await act(async () =>
    resolveDelete({ deleted: true, historyOnly: true, schedulePreserved: true })
  )
  expect(screen.getByText('History 0')).toBeInTheDocument()
})
