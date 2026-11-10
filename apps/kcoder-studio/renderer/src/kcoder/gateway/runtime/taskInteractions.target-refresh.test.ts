import { expect, test, vi } from 'vitest'
import { captureTaskInteraction, readTaskInteractions, respondTaskInteraction } from './taskInteractions'
import { respondToTaskQuestion } from './interactions'
import { assertCommandOwner, refreshCommandDirectory } from './connections'
import type { GatewayRuntimeCore } from './core'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => {}) }))

async function fixture() {
  const taskId = 'original-task', requestId = 2000001
  const frame = { serverId: 'native', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch' }
  const client = { supportsExperimental: () => true,
    request: vi.fn(async (_method, selector) => ({ ...selector, status: 'pending' })), respond: vi.fn() }
  const pending = { client, taskId, requestId, turnId: frame.turnId, questionId: 'question', block: { id: 'block' },
    renderPayload: { questions: [{ id: 'choice', header: 'Mode', question: 'Which mode?', isOther: false,
      options: [{ label: 'Continue', description: 'Original task' }] }] } }
  const task = { taskId, serverId: 'target', threadId: frame.threadId, workspacePath: '/owned',
    runtimeHandle: { memoryTaskSnapshot: { ...frame, attemptId: 'attempt', serverInstanceId: frame.serverId } } }
  const server = { id: task.serverId, transport: 'local', command: '/owned/kcoder', workspacePath: '/owned' }
  let finishDirectory!: (servers?: Array<typeof server>) => void
  const directory = new Promise<Array<typeof server>>(resolve => { finishDirectory = (servers = [server]) => resolve(servers) })
  const runtime = {
    disposed: false, tasks: new Map([[taskId, task]]), clientByTask: new Map([[taskId, client]]),
    threadByTask: new Map([[taskId, frame.threadId]]), appServerDisconnectedClients: new WeakSet(),
    activeTurnByTask: new Map([[taskId, { turnId: frame.turnId }]]),
    turnAttemptIds: new Map([[`${taskId}:${frame.turnId}`, 'attempt']]),
    pendingQuestionByKey: new Map([[`${taskId}\0${requestId}`, pending]]),
    taskDescriptor: async () => ({ taskId, task, server }), serverForParams: vi.fn(async () => server),
    assertCommandTarget: vi.fn(async () => undefined),
    commandDirectoryRefresh: new Map(), commandDirectorySequence: 0,
    configurationEpochByTarget: new Map(), commandClientByServer: new Map(), commandClientScopeByKey: new Map(),
    servers: () => directory, serversPromise: directory,
    respondToTaskQuestion: (id, response, expected) => respondToTaskQuestion.call(core, id, response, expected),
  }
  const core = runtime as unknown as GatewayRuntimeCore
  const address = { taskId, deviceId: task.serverId, threadId: frame.threadId, workspacePath: task.workspacePath }
  await captureTaskInteraction(core, client as never, taskId, frame, requestId)
  const reference = (await readTaskInteractions(core, { address })).items[0].reference
  const refresh = (targetId: string | undefined) => {
    refreshCommandDirectory.call(core, targetId, new Map())
    return runtime.commandDirectoryRefresh.get(targetId).result as Promise<unknown>
  }
  return { runtime, core, client, pending, taskId, requestId, frame, server, address, reference, refresh, finishDirectory }
}

function invoke(f: Awaited<ReturnType<typeof fixture>>, operation: 'status' | 'receipt' | 'answer') {
  return operation === 'answer'
    ? respondTaskInteraction(f.core, { address: f.address, response: {
        reference: f.reference, answers: { choice: { answers: ['Continue'] } },
      } })
    : readTaskInteractions(f.core, { address: f.address })
}

for (const targetId of ['target', undefined, 'unrelated-target']) {
  for (const operation of ['status', 'receipt', 'answer'] as const) {
    test(`${operation} fences a directory refresh at its final target lookup (${targetId})`, async () => {
      const f = await fixture()
      // Pause the existing lookup, then start a refresh in the helper/caller
      // continuation gap. No task/client replacement is needed for this race.
      let release!: (value: unknown) => void
      const at = operation === 'status' ? 1 : operation === 'receipt' ? 2 : 3
      const original = f.runtime.serverForParams.getMockImplementation()!
      for (let index = 1; index < at; index++) f.runtime.serverForParams.mockImplementationOnce(original)
      f.runtime.serverForParams.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      f.client.request.mockClear()
      const operationPromise = invoke(f, operation)
      const outcome = operationPromise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      release(await original())
      await Promise.resolve()
      const refreshing = f.refresh(targetId)
      try {
        const result = await outcome
        if (targetId === 'unrelated-target') {
          expect(result.error).toBeUndefined()
          expect(result.value).toMatchObject(operation === 'answer'
            ? { state: 'response_pending' } : { observationState: 'observed', items: [{ state: 'pending' }] })
        } else if (operation === 'answer') {
          expect(result.error?.message).toBe('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
          expect(f.client.respond).not.toHaveBeenCalled()
          expect(f.pending).not.toHaveProperty('responsePending')
        } else {
          expect(result.error?.message).toBe('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
          expect(result.value).toBeUndefined()
          expect(f.client.request).toHaveBeenCalledTimes(operation === 'status' ? 0 : 1)
        }
      } finally {
        f.finishDirectory()
        await refreshing
      }
      // A harmless completed refresh does not permanently invalidate capture.
      expect((await readTaskInteractions(f.core, { address: f.address })).items).toHaveLength(1)
    })
  }
}

for (const targetId of ['target', undefined]) {
  test.each(['status', 'receipt', 'answer'] as const)(
    `%s rechecks a refresh queued after the authority helper completes (${targetId})`, async operation => {
      const f = await fixture()
      const at = operation === 'status' ? 1 : operation === 'receipt' ? 2 : 3
      f.runtime.assertCommandTarget.mockClear()
      for (let index = 1; index < at; index++) f.runtime.assertCommandTarget.mockResolvedValueOnce(undefined)
      let release!: () => void
      f.runtime.assertCommandTarget.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      f.client.request.mockClear()
      const outcome = invoke(f, operation).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      release()
      await Promise.resolve()
      const refreshing = f.refresh(targetId)
      try {
        const result = await outcome
        if (operation === 'answer') {
          expect(result.error?.message).toBe('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
          expect(f.client.respond).not.toHaveBeenCalled()
        } else {
          expect(result.error?.message).toBe('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
          expect(result.value).toBeUndefined()
          expect(f.client.request).toHaveBeenCalledTimes(operation === 'status' ? 0 : 1)
        }
      } finally {
        f.finishDirectory()
        await refreshing
      }
    }
  )
}

test.each(['status', 'answer'] as const)('%s waits for the existing target authority refresh', async operation => {
  const f = await fixture()
  f.runtime.assertCommandTarget.mockImplementation(server => assertCommandOwner(f.core, server as never))
  f.runtime.assertCommandTarget.mockClear()
  f.client.request.mockClear()
  const refreshing = f.refresh('target')
  let settled = false
  const request = invoke(f, operation).finally(() => { settled = true })
  try {
    await vi.waitFor(() => expect(f.runtime.assertCommandTarget).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.client.respond).not.toHaveBeenCalled()
  } finally {
    f.finishDirectory()
    await refreshing
  }
  expect(await request).toMatchObject(operation === 'answer'
    ? { state: 'response_pending' } : { observationState: 'observed', items: [{ state: 'pending' }] })
})

test.each(['status', 'answer'] as const)('%s rejects a failed directory authority without sending', async operation => {
  const f = await fixture()
  const failed = Promise.reject(new Error('directory unavailable'))
  void failed.catch(() => undefined)
  f.runtime.commandDirectoryRefresh.set('target', { sequence: 1, result: failed })
  f.runtime.assertCommandTarget.mockImplementation(server => assertCommandOwner(f.core, server as never))
  f.client.request.mockClear()
  const outcome = await invoke(f, operation).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  expect(outcome.error).toBeInstanceOf(Error)
  expect(outcome.value).toBeUndefined()
  expect(f.client.request).not.toHaveBeenCalled()
  expect(f.client.respond).not.toHaveBeenCalled()
  expect(f.pending).not.toHaveProperty('responsePending')
})

test.each(['target', undefined])('a refresh during a later card read invalidates the whole old batch (%s)', async targetId => {
  const f = await fixture()
  const requestId = f.requestId + 1
  const second = { ...f.pending, requestId, questionId: 'second-question' }
  f.core.pendingQuestionByKey.set(`${f.taskId}\0${requestId}`, second as never)
  await captureTaskInteraction(f.core, f.client as never, f.taskId, f.frame, requestId)
  let release!: (value: unknown) => void
  f.client.request.mockImplementation(async (_method, selector) => selector.requestId === requestId
    ? await new Promise(resolve => { release = resolve })
    : { ...selector, status: 'pending' })
  const reading = readTaskInteractions(f.core, { address: f.address })
  const rejected = expect(reading).rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const refreshing = f.refresh(targetId)
  release({ ...f.reference.selector, requestId, questionId: 'second-question', status: 'pending' })
  // Complete the unchanged directory while the later card's helper is waiting;
  // its fresh check must not certify the earlier observation's old generation.
  f.finishDirectory()
  await refreshing
  await rejected
  expect(f.core.pendingQuestionByKey.size).toBe(2)
  expect(f.client.respond).not.toHaveBeenCalled()
})

test.each(['target', undefined])('a refresh after answer dispatch preserves unknown outcome without replay (%s)', async targetId => {
  const f = await fixture()
  let refreshing!: Promise<unknown>
  f.client.respond.mockImplementation(() => { refreshing = f.refresh(targetId) })
  try {
    expect(await invoke(f, 'answer')).toMatchObject({ state: 'unknown' })
    expect(f.client.respond).toHaveBeenCalledOnce()
    expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
    expect(f.pending).toMatchObject({ responsePending: true })
  } finally {
    f.finishDirectory()
    await refreshing
  }
  expect(await invoke(f, 'answer')).toMatchObject({ state: 'unknown' })
  expect(f.client.respond).toHaveBeenCalledOnce()
})


for (const boundary of ['serverForParams', 'assertCommandTarget'] as const) {
  for (const at of [1, 2]) {
    test(`failed ${boundary} at lookup ${at} rejects the refresh and recovers the original card`, async () => {
      const f = await fixture()
      const original = f.runtime[boundary].getMockImplementation()!
      for (let index = 1; index < at; index++) f.runtime[boundary].mockImplementationOnce(original as never)
      f.runtime[boundary].mockRejectedValueOnce(new Error('target authority unavailable'))
      f.client.request.mockClear()
      await expect(readTaskInteractions(f.core, { address: f.address }))
        .rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
      expect(f.client.request).toHaveBeenCalledTimes(at - 1)
      expect(f.client.respond).not.toHaveBeenCalled()
      expect(f.runtime.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
      expect(f.pending).not.toHaveProperty('responsePending')
      expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({
        observationState: 'observed', items: [{ reference: f.reference, state: 'pending' }],
      })
      expect(f.client.respond).not.toHaveBeenCalled()
    })

    test(`failed ${boundary} at lookup ${at} still hides an owner replaced while waiting`, async () => {
      const f = await fixture()
      const original = f.runtime[boundary].getMockImplementation()!
      for (let index = 1; index < at; index++) f.runtime[boundary].mockImplementationOnce(original as never)
      f.runtime[boundary].mockImplementationOnce(async () => {
        f.runtime.clientByTask.set(f.taskId, {} as never)
        throw new Error('old target lookup failed')
      })
      f.client.request.mockClear()
      expect(await readTaskInteractions(f.core, { address: f.address })).toMatchObject({
        observationState: 'unknown', items: [],
      })
      expect(f.client.request).toHaveBeenCalledTimes(at - 1)
      expect(f.client.respond).not.toHaveBeenCalled()
    })
  }
}

test('a later card target lookup failure rejects the complete refresh without a partial snapshot', async () => {
  const f = await fixture()
  const requestId = f.requestId + 1
  f.runtime.pendingQuestionByKey.set(`${f.taskId}\0${requestId}`,
    { ...f.pending, requestId, questionId: 'second-question' })
  await captureTaskInteraction(f.core, f.client as never, f.taskId, f.frame, requestId)
  f.runtime.serverForParams.mockResolvedValueOnce(f.server).mockResolvedValueOnce(f.server)
    .mockRejectedValueOnce(new Error('second card authority unavailable'))
  f.client.request.mockClear()
  await expect(readTaskInteractions(f.core, { address: f.address }))
    .rejects.toThrow('TASK_INTERACTION_ORIGINAL_OWNER_UNAVAILABLE')
  expect(f.client.request).toHaveBeenCalledOnce()
  expect(f.runtime.pendingQuestionByKey.size).toBe(2)
  expect((await readTaskInteractions(f.core, { address: f.address })).items).toHaveLength(2)
  expect(f.client.respond).not.toHaveBeenCalled()
})
