import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

for (const operation of ['cron/create', 'integrations/automation/saveSubscription']) {
  for (const kind of ['same', 'changed', 'failed'] as const) {
    test(`pending ${operation} response under ${kind} directory refresh is owner-bound and never replayed`, async () => {
      let profile = 'original',
        failed = false
      let finish!: (value: unknown) => void
      const calls: string[] = []
      const clients = new Map<string, FakeGatewayClient[]>()
      const runtime = new KCoderGatewayRuntime('owned-test', {
        loadServers: async () => {
          if (failed) throw new Error('owned metadata unavailable')
          return [localGatewayServer({ id: 'owner', profile }), localGatewayServer({ id: 'peer' })]
        },
        createClient: serverId => {
          const client = new FakeGatewayClient(null)
          const original = client.request.bind(client)
          client.request = async <T>(
            method: string,
            params?: Record<string, unknown>
          ): Promise<T> => {
            if (method === operation) {
              calls.push(serverId)
              return new Promise(resolve => {
                finish = value => resolve(value as T)
              })
            }
            if (method === 'cron/list') return { jobs: [] } as T
            return original<T>(method, params)
          }
          clients.set(serverId, [...(clients.get(serverId) ?? []), client])
          return client
        },
      })
      const request = (serverId: string, method = 'cron/list') =>
        runtime.request(
          method.startsWith('integrations/')
            ? 'runtime.integrations.request'
            : 'runtime.automations.request',
          {
            deviceId: serverId,
            serverId,
            workspacePath: '/workspace',
            address: { deviceId: serverId, workspacePath: '/workspace' },
            method,
            params: method.startsWith('integrations/')
              ? {
                  contractVersion: 'parallel-v1',
                  requestId: 'original-request',
                  scope: {
                    accountId: 'owned',
                    targetId: serverId,
                    workspaceId: 'workspace',
                    identityGeneration: '1',
                    targetRevision: '1',
                  },
                  operationId: 'original-operation',
                  timeoutMs: 1000,
                  payload: {},
                }
              : {},
          }
        )

      try {
        await request('peer')
        const peer = clients.get('peer')![0]
        const peerClose = vi.spyOn(peer, 'close')
        const pending = request('owner', operation)
        const observed = pending.then(
          value => ({ value }),
          error => ({ error })
        )
        await vi.waitFor(() => expect(calls).toEqual(['owner']))
        const owner = clients.get('owner')![0]
        const close = vi.spyOn(owner, 'close')
        if (kind === 'changed') profile = 'replacement'
        if (kind === 'failed') failed = true
        window.dispatchEvent(
          new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'owner' } })
        )
        const originalReply = operation.startsWith('integrations/')
          ? {
              contractVersion: 'parallel-v1',
              requestId: 'original-request',
              operationId: 'original-operation',
              entityRevision: null,
              observedAt: '2026-10-29T00:00:00Z',
              status: 'completed',
              result: { safeFixture: true },
              error: null,
            }
          : { id: 'original-job' }
        finish(originalReply)
        const result = await observed
        if (kind === 'same') {
          expect(result).toEqual({ value: originalReply })
          expect(close).not.toHaveBeenCalled()
          await request('owner')
          expect(clients.get('owner')).toHaveLength(1)
        } else {
          expect(result).toHaveProperty('error')
          if (kind === 'changed') {
            await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
            await request('owner')
            expect(clients.get('owner')).toHaveLength(2)
          } else {
            await expect(request('owner', operation)).rejects.toThrow()
            expect(clients.get('owner')).toHaveLength(1)
          }
        }
        expect(calls).toEqual(['owner'])
        expect(peerClose).not.toHaveBeenCalled()
      } finally {
        await runtime.disposeAsync()
      }
    })
  }
}
