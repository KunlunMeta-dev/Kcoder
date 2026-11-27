import { createRandomUuid } from '@/lib/random-id'
import type { GatewayClient } from './gatewayRuntimeTypes'
import { confirmsReleasedThreadRuntime } from '../../../shared/threadRuntimeHandoff.mjs'

export const TERMINAL_KCODER_TUI_CAPABILITY = 'terminalKcoderTuiV1'

export async function prepareKcoderTuiHandoff(
  client: GatewayClient,
  threadId: string,
  isCurrent: () => boolean
) {
  const handoff = client.runtimeHandoff?.()
  if (!handoff) throw new Error('TERMINAL_KCODER_TUI_UNSUPPORTED')
  const { snapshot } = await handoff.observe(threadId)
  if (!isCurrent()) throw new Error('TERMINAL_KCODER_TUI_OWNER_CHANGED')
  if (!snapshot.ownerRef) return
  if (!snapshot.releasable || snapshot.clientTurnCount == null) {
    throw new Error('TERMINAL_KCODER_TUI_SESSION_BUSY')
  }

  const operationId = createRandomUuid()
  const request = {
    threadId,
    operationId,
    expectedServerId: snapshot.serverId,
    expectedOwnerRef: snapshot.ownerRef,
    expectedClientTurnCount: snapshot.clientTurnCount,
  }
  let released: boolean
  try {
    released = confirmsReleasedThreadRuntime(request, await handoff.release(request))
  } catch (error) {
    if (!isCurrent()) throw error
    // A lost response does not authorize a second release.
    const { snapshot: current, operation } = await handoff.observe(threadId, operationId)
    released = current.serverId === snapshot.serverId && current.ownerRef === null &&
      operation?.status === 'released' && operation.ownerRef === snapshot.ownerRef
  }
  if (!released) throw new Error('TERMINAL_KCODER_TUI_HANDOFF_UNCONFIRMED')
  if (!isCurrent()) throw new Error('TERMINAL_KCODER_TUI_OWNER_CHANGED')
}
