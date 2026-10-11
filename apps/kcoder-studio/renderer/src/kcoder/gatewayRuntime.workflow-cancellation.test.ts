import { afterEach, describe, expect, test, vi } from 'vitest'
import { workflowApi } from '@/features/workflows/workflowApi'
import { GatewayRpcClient } from './gatewayRpc'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { localGatewayServer } from './gatewayRuntime.test-support'
import { createGatewayIpcHandler } from './gatewayRuntimeInstall'
import { registerGatewayCommandTransport } from './gatewayServiceBridge'

// Model-independent lifecycle: the real RPC client owns pending requests;
// the fake socket controls reply timing without a model or native process.
class WorkflowSocket extends EventTarget {
  static current: WorkflowSocket
  readyState = WebSocket.CONNECTING
  sent: Array<{ id?: number; method: string }> = []
  constructor(readonly url: string | URL) {
    super()
    WorkflowSocket.current = this
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }
  send(raw: string) {
    const frame = JSON.parse(raw)
    this.sent.push(frame)
    if (frame.method === 'initialize')
      queueMicrotask(() =>
        this.reply(frame.id, {
          protocolVersion: '2026-07-27',
          capabilities: {
            experimental: { workflowCanvasV1: true, workflowGraphV2: true, workflowRunsV1: true },
          },
        })
      )
  }
  reply(id: number, result: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) })
    )
  }
  close() {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})
describe.each([Runtime, InstalledRuntime])(
  'workflow cancellation through installed IPC and real Gateway RPC client',
  RuntimeClass => {
    test('read cancellation drops its pending entry and late frames leave other readers and the connection intact', async () => {
      const client = new GatewayRpcClient(
        'local',
        'fixture',
        WorkflowSocket as unknown as typeof WebSocket
      )
      const runtime = new RuntimeClass('fixture', {
        loadServers: async () => [localGatewayServer()],
        createClient: () => client,
      })
      const unregister = registerGatewayCommandTransport(
        createGatewayIpcHandler(runtime as Runtime)
      )
      try {
        const controller = new AbortController()
        const stale = workflowApi.read('local', 'old', undefined, { signal: controller.signal })
        const rejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() =>
          expect(WorkflowSocket.current.sent.some(frame => frame.method === 'workflow/read')).toBe(
            true
          )
        )
        const socket = WorkflowSocket.current
        const oldFrame = socket.sent.at(-1)!
        const current = workflowApi.run('local', 'current')
        await vi.waitFor(() => expect(socket.sent.at(-1)?.method).toBe('workflow/runs/read'))
        const currentFrame = socket.sent.at(-1)!
        const pending = (client as unknown as { pending: Map<number, unknown> }).pending
        expect(pending.has(oldFrame.id!)).toBe(true)
        expect(pending.has(currentFrame.id!)).toBe(true)
        controller.abort()
        await rejected
        expect(pending.has(oldFrame.id!)).toBe(false)
        expect(pending.has(currentFrame.id!)).toBe(true)
        expect(socket.readyState).toBe(WebSocket.OPEN)
        socket.reply(oldFrame.id!, { id: 'stale', revision: 100 })
        socket.reply(currentFrame.id!, { runId: 'current', revision: 2 })
        await expect(current).resolves.toEqual({ runId: 'current', revision: 2 })
        expect(pending.size).toBe(0)
        expect(socket.sent.filter(frame => frame.method === 'workflow/read')).toHaveLength(1)
      } finally {
        unregister()
        await runtime.disposeAsync()
      }
    })

    test('a supplied read cancellation option cannot turn a workflow write receipt into a rejected retry', async () => {
      const client = new GatewayRpcClient(
        'local',
        'fixture',
        WorkflowSocket as unknown as typeof WebSocket
      )
      const runtime = new RuntimeClass('fixture', {
        loadServers: async () => [localGatewayServer()],
        createClient: () => client,
      })
      try {
        const controller = new AbortController()
        const receipt = runtime.request(
          'runtime.workflows.request',
          {
            serverId: 'local',
            method: 'workflow/save',
            params: { id: 'flow', expectedRevision: 1 },
          },
          { signal: controller.signal }
        )
        await vi.waitFor(() =>
          expect(WorkflowSocket.current.sent.at(-1)?.method).toBe('workflow/save')
        )
        controller.abort()
        const socket = WorkflowSocket.current
        socket.reply(socket.sent.at(-1)!.id!, { id: 'flow', revision: 2 })
        await expect(receipt).resolves.toEqual({ id: 'flow', revision: 2 })
      } finally {
        await runtime.disposeAsync()
      }
    })
  }
)
