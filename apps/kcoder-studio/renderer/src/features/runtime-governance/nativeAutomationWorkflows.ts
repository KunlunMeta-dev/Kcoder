import { workflowApi } from '@/features/workflows/workflowApi'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { KnowledgeOperationError } from '@/features/knowledge-integration/client'
import type { SavedBusinessWorkflow } from '@/features/knowledge-integration/BusinessSubscriptions'

/** Enumerate existing saved versions only; never save a draft or choose one automatically. */
export async function nativeAutomationWorkflows(
  serverId: string,
  isCurrent: () => boolean,
  signal: AbortSignal,
  workspacePath?: string
): Promise<SavedBusinessWorkflow[]> {
  const accountCurrent = captureAccountContextRevision()
  const check = () => {
    signal.throwIfAborted()
    if (!isCurrent() || !accountCurrent(serverId))
      throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
  }
  const saved: SavedBusinessWorkflow[] = []
  let offset = 0
  for (let page = 0; page < 32; page += 1) {
    check()
    const result = await workflowApi.list(serverId, offset, {
      signal,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
    })
    check()
    for (const item of result.items) {
      if (
        item.status === 'saved' &&
        Number.isSafeInteger(item.savedVersion) &&
        item.savedVersion! > 0
      ) {
        saved.push({ id: item.id, title: item.title, version: item.savedVersion! })
      } else {
        const versions = await workflowApi.versions(serverId, item.id, {
          signal,
          ...(workspacePath !== undefined ? { workspacePath } : {}),
        })
        check()
        if (!Array.isArray(versions) || versions.length > 256)
          throw new KnowledgeOperationError('AUTOMATION_WORKFLOW_LIST_LIMIT')
        const seen = new Set<number>()
        for (const version of versions) {
          if (
            !Number.isSafeInteger(version.version) ||
            version.version <= 0 ||
            seen.has(version.version) ||
            typeof version.title !== 'string'
          )
            throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
          seen.add(version.version)
          saved.push({ id: item.id, title: version.title, version: version.version })
        }
      }
      if (saved.length > 1024) throw new KnowledgeOperationError('AUTOMATION_WORKFLOW_LIST_LIMIT')
    }
    if (!result.truncated) return saved
    if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset! <= offset)
      throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
    offset = result.nextOffset!
  }
  throw new KnowledgeOperationError('AUTOMATION_WORKFLOW_LIST_LIMIT')
}
