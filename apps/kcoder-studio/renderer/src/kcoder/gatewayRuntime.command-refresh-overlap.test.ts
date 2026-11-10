import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

for (const latestFails of [false, true]) {
  test(`overlapping owner directory reads follow the existing latest result; failure=${latestFails}`, async () => {
    let count = 0,
      finishA!: (value: unknown) => void,
      finishB!: (value: unknown) => void,
      rejectB!: (error: Error) => void
    const old = ['a', 'b'].map(id => localGatewayServer({ id, profile: 'original' }))
    const fresh = ['a', 'b'].map(id => localGatewayServer({ id, profile: 'replacement' }))
    const clients = new Map<string, FakeGatewayClient[]>()
    const runtime = new KCoderGatewayRuntime('owned', {
      loadServers: () => {
        count++
        if (count === 1) return Promise.resolve(old)
        if (count === 2)
          return new Promise(resolve => {
            finishA = value => resolve(value as typeof old)
          })
        if (count === 3)
          return new Promise((resolve, reject) => {
            finishB = value => resolve(value as typeof old)
            rejectB = reject
          })
        throw new Error('No automatic extra metadata read is authorized by this fixture')
      },
      createClient: id => {
        const client = new FakeGatewayClient(null)
        const original = client.request.bind(client)
        client.request = async <T>(method: string, params?: Record<string, unknown>) =>
          method === 'cron/list' ? ({ jobs: [] } as T) : original<T>(method, params)
        clients.set(id, [...(clients.get(id) ?? []), client])
        return client
      },
    })
    const read = (id: string) =>
      runtime.request('runtime.automations.request', {
        deviceId: id,
        address: { deviceId: id, workspacePath: '/workspace' },
        method: 'cron/list',
        params: {},
      })
    try {
      await read('a')
      await read('b')
      const a = clients.get('a')![0],
        b = clients.get('b')![0]
      const closeA = vi.spyOn(a, 'close'),
        closeB = vi.spyOn(b, 'close')
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'a' } }))
      await vi.waitFor(() => expect(count).toBe(2))
      window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'b' } }))
      await vi.waitFor(() => expect(count).toBe(3))
      if (latestFails) rejectB(new Error('latest owned directory failed'))
      else finishB(fresh)
      finishA(old)
      if (latestFails) {
        await expect(read('a')).rejects.toThrow()
        await expect(read('b')).rejects.toThrow()
        expect(clients.get('a')).toHaveLength(1)
        expect(clients.get('b')).toHaveLength(1)
      } else {
        await expect(read('a')).resolves.toEqual({ jobs: [] })
        await expect(read('b')).resolves.toEqual({ jobs: [] })
        expect(closeA).toHaveBeenCalledOnce()
        expect(closeB).toHaveBeenCalledOnce()
        expect(clients.get('a')).toHaveLength(2)
        expect(clients.get('b')).toHaveLength(2)
      }
      expect(count).toBe(3)
    } finally {
      await runtime.disposeAsync()
    }
  })
}
