export interface NativeKnowledgeSource {
  version: 1
  publisherPrincipalId: string
  publicationOwner: {
    accountId: string
    targetId: string
    workspaceId: string | null
    organizationId: string | null
  }
  publicationId: string
}

export function knowledgeSourceReference(
  raw: string
): Pick<NativeKnowledgeSource, 'publicationOwner' | 'publicationId'> | null {
  try {
    const value = JSON.parse(raw)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(key => !['owner', 'publicationId', 'version'].includes(key)) ||
      typeof value.publicationId !== 'string' ||
      !value.publicationId ||
      value.publicationId.length > 256
    )
      return null
    if (value.version !== undefined && (!Number.isSafeInteger(value.version) || value.version < 1))
      return null
    const owner = value.owner
    if (
      !owner ||
      typeof owner !== 'object' ||
      Array.isArray(owner) ||
      Object.keys(owner).sort().join(',') !== 'accountId,organizationId,targetId,workspaceId' ||
      !['accountId', 'targetId'].every(
        key => typeof owner[key] === 'string' && owner[key].length > 0 && owner[key].length <= 256
      ) ||
      !['workspaceId', 'organizationId'].every(
        key =>
          owner[key] === null ||
          (typeof owner[key] === 'string' && owner[key].length > 0 && owner[key].length <= 256)
      )
    )
      return null
    return {
      publicationOwner: {
        accountId: owner.accountId,
        targetId: owner.targetId,
        workspaceId: owner.workspaceId,
        organizationId: owner.organizationId,
      },
      publicationId: value.publicationId,
    }
  } catch {
    return null
  }
}
