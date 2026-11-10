import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ThreadExpertResult } from '../../../../shared/generated/contracts'
import type { RuntimeTaskAddress } from '@/types/api'
import type { ExpertTaskDraft } from '@/types/workbench'
import { TaskExpertControl } from './TaskExpertControl'

const fixture = vi.hoisted(() => ({
  state: {
    currentRuntimeTask: null as RuntimeTaskAddress | null,
    currentProject: null,
    standaloneChatKey: 7,
    expertDraft: null as ExpertTaskDraft | null,
  },
  targetReady: true,
  selectDraftExpert: vi.fn(),
  expert: { snapshot: undefined as ThreadExpertResult | undefined, busy: false, error: '', refresh: vi.fn(async () => {}), select: vi.fn(async () => {}) },
}))

vi.mock('./useTaskExpert', () => ({ useTaskExpert: () => fixture.expert }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => fixture }))
vi.mock('@/features/runtime-target/useRuntimeSettingsTargets', () => ({
  useRuntimeSettingsTargets: () => ({ targets: [] }),
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'original-scope', isCurrent: () => true }),
}))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'task.selected') return `专家：${values?.name} · ${values?.version}`
      return { 'task.noExpert': '不使用专家', 'task.selectorLabel': '专家选择', 'task.clear': '使用普通 KCoder',
        'task.switchUnavailable': '暂时无法读取此任务的专家配置，请重试。',
        'task.retryRead': '重试读取' }[key] ?? key
    },
  }),
}))
vi.mock('./ExpertTarget', () => ({
  ExpertTarget: ({
    children,
    renderFallback,
  }: {
    children: (client: unknown) => ReactNode
    renderFallback: (content: ReactNode) => ReactNode
  }) =>
    fixture.targetReady ? children({}) : renderFallback(<p role="status">正在连接专家服务</p>),
}))
vi.mock('./ExpertTaskDialog', () => ({
  ExpertTaskDialog: ({ onClear }: { onClear?: () => Promise<void> }) => <div data-testid="expert-task-dialog">Expert picker
    {onClear && <button type="button" onClick={onClear}>Clear active expert</button>}</div>,
}))

beforeEach(() => {
  fixture.selectDraftExpert.mockClear()
  fixture.expert.snapshot = undefined
  fixture.expert.error = ''
  fixture.expert.busy = false
  fixture.expert.select.mockClear()
  fixture.expert.refresh.mockClear()
  fixture.targetReady = true
  fixture.state.currentRuntimeTask = null
  fixture.state.expertDraft = {
    deviceId: 'original-target',
    workspacePath: '/original',
    draftKey: 7,
    title: '合同起草专家',
    reference: { id: 'personal.contract', version: '1.0.0', definitionSha256: 'a'.repeat(64) },
  }
})

it('keeps target loading feedback in a closable dialog outside the composer form', () => {
  fixture.targetReady = false
  const submit = vi.fn()
  render(
    <form
      onSubmit={event => {
        event.preventDefault()
        submit()
      }}
    >
      <TaskExpertControl deviceId="original-target" workspacePath="/original" />
    </form>
  )

  fireEvent.click(screen.getByRole('button', { name: '专家：合同起草专家 · 1.0.0' }))
  const dialog = screen.getByTestId('expert-task-target-status')
  expect(dialog).toHaveTextContent('正在连接专家服务')
  expect(dialog.closest('form')).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByTestId('expert-task-target-status')).not.toBeInTheDocument()
  expect(submit).not.toHaveBeenCalled()
})

it('opens the named expert picker outside the composer form without submitting a message', () => {
  const submit = vi.fn()
  render(
    <form
      onSubmit={event => {
        event.preventDefault()
        submit()
      }}
    >
      <TaskExpertControl deviceId="original-target" workspacePath="/original" />
    </form>
  )

  const button = screen.getByRole('button', { name: '专家：合同起草专家 · 1.0.0' })
  expect(button).toHaveAttribute('type', 'button')
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByText('选择专家')).not.toBeInTheDocument()
  fireEvent.click(button)
  expect(screen.getByTestId('expert-task-dialog').closest('form')).toBeNull()
  expect(submit).not.toHaveBeenCalled()
  expect(fixture.selectDraftExpert).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Clear active expert' }))
  expect(fixture.selectDraftExpert).toHaveBeenCalledExactlyOnceWith(null, {
    draftKey: 7,
    projectId: null,
  })
  expect(submit).not.toHaveBeenCalled()
})

it('keeps older or unavailable targets read-only without falling back to draft changes', () => {
  const address: RuntimeTaskAddress = {
    deviceId: 'original-target',
    workspacePath: '/original',
    taskId: 'original-task',
    runtimeHandle: {
      agentDefinition: {
        owner: { accountId: 'owner', targetId: 'target', workspaceId: null },
        definition: { id: 'personal.fixed', version: '2.0.0', definitionSha256: 'b'.repeat(64) },
        title: '已保存专家',
        source: 'expert',
      },
    },
  }
  render(
    <TaskExpertControl address={address} deviceId="original-target" workspacePath="/original" />
  )

  const button = screen.getByRole('button', { name: '专家：已保存专家 · 2.0.0' })
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(screen.queryByTestId('expert-task-dialog')).not.toBeInTheDocument()
  expect(screen.queryByText('合同起草专家')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '使用普通 KCoder' })).not.toBeInTheDocument()
  expect(fixture.selectDraftExpert).not.toHaveBeenCalled()
})

