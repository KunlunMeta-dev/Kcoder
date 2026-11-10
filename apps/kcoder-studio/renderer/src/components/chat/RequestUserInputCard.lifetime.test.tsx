import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard, type RequestUserInputPayload } from './RequestUserInputCard'
import { createRequestUserInputAliasTracker, observeRequestUserInputAliases } from './requestUserInputMessages'

const original: RequestUserInputPayload = {
  requestId: 7, itemId: 'question', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
  questions: [{ id: 'choice', question: 'Which source?', options: [] }],
}

test.each(['requestId', 'itemId', 'threadId', 'turnId', 'appServerEpoch'] as const)(
  'a replacement %s cannot inherit the original draft or pending submission', async field => {
    let finish!: (value: boolean) => void
    const submit = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<RequestUserInputCard payload={original} onSubmit={submit} />)
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Original task only' },
    })
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect(submit).toHaveBeenCalledOnce()
    const replacement = { ...original, [field]: 'replacement' }
    view.rerender(<RequestUserInputCard payload={replacement} onSubmit={submit} />)
    expect.soft(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
    expect.soft(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Replacement task only' },
    })
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect.soft(submit).toHaveBeenCalledTimes(2)
    // The old transport's rejection cannot unlock a newer accepted submission.
    await act(async () => { finish(false) })
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(submit.mock.calls[1]?.[0]).toMatchObject({
      [field]: 'replacement', answers: { choice: { answers: ['Replacement task only'] } },
    })
  },
)

test('same-owner refresh and connection recovery retain the unsent draft', () => {
  const submit = vi.fn()
  const view = render(<RequestUserInputCard payload={original} onSubmit={submit} />)
  const draft = screen.getByTestId('request-user-input-custom-choice')
  fireEvent.change(draft, { target: { value: 'Retain this draft' } })
  view.rerender(<RequestUserInputCard payload={structuredClone(original)} submissionEpoch={1}
    onSubmit={submit} />)
  expect(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
  expect(draft).toHaveValue('Retain this draft')
  expect(submit).not.toHaveBeenCalled()
})

test('equivalent legacy request aliases retain the original unsent draft', () => {
  const submit = vi.fn()
  const view = render(<RequestUserInputCard payload={original} onSubmit={submit} />)
  const draft = screen.getByTestId('request-user-input-custom-choice')
  fireEvent.change(draft, { target: { value: 'Keep this answer' } })
  const { requestId, itemId, ...binding } = original
  view.rerender(<RequestUserInputCard payload={{ ...binding, request_id: requestId, item_id: itemId }}
    submissionEpoch={1} onSubmit={submit} />)
  expect(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
  expect(draft).toHaveValue('Keep this answer')
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ requestId, itemId }))
})

test('a reused subagent ID in another run receives a fresh draft', () => {
  const sourceAgent = { parentSessionId: 'thread', agentId: 'child',
    backgroundRun: { parentSessionId: 'thread', agentId: 'child', runId: 'original-run' } }
  const view = render(<RequestUserInputCard payload={{ ...original, sourceAgent }} />)
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Original worker only' },
  })
  view.rerender(<RequestUserInputCard payload={{ ...original, sourceAgent: {
    ...sourceAgent, backgroundRun: { ...sourceAgent.backgroundRun, runId: 'replacement-run' },
  } }} />)
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
})

function restoredAlias() {
  const restored = { ...original, requestId: undefined, itemId: 'restored-question' }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [restored, original])
  return { restored, aliasesByKey: tracker.aliasesByKey }
}

test('a registered restoration alias retains the draft and original pending submission', async () => {
  const { restored, aliasesByKey } = restoredAlias()
  let finish!: (value: boolean) => void
  const submit = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
  const view = render(<RequestUserInputCard payload={original} aliasesByKey={aliasesByKey} onSubmit={submit} />)
  const draft = screen.getByTestId('request-user-input-custom-choice')
  fireEvent.change(draft, { target: { value: 'Retain the original answer' } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  view.rerender(<RequestUserInputCard payload={restored} aliasesByKey={aliasesByKey} onSubmit={submit} />)
  expect.soft(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
  expect.soft(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Retain the original answer')
  expect.soft(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  expect(submit).toHaveBeenCalledOnce()
  await act(async () => { finish(false) })
  expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Retain the original answer')
})

test.each(['threadId', 'turnId', 'appServerEpoch'] as const)(
  'a registered alias cannot bridge a conflicting %s', field => {
    const { restored, aliasesByKey } = restoredAlias()
    const view = render(<RequestUserInputCard payload={original} aliasesByKey={aliasesByKey} />)
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), { target: { value: 'Original only' } })
    view.rerender(<RequestUserInputCard payload={{ ...restored, [field]: 'replacement' }} aliasesByKey={aliasesByKey} />)
    expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
  },
)

test('identical unregistered prompts cannot inherit another question draft', () => {
  const { restored } = restoredAlias()
  const view = render(<RequestUserInputCard payload={original} />)
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), { target: { value: 'Original only' } })
  view.rerender(<RequestUserInputCard payload={restored} aliasesByKey={new Map()} />)
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
})

test('an unregistered partial projection cannot retire the complete form binding', () => {
  const view = render(<RequestUserInputCard payload={original} />)
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), { target: { value: 'Original only' } })
  view.rerender(<RequestUserInputCard payload={{ ...original, requestId: undefined }} aliasesByKey={new Map()} />)
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
})

test('a restoration alias cannot transfer drafts into a different source-agent run', () => {
  const sourceAgent = { parentSessionId: 'thread', agentId: 'child',
    backgroundRun: { parentSessionId: 'thread', agentId: 'child', runId: 'original-run' } }
  const bound = { ...original, sourceAgent }
  const restored = { ...bound, requestId: undefined, itemId: 'restored' }
  const tracker = createRequestUserInputAliasTracker()
  observeRequestUserInputAliases(tracker, [restored, bound])
  const view = render(<RequestUserInputCard payload={bound} aliasesByKey={tracker.aliasesByKey} />)
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), { target: { value: 'Original worker only' } })
  view.rerender(<RequestUserInputCard payload={{ ...restored, sourceAgent: {
    ...sourceAgent, backgroundRun: { ...sourceAgent.backgroundRun, runId: 'replacement-run' },
  } }} aliasesByKey={tracker.aliasesByKey} />)
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
})
