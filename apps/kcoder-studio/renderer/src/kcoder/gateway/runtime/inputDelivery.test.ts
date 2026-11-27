import { expect, test, vi } from 'vitest'
import { inputDelivery } from './inputDelivery'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { notifyAccountContextChange } from '../../accountContextEvents'

function fixture() {
  const task = {
    taskId: 'task',
    serverId: 'delivery-server',
    threadId: 'thread',
    workspacePath: '/workspace',
  }
  let status: string | null = 'running'
  const client = {
    supportsExperimental: () => true,
    request: vi.fn(async (method: string) => {
      if (method === 'turn/receipt/read')
        return { receipt: status ? { threadId: 'thread', turnId: 'original-turn', status } : null }
      status = 'interrupted'
      return { interrupted: true }
    }),
  }
  const core = {
    tasks: new Map([['task', task]]),
    clientByTask: new Map([['task', client]]),
    appServerDisconnectedClients: new Set(),
    configurationEpochByTarget: new Map(),
    resolveTaskId: (id: string) => id,
    taskConnection: vi.fn(async () => ({ taskId: 'task', task, client })),
  } as unknown as GatewayRuntimeCore
  const params = {
    address: {
      deviceId: task.serverId,
      taskId: task.taskId,
      threadId: task.threadId,
      workspacePath: '/workspace',
    },
    clientMessageId: 'input-one',
    action: 'cancel',
  }
  return {
    core,
    task,
    client,
    params,
    status: (value: string | null) => {
      status = value
    },
  }
}

test('cancellation reads the original receipt and interrupts only its exact turn', async () => {
  const f = fixture()
  expect(await inputDelivery(f.core, f.params)).toEqual({
    status: 'interrupted',
    turnId: 'original-turn',
  })
  expect(f.client.request).toHaveBeenCalledWith('turn/receipt/read', {
    threadId: 'thread',
    clientMessageId: 'input-one',
  })
  expect(f.client.request).toHaveBeenCalledWith('turn/interrupt', {
    threadId: 'thread',
    turnId: 'original-turn',
  })
})

test.each(['completed', 'failed', 'interrupted'])(
  'a %s input is never interrupted or replayed',
  async status => {
    const f = fixture()
    f.status(status)
    expect((await inputDelivery(f.core, f.params)).status).toBe(
      status === 'failed' ? 'execution_failed' : status
    )
    expect(f.client.request).toHaveBeenCalledTimes(1)
  }
)

test('absence or an unreadable receipt stays unknown and never authorizes a mutation', async () => {
  const f = fixture()
  f.status(null)
  expect(await inputDelivery(f.core, f.params)).toEqual({ status: 'unknown' })
  expect(f.client.request).toHaveBeenCalledTimes(1)
})