it('uses one button for the selected expert and clears only its next-turn configuration inside the picker', async () => {
  fixture.expert.snapshot = { threadId: 'original-thread', revision: 7, expert: {
    owner: { accountId: 'owner', targetId: 'target', workspaceId: null },
    definition: { id: 'personal.fixed', version: '2.0.0', definitionSha256: 'b'.repeat(64) },
    title: '已保存专家', source: 'expert',
  }, turns: [] }
  const address = { deviceId: 'original-target', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/original' }
  render(<TaskExpertControl address={address} deviceId="original-target" workspacePath="/original" />)
  expect(screen.queryByRole('button', { name: 'task.usageHistory' })).not.toBeInTheDocument()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: '不使用专家' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '专家：已保存专家 · 2.0.0' }))
  const dialog = await screen.findByTestId('expert-task-dialog')
  expect(dialog.closest('form')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear active expert' }))
  expect(fixture.expert.select).toHaveBeenCalledExactlyOnceWith(null)
  expect(fixture.expert.refresh).toHaveBeenCalledTimes(1)
  expect(fixture.selectDraftExpert).not.toHaveBeenCalled()
})

it('keeps a failed expert read compact and exposes its explanation from the same selector', async () => {
  fixture.expert.error = 'Target unavailable'
  const address = { deviceId: 'original-target', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/original' }
  const submit = vi.fn()
  render(<form onSubmit={submit}>
    <TaskExpertControl address={address} deviceId="original-target" workspacePath="/original" />
  </form>)

  const selector = screen.getByRole('button', { name: '专家选择' })
  expect(selector.querySelector('.lucide-graduation-cap')).not.toBeNull()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(selector).toHaveAccessibleDescription('暂时无法读取此任务的专家配置，请重试。')
  expect(screen.getByRole('status')).toHaveClass('sr-only')
  fireEvent.click(selector)
  const dialog = await screen.findByTestId('expert-task-read-error')
  expect(dialog).toHaveTextContent('暂时无法读取此任务的专家配置，请重试。')
  expect(dialog.closest('form')).toBeNull()
  expect(fixture.expert.refresh).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试读取' }))
  await screen.findByTestId('expert-task-dialog')
  expect(screen.queryByTestId('expert-task-read-error')).not.toBeInTheDocument()
  expect(fixture.expert.refresh).toHaveBeenCalledOnce()
  expect(fixture.expert.select).not.toHaveBeenCalled()
  expect(fixture.selectDraftExpert).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('clears an open stale read error after background recovery without changing the expert', async () => {
  fixture.expert.error = 'Disconnected during restart'
  const address = { deviceId: 'original-target', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/original' }
  const view = render(<TaskExpertControl address={address} deviceId="original-target" workspacePath="/original" />)
  fireEvent.click(screen.getByRole('button', { name: '专家选择' }))
  await screen.findByTestId('expert-task-read-error')

  fixture.expert.error = ''
  fixture.expert.snapshot = { threadId: address.threadId, revision: 0, expert: null, turns: [] }
  view.rerender(<TaskExpertControl address={address} deviceId="original-target" workspacePath="/original" />)
  expect(screen.queryByTestId('expert-task-read-error')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '专家选择' })).toHaveAttribute('aria-expanded', 'false')
  expect(fixture.expert.select).not.toHaveBeenCalled()
  expect(screen.queryByTestId('expert-task-dialog')).not.toBeInTheDocument()
})

it('shows a failed manual read with an existing snapshot and clears it on a fresh same-revision read', async () => {
  const address = { deviceId: 'original-target', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/original' }
  fixture.expert.snapshot = { threadId: address.threadId, revision: 4, expert: null, turns: [] }
  fixture.expert.refresh.mockRejectedValueOnce(new Error('transport lost'))
  const view = render(<TaskExpertControl address={address} deviceId="original-target" workspacePath="/original" />)
  fireEvent.click(screen.getByRole('button', { name: '专家选择' }))
  await screen.findByTestId('expert-task-read-error')

  fixture.expert.snapshot = { ...fixture.expert.snapshot }
  view.rerender(<TaskExpertControl address={address} deviceId="original-target" workspacePath="/original" />)
  expect(screen.queryByTestId('expert-task-read-error')).not.toBeInTheDocument()
  expect(fixture.expert.select).not.toHaveBeenCalled()
})

it('does not carry an old task read error into another task', async () => {
  fixture.expert.error = 'Old task unavailable'
  const address = { deviceId: 'original-target', taskId: 'original-task', threadId: 'original-thread', workspacePath: '/original' }
  const view = render(<TaskExpertControl address={address} deviceId="original-target" workspacePath="/original" />)
  fireEvent.click(screen.getByRole('button', { name: '专家选择' }))
  await screen.findByTestId('expert-task-read-error')

  fixture.expert.error = ''
  view.rerender(<TaskExpertControl address={{ ...address, taskId: 'other-task', threadId: 'other-thread' }} deviceId="original-target" workspacePath="/original" />)
  expect(screen.queryByTestId('expert-task-read-error')).not.toBeInTheDocument()
  expect(fixture.expert.select).not.toHaveBeenCalled()
})
