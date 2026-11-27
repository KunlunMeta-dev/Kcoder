import { isMigrationSourceTransferResult, type MigrationSourceTransferResult } from './generated/contracts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sha = /^[0-9a-f]{64}$/
const errorCode = (value: string | null) => value === null || /^source_transfer_[a-z_]+$/.test(value)
const bytes = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 2 * 1024 * 1024 * 1024
const entries = (value: number) => Number.isInteger(value) && value >= 1 && value <= 1024

/** An idle Gateway task is not a Native completion receipt. Reject contradictory
 * observations before any client presents Ready or offers a dependent action. */
export function validMigrationSourceObservation(value: unknown, requestId: string): value is MigrationSourceTransferResult {
  if (!uuid.test(requestId) || !isMigrationSourceTransferResult(value) || value.requestId !== requestId ||
      !errorCode(value.errorCode) || (value.observation === 'observed') !== (value.result !== null)) return false
  const progress = value.progress
  if (progress) {
    if (progress.requestId !== requestId) return false
    if (progress.phase === 'transferring' && (!entries(progress.entries) || !bytes(progress.totalBytes) ||
        !bytes(progress.acceptedBytes) || progress.acceptedBytes > progress.totalBytes)) return false
  }
  const result = value.result
  if (!result) return true
  if (result.requestId !== requestId) return false
  if ('scope' in result) {
    if (result.sourceObserved !== false) return false
    const targetProgress = result.progress
    if (!result.targetState && (targetProgress || result.receipt)) return false
    if (result.targetState && !targetProgress) return false
    if (targetProgress && (!sha.test(targetProgress.manifestSha256) || !entries(targetProgress.entries) ||
        !bytes(targetProgress.totalBytes) || !bytes(targetProgress.acceptedBytes) ||
        targetProgress.acceptedBytes > targetProgress.totalBytes ||
        targetProgress.partsComplete !== (targetProgress.acceptedBytes === targetProgress.totalBytes))) return false
    if (result.receipt && targetProgress && (result.receipt.manifestSha256 !== targetProgress.manifestSha256 ||
        result.receipt.bytes !== targetProgress.totalBytes || result.receipt.entries !== targetProgress.entries ||
        !targetProgress.partsComplete)) return false
  } else if (!errorCode(result.sourceCapture.errorCode)) return false
  if (result.phase === 'ready' && !result.receipt) return false
  if (Boolean(result.targetState?.ready) !== (result.receipt !== null)) return false
  if (result.targetAdmissionControl?.ready) return false
  if (result.receipt && (result.receipt.requestId !== requestId || !sha.test(result.receipt.manifestSha256) ||
      !entries(result.receipt.entries) || !bytes(result.receipt.bytes))) return false
  return true
}
