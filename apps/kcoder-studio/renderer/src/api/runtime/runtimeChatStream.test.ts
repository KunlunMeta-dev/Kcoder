import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'
import { createRuntimeChatStream, setRuntimeChatStreamDebugEnabled } from './runtimeChatStream'

describe('createRuntimeChatStream', () => {
  const subscribe = vi.fn()
  const request = vi.fn()

  beforeEach(() => {
    subscribe.mockReset()
    subscribe.mockResolvedValue(vi.fn())
    request.mockReset()
    localStorage.clear()
  })

  test('account invalidation erases pending content only for that target', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => { listener = handler; return vi.fn() })
    const stream = createRuntimeChatStream({ subscribe, request })
    for (const deviceId of ['account', 'other']) listener({ event: 'response.output_text.delta', payload: {
      deviceId, taskId: 'task', subtaskId: 'turn', data: { delta: deviceId + '-private' },
    } })
    listener({ event: 'executor.account_context_invalidated', payload: { deviceId: 'account' } })
    const account = vi.fn(), other = vi.fn()
    const closeA = stream.subscribe({ scope: { deviceId: 'account', taskId: 'task' }, onChatChunk: account })
    const closeB = stream.subscribe({ scope: { deviceId: 'other', taskId: 'task' }, onChatChunk: other })
    expect(account).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledWith(expect.objectContaining({ content: 'other-private' }))
    closeA(); closeB()
  })

  test('maps executor text delta events to chat chunks', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onChatChunk = vi.fn()
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({ onChatChunk })
    await Promise.resolve()
    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { delta: 'hello', offset: 0 },
      },
    })

    expect(onChatChunk).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '1001',
      deviceId: 'local-device',
      content: 'hello',
      offset: 0,
      result: { delta: 'hello', offset: 0 },
    })
  })

  test('forwards task-plan events outside a subscription scope for task-level caching', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onRuntimePlanUpdated = vi.fn()
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({
      scope: { deviceId: 'local-device', taskId: 'previous-task' },
      onRuntimePlanUpdated,
    })
    await Promise.resolve()
    listener({
      event: 'runtime.plan.updated',
      payload: {
        taskId: 'new-task',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: {
          plan: [{ step: 'Inspect', status: 'inProgress' }],
        },
      },
    })

    expect(onRuntimePlanUpdated).toHaveBeenCalledWith({
      taskId: 'new-task',
      subtaskId: '1001',
      deviceId: 'local-device',
      threadId: undefined,
      turnId: undefined,
      explanation: undefined,
      plan: [{ step: 'Inspect', status: 'inProgress' }],
    })
  })

  test('does not log every text delta event', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({ onChatChunk: vi.fn() })
    await Promise.resolve()
    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { delta: 'hello', offset: 0 },
      },
    })

    expect(
      consoleDebug.mock.calls.some(call => call[0] === '[KCoder Studio] Runtime chat stream event')
    ).toBe(false)

    consoleDebug.mockRestore()
  })

  test('does not log every block update event', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({ onBlockUpdated: vi.fn() })
    await Promise.resolve()
    listener({
      event: 'response.block.updated',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { block: { id: 'block-1', type: 'tool', status: 'running' } },
      },
    })

    expect(
      consoleDebug.mock.calls.some(call => call[0] === '[KCoder Studio] Runtime chat stream event')
    ).toBe(false)

    consoleDebug.mockRestore()
  })

  test('logs local stream lifecycle only when stream debug is enabled', async () => {
    subscribe.mockImplementation(async () => vi.fn())
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const stream = createRuntimeChatStream({ subscribe, request })

    const cleanupWithoutDebug = stream.subscribe({ onChatChunk: vi.fn() })
    cleanupWithoutDebug()
    expect(consoleDebug).not.toHaveBeenCalledWith(
      '[KCoder Studio] Runtime chat stream subscription',
      expect.anything()
    )

    setRuntimeChatStreamDebugEnabled(true)
    const cleanupWithDebug = stream.subscribe({ onChatChunk: vi.fn() })
    cleanupWithDebug()

    expect(consoleDebug).toHaveBeenCalledWith(
      '[KCoder Studio] Runtime chat stream subscription',
      expect.objectContaining({ action: 'subscribed' })
    )

    consoleDebug.mockRestore()
  })

  test('maps executor terminal events to chat done callbacks', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onChatDone = vi.fn()
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({ onChatDone })
    await Promise.resolve()
    listener({
      event: 'response.completed',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { value: 'complete' },
      },
    })

    expect(onChatDone).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '1001',
      deviceId: 'local-device',
      result: { value: 'complete' },
    })
    expect(consoleInfo).toHaveBeenCalledWith(
      '[KCoder Studio] Runtime chat stream terminal event received',
      expect.objectContaining({
        event: 'response.completed',
        taskId: 'task-1',
        matchedSubscriptionCount: 1,
      })
    )
    consoleInfo.mockRestore()
  })

  test('opens the local executor listener before a task pane subscribes', () => {
    const stream = createRuntimeChatStream({ subscribe, request })
    const cleanup = stream.subscribe({ onDeviceStatus: vi.fn() })

    expect(subscribe).toHaveBeenCalledTimes(1)

    cleanup()
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  test('replays a fast first turn that arrives before its scoped pane subscribes', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const stream = createRuntimeChatStream({ subscribe, request })
    await Promise.resolve()

    listener({
      event: 'response.created',
      payload: { taskId: 'fast-task', subtaskId: 'turn-1', deviceId: 'local-device', data: {} },
    })
    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'fast-task',
        subtaskId: 'turn-1',
        deviceId: 'local-device',
        data: { delta: 'fast answer' },
      },
    })
    listener({
      event: 'response.completed',
      payload: {
        taskId: 'fast-task',
        subtaskId: 'turn-1',
        deviceId: 'local-device',
        data: { value: 'fast answer' },
      },
    })

    const onChatStart = vi.fn()
    const onChatChunk = vi.fn()
    const onChatDone = vi.fn()
    stream.subscribe({
      scope: { taskId: 'fast-task', deviceId: 'local-device' },
      onChatStart,
      onChatChunk,
      onChatDone,
    })

    expect(onChatStart).toHaveBeenCalledTimes(1)
    expect(onChatChunk).toHaveBeenCalledWith(expect.objectContaining({ content: 'fast answer' }))
    expect(onChatDone).toHaveBeenCalledWith(
      expect.objectContaining({ result: { value: 'fast answer' } })
    )
  })

  test('keeps fast events for a late scoped pane when an unscoped subscriber is already active', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const stream = createRuntimeChatStream({ subscribe, request })
    const unscopedChunk = vi.fn()
    stream.subscribe({ onChatChunk: unscopedChunk })
    await Promise.resolve()

    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'late-task',
        subtaskId: 'turn-1',
        deviceId: 'local-device',
        data: { delta: 'buffered answer' },
      },
    })

    const scopedChunk = vi.fn()
    stream.subscribe({
      scope: { taskId: 'late-task', deviceId: 'local-device' },
      onChatChunk: scopedChunk,
    })

    expect(unscopedChunk).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'buffered answer' })
    )
    expect(scopedChunk).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'buffered answer' })
    )
  })

  test('requests an authoritative reset instead of replaying a truncated buffered stream', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const stream = createRuntimeChatStream({ subscribe, request })
    await Promise.resolve()
    for (let index = 0; index < 520; index++)
      listener({
        event: 'response.output_text.delta',
        payload: {
          taskId: 'overflow-task',
          subtaskId: 'turn-1',
          deviceId: 'local-device',
          data: { delta: `fragment-${index}` },
        },
      })
    const onStreamGap = vi.fn()
    const onChatChunk = vi.fn()
    stream.subscribe({
      scope: { taskId: 'overflow-task', deviceId: 'local-device' },
      onStreamGap,
      onChatChunk,
    })
    expect(onStreamGap).toHaveBeenCalledTimes(1)
    expect(onChatChunk).not.toHaveBeenCalled()
    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'overflow-task',
        subtaskId: 'turn-2',
        deviceId: 'local-device',
        data: { delta: 'new turn' },
      },
    })
    expect(onChatChunk).toHaveBeenCalledWith(expect.objectContaining({ content: 'new turn' }))
  })

  test('keeps reset markers for a history-capable subscriber without discarding other targets', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const stream = createRuntimeChatStream({ subscribe, request })
    await Promise.resolve()
    const emit = (deviceId: string, text: string) =>
      listener({
        event: 'response.output_text.delta',
        payload: {
          taskId: 'shared-id',
          subtaskId: 'turn-1',
          deviceId,
          data: { delta: text },
        },
      })
    for (let index = 0; index < 513; index++) emit('target-a', 'lost')
    emit('target-b', 'unaffected')
    const observer = stream.subscribe({
      scope: { taskId: 'shared-id', deviceId: 'target-a' },
      onChatChunk: vi.fn(),
    })
    observer()
    const reset = vi.fn()
    const otherReset = vi.fn()
    const otherChunk = vi.fn()
    stream.subscribe({
      scope: { taskId: 'shared-id', deviceId: 'target-b' },
      onStreamGap: otherReset,
      onChatChunk: otherChunk,
    })
    expect(otherReset).not.toHaveBeenCalled()
    expect(otherChunk).toHaveBeenCalledWith(expect.objectContaining({ content: 'unaffected' }))
    stream.subscribe({ scope: { taskId: 'shared-id', deviceId: 'target-a' }, onStreamGap: reset })
    expect(reset).toHaveBeenCalledTimes(1)
  })

  test('drops buffered events from the previous runtime before a late pane subscribes', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const stream = createRuntimeChatStream({ subscribe, request })
    await Promise.resolve()

    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'recovered-task',
        subtaskId: 'old-turn',
        deviceId: 'local-device',
        data: { delta: 'old runtime answer' },
      },
    })
    listener({
      event: 'executor.runtime_replaced',
      payload: { previousRuntimeInstanceId: 'runtime-old', runtimeInstanceId: 'runtime-new' },
    })

    const onChatChunk = vi.fn()
    stream.subscribe({
      scope: { taskId: 'recovered-task', deviceId: 'local-device' },
      onChatChunk,
    })
    expect(onChatChunk).not.toHaveBeenCalled()

    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'recovered-task',
        subtaskId: 'new-turn',
        deviceId: 'local-device',
        data: { delta: 'new runtime answer' },
      },
    })
    expect(onChatChunk).toHaveBeenCalledTimes(1)
    expect(onChatChunk).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'new runtime answer' })
    )
  })

  test('rejects scoped response events with missing task or device identity', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const onChatChunk = vi.fn()
    const stream = createRuntimeChatStream({ subscribe, request })
    stream.subscribe({
      scope: { taskId: 'task-1', deviceId: 'local-device' },
      onChatChunk,
    })
    await Promise.resolve()

    listener({
      event: 'response.output_text.delta',
      payload: { subtaskId: 'turn-1', deviceId: 'local-device', data: { delta: 'no task' } },
    })
    listener({
      event: 'response.output_text.delta',
      payload: { taskId: 'task-1', subtaskId: 'turn-1', data: { delta: 'no device' } },
    })

    expect(onChatChunk).not.toHaveBeenCalled()
  })

  test('shares one native event listener across multiple stream subscribers', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    const unlisten = vi.fn()
    subscribe.mockImplementation(async handler => {
      listener = handler
      return unlisten
    })
    const firstChunk = vi.fn()
    const secondChunk = vi.fn()
    const stream = createRuntimeChatStream({ subscribe, request })

    const cleanupFirst = stream.subscribe({ onChatChunk: firstChunk })
    const cleanupSecond = stream.subscribe({ onChatChunk: secondChunk })
    await Promise.resolve()

    expect(subscribe).toHaveBeenCalledTimes(1)
    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { delta: 'hello', offset: 0 },
      },
    })

    expect(firstChunk).toHaveBeenCalledTimes(1)
    expect(secondChunk).toHaveBeenCalledTimes(1)

    cleanupFirst()
    expect(unlisten).not.toHaveBeenCalled()
    cleanupSecond()
    expect(unlisten).not.toHaveBeenCalled()
  })

  test('routes scoped events only to matching stream subscribers', async () => {
    let listener!: (event: LocalExecutorEvent) => void
    subscribe.mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    })
    const firstChunk = vi.fn()
    const secondChunk = vi.fn()
    const stream = createRuntimeChatStream({ subscribe, request })

    stream.subscribe({
      scope: { deviceId: 'local-device', taskId: 'task-1' },
      onChatChunk: firstChunk,
    })
    stream.subscribe({
      scope: { deviceId: 'local-device', taskId: 'task-2' },
      onChatChunk: secondChunk,
    })
    await Promise.resolve()

    listener({
      event: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: '1001',
        deviceId: 'local-device',
        data: { delta: 'hello', offset: 0 },
      },
    })

    expect(firstChunk).toHaveBeenCalledTimes(1)
    expect(secondChunk).not.toHaveBeenCalled()
  })

  test('keeps a late native listener active when no pane is subscribed', async () => {
    let resolveSubscribe!: (unlisten: () => void) => void
    const unlisten = vi.fn()
    subscribe.mockImplementation(
      () =>
        new Promise<() => void>(resolve => {
          resolveSubscribe = resolve
        })
    )
    const stream = createRuntimeChatStream({ subscribe, request })

    const cleanup = stream.subscribe({ onChatChunk: vi.fn() })
    cleanup()
    resolveSubscribe(unlisten)
    await Promise.resolve()

    expect(unlisten).not.toHaveBeenCalled()
  })

  test('routes guidance and cancel requests through app ipc', async () => {
    request.mockResolvedValueOnce({ success: true, guidance_id: 'guide-1' })
    request.mockResolvedValueOnce({ success: true })
    const stream = createRuntimeChatStream({ subscribe, request })

    await expect(
      stream.sendGuidance({
        task_id: 0,
        subtask_id: 1001,
        team_id: 0,
        message: 'continue',
      })
    ).resolves.toEqual({ success: true, guidance_id: 'guide-1' })
    await expect(stream.cancelStream({ subtask_id: 1001 })).resolves.toEqual({ success: true })

    expect(request).toHaveBeenNthCalledWith(1, 'runtime.tasks.guidance', {
      task_id: 0,
      subtask_id: 1001,
      team_id: 0,
      message: 'continue',
    })
    expect(request).toHaveBeenNthCalledWith(2, 'runtime.tasks.cancel', { subtask_id: 1001 })
  })
})
