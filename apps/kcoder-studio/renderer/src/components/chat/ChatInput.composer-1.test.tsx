import type { DeviceInfo, RuntimeGoal } from '@/types/api'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ChatInput } from './ChatInput'
import {
  projectChatControls,
  projectWorkControls,
  runtimeWork,
} from './composer/ChatInput.test-support'
import { ControlledChatInput } from './composer/ControlledChatInput.test-support'
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { action?: string; count?: number; device?: string; location?: string },
      interpolation?: { model?: string }
    ) => {
      if (typeof options === 'string') {
        return interpolation?.model ? options.replace('{{model}}', interpolation.model) : options
      }
      if (key === 'workbench.goal_standard_label') return '普通目标（/goal）'
      if (key === 'workbench.goal_pro_label') return '严格目标（/goal-pro）'
      if (key === 'workbench.goal_pro_description') return '持续执行目标，并进行独立验证'
      if (key === 'workbench.code_comment_count') {
        return `${options?.count ?? 0} 个评论`
      }
      if (key === 'workbench.project_work_trigger_device_aria') {
        return `${options?.action ?? ''}，当前设备 ${options?.device ?? ''}`
      }
      if (key === 'workbench.environment_cloud_device') return '云设备'
      if (key === 'workbench.environment_local') return '本机'
      if (key === 'workbench.remove_code_comments') {
        return '移除代码评论'
      }
      return key
    },
  }),
}))
describe('ChatInput composer', () => {
  const originalCreateObjectUrl = URL.createObjectURL
  const originalInnerWidth = window.innerWidth
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    localStorage.clear()
    URL.createObjectURL = originalCreateObjectUrl
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    })
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })
  test('renders the desktop composer sections', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
      />
    )

    expect(screen.getByTestId('project-chat-composer-form')).toHaveClass(
      'min-h-[76px]',
      'pb-1.5',
      'pt-2',
      'bg-background'
    )
    expect(screen.getByTestId('project-chat-composer-form')).not.toHaveClass('bg-surface')
    expect(screen.getByTestId('project-chat-composer')).toHaveClass(
      'shadow-[0_0_0_0.5px_rgba(13,13,13,0.12),0_3px_7.5px_rgba(0,0,0,0.04),0_0_20px_rgba(0,0,0,0.05)]'
    )
    expect(screen.getByTestId('chat-message-input')).toHaveAttribute('rows', '2')
    expect(screen.getByTestId('chat-message-input')).toHaveClass(
      'min-h-[48px]',
      'max-h-[112px]',
      'pt-1',
      'placeholder:text-text-muted/55'
    )
    expect(screen.queryByTestId('custom-mode-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument()
    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-work-button')).toBeInTheDocument()
    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
  })

  test('selects plan mode from the add context menu', async () => {
    const setSelectedModelOption = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          selectedModelOptions: {},
          setSelectedModelOption,
        })}
      />
    )

    expect(screen.queryByTestId('plan-mode-pill')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cancel-plan-mode-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('set-plan-mode-button'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'plan')
  })

  test('shows the plan mode pill when plan mode is selected', async () => {
    const setSelectedModelOption = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          selectedModelOptions: { collaborationMode: 'plan' },
          setSelectedModelOption,
        })}
      />
    )

    const pill = screen.getByTestId('plan-mode-pill')
    expect(pill).toHaveTextContent('计划模式')
    expect(pill).toHaveClass('h-7')
    expect(pill).toHaveClass('rounded-xl')
    expect(pill).toHaveClass('bg-muted')
    expect(screen.getByTestId('plan-mode-pill-icon')).toHaveClass('h-4')
    expect(screen.getByTestId('cancel-plan-mode-button')).toHaveClass('absolute')
    expect(screen.getByTestId('cancel-plan-mode-button')).toHaveClass('left-2')
    expect(screen.getByTestId('plan-mode-pill-icon')).toHaveClass('group-hover:opacity-0')

    await userEvent.click(screen.getByTestId('cancel-plan-mode-button'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'default')
  })

  test('hides the plan mode pill while goal draft mode is active', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goalDraftActive
      />
    )

    expect(screen.getByTestId('goal-draft-pill')).toHaveTextContent('目标')
    expect(screen.queryByTestId('plan-mode-pill')).not.toBeInTheDocument()
  })

  test('shows desktop pause button while the assistant is streaming', async () => {
    const onPause = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        isStreaming
        onPause={onPause}
      />
    )

    expect(screen.getByTestId('pause-response-button')).toBeInTheDocument()
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('pause-response-button'))

    expect(onPause).toHaveBeenCalledTimes(1)
  })

  test('shows desktop send button for a draft while the assistant is streaming', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value="继续修复"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        isStreaming
      />
    )

    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    expect(screen.queryByTestId('pause-response-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalledWith('继续修复')
  })

  test('carries the chosen session settings template into the submit options', async () => {
    const onSubmit = vi.fn()
    function Harness() {
      const [value, setValue] = useState('')
      const [choice, setChoice] = useState<string | undefined>(undefined)
      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          disabled={false}
          settingsTemplatePicker={{
            value: choice,
            placeholder: '跟随默认（fast-local）',
            options: [
              { id: 'fast-local', name: 'Fast local', isDefault: true },
              { id: 'no-bash', name: 'No bash', isDefault: false },
            ],
            onChange: setChoice,
          }}
        />
      )
    }
    render(<Harness />)

    const select = screen.getByTestId('chat-settings-template')
    expect(select).toHaveDisplayValue('跟随默认（fast-local）')
    expect(select).toHaveTextContent('Fast local ★')

    await userEvent.click(select)
    await userEvent.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: 'No bash' })
    )
    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello world')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls.at(-1)?.[1]).toMatchObject({ settingsTemplate: 'no-bash' })
  })

  test('keeps compact actions inside the composer bottom toolbar', () => {
    render(<ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} />)

    const form = screen.getByTestId('chat-message-input').closest('form')

    expect(form).toHaveClass('items-end')
    expect(screen.getByTestId('add-context-button')).toHaveClass('h-11', 'w-11', 'rounded-xl')
    const toolbar = screen.getByTestId('compact-composer-toolbar')
    expect(screen.getByTestId('compact-input-pill').contains(toolbar)).toBe(true)
    expect(toolbar.contains(screen.getByTestId('quick-phrase-button'))).toBe(true)
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('min-h-[52px]')
    expect(screen.getByTestId('chat-message-input')).toHaveClass(
      'py-[14px]',
      'scrollbar-none',
      'text-chat',
      'text-text-primary',
      'leading-5'
    )
    expect(screen.getByTestId('send-message-button')).toHaveClass(
      'absolute',
      'bottom-1',
      'right-1',
      'h-11',
      'w-11',
      'rounded-[22px]'
    )
  })

  test('shows compact pause button while the assistant is streaming', async () => {
    const onPause = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        isStreaming
        onPause={onPause}
      />
    )

    expect(screen.getByTestId('pause-response-button')).toHaveClass(
      'absolute',
      'bottom-1',
      'right-1',
      'h-11',
      'w-11'
    )
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('pause-response-button'))

    expect(onPause).toHaveBeenCalledTimes(1)
  })

  test('shows compact send button for a draft while the assistant is streaming', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value="继续修复"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        isStreaming
      />
    )

    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    expect(screen.queryByTestId('pause-response-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('pr-[92px]')

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalledWith('继续修复')
  })

  test('does not render voice input in the compact composer', async () => {
    render(<ControlledChatInput />)

    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello')

    expect(screen.queryByTestId('voice-input-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('compact-input-pill')).toHaveClass('pr-14')
    expect(screen.getByTestId('send-message-button')).toHaveClass('bottom-1', 'right-1')
  })

  test('opens the compact context sheet with plan and goal actions', async () => {
    const setSelectedModelOption = vi.fn()
    const onSetGoal = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ setSelectedModelOption })}
        onSetGoal={onSetGoal}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('mobile-context-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-set-plan-mode-button')).toHaveTextContent('计划模式')
    expect(screen.getByTestId('mobile-set-goal-button')).toHaveTextContent('普通目标（/goal）')
    expect(screen.getByTestId('mobile-set-goal-pro-button')).toHaveTextContent('/goal-pro')

    await userEvent.click(screen.getByTestId('mobile-set-plan-mode-button'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'plan')
    expect(screen.queryByTestId('mobile-context-sheet')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('mobile-set-goal-button'))

    expect(onSetGoal).toHaveBeenCalledTimes(1)
    expect(onSetGoal).toHaveBeenLastCalledWith('standard')
    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('mobile-set-goal-pro-button'))
    expect(onSetGoal).toHaveBeenLastCalledWith('strict')
    expect(screen.queryByTestId('mobile-context-sheet')).not.toBeInTheDocument()
  })

  test('renders desktop context usage indicator with compact action when usage is available', async () => {
    const onSubmit = vi.fn()
    const onCompactContext = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onCompactContext={onCompactContext}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          contextUsage: {
            total: {
              totalTokens: 15_000,
              inputTokens: 12_000,
              cachedInputTokens: 2_000,
              outputTokens: 3_000,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 8_000,
              inputTokens: 7_000,
              cachedInputTokens: 1_000,
              outputTokens: 1_000,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258_000,
          },
        })}
      />
    )

    expect(screen.getByTestId('context-usage-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('context-usage-indicator')).toHaveAttribute(
      'aria-label',
      'workbench.context_usage_aria'
    )

    await userEvent.click(screen.getByTestId('context-usage-button'))

    expect(screen.getByTestId('confirm-compact-context-button')).toHaveTextContent('压缩')

    await userEvent.click(screen.getByTestId('confirm-compact-context-button'))

    expect(onCompactContext).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-compact-context-button')).not.toBeInTheDocument()
  })

  test('hides the project work bar when requested', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        showProjectWorkBar={false}
      />
    )

    expect(screen.getByTestId('chat-message-input')).toBeInTheDocument()
    expect(screen.queryByTestId('project-work-button')).not.toBeInTheDocument()
  })

  test('renders desktop goal status bar actions', async () => {
    const goal: RuntimeGoal = {
      threadId: 'thread-1',
      objective: '实现 plan 里的功能',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 178,
      createdAt: 1780000000000,
      updatedAt: 1780000000000,
    }
    const onEditGoal = vi.fn()
    const onPauseGoal = vi.fn()
    const onClearGoal = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goal={goal}
        onEditGoal={onEditGoal}
        onPauseGoal={onPauseGoal}
        onClearGoal={onClearGoal}
      />
    )

    const bar = screen.getByTestId('goal-status-bar')
    expect(bar).toHaveTextContent('进行中的目标')
    expect(bar).toHaveTextContent('实现 plan 里的功能')
    expect(bar).toHaveTextContent('2m 58s')

    await userEvent.click(screen.getByTestId('edit-goal-button'))
    await userEvent.click(screen.getByTestId('pause-goal-button'))
    await userEvent.click(screen.getByTestId('clear-goal-button'))

    expect(onEditGoal).toHaveBeenCalledTimes(1)
    expect(onPauseGoal).toHaveBeenCalledTimes(1)
    expect(onClearGoal).toHaveBeenCalledTimes(1)
  })

  test('renders a newly created active goal with a zero-second timer', () => {
    const goal: RuntimeGoal = {
      threadId: 'pending',
      objective: '立刻显示目标条',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goal={goal}
      />
    )

    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('立刻显示目标条')
    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('0s')
  })

  test('shows an active goal as continuing only while a new goal turn is running', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goalContinuing
        goal={{
          threadId: 'thread-1',
          objective: '继续完成测试',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1780000000000,
          updatedAt: 1780000000000,
        }}
      />
    )

    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('目标继续执行中')
    expect(screen.getByTestId('pause-goal-button')).toBeInTheDocument()
  })

  test('offers the resume action for a blocked goal', async () => {
    const onResumeGoal = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goal={{
          threadId: 'thread-1',
          objective: 'Resolve the issue',
          status: 'blocked',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1780000000000,
          updatedAt: 1780000000000,
        }}
        onResumeGoal={onResumeGoal}
      />
    )

    await userEvent.click(screen.getByTestId('resume-goal-button'))

    expect(onResumeGoal).toHaveBeenCalledTimes(1)
  })

  test.each(['usageLimited', 'budgetLimited'] as const)(
    'does not offer the pause action for a %s goal',
    status => {
      render(
        <ChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          goal={{
            threadId: 'thread-1',
            objective: 'Resolve the issue',
            status,
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1780000000000,
            updatedAt: 1780000000000,
          }}
        />
      )

      expect(screen.queryByTestId('pause-goal-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('resume-goal-button')).not.toBeInTheDocument()
    }
  )

  test('does not render the goal status bar after the goal is complete', () => {
    const goal: RuntimeGoal = {
      threadId: 'thread-1',
      objective: '已经达成的目标',
      status: 'complete',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 300,
      createdAt: 1780000000000,
      updatedAt: 1780000000000,
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goal={goal}
      />
    )

    expect(screen.queryByTestId('goal-status-bar')).not.toBeInTheDocument()
  })

  test('renders goal draft pill with a hover-only cancel affordance', () => {
    const onCancelGoalDraft = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        goalDraftActive
        onCancelGoalDraft={onCancelGoalDraft}
      />
    )

    const cancelButton = screen.getByTestId('cancel-goal-draft-button')
    const pill = screen.getByTestId('goal-draft-pill')
    expect(screen.getByPlaceholderText('KCoder Studio 应该往哪个方向努力?')).toBeInTheDocument()
    expect(pill).toHaveTextContent('目标')
    expect(pill).toHaveClass('h-7')
    expect(pill).toHaveClass('rounded-xl')
    expect(pill).toHaveClass('justify-center')
    expect(pill).toHaveClass('border')
    expect(pill).toHaveClass('bg-muted')
    expect(screen.getByTestId('goal-draft-pill-icon')).toHaveClass('h-4')
    expect(cancelButton).toHaveClass('opacity-0')
    expect(cancelButton).toHaveClass('absolute')
    expect(cancelButton).toHaveClass('left-2')
    expect(cancelButton).toHaveClass('group-hover:opacity-100')
    expect(cancelButton).toHaveClass('hover:bg-text-muted/30')

    fireEvent.click(cancelButton)

    expect(onCancelGoalDraft).toHaveBeenCalledTimes(1)
  })

  test('renders compact goal status bar actions', async () => {
    const goal: RuntimeGoal = {
      threadId: 'thread-1',
      objective: '实现新对话 goal',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1780000000000,
      updatedAt: 1780000000000,
    }
    const onEditGoal = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        goal={goal}
        onEditGoal={onEditGoal}
      />
    )

    expect(screen.getByTestId('goal-status-bar')).toHaveTextContent('实现新对话 goal')
    await userEvent.click(screen.getByTestId('edit-goal-button'))
    expect(onEditGoal).toHaveBeenCalledTimes(1)
  })

  test('opens project work menu and selects a project', async () => {
    const onSelectProjectWorkspace = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          runtimeWork: runtimeWork([
            { id: 7, name: 'Wegent', workspaceId: 70 },
            { id: 8, name: 'Docs', workspaceId: 80 },
          ]),
          currentProjectId: 7,
          selectedDeviceWorkspaceId: 70,
          onSelectProjectWorkspace,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('project-work-menu')).toBeInTheDocument()
    expect(screen.getAllByText('Wegent').length).toBeGreaterThan(0)
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')

    await userEvent.click(screen.getByTestId('project-option-8'))

    expect(onSelectProjectWorkspace).toHaveBeenCalledWith(8, 80)
  })

  test('shows no-project transition from the standalone entry', async () => {
    const onSelectStandaloneDevice = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [
            {
              id: 7,
              name: 'Wegent',
              tasks: [],
              config: {
                mode: 'workspace',
                execution: {
                  targetType: 'local',
                  deviceId: 'device-1',
                },
                workspace: {
                  source: 'local_path',
                  localPath: '/workspace/wegent',
                },
              },
            },
          ],
          currentProjectId: 7,
          onSelectStandaloneDevice,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('no-project-option'))

    expect(onSelectStandaloneDevice).toHaveBeenCalledWith(null)
  })

  test('shows no-project option before selecting a concrete project', async () => {
    const onSelectStandaloneDevice = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          currentProjectId: undefined,
          onSelectStandaloneDevice,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')

    await userEvent.click(screen.getByTestId('no-project-option'))

    expect(onSelectStandaloneDevice).toHaveBeenCalledWith(null)
  })

  test('hides standalone devices and selects the local device for no-project mode', async () => {
    const onSelectStandaloneDevice = vi.fn()
    const devices: DeviceInfo[] = [
      {
        id: 1,
        device_id: 'local-online',
        name: 'Local Online',
        status: 'online',
        is_default: false,
        device_type: 'local',
        executor_version: '1.8.5',
      },
      {
        id: 2,
        device_id: 'cloud-online',
        name: 'Cloud Online',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        executor_version: '1.8.5',
      },
      {
        id: 3,
        device_id: 'local-offline',
        name: 'Local Offline',
        status: 'offline',
        is_default: false,
        device_type: 'local',
        executor_version: '1.8.5',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          devices,
          currentProjectId: 7,
          onSelectStandaloneDevice,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.queryByTestId('standalone-device-list')).not.toBeInTheDocument()
    expect(screen.queryByTestId('standalone-device-option-cloud-online')).not.toBeInTheDocument()
    expect(screen.queryByTestId('standalone-device-option-local-online')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('no-project-option'))
    expect(onSelectStandaloneDevice).toHaveBeenCalledWith('local-online')
  })

  test('marks the current project instead of a remembered standalone device', async () => {
    const devices: DeviceInfo[] = [
      {
        id: 1,
        device_id: 'cloud-online',
        name: 'Cloud Online',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          runtimeWork: runtimeWork([{ id: 7, name: 'hello', workspaceId: 70 }]),
          devices,
          currentProjectId: 7,
          selectedDeviceWorkspaceId: 70,
          currentStandaloneDeviceId: 'cloud-online',
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('project-selected-icon-7')).toBeInTheDocument()
    expect(
      screen.queryByTestId('standalone-device-selected-icon-cloud-online')
    ).not.toBeInTheDocument()
  })

  test('keeps standalone device details out of the trigger when no project is selected', async () => {
    const devices: DeviceInfo[] = [
      {
        id: 1,
        device_id: 'local-online',
        name: 'Local Online',
        status: 'online',
        is_default: false,
        device_type: 'local',
      },
      {
        id: 2,
        device_id: 'cloud-online',
        name: 'Cloud Online',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'hello', tasks: [] }],
          devices,
          currentProjectId: undefined,
          currentStandaloneDeviceId: 'local-online',
        })}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('请选择项目')
    expect(screen.getByTestId('project-work-button')).not.toHaveTextContent('Local Online')

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.queryByTestId('standalone-device-list')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('standalone-device-selected-icon-local-online')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('standalone-device-selected-icon-cloud-online')
    ).not.toBeInTheDocument()
  })

  test('uses the project work action as the standalone trigger accessible name', () => {
    const devices: DeviceInfo[] = [
      {
        id: 1,
        device_id: 'local-online',
        name: 'Local Online',
        status: 'online',
        is_default: false,
        device_type: 'local',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'hello', tasks: [] }],
          devices,
          currentProjectId: undefined,
          currentStandaloneDeviceId: 'local-online',
        })}
      />
    )

    const trigger = screen.getByTestId('project-work-button')

    expect(trigger).toHaveTextContent('请选择项目')
    expect(trigger).not.toHaveTextContent('Local Online')
    expect(trigger).toHaveAccessibleName('请选择项目')
  })

  test('does not include enter-project work as a menu item', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          currentProjectId: undefined,
        })}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('请选择项目')

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')
    expect(screen.getByTestId('project-work-menu')).not.toHaveTextContent('进入项目工作')
  })
})
