import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { createTemporaryRuntimeTaskMock } from './DesktopWorkbenchLayout.test-mocks'
import { renderWorkspacePanelLayout } from './DesktopWorkbenchMain.workspace.test-support'
import { ToolPathPreviewConsumer, toolPathPreviews } from '@/kcoder/toolPathPreview'

test('the real temporary chat leases previews for its own task and clears them when closed', async () => {
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
  // Path previews no longer render as a standalone banner (renderer README:
  // three-level disclosure). The open panel's transcript holds the progress lease
  // that keeps this task's projection live; closing it must clear the projection.
  const previews = () =>
    toolPathPreviews.read(address.deviceId, address.taskId).map(entry => entry.path)
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
    expect(previews()).toEqual(['temporary.ts'])
    expect(screen.queryByTestId('tool-path-preview')).toBeNull()
    act(() =>
      send(3, 'item/event', { type: 'tool_path_preview', attempt_id: 'a', id: 'tool', path: null })
    )
    expect(previews()).toEqual([])
    act(() =>
      send(4, 'item/event', {
        type: 'tool_path_preview',
        attempt_id: 'a',
        id: 'tool',
        path: 'again.ts',
      })
    )
    expect(previews()).toEqual(['again.ts'])
    view.unmount()
    act(() =>
      send(5, 'item/event', {
        type: 'tool_path_preview',
        attempt_id: 'a',
        id: 'tool',
        path: 'late.ts',
      })
    )
    expect(previews()).toEqual([])
  } finally {
    view.unmount()
    act(() => consumer.dispose())
  }
})
