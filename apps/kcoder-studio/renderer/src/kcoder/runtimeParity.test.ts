import { afterEach, describe, expect, test, vi } from 'vitest'
import { GatewayRuntimeCore } from './gateway/runtime/core'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'

// The former source-marker guard applied to two divergent class copies. Both
// facades now share an owner and domain handlers. Cursor restart/-32041 behavior
// remains covered through both facades by gatewayRuntime.transcript-cursor tests;
// receipt/retry/resubmit contracts remain in the receipt/provider-failure suites.
// This guard prevents reintroducing a fork without relying on source spelling.
const runtimes: GatewayRuntimeCore[] = []
function create(Constructor: typeof Runtime | typeof InstalledRuntime) {
  const runtime = new Constructor('fixture-token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => new FakeGatewayClient('parity-thread'),
  })
  runtimes.push(runtime)
  return runtime
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.disposeAsync()))
  vi.restoreAllMocks()
})

describe('shared runtime contract across both compatibility facades', () => {
  test('the installed adapter inherits the same core exposed by the standalone facade', () => {
    expect(Runtime).toBe(GatewayRuntimeCore)
    expect(create(InstalledRuntime)).toBeInstanceOf(GatewayRuntimeCore)
  })

  test.each([
    'request',
    'loadTaskTranscript',
    'sendTask',
    'resumeTaskOnce',
    'forwardNotification',
    'forwardAcceptedNotification',
  ] as const)('both facades use the shared %s handler', method => {
    const standalone = create(Runtime)
    const installed = create(InstalledRuntime)
    expect(typeof standalone[method]).toBe('function')
    expect(installed[method]).toBe(standalone[method])
  })

  test('separate runtime instances never share connection owners or replay state', () => {
    const standalone = create(Runtime)
    const installed = create(InstalledRuntime)
    expect(installed.ownedRuntimeClients).not.toBe(standalone.ownedRuntimeClients)
    expect(installed.clientByTask).not.toBe(standalone.clientByTask)
    expect(installed.notificationReplayGuard).not.toBe(standalone.notificationReplayGuard)
  })

  test.each([Runtime, InstalledRuntime])(
    'a failed projection remains retryable and a successful replay is suppressed (%s)',
    async Constructor => {
      const runtime = create(Constructor)
      const project = vi
        .spyOn(runtime, 'forwardAcceptedNotification')
        .mockRejectedValueOnce(new Error('projection failed'))
        .mockResolvedValue(undefined)
      const frame = { serverId: 'local', threadId: 'parity-thread', sequence: 1 }
      await expect(runtime.forwardNotification('item/delta', frame, 'local')).rejects.toThrow(
        'projection failed'
      )
      await runtime.forwardNotification('item/delta', frame, 'local')
      await runtime.forwardNotification('item/delta', frame, 'local')
      expect(project).toHaveBeenCalledTimes(2)
      // The replay key must also remain scoped to its source target.
      await runtime.forwardNotification('item/delta', frame, 'other-target')
      expect(project).toHaveBeenCalledTimes(3)
    }
  )
})
