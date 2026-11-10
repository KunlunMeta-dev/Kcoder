import type { KnowledgeAdoption } from '../../../../shared/generated/contracts'
import { KnowledgeOperationError, type KnowledgeIntegrationClient } from './client'
import { sameKnowledgeOwner } from './identity'
import type { SavedBusinessInputResource } from './BusinessTemplateInputs'

export interface AdoptedPublicationInput {
  reference: SavedBusinessInputResource
  available: boolean
}
const key = (value: Pick<SavedBusinessInputResource, 'kind' | 'id' | 'revision'>) =>
  JSON.stringify([value.kind, value.id, value.revision])
const applicable = (client: KnowledgeIntegrationClient, value: KnowledgeAdoption) =>
  value.enabled &&
  sameKnowledgeOwner(value.owner, client.scope) &&
  sameKnowledgeOwner(value.publicationOwner, client.scope)
const verifyVersions = (items: KnowledgeAdoption[]) => {
  if (
    items.some(
      item => !Number.isSafeInteger(item.publicationVersion) || item.publicationVersion < 1
    )
  )
    throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
}

async function resolve(
  client: KnowledgeIntegrationClient,
  adoption: KnowledgeAdoption,
  signal?: AbortSignal
): Promise<SavedBusinessInputResource> {
  const publication = await client.resolvePublication(
    { owner: adoption.publicationOwner, draft: { publicationId: adoption.publicationId } },
    adoption.publicationVersion,
    signal
  )
  signal?.throwIfAborted()
  if (
    publication.revoked ||
    publication.draft.visibility !== 'personal' ||
    publication.draft.audienceId != null
  )
    throw new KnowledgeOperationError('AUTOMATION_SOURCE_PROVIDER_UNAVAILABLE')
  return {
    kind: 'publication',
    id: adoption.publicationId,
    revision: String(adoption.publicationVersion),
    title: publication.draft.title,
  }
}

/** The native source currently supports same-owner, explicitly adopted personal publications. */
export async function listAdoptedPublicationInputs(
  client: KnowledgeIntegrationClient,
  after?: string,
  signal?: AbortSignal
) {
  const page = await client.listAdoptions(after, signal)
  verifyVersions(page.items)
  if (page.items.length > 10 || (page.nextCursor != null && page.nextCursor === after))
    throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
  const candidates = page.items.filter(adoption => applicable(client, adoption))
  const observations = await Promise.allSettled(
    candidates.map(adoption => resolve(client, adoption, signal))
  )
  signal?.throwIfAborted()
  return {
    items: observations.map((result, index): AdoptedPublicationInput =>
      result.status === 'fulfilled'
        ? { reference: result.value, available: true }
        : {
            reference: {
              kind: 'publication',
              id: candidates[index].publicationId,
              revision: String(candidates[index].publicationVersion),
              title: '',
            },
            available: false,
          }
    ),
    nextCursor: page.nextCursor,
  }
}

/** Re-read adoption and the exact original version before preview; no new adoption or latest fallback. */
export async function verifyAdoptedPublicationInputs(
  client: KnowledgeIntegrationClient,
  references: unknown[],
  signal?: AbortSignal
) {
  const fixed = references.filter(
    (value): value is Pick<SavedBusinessInputResource, 'kind' | 'id' | 'revision'> =>
      !!value &&
      typeof value === 'object' &&
      'kind' in value &&
      value.kind === 'publication' &&
      'id' in value &&
      typeof value.id === 'string' &&
      !!value.id &&
      'revision' in value &&
      typeof value.revision === 'string' &&
      /^[1-9]\d*$/.test(value.revision)
  )
  const wanted = new Set(fixed.map(key))
  if (wanted.size === 0 || wanted.size > 16 || wanted.size !== references.length)
    throw new KnowledgeOperationError('AUTOMATION_SOURCE_PROVIDER_UNAVAILABLE')
  const found = new Map<string, KnowledgeAdoption>()
  let after: string | undefined
  const cursors = new Set<string>()
  for (let pageNumber = 0; pageNumber < 7; pageNumber += 1) {
    const page = await client.listAdoptions(after, signal)
    verifyVersions(page.items)
    if (page.items.length > 10) throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
    signal?.throwIfAborted()
    for (const adoption of page.items) {
      const identity = key({
        kind: 'publication',
        id: adoption.publicationId,
        revision: String(adoption.publicationVersion),
      })
      if (wanted.has(identity) && applicable(client, adoption)) {
        if (found.has(identity)) throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
        found.set(identity, adoption)
      }
    }
    if (!page.nextCursor) break
    if (cursors.has(page.nextCursor)) throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
    cursors.add(page.nextCursor)
    after = page.nextCursor
  }
  if (found.size !== wanted.size) throw new KnowledgeOperationError('AUTOMATION_SOURCE_NOT_ADOPTED')
  await Promise.all([...found.values()].map(adoption => resolve(client, adoption, signal)))
  signal?.throwIfAborted()
}
