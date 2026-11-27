import * as C from './generated/contracts'

export function canonicalInstructionMappings(mappings: C.MigrationSourceInstructionMapping[] = []): C.MigrationSourceInstructionMapping[] {
  return mappings.map(mapping => ({ entryId: mapping.entryId, archiveIncompleteChain: mapping.archiveIncompleteChain === true,
    items: mapping.items.map(item => ({ itemId: item.itemId, targetRelativeScope: item.targetRelativeScope })).sort((a, b) => a.itemId.localeCompare(b.itemId)),
  })).sort((a, b) => a.entryId.localeCompare(b.entryId))
}
/** Empty bindings preserve the original cache/intent identity exactly. */
export function instructionMappingsSignature(mappings: C.MigrationSourceInstructionMapping[] = []): string {
  return mappings.length ? JSON.stringify(canonicalInstructionMappings(mappings)) : ''
}
export function validInstructionMappings(mappings: unknown, selections: C.MigrationSourceAdoptionSelection[]): mappings is C.MigrationSourceInstructionMapping[] {
  if (!Array.isArray(mappings) || mappings.length > 64 || !mappings.every(C.isMigrationSourceInstructionMapping)) return false
  if (new Set(mappings.map(mapping => mapping.entryId)).size !== mappings.length || mappings.reduce((total, mapping) => total + mapping.items.length, 0) > 128) return false
  return mappings.every(mapping => selections.some(selection => selection.entryId === mapping.entryId && selection.projectMapping === 'current_workspace')
    && new Set(mapping.items.map(item => item.itemId)).size === mapping.items.length)
}
