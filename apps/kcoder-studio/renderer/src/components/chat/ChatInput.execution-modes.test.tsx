import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

test.each(['desktop', 'compact'] as const)(
  'keeps the draft editable but waits for the restored model catalog before sending (%s)',
  async variant => {
    const onSubmit = vi.fn()
    const view = render(
      <ControlledChatInput
        variant={variant}
        onSubmit={onSubmit}
        projectChat={projectChatControls({ isModelSelectionReady: false })}
      />
    )
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
    act(() => {
      editor.value = 'restored conversation draft'
      editor.focus()
    })
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(editor.value).toBe('restored conversation draft')
    view.rerender(
      <ControlledChatInput
        variant={variant}
        onSubmit={onSubmit}
        projectChat={projectChatControls({ isModelSelectionReady: true })}
      />
    )
    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    fireEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
  }
)

test('workflow creation uses the ordinary composer text and scoped session option', async () => {
  const onSubmit = vi.fn()
  render(<ControlledChatInput onSubmit={onSubmit} variant="desktop" />)
  await userEvent.click(screen.getByTestId('composer-workflow-mode'))
  expect(screen.getByTestId('composer-workflow-mode')).toHaveAttribute('aria-pressed', 'true')
  const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }
  act(() => {
    editor.value = '生成 PPT 的工作流'
    editor.focus()
  })
  fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      '生成 PPT 的工作流',
      expect.objectContaining({ sessionMode: 'workflow_draft' })
    )
  )
})
