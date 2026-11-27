import type { MigrationSourceCredentialCandidatesParams, MigrationSourceCredentialCandidatesResult,
  MigrationSourceCredentialSelection } from './generated/contracts'
import { validPrivateCredentialResult } from './migrationPrivateCredentials'

export type PrivateCredentialChoice = { kind: 'provider'; selectorIndex: number } | { kind: 'mcp'; fieldIndices: number[] }

/** UI choices reference the original candidate and saved target; names and destinations are never guessed. */
export function selectPrivateCredential(input: MigrationSourceCredentialCandidatesParams, page: MigrationSourceCredentialCandidatesResult,
  itemId: string, choice: PrivateCredentialChoice): MigrationSourceCredentialSelection | null {
  if (!input.jobId || !input.expectedPlanId || !validPrivateCredentialResult('candidates', input, page)) return null
  const row = page.items.find(item => item.itemId === itemId)
  if (!row || row.issueCode != null || !row.sourceName || row.targets?.length !== 1) return null
  const target = row.targets[0]
  if (row.kind === 'provider' && target.kind === 'provider' && choice.kind === 'provider') {
    if (!Number.isSafeInteger(choice.selectorIndex) || choice.selectorIndex < 0 || choice.selectorIndex >= row.selectors.length) return null
    return { kind: 'provider', sourceName: row.sourceName, selector: structuredClone(row.selectors[choice.selectorIndex]),
      targetName: target.targetName, endpoint: target.endpoint, apiFormat: target.apiFormat }
  }
  if (row.kind !== 'mcp' || target.kind !== 'mcp' || choice.kind !== 'mcp' || !row.definitionSha256
    || choice.fieldIndices.length === 0 || new Set(choice.fieldIndices).size !== choice.fieldIndices.length
    || choice.fieldIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= row.fields.length)) return null
  return { kind: 'mcp', sourceName: row.sourceName, definitionSha256: row.definitionSha256, targetName: target.targetName,
    fields: [...choice.fieldIndices].sort((a, b) => a - b).map(index => structuredClone(row.fields[index])) }
}
