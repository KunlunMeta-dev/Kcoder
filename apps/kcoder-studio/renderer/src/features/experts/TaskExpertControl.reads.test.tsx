import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { hookTargetScope } from '@/kcoder/gatewayHookConfiguration'
import i18n from '@/i18n'
import { TaskExpertControl } from './TaskExpertControl'

const fixture = vi.hoisted(() => ({
  state: { currentRuntimeTask: null, currentProject: null, standaloneChatKey: 7, expertDraft: null,
    runtimeWork: null, selectedDeviceWorkspaceId: null, standaloneDeviceId: null, standaloneWorkspacePath: null },
  selectDraftExpert: vi.fn(), updateRuntimeTaskExpertBinding: vi.fn(), bound: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => fixture }))
vi.mock('./useTaskExpert', () => ({ useTaskExpert: (address?: { threadId?: string } | null) => ({
  snapshot: address ? { threadId: address.threadId, revision: 0, expert: null, turns: [] } : undefined,
  busy: false, error: '', refresh: async () => {}, select: vi.fn(),
}) }))
vi.mock('./ExpertTarget', () => ({ ExpertTarget: (props: { children: (client: unknown) => ReactNode }) => {
  fixture.bound(props)
  return props.children({})
} }))
vi.mock('./ExpertTaskDialog', () => ({ ExpertTaskDialog: ({ onClose }: { onClose: () => void }) =>
  <div role="dialog" data-testid="expert-task-dialog"><button onClick={onClose}>Close picker</button></div> }))
const target = { id: 'original-target', transport: 'local' as const, profile: 'original', workspacePath: '/original' }
let marker: HTMLMetaElement
beforeEach(async () => {
  fixture.bound.mockClear()
  fixture.state.standaloneChatKey = 7
  marker = document.createElement('meta'); marker.name = 'kcoder-rpc-token'; marker.content = 'owned-fixture'; document.head.append(marker)
  await i18n.changeLanguage('en')
})
afterEach(() => { cleanup(); marker.remove(); vi.restoreAllMocks() })
const control = () => screen.getByTestId('task-expert-control').querySelector('button')!

test('an explicit workspace keeps the closed picker free of directory reads; opening reads once and carries its owner', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ servers: [target] }))
  render(<TaskExpertControl deviceId={target.id} workspacePath="/original" />)
  await act(async () => {})
  expect(network).not.toHaveBeenCalled()
  fireEvent.click(control())
  await screen.findByTestId('expert-task-dialog')
  expect(network).toHaveBeenCalledTimes(1)
  expect(fixture.bound).toHaveBeenLastCalledWith(expect.objectContaining({ serverId: target.id, targetScope: hookTargetScope(target) }))
})

test('task switching closes the original picker and returning does not reopen its old intent', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ servers: [target] }))
  const a = { deviceId: target.id, taskId: 'original', threadId: 'original', workspacePath: '/original' }
  const b = { ...a, taskId: 'replacement', threadId: 'replacement' }
  const view = render(<TaskExpertControl address={a} deviceId={target.id} workspacePath="/original" />)
  fireEvent.click(control())
  await screen.findByTestId('expert-task-dialog')
  view.rerender(<TaskExpertControl address={b} deviceId={target.id} workspacePath="/original" />)
  expect(screen.queryByTestId('expert-task-dialog')).toBeNull()
  expect(control()).toHaveAttribute('aria-expanded', 'false')
  view.rerender(<TaskExpertControl address={a} deviceId={target.id} workspacePath="/original" />)
  expect(screen.queryByTestId('expert-task-dialog')).toBeNull()
})

test('a new draft identity retires its picker while retaining the original default-workspace lookup', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ servers: [target] }))
  const view = render(<TaskExpertControl deviceId={target.id} />)
  await waitFor(() => expect(control()).toBeEnabled())
  expect(network).toHaveBeenCalledTimes(1)
  fireEvent.click(control())
  await screen.findByTestId('expert-task-dialog')
  fixture.state.standaloneChatKey++
  view.rerender(<TaskExpertControl deviceId={target.id} />)
  expect(screen.queryByTestId('expert-task-dialog')).toBeNull()
})

test('closing a loading picker cancels its directory wait and ignores a late reply', async () => {
  let reply!: (response: Response) => void
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { reply = resolve }))
  render(<TaskExpertControl deviceId={target.id} workspacePath="/original" />)
  fireEvent.click(control())
  await waitFor(() => expect(network).toHaveBeenCalledOnce())
  expect(screen.getByTestId('expert-task-target-status')).toBeVisible()
  const signal = network.mock.calls[0][1]?.signal
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(signal?.aborted).toBe(true)
  await act(async () => { reply(Response.json({ servers: [target] })) })
  expect(screen.queryByTestId('expert-task-target-status')).toBeNull()
  expect(screen.queryByTestId('expert-task-dialog')).toBeNull()
  expect(fixture.bound).not.toHaveBeenCalled()
})

test('directory failure keeps a closable status and an explicit retry recovers the original target', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('owned transport failure'))
    .mockResolvedValue(Response.json({ servers: [target] }))
  render(<TaskExpertControl deviceId={target.id} workspacePath="/original" />)
  fireEvent.click(control())
  const status = await screen.findByTestId('expert-task-target-status')
  await waitFor(() => expect(status.querySelector('[role="alert"]')).not.toBeNull())
  expect(fixture.bound).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('task.retryRead', { ns: 'experts' }) }))
  await screen.findByTestId('expert-task-dialog')
  expect(network).toHaveBeenCalledTimes(2)
})

test('a missing explicit target cannot use another directory default; removing its owner closes the status', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ servers: [{ ...target, id: 'another-target' }] }))
  const view = render(<TaskExpertControl deviceId={target.id} workspacePath="/original" />)
  fireEvent.click(control())
  await waitFor(() => expect(screen.getByTestId('expert-task-target-status').querySelector('[role="alert"]')).not.toBeNull())
  expect(fixture.bound).not.toHaveBeenCalled()
  view.rerender(<TaskExpertControl deviceId={null} workspacePath="/original" />)
  expect(screen.queryByTestId('expert-task-target-status')).toBeNull()
  expect(control()).toBeDisabled()
})
