export const ORGANIZATION_BUDGET_LIMITS = [
  'tokens',
  'modelCalls',
  'runMillis',
  'costMicros',
  'concurrentTasks',
  'concurrentCalls',
] as const
export type OrganizationBudgetLimit = (typeof ORGANIZATION_BUDGET_LIMITS)[number]
export interface OrganizationModelRule {
  id: string
  members: string[]
  workspaceResourceIds: string[]
  provider: string
  model: string
  endpointOrigin: string
  configurationRevision: string | null
  enabled: boolean
}
export interface OrganizationBudgetPolicy {
  id: string
  scope: { kind: 'organization' | 'account' | 'workspace' | 'task'; id: string }
  window: { id: string; startsAtMs: number; endsAtMs: number }
  limits: Partial<Record<OrganizationBudgetLimit, number>>
  currency: string | null
}
export interface OrganizationExecutionPolicy {
  version: 1
  modelRules: OrganizationModelRule[]
  budgetPolicies: OrganizationBudgetPolicy[]
}

export function cloneOrganizationExecutionPolicy(
  value: OrganizationExecutionPolicy | null | undefined
): OrganizationExecutionPolicy {
  return value ? structuredClone(value) : { version: 1, modelRules: [], budgetPolicies: [] }
}

export function organizationModelOrigin(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (
      !['https:', 'http:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/' ||
      /\s|\\/.test(value)
    )
      return null
    return parsed.origin
  } catch {
    return null
  }
}

export function validOrganizationExecutionPolicy(
  value: OrganizationExecutionPolicy,
  members: readonly string[],
  workspaces: readonly string[],
  organizationId: string
): boolean {
  const reference = (id: string) =>
    /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id) && !id.includes('..')
  const unique = (values: string[]) => new Set(values).size === values.length
  const exactName = (name: string) =>
    name.length > 0 &&
    name.length <= 256 &&
    name.trim() === name &&
    [...name].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  if (
    value.version !== 1 ||
    value.modelRules.length > 128 ||
    value.budgetPolicies.length > 128 ||
    !unique(value.modelRules.map(row => row.id)) ||
    !unique(value.budgetPolicies.map(row => row.id))
  )
    return false
  if (
    !value.modelRules.every(
      row =>
        reference(row.id) &&
        row.members.length > 0 &&
        unique(row.members) &&
        row.members.every(id => members.includes(id)) &&
        row.workspaceResourceIds.length > 0 &&
        unique(row.workspaceResourceIds) &&
        row.workspaceResourceIds.every(id => workspaces.includes(id)) &&
        row.provider.trim() === row.provider &&
        exactName(row.provider) &&
        !row.provider.includes('::') &&
        row.model.trim() === row.model &&
        exactName(row.model) &&
        organizationModelOrigin(row.endpointOrigin) !== null &&
        (row.configurationRevision === null || /^[a-f0-9]{64}$/.test(row.configurationRevision))
    )
  )
    return false
  const scopes = value.budgetPolicies.map(row => JSON.stringify(row.scope))
  return (
    unique(scopes) &&
    value.budgetPolicies.every(
      row =>
        reference(row.id) &&
        reference(row.scope.id) &&
        (row.scope.kind !== 'organization' || row.scope.id === organizationId) &&
        (row.scope.kind !== 'account' || members.includes(row.scope.id)) &&
        (row.scope.kind !== 'workspace' || workspaces.includes(row.scope.id)) &&
        reference(row.window.id) &&
        Number.isSafeInteger(row.window.startsAtMs) &&
        row.window.startsAtMs >= 0 &&
        Number.isSafeInteger(row.window.endsAtMs) &&
        row.window.endsAtMs > row.window.startsAtMs &&
        Object.keys(row.limits).length > 0 &&
        Object.entries(row.limits).every(
          ([key, amount]) =>
            ORGANIZATION_BUDGET_LIMITS.includes(key as OrganizationBudgetLimit) &&
            Number.isSafeInteger(amount) &&
            amount >= 0 &&
            (!['concurrentTasks', 'concurrentCalls'].includes(key) || amount <= 2 ** 32 - 1)
        ) &&
        (row.currency === null || /^[A-Z]{3}$/.test(row.currency)) &&
        (row.limits.costMicros === undefined || row.currency !== null)
    )
  )
}
