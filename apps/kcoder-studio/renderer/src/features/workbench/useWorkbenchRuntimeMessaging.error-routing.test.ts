import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
import { RuntimeInputRejectedError } from '@/kcoder/rpcOutcome'
import type { WorkbenchMessage } from '@/types/workbench'
import { usePaneSend } from '@/components/layout/pane/usePaneSend'
import { usePaneInteractions } from '@/components/layout/pane/usePaneInteractions'
import { usePaneGoal } from '@/components/layout/pane/usePaneGoal'
import { useWorkbenchRuntimeMessaging } from './useWorkbenchRuntimeMessaging'

const address = { deviceId: 'local', taskId: 'task', threadId: 'thread', workspacePath: '/work' }
const failed: WorkbenchMessage = {
  id: 'failed-response', role: 'assistant', content: '', status: 'failed', createdAt: '2026-11-11T00:00:00Z',
}

function fixture() {
  const dispatch = vi.fn()
  const rollback = vi.fn()
  const send = vi.fn()
  const cancel = vi.fn()
  const guide = vi.fn()
  const shorten = vi.fn()
  const state = { currentRuntimeTask: null as typeof address | null, devices: [] }
  const modelSelection = { isSelectedModelUnavailable: vi.fn(() => false) }
  const lifecycleStore = {
    sendRequested: vi.fn(), sendRejected: vi.fn(), sendAccepted: vi.fn(),
    stopRequested: vi.fn(), stopRejected: vi.fn(),
  }
  const options = {
    state,
    dispatch,
    executorClient: { runtime: {
      rollbackRuntimeTask: rollback, sendRuntimeMessage: send, cancelRuntimeTask: cancel,
      guideRuntimeTask: guide, shortenWaitRuntimeTask: shorten,
    } },
    services: {},
    lifecycleStore,
    attachmentSelection: { attachments: [] },
    modelSelection,
    skillSelection: { selectedSkills: [] },
  } as unknown as Parameters<typeof useWorkbenchRuntimeMessaging>[0]
  const hook = renderHook(() => useWorkbenchRuntimeMessaging(options))
  return { ...hook, state, dispatch, rollback, send, cancel, guide, shorten, modelSelection, lifecycleStore }
}

test.each([
  { messages: [], key: 'runtime_retry_failure_missing' },
  { messages: [failed], key: 'runtime_retry_user_missing' },
  { messages: [{ ...failed, turnId: 'turn-1' }], key: 'runtime_retry_task_missing' },
])('routes $key to the pane error callback', async ({ messages, key }) => {
  const f = fixture()
  const onError = vi.fn()
  await act(async () => {
    expect(await f.result.current.retryFailedMessage(failed.id, messages, undefined, 'snapshot', { onError })).toBe(false)
  })
  expect(onError).toHaveBeenCalledExactlyOnceWith(i18n.t(`workbench.${key}`))
  expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error_set' }))
})

test.each(['rejected', 'throw'] as const)('routes a %s edit to the explicitly selected error owner', async failure => {
  const f = fixture()
  const message = 'Provider rejected the edited message'
  f.rollback.mockImplementation(async () => {
    if (failure === 'throw') throw new Error(message)
    return { accepted: false, error: message }
  })
  const request = { address, message: 'edited', messageId: 'user' }
  const onError = vi.fn()
  await act(async () => {
    expect(await f.result.current.editLastUserMessage(request, { onError })).toBe(false)
  })
  expect(onError).toHaveBeenCalledExactlyOnceWith(message)
  expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error_set' }))
  await act(async () => {
    expect(await f.result.current.editLastUserMessage(request, {
      onError: error => f.dispatch({ type: 'error_set', error }),
    })).toBe(false)
  })
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'error_set', error: message })
})

test('a global caller must explicitly select its global error handler', async () => {
  const f = fixture()
  await act(async () => {
    expect(await f.result.current.retryFailedMessage(failed.id, [], undefined, 'snapshot', {
      onError: error => f.dispatch({ type: 'error_set', error }),
    })).toBe(false)
  })
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: 'error_set', error: i18n.t('workbench.runtime_retry_failure_missing'),
  })
})

test.each(['send', 'temporary', 'project'] as const)(
  'an unavailable model reports to the caller when starting a %s task',
  async action => {
    const f = fixture()
    f.modelSelection.isSelectedModelUnavailable.mockReturnValue(true)
    const onError = vi.fn()
    const actions = {
      send: () => f.result.current.sendCurrentInput('message', { onError }),
      temporary: () => f.result.current.createTemporaryRuntimeTask('message', { onError }),
      project: () => f.result.current.createProjectRuntimeTask('message', {
        project: { id: 1 } as Parameters<typeof f.result.current.createProjectRuntimeTask>[1]['project'],
        onError,
      }),
    }
    await act(async () => { expect(await actions[action]()).toBe(false) })
    expect(onError).toHaveBeenCalledExactlyOnceWith(i18n.t('workbench.model_disabled_unavailable'))
    expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error_set' }))
  }
)

test.each(['rejected', 'throw'] as const)('a %s wait-shortening action reports its failure to the pane', async failure => {
  const f = fixture()
  f.state.currentRuntimeTask = address
  const message = 'Unable to shorten the current wait'
  f.shorten.mockImplementation(async () => {
    if (failure === 'throw') throw new Error(message)
    return { accepted: false, error: message }
  })
  const onError = vi.fn()
  await act(async () => { await f.result.current.shortenCurrentWait({ onError }) })
  expect(onError).toHaveBeenCalledExactlyOnceWith(message)
  expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error_set' }))
})