test('completion racing with cancellation wins without stopping the new turn', async () => {
  const f = fixture()
  f.client.request.mockImplementation(async method => {
    if (method === 'turn/interrupt') {
      f.status('completed')
      return { interrupted: false }
    }
    return {
      receipt: {
        threadId: 'thread',
        turnId: 'original-turn',
        status: f.client.request.mock.calls.length === 1 ? 'running' : 'completed',
      },
    }
  })
  expect((await inputDelivery(f.core, f.params)).status).toBe('completed')
  expect(f.client.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toEqual([
    ['turn/interrupt', { threadId: 'thread', turnId: 'original-turn' }],
  ])
})

test('an interrupt acknowledgement alone is not proof of terminal cancellation', async () => {
  const f = fixture()
  f.client.request.mockImplementation(async method =>
    method === 'turn/interrupt'
      ? { interrupted: true }
      : { receipt: { threadId: 'thread', turnId: 'original-turn', status: 'running' } }
  )
  expect(await inputDelivery(f.core, f.params)).toEqual({
    status: 'running',
    turnId: 'original-turn',
  })
})

test.each(['device', 'thread', 'workspace'])(
  'a stale %s address cannot read or stop another owner',
  async field => {
    const f = fixture()
    if (field === 'device') f.params.address.deviceId = 'other'
    if (field === 'thread') f.params.address.threadId = 'other'
    if (field === 'workspace') f.params.address.workspacePath = '/other'
    await expect(inputDelivery(f.core, f.params)).rejects.toThrow('owner changed')
    expect(f.client.request).not.toHaveBeenCalled()
  }
)

test('an account change during receipt lookup prevents the subsequent interrupt', async () => {
  const f = fixture()
  f.client.request.mockImplementation(async () => {
    notifyAccountContextChange(f.task.serverId)
    return { receipt: { threadId: 'thread', turnId: 'original-turn', status: 'running' } }
  })
  await expect(inputDelivery(f.core, f.params)).rejects.toThrow('owner changed')
  expect(f.client.request).toHaveBeenCalledTimes(1)
})

test.each(['replacement', 'disconnect'])('a %s during the receipt read cannot project its result or interrupt', async change => {
  const f = fixture()
  f.client.request.mockImplementation(async () => {
    if (change === 'replacement') f.core.clientByTask.set(f.task.taskId, { ...f.client } as unknown as GatewayClient)
    else f.core.appServerDisconnectedClients.add(f.client as unknown as GatewayClient)
    return { receipt: { threadId: f.task.threadId, turnId: 'original-turn', status: 'running' } }
  })
  await expect(inputDelivery(f.core, f.params)).rejects.toThrow('owner changed')
  expect(f.client.request).toHaveBeenCalledTimes(1)
  expect(f.client.request).not.toHaveBeenCalledWith('turn/interrupt', expect.anything())
})

test('legacy pane addresses resolve their thread from the original task binding', async () => {
  const f = fixture()
  const address: Record<string, unknown> = { ...f.params.address }
  delete address.threadId
  expect((await inputDelivery(f.core, { ...f.params, address })).status).toBe('interrupted')
  expect(f.client.request).toHaveBeenCalledWith('turn/interrupt', {
    threadId: 'thread',
    turnId: 'original-turn',
  })
})

test('an original turn fence prevents a changed receipt mapping from stopping a replacement', async () => {
  const f = fixture()
  expect(await inputDelivery(f.core, { ...f.params, expectedTurnId: 'older-turn' })).toEqual({
    status: 'unknown',
    turnId: 'older-turn',
  })
  expect(f.client.request).toHaveBeenCalledTimes(1)
})

test.each(['', 'x'.repeat(1025)])(
  'an invalid turn fence is rejected before any RPC',
  async expectedTurnId => {
    const f = fixture()
    await expect(inputDelivery(f.core, { ...f.params, expectedTurnId })).rejects.toThrow(
      'Invalid input delivery identity'
    )
    expect(f.core.taskConnection).not.toHaveBeenCalled()
    expect(f.client.request).not.toHaveBeenCalled()
  }
)

test.each([
  ['queued', 'accepted'], ['applied', 'applied'],
])('guidance %s uses its mailbox receipt without interrupting its containing turn', async (status, expected) => {
  const f = fixture()
  f.client.request.mockResolvedValue({ receipt: { threadId: 'thread', clientMessageId: 'input-one', turnId: 'original-turn', status } })
  expect(await inputDelivery(f.core, { ...f.params, action: 'read', deliveryMode: 'guidance' })).toEqual(expected === 'accepted' ? { status: expected } : { status: expected, turnId: 'original-turn' })
  expect(f.client.request).toHaveBeenCalledExactlyOnceWith('turn/steer/receipt/read', { threadId: 'thread', clientMessageId: 'input-one' })
})

test('cancel intent on a queued steer does not interrupt its containing turn', async () => {
  const f = fixture()
  f.client.request.mockResolvedValue({ receipt: { threadId: 'thread', clientMessageId: 'input-one', turnId: 'original-turn', status: 'queued' } })
  expect(await inputDelivery(f.core, { ...f.params, deliveryMode: 'guidance' })).toEqual({ status: 'accepted' })
  expect(f.client.request).toHaveBeenCalledTimes(1)
})


test('a dropped steer does not prove that its automatic fallback was rejected', async () => {
  const f = fixture()
  f.client.request.mockImplementation(async method => method === 'turn/steer/receipt/read'
    ? { receipt: { threadId: 'thread', clientMessageId: 'input-one', turnId: 'original-turn', status: 'dropped' } }
    : { receipt: null })
  expect(await inputDelivery(f.core, { ...f.params, deliveryMode: 'guidance' })).toEqual({ status: 'unknown' })
  expect(f.client.request.mock.calls.map(([method]) => method)).toEqual(['turn/steer/receipt/read', 'turn/receipt/read'])
})


test('a dropped steer may resolve to its original-ID fallback on another turn', async () => {
  const f = fixture()
  f.client.request.mockImplementation(async method => method === 'turn/steer/receipt/read'
    ? { receipt: { threadId: 'thread', clientMessageId: 'input-one', turnId: 'original-turn', status: 'dropped' } }
    : { receipt: { threadId: 'thread', turnId: 'fallback-turn', status: 'running' } })
  expect(await inputDelivery(f.core, { ...f.params, action: 'read', deliveryMode: 'guidance' })).toEqual({ status: 'running', turnId: 'fallback-turn' })
})


test.each(['configuration', 'connection'] as const)('a changed %s during receipt lookup cannot publish or interrupt', async boundary => {
  const f = fixture()
  const connection = { connectionId: 'original-socket' }
  Object.assign(f.client, { diagnosticConnection: connection })
  f.client.request.mockImplementation(async () => {
    if (boundary === 'configuration') f.core.configurationEpochByTarget.set(f.task.serverId, {})
    else connection.connectionId = 'replacement-socket'
    return { receipt: { threadId: f.task.threadId, turnId: 'original-turn', status: 'running' } }
  })
  await expect(inputDelivery(f.core, f.params)).rejects.toThrow('owner changed')
  expect(f.client.request.mock.calls.map(([method]) => method)).toEqual(['turn/receipt/read'])
})


test('a configuration change while acquiring the task connection prevents the first receipt RPC', async () => {
  const f = fixture()
  f.core.taskConnection = vi.fn(async () => {
    f.core.configurationEpochByTarget.set(f.task.serverId, {})
    return { taskId: f.task.taskId, task: f.task, client: f.client }
  }) as unknown as typeof f.core.taskConnection
  await expect(inputDelivery(f.core, f.params)).rejects.toThrow('owner changed')
  expect(f.client.request).not.toHaveBeenCalled()
})
