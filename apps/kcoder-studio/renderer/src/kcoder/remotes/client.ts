import { requestLocalExecutor } from '@/host/localExecutor'
import { isContract } from '../../../../shared/generated/validator.mjs'
import type { RemoteCapabilityCatalog } from '../../../../shared/generated/contracts'

/** Uses the finite local runtime route; never asks a target to execute or delegate. */
export async function readRemoteCapabilities(
  cursor: string | undefined,
  signal: AbortSignal
): Promise<RemoteCapabilityCatalog> {
  signal.throwIfAborted()
  const response = await requestLocalExecutor<unknown>(
    'runtime.remotes.readCatalog',
    cursor ? { cursor } : {},
    { signal }
  )
  signal.throwIfAborted()
  if (!isContract('RemoteCapabilityCatalog', response))
    throw new Error('REMOTE_CATALOG_REPLY_INVALID')
  const catalog = response as RemoteCapabilityCatalog
  if (
    catalog.entries.length > 10 ||
    !catalog.snapshotId ||
    (catalog.total != null && catalog.total < catalog.entries.length)
  )
    throw new Error('REMOTE_CATALOG_REPLY_INVALID')
  return catalog
}
