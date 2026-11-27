import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ProjectChatComposer } from '../ProjectChatComposer'
import { projectWorkControls, REMOTE_WORKSPACE_TARGET } from '../ChatInput.test-support'

/** Desktop composer box: `76px` grown by 20%. */
const COMPOSER_FORM_MIN_HEIGHT_PX = 91
/** Desktop composer editor: `48px`/`112px` grown by 20%. */
const COMPOSER_INPUT_MIN_HEIGHT_PX = 58
const COMPOSER_INPUT_MAX_HEIGHT_PX = 134

function renderDesktopComposer() {
  return render(
    <ProjectChatComposer
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      disabled={false}
      placeholder="随心输入"
    />
  )
}

describe('ProjectChatComposer desktop sizing', () => {
  test('the send button executes an exact slash action without submitting a model message', () => {
    const onSubmit = vi.fn()
    const onClearPlanMode = vi.fn()
    render(<ProjectChatComposer value="/unplan" onChange={vi.fn()} onSubmit={onSubmit}
      disabled={false} placeholder="Message" planModeActive onClearPlanMode={onClearPlanMode} />)
    fireEvent.click(screen.getByTestId('send-message-button'))
    expect(onClearPlanMode).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('keeps the project selector without a standalone storage hint', () => {
    const props = {
      value: '', onChange: vi.fn(), onSubmit: vi.fn(), disabled: false, placeholder: '随心输入',
      projectWork: projectWorkControls(),
    }
    const view = render(<ProjectChatComposer {...props} />)
    expect(screen.getByTestId('composer-project-context')).toBeInTheDocument()
    expect(screen.queryByTestId('standalone-storage-hint')).not.toBeInTheDocument()
    view.rerender(<ProjectChatComposer {...props} workspaceTarget={REMOTE_WORKSPACE_TARGET} />)
    expect(screen.queryByTestId('standalone-storage-hint')).not.toBeInTheDocument()
    view.rerender(<ProjectChatComposer {...props} projectWork={projectWorkControls({
      standaloneWorkspacePath: REMOTE_WORKSPACE_TARGET.path,
    })} />)
    expect(screen.queryByTestId('standalone-storage-hint')).not.toBeInTheDocument()
    view.rerender(<ProjectChatComposer {...props} projectWork={projectWorkControls({
      currentRuntimeTask: { deviceId: 'host', taskId: 'existing' },
    })} />)
    expect(screen.queryByTestId('standalone-storage-hint')).not.toBeInTheDocument()
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  test('uses the 20%-taller desktop composer box', () => {
    renderDesktopComposer()

    expect(screen.getByTestId('project-chat-composer-form')).toHaveClass(
      `min-h-[${COMPOSER_FORM_MIN_HEIGHT_PX}px]`,
      'flex-col',
      'rounded-[26px]'
    )
  })

  test('uses the 20%-taller editor bounds', () => {
    renderDesktopComposer()

    expect(screen.getByTestId('chat-message-input')).toHaveClass(
      `min-h-[${COMPOSER_INPUT_MIN_HEIGHT_PX}px]`,
      `max-h-[${COMPOSER_INPUT_MAX_HEIGHT_PX}px]`,
      'resize-none'
    )
  })

  test('keeps the editor bounds inside the composer box', () => {
    expect(COMPOSER_INPUT_MIN_HEIGHT_PX).toBeLessThan(COMPOSER_FORM_MIN_HEIGHT_PX)
    expect(COMPOSER_INPUT_MAX_HEIGHT_PX).toBeGreaterThan(COMPOSER_INPUT_MIN_HEIGHT_PX)
  })
})
