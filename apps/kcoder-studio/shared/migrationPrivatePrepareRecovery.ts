import type { MigrationSourceCredentialPrepareParams } from './generated/contracts'
import { validPrivateCredentialInput } from './migrationPrivateCredentials'
import { PrivateCredentialRecoveryError } from './migrationPrivateCredentialRecovery'

type Store = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>
type Intent = { version: 2; planId: string; input: MigrationSourceCredentialPrepareParams }
function fail(): never { throw new PrivateCredentialRecoveryError('private_credentials_recovery_invalid') }
const offers = (input: MigrationSourceCredentialPrepareParams) => [input.locator.offerId, ...(input.additionalOffers ?? [])].sort()
const identity = (input: MigrationSourceCredentialPrepareParams) => JSON.stringify([
  input.jobId, input.locator.requestId, input.locator.target.targetId, input.locator.target.workspacePath ?? null,
  offers(input), input.consent.apiKeys, input.consent.mcpPrivateFields,
])

/** Immutable per-set metadata survives plan replacement; only Native receipts establish preparation. */
export function privatePrepareRecovery(storage: Store, scope: string, jobId: string) {
  const prefix = `kcoder.migration.private-prepare:${encodeURIComponent(scope)}:${encodeURIComponent(jobId)}:`
  const legacy = `kcoder.mobile.private-prepare:${scope}:${jobId}:`
  const keyFor = (input: MigrationSourceCredentialPrepareParams) => prefix + encodeURIComponent(identity(input))
  const list = (): Intent[] => {
    const records: Intent[] = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key || !key.startsWith(prefix) && !key.startsWith(legacy)) continue
      if (records.length >= 64) fail()
      const raw = storage.getItem(key)
      if (!raw || raw.length > 64 * 1024) fail()
      let value: unknown
      try { value = JSON.parse(raw) } catch { fail() }
      const record = key.startsWith(legacy)
        ? { version: 2, planId: key.slice(legacy.length), input: value } : value
      if (!record || typeof record !== 'object' || !('version' in record) || record.version !== 2
        || !('planId' in record) || typeof record.planId !== 'string' || !record.planId
        || !('input' in record) || !validPrivateCredentialInput('prepare', record.input)
        || record.input.jobId !== jobId || key.startsWith(prefix) && keyFor(record.input) !== key) fail()
      records.push(record as Intent)
    }
    return records
  }
  return {
    list,
    find(input: MigrationSourceCredentialPrepareParams) {
      const matches = list().filter(record => identity(record.input) === identity(input))
      if (matches.some(record => record.input.expectedSequence !== matches[0].input.expectedSequence)) fail()
      return matches[0] ? structuredClone(matches[0]) : null
    },
    save(planId: string, input: MigrationSourceCredentialPrepareParams) {
      if (!validPrivateCredentialInput('prepare', input) || input.jobId !== jobId || !planId) fail()
      const records = list(), key = keyFor(input), previous = records.find(record => identity(record.input) === identity(input))
      if (previous) {
        if (previous.input.expectedSequence !== input.expectedSequence) fail()
        return structuredClone(previous)
      }
      if (records.length >= 64 || storage.getItem(key) !== null) fail()
      const record: Intent = { version: 2, planId, input: structuredClone(input) }, raw = JSON.stringify(record)
      if (raw.length > 64 * 1024) fail()
      storage.setItem(key, raw)
      if (storage.getItem(key) !== raw) fail()
      return record
    },
  }
}
