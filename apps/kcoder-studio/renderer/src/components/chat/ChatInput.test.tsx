import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { getKeyboardPlatform } from '@/lib/keyboard-platform'
import type {
  Attachment,
  DeviceInfo,
  RuntimeGoal,
  RuntimeWorkListResponse,
  UnifiedModel,
} from '@/types/api'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'

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

import { ChatInput } from './ChatInput'
import type { ChatSubmitOptions } from './ChatInput'
import type { ProjectChatControls, ProjectWorkControls } from './ChatInput'

function ControlledChatInput({
  onSubmit = vi.fn(),
  projectChat,
  variant,
  onSetGoal,
}: {
  onSubmit?: (valueOverride?: string, options?: ChatSubmitOptions) => void
  projectChat?: ProjectChatControls
  variant?: 'compact' | 'desktop'
  onSetGoal?: (mode?: RuntimeGoal['mode']) => void
}) {
  const [value, setValue] = useState('')

  return (
    <ChatInput
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      disabled={false}
      variant={variant}
      projectChat={projectChat}
      onSetGoal={onSetGoal}
    />
  )
}

test.each(['desktop', 'compact'] as const)(
  'execution modes retain arguments and consume only an accepted draft (%s)',
  async variant => {
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} onSetGoal={vi.fn()} variant={variant} />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = '/moa-plan Build a plan'
      editor.focus()
    })
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
    await waitFor(() =>
      expect(screen.getByTestId('execution-mode-draft')).toHaveTextContent('/moa-plan')
    )
    expect(editor.value).toBe('Build a plan')
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Build a plan',
        expect.objectContaining({ turnMode: 'moa-plan', guideWhenBusy: false })
      )
    )
    expect(screen.getByTestId('execution-mode-draft')).toBeInTheDocument()
    act(() => onSubmit.mock.calls[0][1].onExecutionModeAccepted())
    expect(screen.queryByTestId('execution-mode-draft')).not.toBeInTheDocument()
  }
)

test('execution mode drafts do not cross project scopes or consume a newer selection', async () => {
  const onSubmit = vi.fn()
  const controls = projectChatControls({ scopeKey: 'project-one' })
  const view = render(
    <ControlledChatInput onSubmit={onSubmit} onSetGoal={vi.fn()} projectChat={controls} />
  )
  let editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
  act(() => {
    editor.value = '/moa first'
    editor.focus()
  })
  fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
  fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
  await waitFor(() => expect(onSubmit).toHaveBeenCalled())
  view.rerender(
    <ControlledChatInput
      onSubmit={onSubmit}
      onSetGoal={vi.fn()}
      projectChat={projectChatControls({ scopeKey: 'project-two' })}
    />
  )
  expect(screen.queryByTestId('execution-mode-draft')).not.toBeInTheDocument()
  editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
  act(() => {
    editor.value = '/moa-plan second'
    editor.focus()
  })
  fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
  await waitFor(() =>
    expect(screen.getByTestId('execution-mode-draft')).toHaveTextContent('/moa-plan')
  )
  act(() => onSubmit.mock.calls[0][1].onExecutionModeAccepted())
  expect(screen.getByTestId('execution-mode-draft')).toHaveTextContent('/moa-plan')
})

describe.each(['desktop', 'compact'] as const)('mode footer layout (%s)', variant => {
  // This checks model-independent composer ordering and draft cancellation.
  test.each(['/orchestrate', '/moa', '/moa-plan'])(
    '%s stays inside the bottom toolbar beside quick phrases and can be cancelled',
    async command => {
      render(<ControlledChatInput onSetGoal={vi.fn()} variant={variant} />)
      const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
      act(() => {
        editor.value = command
        editor.focus()
      })
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
      const footer = await screen.findByTestId('execution-mode-footer')
      const composer =
        variant === 'desktop'
          ? screen.getByTestId('project-chat-composer')
          : editor.closest('form')!
      const toolbar = screen.getByTestId(
        variant === 'desktop' ? 'composer-toolbar' : 'compact-composer-toolbar'
      )
      expect(composer.contains(footer)).toBe(true)
      expect(toolbar.contains(footer)).toBe(true)
      expect(toolbar.contains(screen.getByTestId('quick-phrase-button'))).toBe(true)
      expect(footer).not.toHaveClass('absolute', 'fixed')
      await userEvent.click(within(footer).getByTestId('cancel-mode-pill-button'))
      expect(screen.queryByTestId('execution-mode-footer')).not.toBeInTheDocument()
    }
  )

  test('restored orchestrate session uses the same footer without a draft cancel action', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant={variant}
        sessionMode="orchestrate"
      />
    )
    const footer = screen.getByTestId('execution-mode-footer')
    const toolbar = screen.getByTestId(
      variant === 'desktop' ? 'composer-toolbar' : 'compact-composer-toolbar'
    )
    expect(toolbar.contains(footer)).toBe(true)
    expect(footer).toHaveTextContent('/orchestrate')
    expect(within(footer).queryByTestId('cancel-mode-pill-button')).not.toBeInTheDocument()
  })
})

test.each(['standard', 'strict', 'plan'] as const)(
  'compact %s mode is inside the input toolbar',
  mode => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="compact"
        goalDraftActive={mode !== 'plan'}
        goalDraftMode={mode === 'strict' ? 'strict' : 'standard'}
        projectChat={projectChatControls({ selectedModelOptions: { collaborationMode: 'plan' } })}
      />
    )
    const form = screen.getByTestId('chat-message-input').closest('form')!
    const pill = screen.getByTestId(mode === 'plan' ? 'plan-mode-pill' : 'goal-draft-pill')
    expect(form.contains(pill)).toBe(true)
    expect(screen.getByTestId('compact-composer-toolbar').contains(pill)).toBe(true)
  }
)

