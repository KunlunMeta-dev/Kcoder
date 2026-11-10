import '@/i18n'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import { usePaneInteractions } from './usePaneInteractions'

const payload = {
  kind: 'request_user_input', requestId: 41, itemId: 'question-41',
  questions: [{ id: 'choice', question: 'How should this task continue?', options: [{ label: 'Continue' }] }],
}
const response = { requestId: 41, itemId: 'question-41', answers: { choice: { answers: ['Continue'] } } }

function setup(send: () => Promise<boolean>) {
  const tracker = createRequestUserInputAliasTracker()
  tracker.previousPayloads = [payload]
  let answered = new Set<string>()
  const context = {
    currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId: 'task-a', threadId: 'thread-a' },
    projectChat: { setSelectedModelOption: vi.fn() },
    sendRuntimePaneMessage: vi.fn(send), editLastUserMessage: vi.fn(), cancelRuntimePaneTask: vi.fn(),
    setError: vi.fn(), requestUserInputAliasTrackerRef: { current: tracker },
    updateAnsweredRequestUserInputIds: (update: (value: Set<string>) => Set<string>) => { answered = update(answered) },
    messagesRef: { current: [] }, dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
    getRuntimeModelFields: vi.fn(), applyLocalRequestUserInputResponse: vi.fn(),
  }
  const hook = renderHook(({ taskId }) => usePaneInteractions({
    ...context, currentRuntimeTask: { ...context.currentRuntimeTask, taskId },
  } as unknown as Parameters<typeof usePaneInteractions>[0]), { initialProps: { taskId: 'task-a' } })
  return { ...hook, context, answered: () => answered }
}

describe('question send confirmation owns the local answered projection', () => {
  it.each(['false', 'throw'] as const)('does not settle or hide a question when sending returns %s', async failure => {
    const f = setup(async () => { if (failure === 'throw') throw new Error('transport failed'); return false })
    await act(async () => {
      try { await f.result.current.sendRequestUserInputResponse(response) } catch { /* Assert the unchanged projection below. */ }
    })
    expect(f.context.applyLocalRequestUserInputResponse).not.toHaveBeenCalled()
    expect(f.answered().size).toBe(0)
    expect(f.context.sendRuntimePaneMessage).toHaveBeenCalledOnce()
  })

  it('waits for acceptance before settling a question', async () => {
    let resolve!: (sent: boolean) => void
    const f = setup(() => new Promise<boolean>(done => { resolve = done }))
    let pending!: Promise<boolean>
    act(() => { pending = f.result.current.sendRequestUserInputResponse(response) })
    expect(f.context.applyLocalRequestUserInputResponse).not.toHaveBeenCalled()
    expect(f.answered().size).toBe(0)
    await act(async () => { resolve(true); await pending })
    expect(f.context.applyLocalRequestUserInputResponse).toHaveBeenCalledExactlyOnceWith(response)
    expect([...f.answered()]).toEqual(['request:41', 'item:question-41'])
  })

  it.each([false, true])('does not apply a delayed answer to another task, revisited=%s', async revisit => {
    let resolve!: (sent: boolean) => void
    const f = setup(() => new Promise<boolean>(done => { resolve = done }))
    let pending!: Promise<boolean>
    act(() => { pending = f.result.current.sendRequestUserInputResponse(response) })
    f.rerender({ taskId: 'task-b' })
    if (revisit) f.rerender({ taskId: 'task-a' })
    await act(async () => { resolve(true); await pending })
    expect(f.context.applyLocalRequestUserInputResponse).not.toHaveBeenCalled()
    expect(f.answered().size).toBe(0)
  })

  it.each([false, true])('rejects an old question callback before sending, revisited=%s', async revisit => {
    const f = setup(async () => true)
    const staleSubmit = f.result.current.sendRequestUserInputResponse
    f.rerender({ taskId: 'task-b' })
    if (revisit) f.rerender({ taskId: 'task-a' })
    await act(async () => { expect(await staleSubmit(response)).toBe(false) })
    expect(f.context.sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(f.context.applyLocalRequestUserInputResponse).not.toHaveBeenCalled()
  })
})

it.each(['synchronous', 'asynchronous'] as const)('unlocks the question card after a %s false send without resending', async mode => {
  const submit = vi.fn().mockImplementation(() => mode === 'synchronous' ? false : Promise.resolve(false))
  render(<RequestUserInputCard payload={payload} onSubmit={submit} />)
  const button = screen.getByTestId('request-user-input-submit-button')
  fireEvent.click(button)
  await waitFor(() => expect(button).toBeEnabled())
  expect(submit).toHaveBeenCalledOnce()
  fireEvent.click(button)
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
})
