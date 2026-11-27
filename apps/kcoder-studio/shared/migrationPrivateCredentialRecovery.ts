import type { MigrationSourceCredentialRunParams, MigrationSourceSessionParams } from './generated/contracts'
import { privateCredentialClient, validPrivateCredentialInput } from './migrationPrivateCredentials'

type Store = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>
interface Options {
  storage: Store
  client: ReturnType<typeof privateCredentialClient>
  captureScope(): string
  recoveryScope: string
}

export class PrivateCredentialRecoveryError extends Error {
  readonly outcomeUnknown = false
  readonly code: string
  constructor(code: string) { super(code); this.code = code; this.name = 'PrivateCredentialRecoveryError' }
}
function fail(code: string): never { throw new PrivateCredentialRecoveryError(code) }
const route = (value: MigrationSourceSessionParams) => [value.targetId, value.workspacePath ?? null]
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)])) : value
const semantic = (input: MigrationSourceCredentialRunParams) => JSON.stringify([
  input.locator.requestId, route(input.locator.target), route(input.source), input.manifestSha256, input.entryId,
  input.selections.map(row => JSON.stringify(canonical(row.kind === 'mcp'
    ? { ...row, fields: row.fields.map(field => JSON.stringify(canonical(field))).sort() } : row))).sort(),
  canonical(input.consent),
])

/** Metadata locators enable reconciliation; they never grant authority or cache private values. */
export function createPrivateCredentialRecovery(options: Options) {
  const scope = options.captureScope()
  if (!scope || !options.recoveryScope) fail('private_credentials_authority_changed')
  const prefix = `kcoder.migration.private:${encodeURIComponent(options.recoveryScope)}:`
  const current = () => {
    if (options.captureScope() !== scope) fail('private_credentials_authority_changed')
  }
  const keyFor = (input: MigrationSourceCredentialRunParams) => prefix + input.locator.requestId + ':' + input.locator.offerId
  const load = (key: string): MigrationSourceCredentialRunParams => {
    try {
      const raw = options.storage.getItem(key)
      if (!raw || raw.length > 256 * 1024) fail('private_credentials_recovery_invalid')
      const record: unknown = JSON.parse(raw)
      if (!record || typeof record !== 'object' || !('version' in record) || record.version !== 1
        || !('input' in record) || Object.keys(record).length !== 2 || !validPrivateCredentialInput('run', record.input)
        || keyFor(record.input) !== key) fail('private_credentials_recovery_invalid')
      return record.input
    } catch { return fail('private_credentials_recovery_invalid') }
  }
  const all = () => {
    current()
    const values: MigrationSourceCredentialRunParams[] = []
    try {
      for (let index = 0; index < options.storage.length; index++) {
        const key = options.storage.key(index)
        if (key?.startsWith(prefix)) {
          if (values.length >= 64) fail('private_credentials_recovery_capacity')
          values.push(load(key))
        }
      }
    } catch (error) {
      if (error instanceof PrivateCredentialRecoveryError) throw error
      fail('private_credentials_recovery_unavailable')
    }
    current()
    return values
  }
  const readOriginal = async (saved: MigrationSourceCredentialRunParams, target: MigrationSourceSessionParams) => {
    current()
    if (JSON.stringify(route(saved.locator.target)) !== JSON.stringify(route(target))) fail('private_credentials_binding_changed')
    const locator = { ...saved.locator, target }
    if (!validPrivateCredentialInput('read', locator)) fail('private_credentials_invalid_request')
    const result = await options.client.read(locator)
    current()
    return { input: saved, result }
  }
  const locate = (input: MigrationSourceCredentialRunParams) => {
    current()
    if (!validPrivateCredentialInput('run', input)) fail('private_credentials_invalid_request')
    const records = all(), exact = records.find(row => keyFor(row) === keyFor(input))
    if (exact && semantic(exact) !== semantic(input)) fail('private_credentials_binding_changed')
    return structuredClone(exact ?? records.find(row => semantic(row) === semantic(input)) ?? input)
  }
  return {
    locate,
    list(pageIndex = 0) {
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) fail('private_credentials_invalid_page')
      const records = all().sort((a, b) => keyFor(a).localeCompare(keyFor(b)))
      return { items: records.slice(pageIndex * 10, pageIndex * 10 + 10), totalItems: records.length,
        nextPage: (pageIndex + 1) * 10 < records.length ? pageIndex + 1 : null }
    },
    async run(input: MigrationSourceCredentialRunParams) {
      current()
      if (!validPrivateCredentialInput('run', input)) fail('private_credentials_invalid_request')
      const records = all(), exact = records.find(row => keyFor(row) === keyFor(input))
      if (exact && semantic(exact) !== semantic(input)) fail('private_credentials_binding_changed')
      const previous = exact ?? records.find(row => semantic(row) === semantic(input))
      if (previous) return readOriginal(previous, input.locator.target)
      if (records.length >= 64) fail('private_credentials_recovery_capacity')
      const saved = structuredClone(input), key = keyFor(saved)
      try {
        const text = JSON.stringify({ version: 1, input: saved })
        if (new TextEncoder().encode(text).length > 256 * 1024 || options.storage.getItem(key) !== null) fail('private_credentials_recovery_unavailable')
        options.storage.setItem(key, text)
        if (options.storage.getItem(key) !== text) fail('private_credentials_recovery_unavailable')
      } catch { fail('private_credentials_recovery_unavailable') }
      current()
      const result = await options.client.run(saved)
      current()
      return { input: saved, result }
    },
    async read(input: MigrationSourceCredentialRunParams, target: MigrationSourceSessionParams) {
      current()
      if (!validPrivateCredentialInput('run', input)) fail('private_credentials_invalid_request')
      const saved = load(keyFor(input))
      if (semantic(saved) !== semantic(input)) fail('private_credentials_binding_changed')
      return readOriginal(saved, target)
    },
  }
}
