import type {
  IntegrationEntityRef,
  OfficeArtifactRef,
  OfficeArtifactManifest,
  IntegrationScope,
} from '../../../../../shared/generated/contracts'
import { isOfficeArtifactManifest } from '../../../../../shared/generated/contractGuards.mjs'
import { createRandomUuid } from '@/lib/random-id'
import type { OfficeTurnPhase } from '@/features/office-integration/ArtifactCollection'
import {
  OfficeClientError,
  type OfficeController,
  type OfficeList,
} from '@/features/office-integration/controller'

/** Snapshot references are selectors; every page re-reads the original native revision. */
export function fixedTaskArtifacts(
  controller: OfficeController,
  threadId: string,
  references: IntegrationEntityRef[],
  expectedScope: IntegrationScope,
  automation?: { runId: string; workflowTaskId: string }
) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(threadId) || references.length > 1024)
    throw new OfficeClientError('OFFICE_INVALID_REQUEST', 'retry_read')
  if (automation && (!/^[A-Za-z0-9_-]{1,256}$/.test(automation.runId)
    || !/^[A-Za-z0-9_-]{1,256}$/.test(automation.workflowTaskId)))
    throw new OfficeClientError('OFFICE_INVALID_REQUEST', 'retry_read')
  // Metadata selectors only; Native export still checks the original Core
  // ChildIntent, actual Accepted, epoch and frozen D reference.
  const workflowTaskId = automation?.workflowTaskId
  const unique = new Map<string, OfficeArtifactRef>()
  for (const ref of references) {
    if (
      ref.kind !== 'artifact' ||
      typeof ref.revision !== 'string' ||
      !/^[1-9]\d*$/.test(ref.revision)
    )
      throw new OfficeClientError('OFFICE_REVISION_CONFLICT', 'retry_read')
    const revision = Number(ref.revision)
    if (
      !Number.isSafeInteger(revision) ||
      typeof ref.id !== 'string' ||
      !ref.id ||
      ref.id.length > 256
    )
      throw new OfficeClientError('OFFICE_INVALID_REQUEST', 'retry_read')
    unique.set(`${ref.id}@${revision}`, { id: ref.id, revision })
  }
  const expected = [...unique.values()]
  const scope = controller.scopeKey()
  const cursorOwner = createRandomUuid()
  return async (
    cursor: string | undefined,
    signal: AbortSignal
  ): Promise<OfficeList<Record<string, unknown>>> => {
    signal.throwIfAborted()
    if (scope !== controller.scopeKey())
      throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'retry_read')
    const position = cursor?.startsWith(`${cursorOwner}:`)
      ? cursor.slice(cursorOwner.length + 1)
      : undefined
    const offset =
      cursor === undefined
        ? 0
        : position !== undefined && /^(?:0|[1-9]\d*)$/.test(position)
          ? Number(position)
          : -1
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % 10 !== 0 ||
      offset >= Math.max(1, expected.length)
    )
      throw new OfficeClientError('OFFICE_CURSOR_EXPIRED', 'retry_read')
    const items: OfficeArtifactManifest[] = []
    for (const ref of expected.slice(offset, offset + 10)) {
      const result = await controller.readArtifact(ref, signal)
      signal.throwIfAborted()
      const manifest = result.manifest
      if (
        !isOfficeArtifactManifest(manifest) ||
        manifest.id !== ref.id ||
        manifest.revision !== ref.revision ||
        (workflowTaskId
          ? manifest.task.runId !== workflowTaskId || manifest.task.threadId === threadId
          : manifest.task.threadId !== threadId) ||
        manifest.owner.accountId !== expectedScope.accountId ||
        manifest.owner.targetId !== expectedScope.targetId ||
        manifest.owner.workspaceId !== expectedScope.workspaceId ||
        (manifest.owner.organizationId ?? null) !== (expectedScope.organizationId ?? null)
      )
        throw new OfficeClientError('OFFICE_REVISION_CONFLICT', 'retry_read')
      items.push(manifest)
    }
    if (scope !== controller.scopeKey())
      throw new OfficeClientError('OFFICE_SCOPE_CHANGED', 'retry_read')
    return {
      items: items as unknown as Record<string, unknown>[],
      total: expected.length,
      nextCursor: offset + 10 < expected.length ? `${cursorOwner}:${offset + 10}` : null,
    }
  }
}

/** Native idle is not evidence of a successful final response. */
export function nativeTaskArtifactPhase(
  turnStatus: string | null | undefined,
  busy: boolean
): OfficeTurnPhase {
  if (busy || turnStatus === 'inProgress') return 'running'
  if (turnStatus === 'completed') return 'completed'
  if (turnStatus === 'failed') return 'failed'
  if (turnStatus === 'interrupted') return 'cancelled'
  return 'unknown'
}
