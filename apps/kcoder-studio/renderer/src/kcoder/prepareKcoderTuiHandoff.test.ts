import { expect, test, vi } from 'vitest'
import { ThreadRuntimeHandoffClient } from '../../../shared/threadRuntimeHandoff.mjs'
import type { GatewayClient } from './gatewayRuntimeTypes'
import { prepareKcoderTuiHandoff } from './prepareKcoderTuiHandoff'

const threadId = 'abcde'
const snapshot = { threadId, ownerRef: 'original-owner', serverId: 'server', clientTurnCount: 5, releasable: true }

function client(request: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  const handoff = new ThreadRuntimeHandoffClient({ request, supported: () => true, ownerStamp: () => 1 })
  return { runtimeHandoff: () => handoff } as GatewayClient
}

test('keeps a busy original session attached', async () => {
  const request = vi.fn().mockResolvedValue({ snapshot: { ...snapshot, releasable: false }, operation: null })
  await expect(prepareKcoderTuiHandoff(client(request), threadId, () => true))
    .rejects.toThrow('TERMINAL_KCODER_TUI_SESSION_BUSY')
  expect(request).toHaveBeenCalledExactlyOnceWith('thread/runtime/handoff/read', { threadId })
})

test('reconciles the original release without replaying it after a lost response', async () => {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method.endsWith('release')) throw new Error('lost response')
    if (!params.operationId) return { snapshot, operation: null }
    return {
      snapshot: { ...snapshot, ownerRef: null, clientTurnCount: null, releasable: false },
      operation: { threadId, operationId: params.operationId, ownerRef: snapshot.ownerRef,
        serverId: snapshot.serverId, status: 'released' },
    }
  })
  await prepareKcoderTuiHandoff(client(request), threadId, () => true)
  expect(request).toHaveBeenCalledTimes(3)
  const operationId = request.mock.calls[1][1].operationId
  expect(request.mock.calls[2]).toEqual(['thread/runtime/handoff/read', { threadId, operationId }])
})
