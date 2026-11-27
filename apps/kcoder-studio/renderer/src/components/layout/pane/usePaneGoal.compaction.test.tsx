import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ChatInput } from '@/components/chat/ChatInput'
import { FakeGatewayClient } from '@/kcoder/gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime } from '@/kcoder/gatewayRuntime'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { usePaneGoal } from './usePaneGoal'

const first = '00000000-0000-4000-8000-000000000001'
const second = '00000000-0000-4000-8000-000000000002'
const runtimes = new Set<KCoderGatewayRuntime>()

afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.disposeAsync()))
  runtimes.clear()
  localStorage.clear()
  clearTestTransports()
})

async function fixture() {
  installTestTransport(() => undefined)
  const client = new FakeGatewayClient('compact-thread')
  const fallback = client.request.bind(client)
  const request = vi.spyOn(client, 'request').mockImplementation(async (method, params = {}) =>
    method === 'thread/maintenance/cancel' ? { cancellationRequested: true } : fallback(method, params)
  )
  const runtime = new KCoderGatewayRuntime('fixture-token', {
    loadServers: async () => [{ id: 'local', label: 'Local', transport: 'local', workspacePath: '/fixture' }],
    createClient: () => client,
  })
  runtimes.add(runtime)
  const created = await runtime.request('runtime.tasks.create', {
    taskId: 'compact-task', executionRequest: { prompt: 'Owned fixture' },
  }) as { taskId: string }
  const address = { taskId: created.taskId, deviceId: 'local', threadId: 'compact-thread' }
  const cancelRuntimePaneTask = vi.fn()
  const context = {
    currentRuntimeTask: address, paneStatus: { isBusy: false }, cancelRuntimePaneTask, setError: vi.fn(),
  } as unknown as Parameters<typeof usePaneGoal>[0]
  const notify = (status: string, maintenanceId: string) => runtime.forwardNotification(
    'thread/maintenance', { threadId: address.threadId, operation: 'compact', status, maintenanceId },
    address.deviceId, client,
  )
  request.mockClear()
  return { context, request, cancelRuntimePaneTask, notify }
}

test('the existing stop button cancels the exact compaction and preserves a draft', async () => {
  const f = await fixture()
  const submit = vi.fn()
  function Composer({ variant }: { variant: 'desktop' | 'compact' }) {
    const pane = usePaneGoal(f.context)
    return <ChatInput value="Keep this draft" onChange={() => {}} onSubmit={submit} disabled={false}
      variant={variant} isStreaming={pane.compactionActive} submitDisabled={pane.compactionActive}
      onPause={pane.pauseCurrentResponse} />
  }
  const view = render(<Composer variant="desktop" />)
  await act(() => f.notify('started', first))
  for (const variant of ['desktop', 'compact'] as const) {
    view.rerender(<Composer variant={variant} />)
    const button = screen.getByTestId('pause-response-button')
    fireEvent.click(button)
    await waitFor(() => expect(button).toBeEnabled())
    expect(f.request.mock.calls.at(-1)).toEqual([
      'thread/maintenance/cancel', { threadId: 'compact-thread', maintenanceId: first },
    ])
  }
  expect(screen.getByTestId('chat-message-input')).toHaveValue('Keep this draft')
  expect(submit).not.toHaveBeenCalled()
  expect(f.cancelRuntimePaneTask).not.toHaveBeenCalled()
  await act(() => f.notify('cancelled', first))
  expect(screen.queryByTestId('pause-response-button')).not.toBeInTheDocument()
})

test('an old stopped job does not clear or interrupt a newer one', async () => {
  const f = await fixture()
  const { result } = renderHook(() => usePaneGoal(f.context))
  await act(() => f.notify('started', first))
  const staleStop = result.current.pauseCurrentResponse
  await act(() => f.notify('started', second))
  await act(() => f.notify('cancelled', first))
  await act(() => staleStop())
  expect(f.request).not.toHaveBeenCalled()
  expect(f.cancelRuntimePaneTask).not.toHaveBeenCalled()
  expect(result.current.compactionActive).toBe(true)
  await act(() => result.current.pauseCurrentResponse())
  expect(f.request).toHaveBeenCalledWith('thread/maintenance/cancel', {
    threadId: 'compact-thread', maintenanceId: second,
  })
})
