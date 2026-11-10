import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import type { RequestUserInputResponse } from '@/types/api'
import { MessageList } from './MessageList'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'

const payload = {
  kind: 'request_user_input',
  requestId: 41,
  itemId: 'original-question',
  threadId: 'original-thread',
  turnId: 'original-turn',
  appServerEpoch: 'original-epoch',
  questions: [{ id: 'choice', question: 'Which source?', options: [] }],
}

const block: ProcessingBlock = {
  id: 'live-block',
  type: 'tool',
  toolName: 'AskUserQuestion',
  status: 'pending',
  createdAt: 1_800_000_000_000,
  renderPayload: payload,
}

test.each([
  ['processing list', false],
  ['message list', false],
  ['message list', true],
] as const)(
  '%s preserves drafts and pending submission when recovery rebuilds block IDs (leading tool %s)',
  async (entry, leadingTool) => {
    let finish!: (result: boolean) => void
    const submit = vi.fn<(response: RequestUserInputResponse) => Promise<boolean>>(
      () =>
        new Promise<boolean>(resolve => {
          finish = resolve
        })
    )
    const display = (blocks: ProcessingBlock[]) => {
      if (leadingTool)
        blocks = [
          {
            id: `${blocks[0].id}-preceding-tool`,
            type: 'tool',
            toolName: 'Read',
            status: 'done',
            createdAt: 1_800_000_000_000,
          },
          ...blocks,
        ]
      const message: WorkbenchMessage = {
        id: 'original-message',
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: '2026-11-10T06:00:00.000Z',
        blocks,
      }
      return entry === 'processing list' ? (
        <ToolBlocksDisplay blocks={blocks} isStreaming onRequestUserInputSubmit={submit} />
      ) : (
        <MessageList messages={[message]} onRequestUserInputSubmit={submit} />
      )
    }
    const view = render(display([block]))
    const draft = screen.getByTestId('request-user-input-custom-choice')
    fireEvent.change(draft, { target: { value: 'Answer for the original question' } })
    view.rerender(display([{ ...block, id: 'restored-block' }]))
    expect.soft(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
    expect
      .soft(screen.getByTestId('request-user-input-custom-choice'))
      .toHaveValue('Answer for the original question')
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Answer for the original question' },
    })
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect(submit).toHaveBeenCalledOnce()
    view.rerender(display([{ ...block, id: 'reloaded-block' }]))
    expect.soft(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect.soft(submit).toHaveBeenCalledOnce()
    await act(async () => {
      finish(false)
    })
    expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
    expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue(
      'Answer for the original question'
    )
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      requestId: 41,
      itemId: 'original-question',
      threadId: 'original-thread',
      answers: { choice: { answers: ['Answer for the original question'] } },
    })
  }
)

test.each(['requestId', 'itemId', 'threadId', 'turnId', 'appServerEpoch'] as const)(
  'a replacement %s in the same message cannot inherit the original draft',
  field => {
    const display = (replacement: typeof payload) => (
      <MessageList
        messages={[
          {
            id: 'same-message',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-11-10T06:00:00.000Z',
            blocks: [{ ...block, renderPayload: replacement }],
          },
        ]}
      />
    )
    const view = render(display(payload))
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Original question only' },
    })
    view.rerender(display({ ...payload, [field]: 'replacement' }))
    expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
  }
)
