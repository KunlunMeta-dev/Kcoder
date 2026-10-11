export interface ReceiptClient {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>
  supportsExperimental?(capability: string): boolean
}
export interface TurnStartResult { turn?: { id?: string; status?: string; attemptId?: string } }

/** Query authoritative evidence only; absence never authorizes a repeated mutation. */
export async function readTurnReceipt(client: ReceiptClient, params: Record<string, unknown>): Promise<TurnStartResult> {
  const retryOperationId = typeof params.retryOperationId === 'string' ? params.retryOperationId : undefined
  const clientMessageId = typeof params.clientMessageId === 'string' ? params.clientMessageId : undefined
  if ((!retryOperationId && !clientMessageId) || !client.supportsExperimental?.('turnReceiptsV1'))
    throw new Error('Turn receipt capability or request identity is unavailable')
  const response = await client.request<{ receipt?: { threadId?: unknown; turnId?: unknown; status?: unknown; attemptId?: unknown } | null }>(
    'turn/receipt/read', { threadId: params.threadId, ...(retryOperationId ? { retryOperationId } : { clientMessageId }) }
  )
  const receipt = response.receipt
  if (!receipt || receipt.threadId !== params.threadId || typeof receipt.turnId !== 'string' || !receipt.turnId.trim() ||
    (typeof params.retryFromAttemptId === 'string' && (typeof receipt.attemptId !== 'string' || !receipt.attemptId.trim())) ||
    (typeof params.retryFromTurnId === 'string' && receipt.turnId !== params.retryFromTurnId) ||
    !['running', 'completed', 'failed', 'interrupted'].includes(String(receipt.status)))
    throw new Error('Turn acceptance remains unknown')
  return { turn: { id: receipt.turnId, status: String(receipt.status),
    ...(typeof receipt.attemptId === 'string' ? { attemptId: receipt.attemptId } : {}) } }
}

/** Desktop and Mobile share the same acceptance recovery. Never send turn/start twice. */
export async function startTurnWithReceipt<C extends ReceiptClient>(
  client: C,
  params: Record<string, unknown>,
  recoverClient: () => Promise<C>,
  errors: { invalidReply(): Error; ambiguous(error: unknown): boolean; unknownOutcome(cause: unknown): Error }
): Promise<{ client: C; result: TurnStartResult; recovered: boolean }> {
  try {
    const result = await client.request<TurnStartResult>('turn/start', params)
    if (typeof result?.turn?.id !== 'string' || !result.turn.id.trim() ||
      (typeof params.retryFromTurnId === 'string' && result.turn.id !== params.retryFromTurnId) ||
      (typeof params.retryFromAttemptId === 'string' && (typeof result.turn.attemptId !== 'string' || !result.turn.attemptId.trim()))) throw errors.invalidReply()
    return { client, result, recovered: false }
  } catch (error) {
    if (!errors.ambiguous(error)) throw error
    try {
      if (typeof params.retryOperationId !== 'string' && typeof params.clientMessageId !== 'string') throw error
      const current = await recoverClient()
      return { client: current, result: await readTurnReceipt(current, params), recovered: true }
    } catch (queryError) {
      throw errors.unknownOutcome(queryError)
    }
  }
}