function projectChatControls(overrides: Partial<ProjectChatControls> = {}): ProjectChatControls {
  return {
    models: [],
    skills: [],
    selectedModel: null,
    selectedModelOptions: {},
    selectedSkills: [],
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
    isOptionsLocked: false,
    setSelectedModel: vi.fn(),
    setSelectedModelOption: vi.fn(),
    toggleSkill: vi.fn(),
    handleFileSelect: vi.fn().mockResolvedValue(undefined),
    removeAttachment: vi.fn().mockResolvedValue(undefined),
    listLocalSkills: vi.fn().mockResolvedValue([]),
    listLocalApps: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

const REMOTE_WORKSPACE_TARGET = {
  deviceId: 'remote-device',
  path: '/workspace/project',
  source: 'project',
  workspaceSource: 'remote',
} as const

function projectWorkControls(overrides: Partial<ProjectWorkControls> = {}): ProjectWorkControls {
  const devices =
    overrides.devices?.map(device => ({
      ...device,
      bind_shell: device.bind_shell ?? 'claudecode',
      executor_version:
        device.bind_shell === 'openclaw'
          ? device.executor_version
          : (device.executor_version ?? '1.8.5'),
    })) ?? []
  const currentProject =
    overrides.currentProject ??
    overrides.projects?.find(project => project.id === overrides.currentProjectId) ??
    null

  return {
    projects: [],
    devices,
    currentProject,
    currentProjectId: undefined,
    currentStandaloneDeviceId: null,
    onSelectProject: vi.fn(),
    onSelectStandaloneDevice: vi.fn(),
    ...overrides,
    devices,
  }
}

function runtimeWork(
  items: Array<{
    id: number
    name: string
    workspaceId?: number | null
    deviceId?: string
    deviceName?: string
    deviceStatus?: DeviceInfo['status']
    available?: boolean
    workspacePath?: string
  }>
): RuntimeWorkListResponse {
  return {
    projects: items.map(item => ({
      project: { id: item.id, name: item.name },
      deviceWorkspaces: [
        {
          id: item.workspaceId ?? item.id * 10,
          projectId: item.id,
          deviceId: item.deviceId ?? 'device-online',
          deviceName: item.deviceName ?? 'Online Device',
          deviceStatus: item.deviceStatus ?? 'online',
          available: item.available ?? true,
          workspacePath: item.workspacePath ?? `/workspace/${item.name}`,
          mapped: true,
          tasks: [],
        },
      ],
    })),
    chats: [],
    totalTasks: 0,
  }
}

describe('ChatInput', () => {
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

  test('keeps the desktop editor focused while submission is temporarily disabled', async () => {
    const props = {
      value: 'next draft',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      disabled: false,
      variant: 'desktop' as const,
    }
    const { rerender } = render(<ChatInput {...props} submitDisabled={false} />)
    const editor = screen.getByTestId('chat-message-input')

    editor.focus()
    await waitFor(() => expect(editor).toHaveFocus())

    rerender(<ChatInput {...props} submitDisabled />)

    expect(editor).toHaveAttribute('contenteditable', 'true')
    expect(editor).toHaveFocus()
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
  })

  test('does not move selection when an unfocused composer syncs its value', async () => {
    const renderComposers = (backgroundValue?: string) => (
      <>
        <ChatInput
          value="foreground draft"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
        />
        {backgroundValue !== undefined ? (
          <ChatInput
            value={backgroundValue}
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            disabled={false}
            variant="desktop"
          />
        ) : null}
      </>
    )
    const { rerender } = render(renderComposers())
    const foregroundComposer = screen.getByTestId('chat-message-input')
    foregroundComposer.focus()
    await waitFor(() => {
      expect(foregroundComposer).toHaveFocus()
      expect(foregroundComposer.contains(window.getSelection()?.anchorNode ?? null)).toBe(true)
    })

    const textNode = document.createTreeWalker(foregroundComposer, NodeFilter.SHOW_TEXT).nextNode()
    expect(textNode).not.toBeNull()
    const range = document.createRange()
    range.setStart(textNode!, 5)
    range.collapse(true)
    const selection = window.getSelection()!
    act(() => {
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })

    expect(foregroundComposer).toHaveFocus()
    expect(foregroundComposer.contains(window.getSelection()?.anchorNode ?? null)).toBe(true)
    expect(window.getSelection()?.anchorOffset).toBe(5)

    rerender(renderComposers('background initial value'))

    await waitFor(() => {
      expect(foregroundComposer).toHaveFocus()
      expect(foregroundComposer.contains(window.getSelection()?.anchorNode ?? null)).toBe(true)
      expect(window.getSelection()?.anchorOffset).toBe(5)
    })

    rerender(renderComposers('background update'))

    await waitFor(() => {
      expect(foregroundComposer).toHaveFocus()
      expect(foregroundComposer.contains(window.getSelection()?.anchorNode ?? null)).toBe(true)
      expect(window.getSelection()?.anchorOffset).toBe(5)
    })
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

  test('offers interrupt-and-send while the assistant is streaming', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value="立即改方向"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        isStreaming
      />
    )

    const menuButton = screen.getByTestId('send-mode-menu-button')
    expect(menuButton).toHaveAttribute('title', '选择发送方式')
    expect(menuButton.querySelector('.lucide-chevron-down')).toBeInTheDocument()

    await userEvent.click(menuButton)
    expect(
      screen.getByTestId('send-after-turn-option').querySelector('.lucide-clock-3')
    ).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('interrupt-and-send-option'))

    expect(onSubmit).toHaveBeenCalledWith('立即改方向', { interruptWhenBusy: true })
  })

  test('distinguishes the active model from the next-turn model while streaming', async () => {
    const activeModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
    }
    const selectedModel: UnifiedModel = {
      name: 'local-model:second',
      type: 'runtime',
      displayName: 'Second Model',
      isActive: true,
    }

    const projectChat = projectChatControls({
      models: [activeModel, selectedModel],
      activeModel,
      selectedModel,
    })
    const { rerender } = render(
      <ChatInput
        value="换模型继续"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        isStreaming
        projectChat={projectChat}
      />
    )

    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Next · Second Model')
    await userEvent.click(screen.getByTestId('send-mode-menu-button'))
    expect(screen.getByTestId('guide-current-turn-option')).toHaveTextContent(
      'Guide current response · First Model'
    )
    expect(screen.getByTestId('interrupt-and-send-option')).toHaveTextContent(
      'Interrupt and use Second Model'
    )

    rerender(
      <ChatInput
        value="换模型继续"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        isStreaming={false}
        projectChat={projectChat}
      />
    )
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Second Model')
    expect(screen.getByTestId('model-selector-button')).not.toHaveTextContent('Next')
  })

  test('warns before switching away from the model that owns the conversation context', async () => {
    const activeModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const targetModel: UnifiedModel = {
      name: 'local-model:second',
      type: 'runtime',
      displayName: 'Second Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const setSelectedModel = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [activeModel, targetModel],
          activeModel,
          selectedModel: activeModel,
          setSelectedModel,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    await userEvent.click(screen.getByTestId('model-option-local-model:second'))

    expect(screen.getByTestId('model-switch-warning-dialog')).toHaveTextContent(
      'Switching to Second Model may change how the existing context is understood.'
    )
    expect(setSelectedModel).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('model-switch-warning-cancel-button'))

    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
    expect(setSelectedModel).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    await userEvent.click(screen.getByTestId('model-option-local-model:second'))
    await userEvent.click(screen.getByTestId('model-switch-warning-confirm-button'))

    expect(setSelectedModel).toHaveBeenCalledWith(targetModel)
    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
  })

  test('does not warn when selecting a model before a conversation has an active model', async () => {
    const targetModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const setSelectedModel = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [targetModel],
          selectedModel: null,
          setSelectedModel,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    await userEvent.click(screen.getByTestId('model-option-local-model:first'))

    expect(setSelectedModel).toHaveBeenCalledWith(targetModel)
    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
  })

  test('does not warn when reselecting the model already chosen for the next turn', async () => {
    const activeModel: UnifiedModel = {
      name: 'local-model:first',
      type: 'runtime',
      displayName: 'First Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const selectedModel: UnifiedModel = {
      name: 'local-model:second',
      type: 'runtime',
      displayName: 'Second Model',
      isActive: true,
      config: { ui: { family: 'local' } },
    }
    const setSelectedModel = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [activeModel, selectedModel],
          activeModel,
          selectedModel,
          setSelectedModel,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    await userEvent.click(screen.getByTestId('model-option-local-model:second'))

    expect(setSelectedModel).toHaveBeenCalledWith(selectedModel)
    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
  })

  test('renders queued messages and guidance controls above the composer', async () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-1',
        content: '继续检查 capability sync',
        status: 'queued',
        createdAt: '2026-05-25T15:08:00.000+08:00',
      },
    ]
    const guidanceMessages: GuidanceWorkbenchMessage[] = [
      {
        id: 'guidance-1',
        content: '先跳过 device:sync_capabilities',
        status: 'queued',
        createdAt: '2026-05-25T15:09:00.000+08:00',
      },
    ]
    const onSendQueuedAsGuidance = vi.fn()
    const onInterruptAndSendQueuedMessage = vi.fn()
    const onCancelQueuedMessage = vi.fn()
    const onEditQueuedMessage = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={guidanceMessages}
        onSendQueuedAsGuidance={onSendQueuedAsGuidance}
        onInterruptAndSendQueuedMessage={onInterruptAndSendQueuedMessage}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onEditQueuedMessage={onEditQueuedMessage}
      />
    )

    expect(screen.getByTestId('conversation-queue-panel')).toBeInTheDocument()
    expect(screen.getByText('继续检查 capability sync')).toBeInTheDocument()
    expect(screen.getByText('先跳过 device:sync_capabilities')).toBeInTheDocument()
    expect(
      screen.getAllByTestId(/^conversation-queue-row-/).map(row => row.getAttribute('data-testid'))
    ).toEqual(['conversation-queue-row-guidance-1', 'conversation-queue-row-queued-1'])

    await userEvent.click(screen.getByTestId('queue-guidance-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-interrupt-button-guidance-1'))
    await userEvent.click(screen.getByTestId('queue-interrupt-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-more-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-edit-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-cancel-button-queued-1'))

    expect(onSendQueuedAsGuidance).toHaveBeenCalledWith('queued-1')
    expect(onInterruptAndSendQueuedMessage).toHaveBeenNthCalledWith(1, 'guidance-1')
    expect(onInterruptAndSendQueuedMessage).toHaveBeenNthCalledWith(2, 'queued-1')
    expect(onEditQueuedMessage).toHaveBeenCalledWith('queued-1')
    expect(onCancelQueuedMessage).toHaveBeenCalledWith('queued-1')
  })

  test('restores queued message text into the composer when editing', async () => {
    function Harness() {
      const [value, setValue] = useState('')
      const [queuedMessages, setQueuedMessages] = useState<QueuedWorkbenchMessage[]>([
        {
          id: 'queued-1',
          content: '先检查引导条里的文本',
          status: 'queued',
          createdAt: '2026-05-25T15:08:00.000+08:00',
        },
      ])

      return (
        <ChatInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          queuedMessages={queuedMessages}
          onEditQueuedMessage={id => {
            const message = queuedMessages.find(item => item.id === id)
            if (!message) return
            setValue(message.content)
            setQueuedMessages(current => current.filter(item => item.id !== id))
          }}
        />
      )
    }

    render(<Harness />)

    await userEvent.click(screen.getByTestId('queue-more-button-queued-1'))
    await userEvent.click(screen.getByTestId('queue-edit-button-queued-1'))

    await waitFor(() =>
      expect(screen.getByTestId('chat-message-input')).toHaveTextContent('先检查引导条里的文本')
    )
  })

  test('shows lightweight interrupt action while guidance is sending', async () => {
    const onInterruptAndSendQueuedMessage = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'sending-guidance',
            content: '请停止等待并检查目录',
            status: 'sending',
            notice: '正在引导当前对话',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        onInterruptAndSendQueuedMessage={onInterruptAndSendQueuedMessage}
      />
    )

    const interruptButton = screen.getByTestId('queue-interrupt-button-sending-guidance')
    expect(screen.getByText('引导中')).toBeInTheDocument()
    expect(interruptButton).toHaveTextContent('workbench.interrupt_and_send_short')
    expect(interruptButton).toHaveClass('text-text-secondary', 'hover:bg-muted')
    expect(interruptButton).not.toHaveClass('border', 'bg-base', 'shadow-sm')
    expect(screen.queryByTestId('queue-guidance-button-sending-guidance')).not.toBeInTheDocument()
    expect(screen.queryByTestId('queue-cancel-button-sending-guidance')).not.toBeInTheDocument()
    expect(screen.queryByTestId('queue-more-button-sending-guidance')).not.toBeInTheDocument()

    await userEvent.click(interruptButton)

    expect(onInterruptAndSendQueuedMessage).toHaveBeenCalledWith('sending-guidance')
  })

  test('provides left-side drag handles to reorder multiple queued messages', () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-first',
        content: '先执行检查',
        status: 'queued',
        createdAt: '2026-05-25T15:08:00.000+08:00',
      },
      {
        id: 'queued-second',
        content: '再执行修复',
        status: 'queued',
        createdAt: '2026-05-25T15:09:00.000+08:00',
      },
    ]
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={[]}
      />
    )

    expect(screen.getByTestId('queue-drag-handle-queued-first')).toHaveAttribute(
      'aria-label',
      '拖拽调整消息顺序'
    )
    expect(screen.getByTestId('queue-drag-handle-queued-second')).toHaveAttribute(
      'aria-label',
      '拖拽调整消息顺序'
    )
  })

  test('shows active queued guidance before messages waiting to send', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'queued-waiting',
            content: '看磁盘',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
          {
            id: 'queued-guidance',
            content: '看 cpu',
            status: 'sending',
            notice: '正在引导当前对话',
            createdAt: '2026-05-25T15:09:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
      />
    )

    expect(
      screen.getAllByTestId(/^conversation-queue-row-/).map(row => row.getAttribute('data-testid'))
    ).toEqual(['conversation-queue-row-queued-guidance', 'conversation-queue-row-queued-waiting'])
  })

  test('shows a control to resume a paused queue', async () => {
    const onResumeQueue = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'queued-paused',
            content: '等待发送',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
        queuePaused
        onResumeQueue={onResumeQueue}
      />
    )

    await userEvent.click(screen.getByTestId('resume-queue-button'))

    expect(onResumeQueue).toHaveBeenCalledTimes(1)
  })

  test('asks whether to preserve a paused queue before sending a new message', async () => {
    const onSubmit = vi.fn()
    const onResumeQueue = vi.fn()
    const onChange = vi.fn()
    const onResumeQueueWithInput = vi.fn()

    render(
      <ChatInput
        value="发送新消息"
        onChange={onChange}
        onSubmit={onSubmit}
        disabled={false}
        queuedMessages={[
          {
            id: 'queued-paused-send',
            content: '等待发送',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
        queuePaused
        onResumeQueue={onResumeQueue}
        onResumeQueueWithInput={onResumeQueueWithInput}
      />
    )

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(screen.getByTestId('paused-queue-send-dialog')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('paused-queue-send-preserve-button'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onResumeQueueWithInput).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith('')
  })

  test('hides drag handles when fewer than two messages are queued', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={[
          {
            id: 'queued-only',
            content: '执行检查',
            status: 'queued',
            createdAt: '2026-05-25T15:08:00.000+08:00',
          },
        ]}
        guidanceMessages={[]}
      />
    )

    expect(screen.queryByTestId('queue-drag-handle-queued-only')).not.toBeInTheDocument()
  })

  test('keeps queued rows compact without generic queue notices', () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-notice',
        content: '执行pwd',
        status: 'queued',
        createdAt: '2026-05-25T15:08:00.000+08:00',
        notice: '已排队，当前回复结束后发送',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={[]}
      />
    )

    expect(screen.getByText('执行pwd')).toBeInTheDocument()
    expect(screen.queryByText('已排队，当前回复结束后发送')).not.toBeInTheDocument()
  })

  test('shows sending notices for queued rows that are actively being sent', () => {
    const queuedMessages: QueuedWorkbenchMessage[] = [
      {
        id: 'queued-sending',
        content: '执行ls',
        status: 'sending',
        createdAt: '2026-05-25T15:08:00.000+08:00',
        notice: '正在发送',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        queuedMessages={queuedMessages}
        guidanceMessages={[]}
      />
    )

    expect(screen.getByText('执行ls')).toBeInTheDocument()
    expect(screen.getByText('正在发送')).toBeInTheDocument()
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

  test('opens a mobile context sheet that uploads files without type restrictions', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const script = new File(['#!/bin/sh'], 'init_env.sh', {
      type: 'application/x-sh',
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('mobile-context-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-take-photo-button')).toHaveTextContent('拍照')
    expect(screen.getByTestId('mobile-upload-image-button')).toHaveTextContent('上传文件')
    expect(screen.queryByText('添加照片和文件')).not.toBeInTheDocument()
    expect(screen.getByTestId('mobile-camera-file-input')).toHaveAttribute('accept', 'image/*')
    expect(screen.getByTestId('mobile-camera-file-input')).toHaveAttribute('capture', 'environment')
    expect(screen.getByTestId('mobile-image-file-input')).not.toHaveAttribute('accept')

    await userEvent.upload(screen.getByTestId('mobile-image-file-input'), script)

    expect(handleFileSelect).toHaveBeenCalledWith([script])
    expect(screen.queryByTestId('mobile-context-sheet')).not.toBeInTheDocument()
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

  test('desktop file picker does not restrict attachment file types', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('attachment-file-input')).not.toHaveAttribute('accept')
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

  test('does not expose compact slash when the current chat cannot compact context', async () => {
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} variant="desktop" />)

    await userEvent.click(screen.getByTestId('chat-message-input'))
    await userEvent.keyboard('/comp')

    expect(screen.queryByTestId('slash-command-option-compact')).not.toBeInTheDocument()
    expect(screen.queryByText('/compact')).not.toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('applies slash safety at the shared submit boundary for send-button clicks', async () => {
    const onSubmit = vi.fn()
    const onSetGoal = vi.fn()
    const setSelectedModelOption = vi.fn()
    const requestModelSelectorOpen = vi.fn()
    render(
      <ControlledChatInput
        onSubmit={onSubmit}
        onSetGoal={onSetGoal}
        variant="desktop"
        projectChat={projectChatControls({
          requestModelSelectorOpen,
          setSelectedModelOption,
        })}
      />
    )

    const editor = screen.getByTestId('chat-message-input')
    await userEvent.click(editor)
    await userEvent.keyboard('/')
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('chat-input-error')).toHaveTextContent('请输入 slash 指令名称')

    await userEvent.clear(editor)
    await userEvent.type(editor, '/unknown')
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('chat-input-error')).toHaveTextContent('/unknown')

    await userEvent.clear(editor)
    await userEvent.type(editor, '/goal 修复并验证')
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSetGoal).toHaveBeenCalledWith('standard')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(editor).toHaveTextContent('修复并验证')

    await userEvent.clear(editor)
    await userEvent.type(editor, '/goal-pro')
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSetGoal).toHaveBeenLastCalledWith('strict')

    await userEvent.type(editor, '/plan')
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'plan')

    await userEvent.type(editor, '/model')
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(requestModelSelectorOpen).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('uploads pasted images from the desktop message textbox', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const image = new File(['image'], 'clipboard.png', { type: 'image/png' })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [image],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([image]))
  })

  test('uploads pasted documents for a remote desktop workspace', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const documentFile = new File(['document'], 'requirements.pdf', {
      type: 'application/pdf',
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
        workspaceTarget={REMOTE_WORKSPACE_TARGET}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [documentFile],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([documentFile]))
  })

  test('turns long pasted text from the desktop message textbox into a text attachment', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const onChange = vi.fn()
    const longText = 'long pasted text\n'.repeat(400)

    render(
      <ChatInput
        value=""
        onChange={onChange}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.paste(screen.getByTestId('chat-message-input'), {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? longText : ''),
      },
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(handleFileSelect).toHaveBeenCalledTimes(1)
    const files = handleFileSelect.mock.calls[0][0] as File[]
    expect(files).toHaveLength(1)
    expect(files[0].name).toMatch(/^clipboard-text-\d+\.txt$/)
    expect(files[0].type).toBe('text/plain')
    expect(await files[0].text()).toBe(longText)
  })

  test('uploads dropped images from the desktop composer', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const imageFile = new File(['image'], 'drop-preview.png', {
      type: 'image/png',
    })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    fireEvent.drop(screen.getByTestId('chat-message-input'), {
      dataTransfer: {
        types: ['Files'],
        files: [imageFile],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([imageFile]))
  })

  test('highlights the desktop composer while files are dragged over it', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
      />
    )

    const composer = screen.getByTestId('project-chat-composer-form')
    const dataTransfer = { types: ['Files'], dropEffect: 'none' }

    fireEvent.dragEnter(composer, { dataTransfer })

    expect(composer).toHaveClass('border-focus', 'ring-2', 'ring-focus/20')
    expect(dataTransfer.dropEffect).toBe('copy')

    fireEvent.dragLeave(composer, { dataTransfer, relatedTarget: document.body })

    expect(composer).toHaveClass('border-border/45')
  })

  test('uploads pasted images from the fullscreen compact textbox', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const image = new File(['image'], 'fullscreen-clipboard.png', { type: 'image/png' })

    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [image],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([image]))
  })

  test('uploads pasted documents from a remote fullscreen compact textbox', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const documentFile = new File(['document'], 'fullscreen-requirements.pdf', {
      type: 'application/pdf',
    })

    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
        workspaceTarget={REMOTE_WORKSPACE_TARGET}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [documentFile],
      },
    })

    await waitFor(() => expect(handleFileSelect).toHaveBeenCalledWith([documentFile]))
  })

  test('turns long pasted text from the fullscreen compact textbox into a text attachment', async () => {
    const handleFileSelect = vi.fn().mockResolvedValue(undefined)
    const onChange = vi.fn()
    const longText = 'fullscreen pasted text\n'.repeat(400)

    render(
      <ChatInput
        value={'line 1\nline 2\nline 3\nline 4\nline 5'}
        onChange={onChange}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({ handleFileSelect })}
      />
    )

    await userEvent.click(screen.getByTestId('expand-input-button'))
    fireEvent.paste(screen.getByTestId('fullscreen-message-input'), {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? longText : ''),
      },
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(handleFileSelect).toHaveBeenCalledTimes(1)
    const files = handleFileSelect.mock.calls[0][0] as File[]
    expect(files).toHaveLength(1)
    expect(files[0].name).toMatch(/^clipboard-text-\d+\.txt$/)
    expect(files[0].type).toBe('text/plain')
    expect(await files[0].text()).toBe(longText)
  })

  test('enables compact send when only image attachments are present', async () => {
    const onSubmit = vi.fn()
    const attachment: Attachment = {
      id: 45,
      filename: 'photo.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toBeInTheDocument()
    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('blocks compact send while an attachment upload has failed', async () => {
    const onSubmit = vi.fn()

    render(
      <ChatInput
        value="请检查这张图片"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        projectChat={projectChatControls({
          errors: new Map([['photo.png', 'KCoder 网关附件不能超过 256 KiB']]),
        })}
      />
    )

    expect(screen.getByTestId('attachment-error-badge')).toHaveTextContent('photo.png')
    expect(screen.getByTestId('attachment-error-badge')).toHaveAttribute(
      'title',
      'photo.png: KCoder 网关附件不能超过 256 KiB'
    )
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('renders an upload placeholder with a cancel button', async () => {
    const cancelUpload = vi.fn()
    const file = new File(['image'], 'photo.png', { type: 'image/png' })

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={projectChatControls({
          uploadingFiles: new Map([['photo.png', { file, progress: 42 }]]),
          cancelUpload,
        })}
      />
    )

    expect(screen.getByTestId('uploading-attachment-badge')).toHaveAttribute(
      'aria-label',
      'photo.png 上传中 42%'
    )
    expect(screen.getByTestId('uploading-attachment-badge')).toHaveTextContent('42%')
    await userEvent.click(screen.getByTestId('cancel-upload-button'))
    expect(cancelUpload).toHaveBeenCalledWith('photo.png')
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

  test('opens the desktop model menu with real model options', async () => {
    const model: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
          controls: ['speed'],
        },
      },
    }
    const cloudModel: UnifiedModel = {
      ...model,
      name: 'cloud-gpt-5.5',
      displayName: '云端:gpt-5.5',
    }
    const setSelectedModel = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model, cloudModel],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high', speed: 'standard' },
          setSelectedModel,
        })}
      />
    )

    const selectorButton = screen.getByTestId('model-selector-button')
    expect(selectorButton).toHaveClass(
      'transition-[width,background-color,color,opacity]',
      'duration-200'
    )
    expect(screen.getByTestId('model-selector-tooltip')).toHaveTextContent('选择模型')
    expect(screen.getByTestId('model-selector-tooltip')).toHaveTextContent(
      getKeyboardPlatform() === 'mac' ? '⌃⇧M' : 'CtrlShiftM'
    )
    expect(screen.getByTestId('model-selector-tooltip')).toHaveClass('h-9')
    expect(screen.getByTestId('model-selector-tooltip')).toHaveClass(
      'group-hover/model-selector:opacity-100',
      'group-hover/model-selector:delay-[1500ms]'
    )
    expect(screen.getByTestId('model-selector-tooltip')).not.toHaveClass(
      'group-focus-within/model-selector:delay-0'
    )

    await userEvent.click(selectorButton)

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu')).toHaveAttribute(
      'data-enter-animation',
      'main'
    )
    expect(selectorButton).toHaveStyle({ width: 'var(--model-selector-width, auto)' })
    expect(screen.queryByTestId('model-selector-tooltip')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu').parentElement).toHaveClass(
      'fixed',
      'z-system-popover',
      'w-64'
    )
    expect(screen.getByTestId('model-selector-menu').parentElement?.parentElement).toBe(
      document.body
    )
    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-control-menu-model')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-menu-reasoning')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-menu-speed')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-reset-default-button')).toBeEnabled()
    expect(screen.queryByTestId('model-advanced-intelligence-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-reasoning-slider')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-reasoning-high')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-plan')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-speed-fast')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-option-default')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Overseas:gpt-5.5')
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-selector-submenu')).toHaveAttribute(
      'data-enter-animation',
      'submenu'
    )
    expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({ left: '256px' })
    const modelOption = screen.getByTestId('model-option-overseas-gpt-5.5')
    expect(modelOption).toHaveTextContent('Overseas:gpt-5.5')
    expect(modelOption.querySelectorAll('span')).toHaveLength(2)
    expect(screen.getByTestId('model-option-cloud-gpt-5.5')).toHaveAccessibleName(/云端/)

    await userEvent.click(screen.getByTestId('model-option-overseas-gpt-5.5'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('shows an empty state when no desktop models are available', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ models: [], selectedModel: null })}
      />
    )

    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Default')
    await userEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-selector-submenu')).toHaveTextContent('No models available')
  })

  test('closes the desktop model menu only from its trigger, outside click, or Escape', async () => {
    const model: UnifiedModel = {
      name: 'codex-gpt-5.5',
      type: 'user',
      displayName: 'Codex:gpt-5.5',
      config: { ui: { family: 'gpt', modelLabel: 'gpt-5.5', sortOrder: 10 } },
    }
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ models: [model], selectedModel: model })}
      />
    )

    const trigger = screen.getByTestId('model-selector-button')
    await userEvent.click(trigger)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    await userEvent.click(trigger)
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
  })

  test('suppresses the model tooltip after closing until the pointer re-enters', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls()}
      />
    )
    const trigger = screen.getByTestId('model-selector-button')

    await userEvent.click(trigger)
    await userEvent.click(trigger)

    expect(screen.queryByTestId('model-selector-tooltip')).not.toBeInTheDocument()

    await userEvent.unhover(trigger)
    await userEvent.hover(trigger)

    expect(screen.getByTestId('model-selector-tooltip')).toBeInTheDocument()
  })

  test('keeps the desktop model submenu open after the pointer leaves the menu', async () => {
    const model: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()

    fireEvent.mouseLeave(screen.getByTestId('model-selector-menu').parentElement as HTMLElement)

    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()
  })

  test('keeps the desktop model menu in narrow Tauri windows', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const model: UnifiedModel = {
      name: 'codex-gpt-5.5',
      type: 'user',
      displayName: '5.5',
      config: {
        ui: {
          family: 'gpt',
          modelLabel: '5.5',
          sortOrder: 10,
        },
      },
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-menu')).not.toHaveAttribute('data-mobile')
    expect(screen.getByTestId('model-selector-menu')).not.toHaveAttribute('aria-modal')
    expect(screen.queryByTestId('model-selector-submenu')).not.toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))
    expect(screen.getByTestId('model-selector-submenu')).toBeInTheDocument()
  })

  test('opens the desktop model menu when the external open signal changes', async () => {
    const model: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    const { rerender } = render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          modelSelectorOpenSignal: 0,
        })}
      />
    )

    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    rerender(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          modelSelectorOpenSignal: 1,
        })}
      />
    )

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('keeps the desktop model menu open after selecting a model opened by external signal', async () => {
    const model: UnifiedModel = {
      name: 'ali-qwen3-coder-plus',
      type: 'user',
      displayName: 'ali-qwen3-coder-plus',
      config: {
        ui: {
          family: 'qwen',
          region: 'domestic',
          modelLabel: 'ali-qwen3-coder-plus',
          sortOrder: 10,
        },
      },
    }
    const setSelectedModel = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: null,
          modelSelectorOpenSignal: 1,
          setSelectedModel,
        })}
      />
    )

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    await userEvent.click(screen.getByTestId('model-option-ali-qwen3-coder-plus'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
  })

  test('keeps the desktop model submenu inside the viewport near the bottom edge', async () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 1000,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function getMockRect(this: HTMLElement) {
        const testId = this.getAttribute('data-testid')
        if (testId === 'model-selector-menu') {
          return {
            top: 760,
            bottom: 900,
            left: 480,
            right: 736,
            width: 256,
            height: 140,
          } as DOMRect
        }
        if (testId === 'model-control-menu-model') {
          return {
            top: 780,
            bottom: 812,
            left: 492,
            right: 724,
            width: 232,
            height: 32,
          } as DOMRect
        }
        if (testId === 'model-selector-submenu') {
          return {
            top: 0,
            bottom: 192,
            left: 0,
            right: 288,
            width: 288,
            height: 192,
          } as DOMRect
        }
        return {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
        } as DOMRect
      }
    )

    const minimaxModel: UnifiedModel = {
      name: 'public-minimax-m2.7',
      type: 'user',
      displayName: '公网:minimax-m2.7',
      config: {
        ui: {
          family: 'minimax',
          region: 'public',
          modelLabel: 'minimax-m2.7',
          sortOrder: 10,
        },
      },
    }

    try {
      render(
        <ChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          projectChat={projectChatControls({
            models: [minimaxModel],
            selectedModel: minimaxModel,
            selectedModelOptions: {},
          })}
        />
      )

      await userEvent.click(screen.getByTestId('model-selector-button'))
      await userEvent.hover(screen.getByTestId('model-control-menu-model'))

      await waitFor(() => {
        expect(screen.getByTestId('model-selector-submenu')).toHaveStyle({
          top: '20px',
        })
      })
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      })
    }
  })

  test('shows incompatible model options as disabled', async () => {
    const selectedModel: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    const incompatibleModel: UnifiedModel = {
      name: 'overseas-gpt-5.4',
      type: 'user',
      displayName: '海外:gpt-5.4',
      compatibilityDisabled: true,
      compatibilityDisabledReason: 'runtime_family_mismatch',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.4',
          sortOrder: 20,
        },
      },
    }
    const setSelectedModel = vi.fn()
    const onBlockedModelSelect = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [selectedModel, incompatibleModel],
          selectedModel,
          selectedModelOptions: {},
          setSelectedModel,
          onBlockedModelSelect,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    const disabledOption = screen.getByTestId('model-option-overseas-gpt-5.4')
    expect(disabledOption).not.toBeDisabled()
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true')
    expect(disabledOption).toHaveAttribute('title', 'Incompatible with the current model protocol')
    expect(disabledOption).toHaveTextContent('Incompatible with the current model protocol')

    await userEvent.click(disabledOption)

    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(onBlockedModelSelect).toHaveBeenCalledWith(
      incompatibleModel,
      'Incompatible with the current model protocol'
    )
  })

  test('shows cross-provider model options as greyed and blocks selection', async () => {
    const selectedModel: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      displayName: 'GPT 5.6 Sol',
      config: {
        weworkModelKind: 'codex-official',
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Sol',
        },
      },
    }
    const thirdPartyModel: UnifiedModel = {
      name: 'kimi-k2.5',
      type: 'runtime',
      displayName: 'Kimi K2.5',
      compatibilityDisabled: true,
      compatibilityDisabledReason: 'provider_boundary_mismatch',
      config: {
        weworkModelKind: 'codex-provider',
        ui: {
          family: 'codex-provider',
          modelLabel: 'Kimi K2.5',
        },
      },
    }
    const setSelectedModel = vi.fn()
    const onBlockedModelSelect = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [selectedModel, thirdPartyModel],
          selectedModel,
          activeModel: selectedModel,
          selectedModelOptions: {},
          setSelectedModel,
          onBlockedModelSelect,
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    const disabledOption = screen.getByTestId('model-option-kimi-k2.5')
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true')
    expect(disabledOption).toHaveClass('cursor-not-allowed', 'text-text-muted')
    expect(disabledOption).toHaveAttribute(
      'title',
      'Official Codex and third-party models cannot be switched within one conversation. Start a new conversation and @mention this conversation to continue with its context.'
    )
    expect(disabledOption).toHaveTextContent(
      'Official Codex and third-party models cannot be switched within one conversation. Start a new conversation and @mention this conversation to continue with its context.'
    )

    await userEvent.click(disabledOption)

    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(onBlockedModelSelect).toHaveBeenCalledWith(
      thirdPartyModel,
      'Official Codex and third-party models cannot be switched within one conversation. Start a new conversation and @mention this conversation to continue with its context.'
    )
    expect(screen.queryByTestId('model-switch-warning-dialog')).not.toBeInTheDocument()
  })

  test('omits Codex plan mode from the desktop model menu', async () => {
    const model: UnifiedModel = {
      name: 'codex-gpt-5.5',
      type: 'user',
      displayName: 'Codex:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          selectedModel: model,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    const menu = within(screen.getByTestId('model-selector-menu'))
    expect(screen.queryByTestId('model-control-collaborationMode-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-control-collaborationMode-plan')).not.toBeInTheDocument()
    expect(menu.queryByText('运行模式')).not.toBeInTheDocument()
    expect(menu.queryByText('计划模式')).not.toBeInTheDocument()
  })

  test('lists models by family in the second-level menu while keeping selected controls', async () => {
    const gptModel: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          region: 'overseas',
          modelLabel: 'gpt-5.5',
          sortOrder: 10,
        },
      },
    }
    const claudeModel: UnifiedModel = {
      name: 'claude-opus',
      type: 'user',
      displayName: 'Claude Opus',
      config: {
        ui: {
          family: 'claude',
          modelLabel: 'claude-opus',
          sortOrder: 10,
        },
      },
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [claudeModel, gptModel],
          selectedModel: gptModel,
          selectedModelOptions: { reasoning: 'high' },
        })}
      />
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))
    await userEvent.hover(screen.getByTestId('model-control-menu-model'))

    expect(screen.getByTestId('model-option-claude-opus')).toBeInTheDocument()
    expect(screen.getByTestId('model-option-overseas-gpt-5.5')).toBeInTheDocument()
    expect(screen.queryByTestId('model-control-menu-reasoning')).not.toBeInTheDocument()
  })

  test('does not render the desktop skill selector', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          skills: [
            {
              id: 1,
              name: 'project-summary',
              namespace: 'default',
              description: 'Summarize project context',
              is_active: true,
              is_public: false,
              user_id: 1,
            },
          ],
        })}
      />
    )

    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-selector-menu')).not.toBeInTheDocument()
  })

  test('opens the desktop add context menu with file upload, plan, and goal actions', async () => {
    const setSelectedModelOption = vi.fn()
    const onSetGoal = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ setSelectedModelOption })}
        onSetGoal={onSetGoal}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    const menu = within(screen.getByTestId('add-context-menu'))
    expect(menu.getByText('添加照片和文件')).toBeInTheDocument()
    expect(menu.getByText('计划模式')).toBeInTheDocument()
    expect(menu.getByText('开启计划模式')).toBeInTheDocument()
    expect(menu.getByText('普通目标（/goal）')).toBeInTheDocument()
    expect(menu.getByText('严格目标（/goal-pro）')).toBeInTheDocument()
    expect(menu.getByText('设置 KCoder Studio 将持续努力实现的目标')).toBeInTheDocument()
    expect(menu.queryByText('Attach Google Chrome')).not.toBeInTheDocument()
    expect(menu.queryByText('插件')).not.toBeInTheDocument()
    expect(screen.getByTestId('attach-files-button')).toHaveClass(
      'font-normal',
      'text-text-primary'
    )
    expect(screen.getByTestId('set-plan-mode-button')).toHaveClass(
      'font-normal',
      'text-text-primary'
    )

    await userEvent.click(screen.getByTestId('set-plan-mode-button'))

    expect(setSelectedModelOption).toHaveBeenCalledWith('collaborationMode', 'plan')

    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('set-goal-button'))

    expect(onSetGoal).toHaveBeenCalledTimes(1)
    expect(onSetGoal).toHaveBeenLastCalledWith('standard')
    await userEvent.click(screen.getByTestId('add-context-button'))
    await userEvent.click(screen.getByTestId('set-goal-pro-button'))
    expect(onSetGoal).toHaveBeenLastCalledWith('strict')
  })

  test('closes the desktop add context menu before opening the file picker', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls()}
      />
    )

    await userEvent.click(screen.getByTestId('add-context-button'))
    const fileInput = screen.getByTestId('attachment-file-input') as HTMLInputElement
    const clickFileInput = vi.spyOn(fileInput, 'click')

    await userEvent.click(screen.getByTestId('attach-files-button'))

    expect(clickFileInput).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('add-context-menu')).not.toBeInTheDocument()
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

  test('renders attachment badges and removes an attachment', async () => {
    const removeAttachment = vi.fn().mockResolvedValue(undefined)
    const attachment: Attachment = {
      id: 42,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          attachments: [attachment],
          removeAttachment,
        })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toHaveTextContent('brief.pdf')

    await userEvent.click(screen.getByTestId('remove-attachment-button'))

    expect(removeAttachment).toHaveBeenCalledWith(42)
  })

  test('renders document attachments as fixed two-line cards', () => {
    const attachment: Attachment = {
      id: 42,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toHaveClass('h-14', 'w-[220px]', 'rounded-xl')
    expect(screen.getByTestId('attachment-document-icon')).toHaveTextContent('PDF')
    expect(screen.getByText('brief.pdf')).toHaveClass('truncate')
    expect(screen.getAllByText('PDF')).toHaveLength(2)
  })

  test('renders pasted text attachments as compact preview cards', async () => {
    const removeAttachment = vi.fn().mockResolvedValue(undefined)
    const attachment: Attachment = {
      id: 45,
      filename: 'clipboard-text-1783070360990.txt',
      file_size: 1200,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: '.txt',
      created_at: '2026-05-27T00:00:00.000Z',
      text_preview: '{ "event_type": "http_exchange", "id": "e9972aac" }',
      text_content: '{\n  "event_type": "http_exchange",\n  "id": "e9972aac"\n}',
    }

    render(
      <ControlledChatInput
        variant="desktop"
        projectChat={projectChatControls({
          attachments: [attachment],
          removeAttachment,
        })}
      />
    )

    expect(screen.getByTestId('attachment-badge')).toHaveClass(
      'h-[72px]',
      'rounded-[20px]',
      'bg-muted'
    )
    expect(screen.getByTestId('attachment-text-preview')).toHaveTextContent(
      '{ "event_type": "http_exchange", "id": "e9972aac" }'
    )
    expect(screen.getByTestId('show-text-attachment-button')).toHaveTextContent(
      'workbench.show_text_attachment_in_composer'
    )

    await userEvent.click(screen.getByTestId('show-text-attachment-button'))

    expect(screen.getByTestId('chat-message-input')).toHaveValue(
      '{\n  "event_type": "http_exchange",\n  "id": "e9972aac"\n}'
    )
    expect(removeAttachment).toHaveBeenCalledWith(45)
  })

  test('renders an image preview for image attachments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
      })
    )
    URL.createObjectURL = vi.fn(() => 'blob:attachment-preview')
    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-preview')).toHaveAttribute(
        'src',
        'blob:attachment-preview'
      )
    })
  })

  test('renders an Appshot image and its text context as one attachment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
      })
    )
    URL.createObjectURL = vi.fn(() => 'blob:appshot-preview')
    const appshot: Attachment = {
      id: -10,
      filename: 'appshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-07-15T00:00:00.000Z',
      ui_group_id: 'appshot-capture-1',
      ui_group_role: 'primary',
      ui_kind: 'appshot',
    }
    const textContext: Attachment = {
      ...appshot,
      id: -11,
      filename: 'appshot-context.txt',
      mime_type: 'text/plain',
      file_extension: '.txt',
      ui_group_role: 'companion',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [appshot, textContext] })}
      />
    )

    expect(screen.getAllByTestId('attachment-badge')).toHaveLength(1)
    expect(screen.getByTestId('attachment-appshot-label')).toHaveTextContent('应用快照')
    expect(screen.queryByTestId('attachment-text-icon')).not.toBeInTheDocument()
  })

  test('opens an enlarged image from the composer attachment preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
      })
    )
    URL.createObjectURL = vi.fn(() => 'blob:attachment-preview')
    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    await userEvent.click(await screen.findByTestId('attachment-image-preview'))

    const lightbox = screen.getByTestId('attachment-image-lightbox')

    expect(lightbox).toBeInTheDocument()
    expect(lightbox.parentElement).toBe(document.body)
    expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'src',
      'blob:attachment-preview'
    )
    expect(screen.getByTestId('attachment-image-lightbox-image')).toHaveAttribute(
      'alt',
      'screenshot.png'
    )
  })

  test('loads image previews with the auth token from local storage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
    })
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:attachment-preview')
    localStorage.setItem('auth_token', 'token-123')

    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('attachment-image-preview')).toHaveAttribute(
        'src',
        'blob:attachment-preview'
      )
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/attachments/43/download', {
      headers: { Authorization: 'Bearer token-123' },
    })
  })

  test('uses matching overlay remove buttons for image and document attachments', () => {
    const attachments: Attachment[] = [
      {
        id: 43,
        filename: 'screenshot.png',
        file_size: 1200,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-27T00:00:00.000Z',
      },
      {
        id: 44,
        filename: 'brief.pdf',
        file_size: 1200,
        mime_type: 'application/pdf',
        status: 'ready',
        file_extension: '.pdf',
        created_at: '2026-05-27T00:00:00.000Z',
      },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments })}
      />
    )

    const removeButtons = screen.getAllByTestId('remove-attachment-button')

    expect(removeButtons).toHaveLength(2)
    removeButtons.forEach(button => {
      expect(button).toHaveClass('absolute', '-right-1.5', '-top-1.5')
      expect(button).toHaveClass('rounded-full', 'bg-text-primary', 'text-white')
    })
  })

  test('enables send when only attachments are present', async () => {
    const onSubmit = vi.fn()
    const attachment: Attachment = {
      id: 44,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />
    )

    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
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

  test('renders remote project IPs and hides local device names in the project menu', async () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          runtimeWork: runtimeWork([
            {
              id: 7,
              name: 'Wegent',
              workspaceId: 70,
              deviceId: 'device-online',
              deviceName: '203.0.113.10',
            },
            {
              id: 8,
              name: 'Docs',
              workspaceId: 80,
              deviceId: 'device-local',
              deviceName: 'Local Device',
            },
          ]),
          devices: [
            {
              id: 1,
              device_id: 'device-online',
              name: 'online-executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              client_ip: '203.0.113.10',
            },
            {
              id: 2,
              device_id: 'device-local',
              name: 'Local Device',
              status: 'online',
              is_default: false,
              device_type: 'local',
            },
          ],
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const projectDeviceLabel = screen.getAllByText('203.0.113.10')[0]
    expect(projectDeviceLabel).toHaveClass('text-text-secondary')
    expect(projectDeviceLabel).not.toHaveClass('text-primary')
    expect(
      within(screen.getByTestId('project-option-8')).queryByText('Local Device')
    ).not.toBeInTheDocument()
  })

  test('ignores the projects table when runtime work is empty', async () => {
    const onSelectProject = vi.fn()

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [
            { id: 7, name: 'Online Project', tasks: [] },
            { id: 8, name: 'Offline Project', tasks: [] },
          ],
          runtimeWork: runtimeWork([]),
          onSelectProject,
          devices: [
            {
              id: 1,
              device_id: 'device-online',
              name: 'online-executor',
              status: 'online',
              is_default: false,
            },
            {
              id: 2,
              device_id: 'device-offline',
              name: 'offline-executor',
              status: 'offline',
              is_default: false,
            },
          ],
        })}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByText('暂无项目')).toBeInTheDocument()
    expect(screen.queryByTestId('project-option-7')).not.toBeInTheDocument()
    expect(screen.queryByText('Online Project')).not.toBeInTheDocument()
    expect(onSelectProject).not.toHaveBeenCalled()
  })

  test('keeps model selector enabled and omits skill selector when options are locked', () => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          selectedSkills: [
            {
              name: 'project-summary',
              namespace: 'default',
              is_public: false,
            },
          ],
          isOptionsLocked: true,
        })}
      />
    )

    expect(screen.getByTestId('model-selector-button')).not.toBeDisabled()
    expect(screen.queryByTestId('skill-selector-button')).not.toBeInTheDocument()
  })

  test.each([
    ['model selector', 'model-selector-button', 'model-selector-menu'],
    ['add context menu', 'add-context-button', 'add-context-menu'],
    ['project work menu', 'project-work-button', 'project-work-menu'],
  ])(
    'closes the desktop %s when clicking outside the dropdown',
    async (_, buttonTestId, menuTestId) => {
      render(
        <ChatInput
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          disabled={false}
          variant="desktop"
          projectWork={projectWorkControls({
            projects: [{ id: 7, name: 'Wegent', tasks: [] }],
          })}
        />
      )

      await userEvent.click(screen.getByTestId(buttonTestId))
      expect(screen.getByTestId(menuTestId)).toBeInTheDocument()

      await userEvent.click(screen.getByTestId('chat-message-input'))

      expect(screen.queryByTestId(menuTestId)).not.toBeInTheDocument()
    }
  )

  test('limits the desktop worktree branch menu while branches scroll', async () => {
    const branches = Array.from({ length: 50 }, (_, index) => `feature/branch-${index}`)
    const worktreeProject = {
      id: 7,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/wegent',
        },
      },
    }
    vi.stubGlobal('innerHeight', 380)

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [worktreeProject],
          currentProject: worktreeProject,
          currentProjectId: 7,
          isGitProject: true,
          executionMode: 'git_worktree',
          executionModeLocked: false,
          onExecutionModeChange: vi.fn(),
          branchName: 'main',
          branchLoading: false,
          onListBranches: vi.fn().mockResolvedValue(branches),
          worktreeBranch: null,
          onWorktreeBranchChange: vi.fn(),
        })}
      />
    )

    const branchButton = screen.getByTestId('project-worktree-branch-button')
    vi.spyOn(branchButton, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 300,
      left: 0,
      top: 300,
      right: 120,
      bottom: 336,
      width: 120,
      height: 36,
      toJSON: () => ({}),
    })

    await userEvent.click(branchButton)

    const menu = await screen.findByTestId('project-worktree-branch-menu')
    await waitFor(() => expect(menu).toHaveStyle({ maxHeight: '276px' }))
    expect(menu).toHaveClass('bottom-11', 'overflow-hidden')
    expect(screen.getByTestId('project-worktree-branch-list')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto'
    )
    expect(await screen.findAllByTestId('project-worktree-branch-option')).toHaveLength(50)
  })

  test('submits typed content', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<ChatInput value="hello" onChange={onChange} onSubmit={onSubmit} disabled={false} />)

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalled()
  })
})

test('shows a read-only template badge for a running session', () => {
  render(
    <ChatInput
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      disabled={false}
      settingsTemplateBadge={{ name: 'No bash', status: 'drifted' }}
    />
  )
  const badge = screen.getByTestId('chat-settings-template-badge')
  expect(badge).toHaveAttribute('data-status', 'drifted')
  expect(badge).toHaveTextContent('No bash')
  expect(screen.queryByTestId('chat-settings-template')).not.toBeInTheDocument()
})
