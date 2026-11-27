import { describe, expect, test, vi } from 'vitest'
import { RemoteOperationClient, RemoteOperationClientError } from './operationClient'
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
vi.mock('@/kcoder/accountContextEvents', () => ({ captureAccountContextRevision: () => () => true }))
const scope = { accountId: 'a', targetId: 't', workspaceId: 'w', identityGeneration: 'g', targetRevision: 'r' }
const target = { serverId: 'local', workspacePath: '/owned' }
describe('original Native operation client', () => {
  test('cancellation dispatches once and a lost receipt is followed by an original read', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const transport = { request: vi.fn(async (_method: string, raw: unknown) => {
      const input = raw as { method: string; params: Record<string, unknown> }; requests.push(input)
      if (input.method === 'integrations/scope/read') return scope
      if (input.method.endsWith('cancelOperation')) throw new Error('lost receipt')
      return { requestId: input.params.requestId, scope, operationId: 'original', outcome: 'observed', snapshot: null }
    }) }
    const client = new RemoteOperationClient(target, transport)
    await expect(client.cancel('original', 2)).rejects.toMatchObject({ uncertain: true })
    expect(requests.filter(item => item.method.endsWith('cancelOperation'))).toHaveLength(1)
    await expect(client.read('original')).resolves.toMatchObject({ operationId: 'original', snapshot: null })
    expect(requests.at(-1)?.params.operationId).toBe('original')
    expect(requests.filter(item => item.method.endsWith('cancelOperation'))).toHaveLength(1)
    client.dispose()
  })
  test('a late old-owner result cannot project into a replaced client', async () => {
    let finish!: (value: unknown) => void
    const client = new RemoteOperationClient(target, { request: vi.fn(async (_method, raw) => {
      const input = raw as { method: string; params: Record<string, unknown> }
      if (input.method === 'integrations/scope/read') return scope
      return new Promise(resolve => { finish = resolve })
    }) })
    const pending = client.read('original')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    client.dispose()
    finish({ requestId: 'late', scope, operationId: 'original', outcome: 'observed', snapshot: null })
    await expect(pending).rejects.toBeInstanceOf(RemoteOperationClientError)
  })
})
