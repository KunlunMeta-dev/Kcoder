import type { IntegrationOwner } from '../../../../shared/generated/contracts'
/** Presentation equality only; native policy still authorizes every operation. */
export function sameKnowledgeOwner(left: IntegrationOwner, right: IntegrationOwner): boolean {
  return (
    left.accountId === right.accountId &&
    left.targetId === right.targetId &&
    left.workspaceId === right.workspaceId &&
    (left.organizationId ?? null) === (right.organizationId ?? null)
  )
}
