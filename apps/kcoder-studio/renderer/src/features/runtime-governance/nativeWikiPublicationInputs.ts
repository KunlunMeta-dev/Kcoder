import { knowledgeApi } from '@/kcoder/knowledgeApi'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { KnowledgeOperationError } from '@/features/knowledge-integration/client'
import type { NativeWikiPublicationInputs } from '@/features/knowledge-integration/wikiPublicationInputs'

/** Metadata locates fixed Wiki revisions; the native publisher checks access and bytes. */
export function nativeWikiPublicationInputs(ownerKey: string, serverId: string, isCurrent: () => boolean): NativeWikiPublicationInputs {
  const accountCurrent = captureAccountContextRevision()
  const check = (signal: AbortSignal) => {
    signal.throwIfAborted()
    if (!isCurrent() || !accountCurrent(serverId)) throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
  }
  return {
    ownerKey,
    async listLibraries({ after, limit, signal }) {
      check(signal)
      const page = await knowledgeApi.libraries(serverId, after, limit, { signal })
      check(signal)
      return { items: page.items.map(library => ({ id: library.id, title: library.name, archived: library.archived })), nextCursor: page.nextAfterId }
    },
    async listPages({ libraryId, after, limit, signal }) {
      check(signal)
      const page = await knowledgeApi.pages(serverId, libraryId, after, limit, { signal })
      check(signal)
      return { items: page.items.map(item => ({ title: item.title, source: { libraryId, pageId: item.pageId, pageRevision: item.revisionId } })), nextCursor: page.nextAfterId }
    },
  }
}
