import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { ProjectHistoryRefreshDialog } from '../ProjectHistoryRefreshDialog'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: request }))

test('the workspace selector key uses the normalized device path', () => {
  render(
    <ProjectHistoryRefreshDialog
      workspaces={[
        {
          deviceId: 'device-1',
          deviceName: 'This computer',
          deviceStatus: 'online',
          available: true,
          workspacePath: String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-factory`,
          tasks: [],
        },
      ]}
      onClose={vi.fn()}
    />
  )
  // The selected value is the identity key of both the <option> and the
  // refresh request, so it must be the namespace-free form.
  expect(screen.getByTestId('history-refresh-target')).toHaveValue(
    JSON.stringify(['device-1', 'C:/Users/kunlunmeta/projects/gpt-factory'])
  )
})