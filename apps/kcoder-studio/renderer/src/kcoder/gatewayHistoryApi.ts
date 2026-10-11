import { requestLocalExecutor } from '@/tauri/localExecutor'
import {
  historyRefreshResult,
  type HistoryRefreshInput,
  type HistoryRefreshResult,
} from './gatewayHistoryRefresh'

export interface HistoryRefreshAddress {
  deviceId: string
  workspacePath: string
}

export async function requestHistoryRefresh(
  address: HistoryRefreshAddress,
  input: HistoryRefreshInput
): Promise<HistoryRefreshResult> {
  return historyRefreshResult(
    await requestLocalExecutor('runtime.history.refresh', {
      deviceId: address.deviceId,
      workspacePath: address.workspacePath,
      ...input,
    })
  )
}

export async function cancelHistoryRefresh(
  step: (input: HistoryRefreshInput) => Promise<HistoryRefreshResult>,
  cursor: string | undefined
): Promise<void> {
  if (cursor) await step({ cursor, cancel: true }).catch(() => undefined)
}

/** Advance bounded single RPC steps; caller cancellation also handles a late in-flight cursor. */
export async function advanceHistoryRefresh(
  step: (input: HistoryRefreshInput) => Promise<HistoryRefreshResult>,
  options: {
    cursor?: string
    cancelled: () => boolean
    onCursor: (cursor: string | undefined) => void
    onProgress: (progress: HistoryRefreshResult) => void
    maxSteps?: number
    maxDurationMs?: number
  }
): Promise<{ result?: HistoryRefreshResult; paused: boolean }> {
  let cursor = options.cursor
  let result: HistoryRefreshResult | undefined
  const seen = new Set(cursor ? [cursor] : [])
  const deadline = Date.now() + Math.min(options.maxDurationMs ?? 120_000, 120_000)
  try {
    for (
      let count = 0;
      count < Math.min(options.maxSteps ?? 200, 200) && Date.now() < deadline;
      count += 1
    ) {
      if (options.cancelled()) {
        await cancelHistoryRefresh(step, cursor)
        return { paused: false }
      }
      result = await step(cursor ? { cursor } : { acknowledgeExternalWriters: true })
      cursor = result.nextCursor
      options.onCursor(cursor)
      if (options.cancelled()) {
        await cancelHistoryRefresh(step, cursor)
        return { paused: false }
      }
      if (result.status === 'building' && (!cursor || seen.has(cursor)))
        throw new Error('History refresh returned a repeated continuation cursor')
      if (cursor) seen.add(cursor)
      options.onProgress(result)
      if (result.status !== 'building') return { result, paused: false }
    }
    return { result, paused: true }
  } catch (error) {
    await cancelHistoryRefresh(step, cursor)
    options.onCursor(undefined)
    throw error
  }
}
