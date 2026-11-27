import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { setStudioWorkMode } from '@/features/workbench/studioWorkMode'
import type { RuntimeTaskAddress } from '@/types/api'
import { ChatInput, type ChatInputProps, type ProjectWorkControls } from './ChatInput'
import { projectChatControls } from './composer/ChatInput.test-support'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

function task(mode: 'kcoder' | 'kworker'): RuntimeTaskAddress {
  return {
    deviceId: 'owned-target',
    taskId: `restored-${mode}`,
    threadId: `thread-${mode}`,
    runtimeHandle: { studioWorkMode: mode },
  }
}

function work(address: RuntimeTaskAddress): ProjectWorkControls {
  return {
    projects: [], devices: [], currentRuntimeTask: address,
    executionMode: 'current_workspace',
    onSelectProject: vi.fn(), onSelectStandaloneDevice: vi.fn(), onExecutionModeChange: vi.fn(),
  }
}

function props(variant: 'desktop' | 'compact'): ChatInputProps {
  return {
    value: 'Retained draft', onChange: vi.fn(), onSubmit: vi.fn(), disabled: false, variant,
    projectChat: projectChatControls(), onSetGoal: vi.fn(), onCancelGoalDraft: vi.fn(),
  }
}

function goalButtons(variant: 'desktop' | 'compact') {
  return variant === 'desktop'
    ? ['set-goal-button', 'set-goal-pro-button']
    : ['mobile-set-goal-button', 'mobile-set-goal-pro-button']
}

test.each(['desktop', 'compact'] as const)(
  '%s blank composer updates Goal and Goal-Pro when its work mode changes without clearing stored choices',
  async variant => {
    const input = props(variant)
    render(<ChatInput {...input} />)
    await userEvent.click(screen.getByTestId('add-context-button'))
    const [goal, pro] = goalButtons(variant)
    expect(screen.getByTestId(goal)).toBeInTheDocument()
    expect(screen.getByTestId(pro)).toBeInTheDocument()

    act(() => setStudioWorkMode('kworker'))
    expect(screen.queryByTestId(goal)).not.toBeInTheDocument()
    expect(screen.queryByTestId(pro)).not.toBeInTheDocument()
    expect(input.onSetGoal).not.toHaveBeenCalled()
    expect(input.onCancelGoalDraft).not.toHaveBeenCalled()
    expect(input.onChange).not.toHaveBeenCalled()

    act(() => setStudioWorkMode('kcoder'))
    expect(screen.getByTestId(goal)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId(pro))
    expect(input.onSetGoal).toHaveBeenCalledExactlyOnceWith('strict')
  }
)

test.each(['desktop', 'compact'] as const)(
  '%s restored composer follows its bound task instead of the blank-page preference and retains a hidden goal draft',
  async variant => {
    const input = { ...props(variant), goalDraftActive: true }
    const view = render(<ChatInput {...input} projectWork={work(task('kworker'))} />)
    await userEvent.click(screen.getByTestId('add-context-button'))
    const [goal, pro] = goalButtons(variant)
    expect(screen.queryByTestId(goal)).not.toBeInTheDocument()
    expect(screen.queryByTestId(pro)).not.toBeInTheDocument()
    expect(screen.queryByTestId('goal-draft-pill')).not.toBeInTheDocument()

    act(() => setStudioWorkMode('kworker'))
    view.rerender(<ChatInput {...input} projectWork={work(task('kcoder'))} />)
    expect(screen.getByTestId(goal)).toBeInTheDocument()
    expect(screen.getByTestId(pro)).toBeInTheDocument()
    expect(screen.getByTestId('goal-draft-pill')).toBeInTheDocument()
    expect(input.onCancelGoalDraft).not.toHaveBeenCalled()
    expect(input.onSetGoal).not.toHaveBeenCalled()
    expect(input.onChange).not.toHaveBeenCalled()
  }
)

test('split composers keep independent Goal menus for their actual tasks', async () => {
  setStudioWorkMode('kworker')
  const coding = props('desktop')
  const worker = props('compact')
  render(<>
    <section data-testid="coding-pane"><ChatInput {...coding} projectWork={work(task('kcoder'))} /></section>
    <section data-testid="worker-pane"><ChatInput {...worker} projectWork={work(task('kworker'))} /></section>
  </>)
  const codingPane = within(screen.getByTestId('coding-pane'))
  const workerPane = within(screen.getByTestId('worker-pane'))
  await userEvent.click(codingPane.getByTestId('add-context-button'))
  expect(codingPane.getByTestId('set-goal-button')).toBeInTheDocument()
  expect(codingPane.getByTestId('set-goal-pro-button')).toBeInTheDocument()
  await userEvent.click(workerPane.getByTestId('add-context-button'))
  expect(workerPane.queryByTestId('mobile-set-goal-button')).not.toBeInTheDocument()
  expect(workerPane.queryByTestId('mobile-set-goal-pro-button')).not.toBeInTheDocument()
  expect(coding.onSetGoal).not.toHaveBeenCalled()
  expect(worker.onSetGoal).not.toHaveBeenCalled()
})
