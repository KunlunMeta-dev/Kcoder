import { isThreadWorkspaceLookupResult } from '../../../../../shared/generated/contractGuards.mjs'
import type { GatewayServer } from '../../gatewayRpc'
import type { GatewayRuntimeCore } from './core'

/** Metadata locates candidates; only the subsequent Native thread/list establishes a match. */
export async function persistentTaskWorkspaceHints(
  runtime: GatewayRuntimeCore,
  server: GatewayServer,
  threadId: string,
  assertCurrent: () => Promise<void>,
): Promise<string[]> {
  return runtime.withWorkspaceReadClient(server, async client => {
    await assertCurrent()
    if (client.supportsExperimental?.('threadWorkspaceLookupV1') !== true) return []
    const paths = new Set<string>()
    const seen = new Set<string>()
    let cursor: string | undefined
    let scanned = 0
    let pages = 0
    do {
      const result = await client.request<unknown>('thread/workspace/lookup', {
        threadId, limit: 64, ...(cursor ? { cursor } : {}),
      })
      await assertCurrent()
      if (!isThreadWorkspaceLookupResult(result) || result.threadId !== threadId ||
          result.issueCount !== 0 || result.scannedProjects > 64 ||
          (result.nextCursor ? result.completeness !== 'partial' : result.completeness !== 'complete'))
        throw new Error('ORIGINAL_TASK_INDEX_UNAVAILABLE')
      for (const candidate of result.candidates) paths.add(candidate.workspacePath)
      scanned += result.scannedProjects
      pages += 1
      if (paths.size > 256 || scanned > 16_384 || pages > 256)
        throw new Error('ORIGINAL_TASK_INDEX_UNAVAILABLE')
      const next = result.nextCursor || undefined
      if (next && (seen.has(next) || result.scannedProjects === 0 || pages >= 256))
        throw new Error('ORIGINAL_TASK_INDEX_UNAVAILABLE')
      if (next) seen.add(next)
      cursor = next
    } while (cursor)
    return [...paths]
  }, server.workspacePath, false)
}
