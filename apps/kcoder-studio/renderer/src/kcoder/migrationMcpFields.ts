import type {
  MigrationMcpCandidate,
  MigrationMcpPrivateField,
} from '../../../shared/generated/contracts'

export function mcpPrivateFieldKey(field: MigrationMcpPrivateField) {
  return JSON.stringify([
    field.kind,
    field.kind === 'header' ? field.name.toLowerCase() : field.name,
  ])
}

export function mcpCandidatePrivateFields(
  candidate?: MigrationMcpCandidate
): MigrationMcpPrivateField[] {
  const fields: MigrationMcpPrivateField[] = [
    ...(candidate?.requiredEnv ?? []).map(name => ({ kind: 'environment' as const, name })),
    ...(candidate?.requiredHeaders ?? []).map(name => ({ kind: 'header' as const, name })),
  ]
  return [...new Map(fields.map(field => [mcpPrivateFieldKey(field), field])).values()]
}
