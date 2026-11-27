import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard, type RequestUserInputPayload } from './RequestUserInputCard'
import { requestUserInputPayloadKeys } from './requestUserInputMessages'

const original: RequestUserInputPayload = {
  requestId: 7, itemId: 'question', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
  sourceAgent: { parentSessionId: 'parent', agentId: 'worker',
    backgroundRun: { parentSessionId: 'parent', agentId: 'worker', runId: 'run' } },
  questions: [{ id: 'choice', question: 'Which source?', options: [] }],
}

test.each(['parentSessionId', 'agentId'] as const)(
  'a replaced background-run %s cannot inherit drafts or submission guards', async field => {
    let finishOriginal!: (value: boolean) => void
    const submit = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOriginal = resolve }))
    const view = render(<RequestUserInputCard payload={original} onSubmit={submit} />)
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Original source only' },
    })
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    const replacement = structuredClone(original)
    replacement.sourceAgent!.backgroundRun![field] = 'replacement'
    // Transcript correlation already treats the complete run address as a new source.
    expect(requestUserInputPayloadKeys(replacement)).not.toEqual(requestUserInputPayloadKeys(original))
    view.rerender(<RequestUserInputCard payload={replacement} onSubmit={submit} />)
    expect.soft(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
    expect.soft(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Replacement source only' },
    })
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    expect.soft(submit).toHaveBeenCalledTimes(2)
    await act(async () => { finishOriginal(false) })
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(submit.mock.calls[1]?.[0]).toMatchObject({
      sourceAgent: replacement.sourceAgent, answers: { choice: { answers: ['Replacement source only'] } },
    })
  },
)
