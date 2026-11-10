import type { AppearanceUpdate } from '../types'

export const APPEARANCE_SCHEMA_VERSION = 1

// Unversioned client preferences are the released v0 baseline. Keep the flat
// object so older clients continue to understand the same preference fields.
export function migrateAppearanceDocument(value: unknown): AppearanceUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('appearance_storage_corrupt')
  }
  const document = value as Record<string, unknown>
  const version = document.schemaVersion === undefined ? 0 : document.schemaVersion
  if (version !== 0 && version !== APPEARANCE_SCHEMA_VERSION) {
    throw new Error('appearance_storage_unsupported_version')
  }
  const { schemaVersion: _version, ...settings } = document
  return settings as AppearanceUpdate
}
