import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import { ExpertTaskHistory } from './ExpertTaskHistory'

const fixture = vi.hoisted(() => ({
  work: null as RuntimeWorkListResponse | null,
  refresh: vi.fn(),
  openRuntimeTask: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({
  state: { runtimeWork: fixture.work },
  refreshWorkLists: fixture.refresh,
  openRuntimeTask: fixture.openRuntimeTask,
}) }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({
  t: (key: string) => key,
}) }))

it('marks the history incomplete and hides cached bindings when the authoritative refresh fails', async () => {
  fixture.work = { projects: [], chats: [{
    deviceId: 'target', workspacePath: '/workspace', tasks: [{
      taskId: 'task', threadId: 'thread', title: 'Cached task', runtime: 'kcoder',
      runtimeHandle: { agentDefinition: { title: 'Cached expert', definition: { version: '1' } } },
    }],
  }], totalTasks: 1 } as unknown as RuntimeWorkListResponse
  fixture.refresh.mockReset().mockRejectedValueOnce(new Error('runtime index unavailable'))
  render(<ExpertTaskHistory deviceId="target" workspacePath="/workspace" />)

  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  expect(await screen.findByRole('status')).toHaveTextContent('task.historyPartial')
  expect(fixture.refresh).toHaveBeenCalledWith({ requireRuntimeWork: true })
  await waitFor(() => expect(screen.queryByRole('button', { name: /Cached task/ })).not.toBeInTheDocument())
})
