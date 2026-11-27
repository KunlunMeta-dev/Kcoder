import '@/components/layout/DesktopWorkbenchLayout.test-mocks'
import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { DesktopWorkbenchLayout, baseProps } from '@/components/layout/DesktopWorkbenchLayout.test-harness'

vi.mock('./MigrationFirstUseLauncher', () => ({
  MigrationFirstUseLauncher: ({ enabled, targetId }: { enabled: boolean; targetId?: string }) =>
    <span data-testid="first-use-current-target" data-enabled={String(enabled)} data-target={targetId}/>,
}))

it('keeps first-use discovery available after asynchronous bootstrap selects the target workspace', async () => {
  const view = render(<DesktopWorkbenchLayout {...baseProps}/>)
  expect(screen.getByTestId('first-use-current-target')).toHaveAttribute('data-enabled', 'true')
  const project = { id: 19, name: 'Current target', tasks: [], config: { mode: 'workspace',
    execution: { targetType: 'local' as const, deviceId: 'current-target' },
    workspace: { source: 'local_path' as const, localPath: '/owned/first-use' } } }
  await act(async () => {
    await Promise.resolve()
    view.rerender(<DesktopWorkbenchLayout {...baseProps} state={{ ...baseProps.state, currentProject: project,
      projects: [project], standaloneDeviceId: 'current-target', devices: [{ id: 19, device_id: 'current-target',
        name: 'Current target', status: 'online', is_default: true, device_type: 'remote' }] }}/>)
  })
  expect(screen.getByTestId('first-use-current-target')).toHaveAttribute('data-enabled', 'true')
  expect(screen.getByTestId('first-use-current-target')).toHaveAttribute('data-target', 'current-target')
})
