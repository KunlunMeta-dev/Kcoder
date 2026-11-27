import { createRandomUuid } from '@/lib/random-id'
import type { GatewayClient } from './gatewayRuntimeTypes'
import { isUnconfirmedRpcFailure } from './rpcOutcome'
import { GatewayRpcError } from './gatewayRpc'
import { isContract } from '../../../shared/generated/validator.mjs'
import { isCronCreationContext } from '../../../shared/generated/contractGuards.mjs'
import type { CronCreationReadResult } from '../../../shared/generated/contracts'

export class AutomationCreationUnknownError extends Error {
  readonly uncertain = true
  readonly clientRequestId: string
  constructor(clientRequestId: string, cause: unknown) {
    super('Scheduled task creation is unconfirmed', { cause })
    this.clientRequestId = clientRequestId
  }
}

export function automationCreationId(context: unknown): string | undefined {
  if (!isCronCreationContext(context)) throw new Error('Invalid scheduled task creation context')
  if (context.epoch === null) return undefined
  if (typeof context.epoch !== 'number' || !Number.isSafeInteger(context.epoch) || context.epoch < 0)
    throw new Error('Invalid scheduled task creation generation')
  return `cron-v1-${context.epoch}-${createRandomUuid()}`
}

/** Creation is sent once; reconnection only observes its original durable receipt. */
export async function createAutomationWithReceipt(
  client: GatewayClient,
  fields: Record<string, unknown>,
  options: { recoverClient: () => Promise<GatewayClient>; isCurrent: () => boolean }
) {
  const check = () => { if (!options.isCurrent()) throw new Error('Scheduled task owner changed') }
  check()
  const supported = client.supportsExperimental?.('cronCreationReceiptsV1') === true
  const clientRequestId = fields.clientRequestId ?? (supported
    ? automationCreationId(await client.request('cron/list', { creationContext: true })) : undefined)
  check()
  if (supported && typeof clientRequestId !== 'string') throw new Error('Missing scheduled task creation identity')
  try {
    const result = await client.request<{ job?: { id?: unknown } }>('cron/create', supported ? { ...fields, clientRequestId } : fields)
    check()
    if (supported && (typeof result?.job?.id !== 'string' || !result.job.id.trim()))
      throw new GatewayRpcError('Invalid scheduled task creation reply', -1, undefined, 'runtime-session', 'invalid-response')
    return result
  } catch (error) {
    if (!supported || !isUnconfirmedRpcFailure(error)) throw error
    try {
      const recovered = await options.recoverClient()
      check()
      if (!recovered.supportsExperimental?.('cronCreationReceiptsV1')) throw error
      const receipt = await recovered.request<CronCreationReadResult>('cron/list', { clientRequestId })
      check()
      if (isContract('CronCreationReadResult', receipt) && receipt.clientRequestId === clientRequestId
        && receipt.creationReceipt?.id.trim())
        return { job: receipt.creationReceipt }
    } catch { /* The original create remains unknown; no new mutation is permitted. */ }
    throw new AutomationCreationUnknownError(clientRequestId as string, error)
  }
}
