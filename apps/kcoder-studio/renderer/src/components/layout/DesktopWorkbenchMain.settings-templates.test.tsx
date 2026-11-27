import { getDesktopWorkbenchHoistedMocks } from './DesktopWorkbenchLayout.test-mocks'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { DesktopWorkbenchLayout, createDeferred } from './DesktopWorkbenchLayout.test-harness'
import { createLocalRuntimeTaskPanelFixture } from './DesktopWorkbenchMain.workspace.test-support'
import * as sessions from './useWorkbenchPaneSession'
import type { SettingsTemplateCatalog } from '@/kcoder/configTemplates'

const { list } = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/kcoder/configTemplates', async original => ({
  ...await original<typeof import('@/kcoder/configTemplates')>(), listSettingsTemplates: list,
}))
const binding = { id: 'template', revisionSha256: 'revision' }
const catalog: SettingsTemplateCatalog = { templates: [{ ...binding, name: 'Current template', updatedAt: '', sizeBytes: 0 }] }
let restoredBinding: sessions.WorkbenchPaneSession['sessionTemplateBinding'] = null
beforeEach(() => {
  restoredBinding = null
  list.mockResolvedValue(catalog)
  vi.spyOn(sessions, 'useWorkbenchPaneSession').mockImplementation(() => ({
    ...getDesktopWorkbenchHoistedMocks().paneSessionMockRef.current as sessions.WorkbenchPaneSession,
    sessionTemplateBinding: restoredBinding,
  }))
})

test('existing unbound conversations do not read a template catalog on mount or task switch', async () => {
  const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
  const view = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)
  await act(async () => { await Promise.resolve() })
  expect(list).not.toHaveBeenCalled()
  view.rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)
  await act(async () => { await Promise.resolve() })
  expect(list).not.toHaveBeenCalled()
  expect(screen.queryByTestId('chat-settings-template-badge')).not.toBeInTheDocument()
})

test('a binding restored after the transcript loads reads the current catalog and shows its badge', async () => {
  const { propsForTask, taskA } = createLocalRuntimeTaskPanelFixture()
  const view = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)
  await act(async () => { await Promise.resolve() })
  expect(list).not.toHaveBeenCalled()
  restoredBinding = binding
  view.rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)
  await waitFor(() => expect(list).toHaveBeenCalledExactlyOnceWith(taskA.deviceId))
  expect(await screen.findByTestId('chat-settings-template-badge')).toHaveTextContent('Current template')
})

test('removing a binding rejects the pending catalog and does not requery an unbound task', async () => {
  const pending = createDeferred<SettingsTemplateCatalog>()
  const current = createDeferred<SettingsTemplateCatalog>()
  list.mockReturnValueOnce(pending.promise)
  restoredBinding = binding
  const { propsForTask, taskA } = createLocalRuntimeTaskPanelFixture()
  const view = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)
  await waitFor(() => expect(list).toHaveBeenCalledOnce())
  restoredBinding = null
  view.rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)
  await act(async () => { pending.resolve(catalog) })
  expect(list).toHaveBeenCalledOnce()
  expect(screen.queryByTestId('chat-settings-template-badge')).not.toBeInTheDocument()
  list.mockReturnValueOnce(current.promise)
  restoredBinding = binding
  view.rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  expect(screen.queryByTestId('chat-settings-template-badge')).not.toBeInTheDocument()
  await act(async () => { current.resolve({ templates: [{ ...catalog.templates[0], name: 'Restored template' }] }) })
  expect(await screen.findByTestId('chat-settings-template-badge')).toHaveTextContent('Restored template')
})

test('a new conversation still reads template choices from its selected target', async () => {
  const { propsForTask, taskA } = createLocalRuntimeTaskPanelFixture()
  const props = propsForTask(taskA)
  const project = { ...props.state.currentProject, config: { execution: { deviceId: taskA.deviceId } } }
  render(<DesktopWorkbenchLayout {...props} state={{ ...props.state, currentRuntimeTask: null, currentProject: project }} />)
  await waitFor(() => expect(list).toHaveBeenCalledExactlyOnceWith(taskA.deviceId))
})
