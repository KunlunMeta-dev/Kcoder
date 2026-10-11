import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ChatInput } from './ChatInput'
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
describe('ChatInput keyboard', () => {
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
})
