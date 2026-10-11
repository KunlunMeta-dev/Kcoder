import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ChatInput } from './ChatInput'
import { projectChatControls } from './composer/ChatInput.test-support'
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
describe('ChatInput workflow-skills', () => {
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
})
