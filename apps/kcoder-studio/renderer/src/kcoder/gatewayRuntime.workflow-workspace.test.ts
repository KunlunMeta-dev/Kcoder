import { expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from './accountContextEvents'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'

const selected = '/remote/selected-project'
const target = { id: 'original-ssh', label: 'Original SSH', description: '', transport: 'ssh' as const, host: 'owned-a.test', workspacePath: '/remote/default' }

test('workflow reads and original Human responses route to the explicitly selected SSH workspace', async () => {
  const connections: unknown[] = [], client = new FakeGatewayClient(null)
  const original = client.request.bind(client)
  const request = vi.spyOn(client, 'request').mockImplementation(async (method, params) =>
    method.startsWith('workflow/') ? { accepted: true } as never : original(method, params))
  const runtime = createTestGatewayRuntime('fixture', {
    loadServers: async () => [target],
    createClient: (serverId, _token, _channel, workspacePath) => { connections.push({ serverId, workspacePath }); return client },
  })
  try {
    for (const method of ['workflow/runs/read', 'workflow/runs/requests', 'workflow/runs/output', 'workflow/runs/respond']) {
      await runtime.request('runtime.workflows.request', { serverId: target.id, workspacePath: selected, method,
        params: { runId: 'original-run', ...(method.endsWith('/respond') ? { requestId: 'original-request', value: true } : {}) } })
    }
    expect(connections).toEqual([{ serverId: target.id, workspacePath: selected }])
    expect(request.mock.calls.filter(([method]) => method.startsWith('workflow/')).map(([, params]) => params?.runId)).toEqual(Array(4).fill('original-run'))
  } finally { runtime.dispose() }
})

test.each(['target', 'account'])('a %s switch while opening the selected workspace rejects the old Human response before dispatch', async change => {
  let current = target
  const client = new FakeGatewayClient(null), request = vi.spyOn(client, 'request')
  const runtime = createTestGatewayRuntime('fixture', {
    loadServers: async () => [current],
    createClient: () => {
      if (change === 'target') {
        current = { ...target, host: 'owned-b.test' }
        window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } }))
      }
      else notifyAccountContextChange(target.id)
      return client
    },
  })
  try {
    await expect(runtime.request('runtime.workflows.request', { serverId: target.id, workspacePath: selected,
      method: 'workflow/runs/respond', params: { runId: 'original-run', requestId: 'original-request', value: true } })).rejects.toThrow()
    expect(request).not.toHaveBeenCalledWith('workflow/runs/respond', expect.anything())
  } finally { runtime.dispose() }
})
