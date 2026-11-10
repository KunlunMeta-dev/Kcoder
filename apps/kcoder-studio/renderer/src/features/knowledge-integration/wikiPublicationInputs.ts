import type { PublicationSource } from '../../../../shared/generated/contracts'
import type { PublishableWikiPage } from './KnowledgePublications'

export interface NativeWikiPublicationLibrary {
  id: string
  title: string
  archived?: boolean
}
export interface NativeWikiMetadataPage<T> {
  items: T[]
  nextCursor?: string | null
}
/** Metadata only. The target's existing Wiki API and publication service retain authority. */
export interface NativeWikiPublicationInputs {
  ownerKey: string
  listLibraries(input: {
    after?: string
    limit: 10
    signal: AbortSignal
  }): Promise<NativeWikiMetadataPage<NativeWikiPublicationLibrary>>
  listPages(input: {
    libraryId: string
    after?: string
    limit: 10
    signal: AbortSignal
  }): Promise<NativeWikiMetadataPage<PublishableWikiPage>>
}
export const publicationSourceKey = (source: PublicationSource) =>
  JSON.stringify([source.libraryId, source.pageId, source.pageRevision])
