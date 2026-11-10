import { expect, test, vi } from 'vitest'
import {
  readContinuousWork,
  readContinuousWorkCapabilities,
  readContinuousWorks,
  submitContinuousWorkControl,
} from './continuousWorks'
import { GatewayRpcError } from '../../gatewayRpc'
import type { GatewayRuntimeCore } from './core'

test('reads bounded native pages and rejects a changed target', async () => {
  const server = {
    id: 'owned-target',
    transport: 'local',
    workspacePath: '/owned',
    command: 'kcoder',
  }
  const work = (id: string) => ({
    workId: id,
    threadId: 'thread-1',
    phase: 'pending',
    freshness: 'partial',
    revision: 1,
    requirementsRevision: 1,
  })
  const request = vi
    .fn()
    .mockResolvedValueOnce({ items: [work('work-1')], nextCursor: 'work-1' })
    .mockResolvedValueOnce({ items: [work('work-2')] })
  const client = { supportsExperimental: () => true, request }
  const runtime = {
    disposed: false,
    workspaceScanGeneration: 0,
    tasks: new Map([['task', { serverId: 'owned-target', workspacePath: '/owned' }]]),
    serverForParams: vi.fn().mockResolvedValue(server),
    withTransientClient: async (
      _server: unknown,
      run: (value: typeof client) => Promise<unknown>
    ) => run(client),
  } as unknown as GatewayRuntimeCore
  const result = await readContinuousWorks(runtime, {
    deviceId: 'owned-target',
    workspacePath: '/owned',
  })
  expect(result.status).toBe('complete')
  expect(result.items.map(item => item.workId)).toEqual(['work-1', 'work-2'])
  expect(request).toHaveBeenLastCalledWith(
    'work/list',
    { cursor: 'work-1', allowPartial: true },
    expect.anything()
  )

  request
    .mockReset()
    .mockResolvedValueOnce({ items: [], nextCursor: 'work-skipped', partial: true })
    .mockResolvedValueOnce({ items: [work('work-2')] })
  const partial = await readContinuousWorks(runtime, {
    deviceId: 'owned-target',
    workspacePath: '/owned',
  })
  expect(partial.incomplete).toBe(true)
  expect(partial.items.map(item => item.workId)).toEqual(['work-2'])
  expect(request).toHaveBeenLastCalledWith(
    'work/list',
    { cursor: 'work-skipped', allowPartial: true },
    expect.anything()
  )

  request
    .mockReset()
    .mockRejectedValueOnce(new GatewayRpcError('old gateway', -32602))
    .mockResolvedValueOnce({ items: [work('work-1')] })
  const legacy = await readContinuousWorks(runtime, {
    deviceId: 'owned-target',
    workspacePath: '/owned',
  })
  expect(legacy.items.map(item => item.workId)).toEqual(['work-1'])
  expect(request).toHaveBeenLastCalledWith('work/list', {}, expect.anything())

  const changed = { ...server, settingsFile: '/other/settings.json' }
  vi.mocked(runtime.serverForParams)
    .mockResolvedValueOnce(server as never)
    .mockResolvedValue(changed as never)
  request.mockReset().mockResolvedValue({ items: [work('work-1')] })
  await expect(
    readContinuousWorks(runtime, { deviceId: 'owned-target', workspacePath: '/owned' })
  ).rejects.toThrow()
})

function controlRuntime(
  capabilities: { read?: boolean; input?: boolean; control?: boolean },
  request: ReturnType<typeof vi.fn>
) {
  const server = {
    id: 'owned-target',
    transport: 'local',
    workspacePath: '/owned',
    command: 'kcoder',
  }
  const client = {
    supportsExperimental: (name: string) =>
      name === 'continuousWorkReadV1'
        ? capabilities.read === true
        : name === 'continuousWorkInputV1'
          ? capabilities.input === true
          : name === 'continuousWorkControlV1'
            ? capabilities.control === true
            : false,
    request,
  }
  const runtime = {
    disposed: false,
    workspaceScanGeneration: 0,
    tasks: new Map([['task', { serverId: 'owned-target', workspacePath: '/owned' }]]),
    serverForParams: vi.fn().mockResolvedValue(server),
    withTransientClient: async (
      _server: unknown,
      run: (value: typeof client) => Promise<unknown>
    ) => run(client),
  } as unknown as GatewayRuntimeCore
  return runtime
}

const controlParams = {
  deviceId: 'owned-target',
  workspacePath: '/owned',
  threadId: 'thread-1',
  workId: 'work-1',
  requestId: 'control-1',
  expectedRevision: 3,
  action: 'stop',
  target: { kind: 'work' },
}

const controlReply = {
  workId: 'work-1',
  requestId: 'control-1',
  action: 'stop',
  target: { kind: 'work' },
  revision: 4,
  controlEpoch: 2,
  state: 'settling',
}

