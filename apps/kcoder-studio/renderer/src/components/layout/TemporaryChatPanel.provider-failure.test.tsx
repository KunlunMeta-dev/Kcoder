import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import {
  createTemporaryRuntimeTaskMock,
  subscribeRuntimeTaskStreamMock,
} from './DesktopWorkbenchLayout.test-mocks'
import { renderWorkspacePanelLayout } from './DesktopWorkbenchMain.workspace.test-support'
import {
  createRuntimeTaskStreamHandlers,
  type RuntimeTaskStreamHandlers,
} from '@/features/workbench/runtimePaneMessages'
import { emitResponseApiEvent, createResponseApiStreamState } from '@/stream/responseApiStream'

test('temporary chat preserves its prompt when initial submission fails', async () => {
  createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
    options?.onError?.('connection unavailable')
    return null
  })
  const view = renderWorkspacePanelLayout()
  try {
    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-chat-option'))
    const panel = screen.getByTestId('right-workspace-chat-panel')
    await userEvent.type(within(panel).getByTestId('chat-message-input'), 'keep draft{Enter}')
    expect(within(panel).getByTestId('chat-message-input').textContent).toBe('keep draft')
    expect(within(panel).getByText('connection unavailable')).toBeVisible()
  } finally {
    view.unmount()
  }
})

test('real temporary pane shows scoped typed failures without affecting the main pane', async () => {
  const address = {
    deviceId: 'workspace-cloud-device',
    taskId: 'runtime-side-chat',
    workspacePath: '/workspace/project',
  }
  let handlers: ReturnType<typeof createRuntimeTaskStreamHandlers> | undefined
  subscribeRuntimeTaskStreamMock.mockImplementation((...args: unknown[]) => {
    const [scope, callbacks] = args as [typeof address, RuntimeTaskStreamHandlers]
    if (scope.taskId === address.taskId)
      handlers = createRuntimeTaskStreamHandlers(scope, callbacks)
    return () => {}
  })
  createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
    options?.onRuntimeTaskOptimisticOpen?.(address)
    return address
  })
  const view = renderWorkspacePanelLayout()
  try {
    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-chat-option'))
    const panel = screen.getByTestId('right-workspace-chat-panel')
    await userEvent.type(within(panel).getByTestId('chat-message-input'), 'request')
    await userEvent.click(within(panel).getByTestId('send-message-button'))
    expect(within(panel).getByTestId('chat-message-input').textContent).toBe('')
    // Reserve navigation space outside the scrolling viewport, not inside message padding.
    const scroller = within(panel).getByTestId('right-workspace-chat-scroll-area')
    expect(scroller).toHaveClass('lg:ml-14')
    expect(within(panel).getByTestId('right-workspace-chat-scroll-area-content')).not.toHaveClass('lg:pl-14')
    expect(handlers).toBeDefined()
    const send = (deviceId: string, taskId: string) =>
      emitResponseApiEvent(
        handlers!,
        'response.failed',
        {
          deviceId,
          taskId,
          subtaskId: 'turn-side',
          data: {
            message: 'HTTP 401 quota exceeded network',
            provider_failure: {
              category: 'invalid_parameter',
              recovery_action: 'needs_human',
              retryable: false,
              resume_safe: false,
            },
          },
        },
        createResponseApiStreamState()
      )
    act(() => {
      send('other', address.taskId)
      send(address.deviceId, 'other')
    })
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(2)
    vi.mocked(console.warn).mockClear()
    expect(within(panel).queryByTestId('assistant-error-card')).toBeNull()
    act(() => send(address.deviceId, address.taskId))
    expect(within(panel).getByTestId('assistant-error-card')).toHaveTextContent('需要人工处理')
    expect(within(panel).getByTestId('assistant-error-card')).toHaveTextContent('参数错误')
    expect(screen.getAllByTestId('assistant-error-card')).toHaveLength(1)
    expect(within(panel).queryByTestId('stop-generating-button')).toBeNull()
    await userEvent.type(within(panel).getByTestId('chat-message-input'), 'next request{Enter}')
    expect(within(panel).getByTestId('chat-message-input').textContent).toBe('')
  } finally {
    view.unmount()
  }
})
