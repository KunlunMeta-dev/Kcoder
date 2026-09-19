import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { createTemporaryRuntimeTaskMock } from './DesktopWorkbenchLayout.test-mocks'
import { renderWorkspacePanelLayout } from './DesktopWorkbenchMain.workspace.test-support'
import { ToolPathPreviewConsumer } from '@/kcoder/toolPathPreview'

test('the real temporary chat renders previews outside messages and clears them when closed', async () => {
  const address = {
    deviceId: 'workspace-cloud-device',
    taskId: 'runtime-side-chat',
    workspacePath: '/workspace/project',
  }
  createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
    options?.onRuntimeTaskOptimisticOpen?.(address)
    return address
  })
  const view = renderWorkspacePanelLayout()
  const consumer = new ToolPathPreviewConsumer()
  const client = {}
  const send = (sequence: number, method: string, event?: Record<string, unknown>) =>
    consumer.handle(
      method,
      { serverId: 'instance', threadId: 'thread', turnId: 'turn', sequence, event },
      address.deviceId,
      address.taskId,
      client
    )
  try {
    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-chat-option'))
    const panel = screen.getByTestId('right-workspace-chat-panel')
    await userEvent.type(within(panel).getByTestId('chat-message-input'), 'change file')
    await userEvent.click(within(panel).getByTestId('send-message-button'))
    act(() => {
      send(1, 'turn/started')
      send(2, 'item/event', {
        type: 'tool_path_preview',
        attempt_id: 'a',
        id: 'tool',
        path: 'temporary.ts',
      })
    })
    expect(within(panel).getByTestId('tool-path-preview')).toHaveTextContent(
      '准备修改 temporary.ts'
    )
    expect(screen.getAllByTestId('tool-path-preview')).toHaveLength(1)
    act(() =>
      send(3, 'item/event', { type: 'tool_path_preview', attempt_id: 'a', id: 'tool', path: null })
    )
    expect(within(panel).queryByTestId('tool-path-preview')).toBeNull()
    act(() =>
      send(4, 'item/event', {
        type: 'tool_path_preview',
        attempt_id: 'a',
        id: 'tool',
        path: 'again.ts',
      })
    )
    expect(within(panel).getByTestId('tool-path-preview')).toHaveTextContent('again.ts')
    view.unmount()
    act(() =>
      send(5, 'item/event', {
        type: 'tool_path_preview',
        attempt_id: 'a',
        id: 'tool',
        path: 'late.ts',
      })
    )
    expect(screen.queryByTestId('tool-path-preview')).toBeNull()
  } finally {
    view.unmount()
    act(() => consumer.dispose())
  }
})
