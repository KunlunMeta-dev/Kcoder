import { canonicalInstructionMappings, instructionMappingsSignature, validInstructionMappings } from '../../../shared/migrationInstructionMappings'
import { isMigrationSourceAdoptionParams, isMigrationSourceAdoptionPrepareParams, type MigrationSourceAdoptionPrepareParams,
  type MigrationSourceAdoptionSession } from '../../../shared/generated/contracts'
import { createMigrationSourceAdoptionClient } from './gatewayMigrationSourceAdoption'
import { MigrationSourceHttpError, type MigrationSourceHttpOptions } from './gatewayMigrationSourceHttp'

interface Options extends MigrationSourceHttpOptions {
  storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>
  recoveryScope: string
}
function semantic(input: MigrationSourceAdoptionPrepareParams) {
  const base = [input.locator.requestId, input.locator.target.targetId,
    input.locator.target.workspacePath ?? null, input.manifestSha256,
    [...input.selections].sort((a, b) => a.entryId.localeCompare(b.entryId)).map(item => [item.entryId, item.projectMapping ?? null])]
  const mappings = instructionMappingsSignature(input.instructionMappings)
  return JSON.stringify(mappings ? [...base, mappings] : base)
}

/** Cache only stable selectors. Native owns the intent, scan jobs and publication receipts. */
export function createMigrationSourceAdoptionRecovery(options: Options) {
  const client = createMigrationSourceAdoptionClient(options)
  const scope = options.captureScope()
  if (!scope || !options.recoveryScope) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
  const prefix = `kcoder.migration.adoption:${encodeURIComponent(options.recoveryScope)}:`
  const current = () => {
    if (!scope || options.captureScope() !== scope) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
  }
  const readRecord = (key: string): MigrationSourceAdoptionPrepareParams => {
    try {
      const raw = options.storage.getItem(key)
      if (!raw || raw.length > 64 * 1024) throw new Error('missing or oversized selector record')
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('input' in value)
        || Object.keys(value).length !== 2 || !isMigrationSourceAdoptionPrepareParams(value.input)
        || new Set(value.input.selections.map(item => item.entryId)).size !== value.input.selections.length || !validInstructionMappings(value.input.instructionMappings ?? [], value.input.selections)
        || key !== prefix + value.input.locator.requestId + ':' + value.input.locator.adoptionId) throw new Error('invalid selector record')
      return value.input
    } catch { throw new MigrationSourceHttpError('source_transfer_adoption_recovery_invalid', false) }
  }
  const list = (requestId: string) => {
      current()
      if (!isMigrationSourceAdoptionParams({ requestId, adoptionId: requestId, target: { sessionId: requestId, purpose: 'target', targetId: 'cache' } })) {
        throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
      }
      const values: MigrationSourceAdoptionPrepareParams[] = []
      try {
        for (let i = 0; i < options.storage.length; i++) {
          const key = options.storage.key(i)
          if (key?.startsWith(prefix + requestId + ':')) values.push(readRecord(key))
        }
      } catch (error) {
        if (error instanceof MigrationSourceHttpError) throw error
        throw new MigrationSourceHttpError('source_transfer_recovery_unavailable', false)
      }
      current()
      return values
  }
  return {
    list,
    async prepare(input: MigrationSourceAdoptionPrepareParams) {
      current()
      if (!isMigrationSourceAdoptionPrepareParams(input) || new Set(input.selections.map(item => item.entryId)).size !== input.selections.length || !validInstructionMappings(input.instructionMappings ?? [], input.selections)) {
        throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
      }
      const desired = { ...input, ...(input.instructionMappings?.length ? { instructionMappings: canonicalInstructionMappings(input.instructionMappings) } : {}), selections: [...input.selections].sort((a, b) => a.entryId.localeCompare(b.entryId)) }
      const previous = list(input.locator.requestId).find(item => semantic(item) === semantic(desired))
      if (previous) return { locator: { ...previous.locator, target: input.locator.target }, result: await client.read({ ...previous.locator, target: input.locator.target }) }
      const key = prefix + input.locator.requestId + ':' + input.locator.adoptionId
      const text = JSON.stringify({ version: 1, input: desired })
      try {
        if (options.storage.getItem(key) !== null || text.length > 64 * 1024) throw new Error('identity already bound or oversized')
        options.storage.setItem(key, text)
        if (options.storage.getItem(key) !== text) throw new Error('selector record not retained')
      } catch { throw new MigrationSourceHttpError('source_transfer_recovery_unavailable', false) }
      current()
      return { locator: input.locator, result: await client.prepare(desired) }
    },
    async read(input: MigrationSourceAdoptionPrepareParams, target: MigrationSourceAdoptionSession) {
      current()
      const saved = readRecord(prefix + input.locator.requestId + ':' + input.locator.adoptionId)
      if (semantic(saved) !== semantic(input) || target.targetId !== saved.locator.target.targetId
        || (target.workspacePath ?? null) !== (saved.locator.target.workspacePath ?? null)) {
        throw new MigrationSourceHttpError('source_transfer_request_changed', false)
      }
      return client.read({ ...saved.locator, target })
    },
  }
}
