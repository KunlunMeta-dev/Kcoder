import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { BufferedChatInput } from './BufferedChatInput'
import {
  captureAccountContextRevision,
  notifyAccountContextChange,
} from '@/kcoder/accountContextEvents'

describe('BufferedChatInput', () => {
  test('syncs external value changes into the draft', async () => {
    const { rerender } = render(
      <BufferedChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} />
    )

    rerender(
      <BufferedChatInput
        value="queued message"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('queued message')
    })
  })

  test('restores submitted text when it is externally returned for editing', async () => {
    const onSubmit = vi.fn()
    const props = {
      onChange: vi.fn(),
      onSubmit,
      disabled: false,
    }
    const { rerender } = render(<BufferedChatInput {...props} value="queued message" />)

    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledWith('queued message')

    rerender(<BufferedChatInput {...props} value="" />)
    rerender(<BufferedChatInput {...props} value="queued message" />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('queued message')
    })
  })

  test('appends an insertion without replacing the buffered draft', async () => {
    const props = {
      value: '',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      disabled: false,
    }
    const { rerender } = render(<BufferedChatInput {...props} />)
    await userEvent.type(screen.getByTestId('chat-message-input'), 'Existing draft')

    rerender(<BufferedChatInput {...props} insertion={{ id: 1, text: 'Selected response' }} />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue(
        'Existing draft\nSelected response'
      )
    })
  })

  test('persists ordinary text while the composer is still mounted', async () => {
    const onChange = vi.fn()
    render(<BufferedChatInput value="" onChange={onChange} onSubmit={vi.fn()} disabled={false} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), 'unfinished draft')

    expect(onChange).toHaveBeenLastCalledWith('unfinished draft')
  })

  test('does not insert a late review reference into a different conversation draft', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const insertion = { id: 1, text: 'Reference for task A', scopeKey: 'task-A' }
    const view = render(
      <BufferedChatInput
        value="Task B draft"
        onChange={onChange}
        onSubmit={onSubmit}
        insertionScopeKey="task-B"
        insertion={insertion}
      />
    )
    expect(screen.getByTestId('chat-message-input')).toHaveValue('Task B draft')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalledWith(expect.stringContaining('Reference for task A'))
    view.rerender(
      <BufferedChatInput
        value="Task A draft"
        onChange={onChange}
        onSubmit={onSubmit}
        insertionScopeKey="task-A"
        insertion={insertion}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId('chat-message-input')).toHaveValue(
        'Task A draft\nReference for task A'
      )
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('applies an owned review insertion once and preserves subsequent edits', async () => {
    const props = {
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      insertionScopeKey: 'task-A',
      insertion: { id: 4, text: 'Review reference', scopeKey: 'task-A' },
    }
    const view = render(<BufferedChatInput {...props} value="Original draft" />)
    await waitFor(() =>
      expect(screen.getByTestId('chat-message-input')).toHaveValue(
        'Original draft\nReview reference'
      )
    )
    view.rerender(<BufferedChatInput {...props} value="Newer user draft" />)
    expect(screen.getByTestId('chat-message-input')).toHaveValue('Newer user draft')
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  test('rejects an invalidated account reference even when the conversation key is unchanged', () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const target = 'buffered-review-account'
    const accountCurrent = captureAccountContextRevision()
    notifyAccountContextChange(target)
    render(
      <BufferedChatInput
        value="Current account draft"
        onChange={onChange}
        onSubmit={onSubmit}
        insertionScopeKey="same-task"
        insertion={{
          id: 7,
          text: 'Previous account reference',
          scopeKey: 'same-task',
          isCurrent: () => accountCurrent(target),
        }}
      />
    )
    expect(screen.getByTestId('chat-message-input')).toHaveValue('Current account draft')
    expect(onChange).not.toHaveBeenCalledWith(expect.stringContaining('Previous account'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('restores a buffered draft after switching chat scopes', async () => {
    const drafts = new Map<string, string>()
    const onBlankChange = vi.fn((value: string) => drafts.set('blank', value))
    const onTaskChange = vi.fn((value: string) => drafts.set('task', value))
    const baseProjectChat = {
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
      handleFileSelect: vi.fn(),
      removeAttachment: vi.fn(),
      listLocalSkills: vi.fn(),
    }
    const { rerender } = render(
      <BufferedChatInput
        value=""
        onChange={onBlankChange}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={{ ...baseProjectChat, scopeKey: 'blank' }}
      />
    )
    await userEvent.type(screen.getByTestId('chat-message-input'), 'unfinished draft')

    rerender(
      <BufferedChatInput
        value=""
        onChange={onTaskChange}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={{ ...baseProjectChat, scopeKey: 'task' }}
      />
    )

    await waitFor(() => expect(onBlankChange).toHaveBeenCalledWith('unfinished draft'))
    expect(screen.getByTestId('chat-message-input')).toHaveValue('')

    rerender(
      <BufferedChatInput
        value={drafts.get('blank') ?? ''}
        onChange={onBlankChange}
        onSubmit={vi.fn()}
        disabled={false}
        projectChat={{ ...baseProjectChat, scopeKey: 'blank' }}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('unfinished draft')
    })
  })
})
