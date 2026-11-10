import { requestLocalExecutor } from '@/host/localExecutor'
import type { RuntimeTaskAddress } from '@/types/api'
import type { ThreadLifetimeResult, SessionLifetimeMode } from '../../../shared/generated/contracts'
import { isContract } from '../../../shared/generated/validator.mjs'

export async function readTaskLifetime(address: RuntimeTaskAddress) {
  return checked(await requestLocalExecutor('runtime.tasks.lifetime.read', { address }))
}
export async function setTaskLifetime(
  address: RuntimeTaskAddress, expectedRevision: number, mode: SessionLifetimeMode
) {
  return checked(await requestLocalExecutor('runtime.tasks.lifetime.set', {
    address, expectedRevision, mode,
  }))
}
function checked(value: unknown): ThreadLifetimeResult {
  if (!isContract('ThreadLifetimeResult', value)) throw new Error('SESSION_LIFETIME_RESPONSE_INVALID')
  return value as ThreadLifetimeResult
}
export function attachTaskView(address: RuntimeTaskAddress, viewId: string) {
  return requestLocalExecutor('runtime.tasks.view.attach', { address, viewId })
}
export function releaseTaskView(address: RuntimeTaskAddress, viewId: string) {
  return requestLocalExecutor('runtime.tasks.view.release', { address, viewId })
}
