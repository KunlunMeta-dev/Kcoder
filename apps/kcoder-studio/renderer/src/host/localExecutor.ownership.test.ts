import { afterEach, expect, test, vi } from 'vitest'
import { registerRuntimeTransport } from '@/lib/runtime-transport'
import { createGatewayIpcHandler } from '@/kcoder/gatewayRuntimeInstall'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from '@/kcoder/gatewayRuntime.test-support'
import { ensureLocalExecutorStarted, LOCAL_EXECUTOR_COMMANDS } from './localExecutor'

const stops: (() => void)[] = []
afterEach(() => { while (stops.length) stops.pop()?.() })

test.each(['success', 'failure'])('a replacement transport starts its own preflight before the old %s settles', async outcome => {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const original = vi.fn(async () => { await gate; if (outcome === 'failure') throw new Error('original transport error'); return { ready: true, running: true, deviceId: 'original' } })
  const stopOriginal = registerRuntimeTransport(original); stops.push(stopOriginal)
  const first = ensureLocalExecutorStarted().then(value => value, error => error)
  stopOriginal()
  const replacement = vi.fn(async () => ({ ready: true, running: true, deviceId: 'replacement' }))
  stops.push(registerRuntimeTransport(replacement))
  const second = ensureLocalExecutorStarted()
  try {
    expect(replacement).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.ensure, undefined)
    await expect(second).resolves.toMatchObject({ deviceId: 'replacement' })
    finish()
    expect(await first).toMatchObject({ name: 'AbortError' })
  } finally { finish(); await Promise.allSettled([first, second]) }
})

test('concurrent current preflights reuse the Runtime directory and connection instead of a host-global result', async () => {
  let finish!: () => void
  const client = new FakeGatewayClient(null)
  client.connectGate = new Promise<void>(resolve => { finish = resolve })
  const loadServers = vi.fn(async () => [localGatewayServer()])
  const connect = vi.spyOn(client, 'connect')
  const runtime = createTestGatewayRuntime('owned-preflight', { loadServers, createClient: () => client })
  stops.push(registerRuntimeTransport(createGatewayIpcHandler(runtime)))
  const first = ensureLocalExecutorStarted(), second = ensureLocalExecutorStarted()
  try {
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    finish()
    expect(await first).toMatchObject({ ready: true })
    expect(await second).toMatchObject({ ready: true })
    expect(loadServers).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledOnce()
  } finally { finish(); await Promise.allSettled([first, second]); await runtime.disposeAsync() }
})

test('a current transport failure keeps its original error and a later call can recover', async () => {
  const failure = new Error('owned current handshake failure')
  const handler = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ ready: true, running: true, deviceId: 'recovered' })
  stops.push(registerRuntimeTransport(handler))
  await expect(ensureLocalExecutorStarted()).rejects.toBe(failure)
  await expect(ensureLocalExecutorStarted()).resolves.toMatchObject({ deviceId: 'recovered' })
})
