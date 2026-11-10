const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
/** Generated schemas check shape first; these checks bind facts to the requested selection. */
export function validHistoryLifecycleResult(method: string, input: unknown, output: unknown): boolean {
  const params = object(input), result = object(output)
  if (method.startsWith('migration/history/view/')) {
    if (result.lease === null) return !method.endsWith('/open') && !method.endsWith('/renew')
    const lease = object(result.lease)
    return lease.requestId === params.requestId && (!params.leaseId || lease.leaseId === params.leaseId) &&
      (!params.jobId || lease.jobId === params.jobId) && (!params.expectedArchiveId || lease.archiveId === params.expectedArchiveId) &&
      (!method.endsWith('/open') || (lease.viewId ?? null) === (params.viewId ?? null)) &&
      [lease.sequence, lease.remainingMs, lease.managedArchives, lease.legacyArchives].every(count) &&
      lease.remainingMs <= 30_000 && lease.managedArchives + lease.legacyArchives >= 1 && lease.managedArchives + lease.legacyArchives <= 256
  }
  const state = (value: unknown, canonical = false) => {
    const retirement = object(object(value).retirement)
    return (!params.jobId || retirement.jobId === params.jobId) &&
      (canonical || !params.operationId || retirement.operationId === params.operationId) &&
      [retirement.sequence, retirement.cancelRevision, retirement.retainedReferences, retirement.collectedBytes].every(count) &&
      (retirement.collectedBytes === 0 || retirement.logicalRetired === true)
  }
  if (method.endsWith('/preview')) return result.jobId === params.jobId && count(result.jobSequence) && count(result.retainedReferences) &&
    (!result.existing || state(result.existing, true))
  if (method.endsWith('/list')) return Array.isArray(result.items) && result.items.length <= 10 && result.items.every((item: unknown) => state(item)) &&
    (!params.cursor || result.nextCursor !== params.cursor)
  return state(result, method.endsWith('/prepare'))
}
