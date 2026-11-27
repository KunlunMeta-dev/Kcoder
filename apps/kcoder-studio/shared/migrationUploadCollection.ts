import type { HistoricalAttachmentSelection } from './generated/contracts'
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const selection = (value: HistoricalAttachmentSelection) => JSON.stringify([value.jobId, value.viewId ?? null, value.position, value.blockIndex, value.toolItemIndex ?? null])
/** Generated shape checks run first; this binds results to the exact requested history coordinates. */
export function validUploadCollectionResult(input: unknown, output: unknown): boolean {
  const params = record(input), result = record(output)
  if (result.job) return result.job.state.operationId === params.operationId && selection(result.job.selection) === selection(params.selection) && result.job.historicalContentVerified === false && result.job.state.stage === 'ready' && !!result.job.state.receipt
  const valid = (state: Record<string, any>, required = false) => {
    const value = state.collection
    if (!value) return !required
    return (!params.operationId || params.operationId === value.operationId) &&
      (!params.collectionId || params.collectionId === value.collectionId) &&
      selection(params.selection) === selection(value.selection) && /^[a-f0-9]{64}$/.test(value.collectionId) &&
      [value.sequence, value.uploadSequence, value.cancelRevision, value.deletedBytes, value.releasedReservationBytes].every(n => Number.isSafeInteger(n) && n >= 0)
  }
  if (Array.isArray(result.items)) return result.items.length <= 10 && result.items.every(item => valid(item, true)) && (!params.cursor || result.nextCursor !== params.cursor)
  return valid(result)
}
