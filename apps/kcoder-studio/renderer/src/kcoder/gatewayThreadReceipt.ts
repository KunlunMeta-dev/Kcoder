import i18n from '@/i18n'
import { GatewayRpcError } from './gatewayRpc'
import type { GatewayClient } from './gatewayRuntimeTypes'

export class ThreadCreationUnknownError extends Error {
  constructor(cause: unknown) {
    super(i18n.t('workbench.thread_creation_unknown'), { cause })
    this.name = 'ThreadCreationUnknownError'
  }
}
/** Discover the original creation; never reissue thread/start after transport ambiguity. */
export async function startThreadWithReceipt(
  client: GatewayClient,
  params: Record<string, unknown>,
  recoverClient: () => Promise<GatewayClient>
): Promise<{ client: GatewayClient; result: { thread?: { id?: string } } }> {
  try {
    const result = await client.request<{ thread?: { id?: string } }>('thread/start', params)
    if (!result.thread?.id?.trim()) throw new GatewayRpcError('Invalid thread creation reply', -1, undefined, 'runtime-session', 'invalid-response')
    return { client, result }
  } catch (error) {
    if (!(error instanceof GatewayRpcError) || error.code !== -1 || error.reason === 'remote') throw error
    let recovered: GatewayClient | undefined
    try {
      recovered = await recoverClient()
      if (!recovered.supportsExperimental?.('threadCreationReceiptsV1')) throw error
      const { receipt } = await recovered.request<{ receipt?: {
        threadId?: unknown; status?: unknown; thread?: { id?: unknown }
      } | null }>('thread/creation/read', { clientRequestId: params.clientRequestId })
      if (receipt?.status !== 'ready' || typeof receipt.threadId !== 'string' || !receipt.threadId.trim() ||
          receipt.thread?.id !== receipt.threadId) throw error
      const result = await recovered.request<{ thread?: { id?: string } }>('thread/resume', { threadId: receipt.threadId })
      if (result.thread?.id !== receipt.threadId) throw error
      return { client: recovered, result }
    } catch (queryError) {
      recovered?.close()
      throw new ThreadCreationUnknownError(queryError)
    }
  }
}
