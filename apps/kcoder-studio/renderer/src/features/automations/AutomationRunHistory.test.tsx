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
    expect(screen.getByRole('alert')).toHaveTextContent('startup refused')
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
    expect(await screen.findByText('automations.execution.noReplay')).toBeInTheDocument()
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
        const client = new FakeGatewayClient(null)
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
