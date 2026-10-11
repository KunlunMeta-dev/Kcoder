import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ProjectChatComposer } from '@/components/chat/composer/ProjectChatComposer'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

// QA: actual shared ProseMirror editor, not a textarea stand-in. Keyboard and capability
// rendering are model independent; native E2E verifies the same editor in the WebView.
describe('subagent uses the ordinary composer editor', () => {
  test('Enter sends text, Shift+Enter inserts a line break, and unsupported controls stay absent', () => {
    const onSubmit = vi.fn()
    const onChange = vi.fn()
    render(
      <ProjectChatComposer
        textOnly
        value="instruction"
        onChange={onChange}
        onSubmit={onSubmit}
        disabled={false}
        placeholder="instruction"
      />
    )
    const editor = screen.getByTestId('chat-message-input')
    expect(editor).toHaveAttribute('contenteditable', 'true')
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('\n'))
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('add-context-menu-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-selector-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('send-mode-menu-button')).not.toBeInTheDocument()
  })

  test('IME confirmation never submits an instruction; literal slash text remains sendable', () => {
    const onSubmit = vi.fn()
    render(
      <ProjectChatComposer
        textOnly
        value="/analyze this directory"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        placeholder="instruction"
      />
    )
    const editor = screen.getByTestId('chat-message-input')
    fireEvent.compositionStart(editor)
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.compositionEnd(editor)
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyUp(editor, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('/analyze this directory', undefined)
    expect(screen.queryByTestId('composer-slash-command-error')).not.toBeInTheDocument()
  })

  test('only supported independent stop is shown while a worker is streaming', () => {
    const onPause = vi.fn()
    const props = {
      textOnly: true,
      value: '',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      disabled: false,
      placeholder: 'instruction',
      isStreaming: true,
    }
    const view = render(<ProjectChatComposer {...props} />)
    expect(screen.queryByTestId('pause-response-button')).not.toBeInTheDocument()
    view.rerender(<ProjectChatComposer {...props} onPause={onPause} />)
    fireEvent.click(screen.getByTestId('pause-response-button'))
    expect(onPause).toHaveBeenCalledTimes(1)
  })
})