test('pausing the current task reports rejection to the explicitly selected owner', async () => {
  const f = fixture()
  f.state.currentRuntimeTask = address
  const message = 'Unable to pause the current task'
  f.cancel.mockResolvedValue({ accepted: false, error: message })
  const onError = vi.fn()
  await act(async () => { await f.result.current.pauseCurrentResponse({ onError }) })
  expect(onError).toHaveBeenCalledExactlyOnceWith(message)
  expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error_set' }))
})

test('a guidance transport failure reports to the pane and retains its failed result', async () => {
  const f = fixture()
  const message = 'Guidance transport lost'
  f.guide.mockRejectedValue(new Error(message))
  const onError = vi.fn()
  await act(async () => {
    expect(await f.result.current.sendRuntimePaneGuidance({
      address, message: 'guidance', clientGuidanceId: 'guidance-id',
    }, { onError })).toEqual({ sent: false, error: message })
  })
  expect(onError).toHaveBeenCalledExactlyOnceWith(message)
  expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error_set' }))
})

test.each(['send', 'answer', 'edit', 'ignore', 'stop', 'shorten'] as const)(
  'a failed %s action reports to the owning conversation through the messaging service',
  async action => {
    const f = fixture()
    f.state.currentRuntimeTask = address
    const error = 'Runtime rejected this conversation action'
    for (const rpc of [f.send, f.rollback, f.cancel, f.shorten])
      rpc.mockResolvedValue({ accepted: false, error })
    const setError = vi.fn()
    const user: WorkbenchMessage = {
      id: 'user', role: 'user', content: 'original', createdAt: failed.createdAt,
    }
    const context = {
      ...f.result.current,
      currentRuntimeTask: address,
      accountScopeInvalidatedRef: { current: false },
      queuedMessageSendInFlightIdsRef: { current: new Set() },
      setQueuedMessages: vi.fn(),
      projectChat: { models: [], selectedModelOptions: {} },
      setError,
      dispatchMessages: vi.fn(),
      messagesRef: { current: [user, failed] },
      lastSubmittedRetryMessageRef: { current: null },
      paneStatus: { isBusy: false },
      queuedMessages: [],
      goal: null,
      taskGoalStatus: null,
      shortenCurrentWaitAction: f.result.current.shortenCurrentWait,
    } as unknown as Parameters<typeof usePaneSend>[0]
    const pane = renderHook(() => {
      const sending = usePaneSend(context)
      const interactions = usePaneInteractions(sending)
      return usePaneGoal(interactions as unknown as Parameters<typeof usePaneGoal>[0])
    })
    const actions = {
      send: () => pane.result.current.sendRuntimeMessage({
        id: user.id, content: user.content, status: 'queued', createdAt: user.createdAt,
      }),
      answer: () => pane.result.current.sendRequestUserInputResponse({
        requestId: 41, answers: { choice: { answers: ['Continue'] } },
      }),
      edit: () => pane.result.current.editLastUserMessageInPane(user, 'edited'),
      ignore: () => pane.result.current.ignoreRequestUserInput({
        requestId: 41, questions: [{ id: 'choice', question: 'Continue?', options: [] }],
      }),
      stop: () => pane.result.current.pauseCurrentResponse(),
      shorten: () => pane.result.current.shortenCurrentWait(),
    }
    await act(async () => { await actions[action]() })
    expect(setError).toHaveBeenCalledExactlyOnceWith(error)
    expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error_set' }))
    if (action === 'edit')
      expect(context.dispatchMessages).toHaveBeenLastCalledWith({ type: 'reset', messages: [user, failed] })
  }
)


test('only an explicit negative acknowledgement permits rejected-delivery handling', async () => {
  const f = fixture()
  const onRejected = vi.fn()
  const onError = vi.fn()
  f.send.mockResolvedValueOnce({ accepted: false, error: 'not accepted' })
  await act(async () => { await f.result.current.sendRuntimePaneMessage({ address, message: 'one', clientMessageId: 'input' }, { onError, onRejected }) })
  expect(onRejected).toHaveBeenCalledTimes(1)
  onRejected.mockClear()
  f.send.mockRejectedValueOnce(new Error('transport receipt lost'))
  await act(async () => { await f.result.current.sendRuntimePaneMessage({ address, message: 'one', clientMessageId: 'input' }, { onError, onRejected }) })
  expect(onRejected).not.toHaveBeenCalled()
})


test.each([
  new RuntimeInputRejectedError('Upload failed before submission'),
  new GatewayRpcError('Invalid image', -32602, undefined, 'runtime-session', 'remote'),
])('guidance explicitly rejected before execution is retryable', async error => {
  const f = fixture()
  f.guide.mockRejectedValue(error)
  const result = await f.result.current.sendRuntimePaneGuidance({ address, message: '', clientGuidanceId: 'image-guidance' }, { onError: vi.fn() })
  expect(result).toMatchObject({ sent: false, rejected: true })
})

test('a transport timeout remains unknown even with an HTTP-like error code', async () => {
  const f = fixture()
  f.guide.mockRejectedValue(new GatewayRpcError('Timed out', 504, undefined, 'runtime-session', 'timeout'))
  const result = await f.result.current.sendRuntimePaneGuidance({ address, message: 'input', clientGuidanceId: 'timeout-guidance' }, { onError: vi.fn() })
  expect(result.sent).toBe(false)
  expect(result.rejected).not.toBe(true)
})


test.each([-32603, -32034])('remote outcome code %s is not proof that admission failed', async code => {
  const f = fixture()
  f.guide.mockRejectedValue(new GatewayRpcError('Unknown server outcome', code, undefined, 'runtime-session', 'remote'))
  const result = await f.result.current.sendRuntimePaneGuidance({ address, message: 'input', clientGuidanceId: 'unknown-remote' }, { onError: vi.fn() })
  expect(result.rejected).not.toBe(true)
})
