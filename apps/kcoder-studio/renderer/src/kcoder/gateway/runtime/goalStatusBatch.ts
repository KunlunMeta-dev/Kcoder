import type { RuntimeGoalStatusObservation } from '@/types/api'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { parseThreadGoalStatusObservation } from '../../threadGoalStatus'

const BATCH_SIZE = 100
const MAX_THREADS_PER_SCAN = 10_000
const SCAN_BUDGET_MS = 800

/** Bounded, read-only observations; unobserved or invalid rows stay unavailable. */
export async function observeThreadGoalStatuses(
  client: Pick<GatewayClient, 'request'>,
  threadIds: string[],
  cancelled: () => boolean,
  budgetMs = SCAN_BUDGET_MS
): Promise<Map<string, RuntimeGoalStatusObservation>> {
  const ids = [...new Set(threadIds)]
  const observations = new Map<string, RuntimeGoalStatusObservation>(
    ids.map(id => [id, { availability: 'unavailable' }])
  )
  const deadline = performance.now() + budgetMs
  for (let start = 0; start < Math.min(ids.length, MAX_THREADS_PER_SCAN); start += BATCH_SIZE) {
    const remaining = deadline - performance.now()
    if (cancelled() || remaining <= 0) break
    const batch = ids.slice(start, Math.min(start + BATCH_SIZE, MAX_THREADS_PER_SCAN))
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort()
          reject(new DOMException('Goal observation timed out', 'AbortError'))
        }, remaining)
      })
      const response = await Promise.race([
        client.request<unknown>('thread/goal/status/readMany', { threadIds: batch }, { signal: abort.signal }),
        timeout,
      ])
      if (cancelled() || performance.now() > deadline || !response ||
          typeof response !== 'object' || Array.isArray(response)) break
      const rows = (response as Record<string, unknown>).observations
      if (!Array.isArray(rows) || rows.length !== batch.length) break
      const expected = new Set(batch)
      const received = new Map<string, RuntimeGoalStatusObservation>()
      let valid = true
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) { valid = false; break }
        const id = (row as Record<string, unknown>).threadId
        if (typeof id !== 'string' || !expected.has(id) || received.has(id)) { valid = false; break }
        received.set(id, parseThreadGoalStatusObservation(row, id))
      }
      if (!valid) break
      for (const [id, observation] of received) observations.set(id, observation)
    } catch {
      // A failed read cannot establish either Goal absence or completion.
      break
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return observations
}