test('capabilities follow the negotiated names and never imply unsupported support', async () => {
  const request = vi.fn()
  const none = await readContinuousWorkCapabilities(
    controlRuntime({}, request),
    { deviceId: 'owned-target' }
  )
  expect(none).toEqual({ status: 'unsupported', read: false, input: false, control: false })

  const partial = await readContinuousWorkCapabilities(
    controlRuntime({ read: true }, request),
    { deviceId: 'owned-target' }
  )
  expect(partial).toEqual({ status: 'ready', read: true, input: false, control: false })

  const full = await readContinuousWorkCapabilities(
    controlRuntime({ read: true, input: true, control: true }, request),
    { deviceId: 'owned-target' }
  )
  expect(full).toEqual({ status: 'ready', read: true, input: true, control: true })
  expect(request).not.toHaveBeenCalled()
})

test('a control submission sends exactly one request and reports the observed state', async () => {
  const request = vi.fn().mockResolvedValue(controlReply)
  const outcome = await submitContinuousWorkControl(
    controlRuntime({ read: true, control: true }, request),
    controlParams
  )
  expect(outcome).toEqual({
    state: 'settling',
    workId: 'work-1',
    requestId: 'control-1',
    revision: 4,
    controlEpoch: 2,
  })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith(
    'work/control',
    {
      threadId: 'thread-1',
      workId: 'work-1',
      requestId: 'control-1',
      expectedRevision: 3,
      action: 'stop',
      target: { kind: 'work' },
    },
    expect.anything()
  )
})

test('unnegotiated control sends nothing and an unverifiable reply stays unknown', async () => {
  const supported = vi.fn()
  const unsupported = await submitContinuousWorkControl(
    controlRuntime({ read: true }, supported),
    controlParams
  )
  expect(unsupported).toEqual({ state: 'unsupported', workId: 'work-1', requestId: 'control-1' })
  expect(supported).not.toHaveBeenCalled()

  for (const [error, state] of [
    [new GatewayRpcError('unavailable', -32601), 'unsupported'],
    [new GatewayRpcError('invalid', -32602), 'invalid'],
    [new Error('transport lost'), 'unknown'],
    [new GatewayRpcError('unknown outcome', -32034), 'unknown'],
  ] as const) {
    const request = vi.fn().mockRejectedValueOnce(error)
    const outcome = await submitContinuousWorkControl(
      controlRuntime({ read: true, control: true }, request),
      controlParams
    )
    expect(outcome.state).toBe(state)
    expect(request).toHaveBeenCalledTimes(1)
  }

  const mismatched = vi
    .fn()
    .mockResolvedValue({ ...controlReply, requestId: 'another-request', state: 'settled' })
  const unknown = await submitContinuousWorkControl(
    controlRuntime({ read: true, control: true }, mismatched),
    controlParams
  )
  expect(unknown.state).toBe('unknown')
  expect(mismatched).toHaveBeenCalledTimes(1)

  const futureState = vi.fn().mockResolvedValue({ ...controlReply, state: 'future_state' })
  const observed = await submitContinuousWorkControl(
    controlRuntime({ read: true, control: true }, futureState),
    controlParams
  )
  expect(observed.state).toBe('unknown')
})

test('an action that cannot target a work is rejected before any request', async () => {
  const request = vi.fn()
  await expect(
    submitContinuousWorkControl(controlRuntime({ read: true, control: true }, request), {
      ...controlParams,
      action: 'cancel_run',
      target: { kind: 'work' },
    })
  ).rejects.toThrow('CONTINUOUS_WORK_REQUEST_INVALID')
  await expect(
    submitContinuousWorkControl(controlRuntime({ read: true, control: true }, request), {
      ...controlParams,
      expectedRevision: 0,
    })
  ).rejects.toThrow('CONTINUOUS_WORK_REQUEST_INVALID')
  expect(request).not.toHaveBeenCalled()
})

test('re-reading a work is the only recovery path and reports absence honestly', async () => {
  const work = {
    workId: 'work-1',
    threadId: 'thread-1',
    phase: 'paused',
    freshness: 'partial',
    revision: 4,
    requirementsRevision: 2,
  }
  const ready = vi.fn().mockResolvedValue({ work, presence: 'present' })
  expect(
    await readContinuousWork(controlRuntime({ read: true }, ready), {
      deviceId: 'owned-target',
      workspacePath: '/owned',
      workId: 'work-1',
    })
  ).toEqual({ status: 'ready', work })

  const absent = vi.fn().mockResolvedValue({ work: null, presence: 'confirmed_absent' })
  expect(
    await readContinuousWork(controlRuntime({ read: true }, absent), {
      deviceId: 'owned-target',
      workspacePath: '/owned',
      workId: 'work-1',
    })
  ).toEqual({ status: 'absent' })

  const unsupportedClient = vi.fn()
  expect(
    await readContinuousWork(controlRuntime({}, unsupportedClient), {
      deviceId: 'owned-target',
      workspacePath: '/owned',
      workId: 'work-1',
    })
  ).toEqual({ status: 'unsupported' })
  expect(unsupportedClient).not.toHaveBeenCalled()
})
