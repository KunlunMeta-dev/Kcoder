import type { ProviderSettings } from '@/kcoder/providerSettings'

export type MigrationFirstUseStatus = 'unknown' | 'unconfigured' | 'incomplete' | 'configured'

/** A catalog load/error is not evidence that a target has no configuration. */
export function migrationFirstUseStatus(settings: ProviderSettings | null): MigrationFirstUseStatus {
  if (!settings || !Array.isArray(settings.profiles)) return 'unknown'
  const rows = settings.profiles
  if (rows.some(profile => !profile || typeof profile.id !== 'string' || typeof profile.model !== 'string')) return 'unknown'
  const ready = rows.filter(profile => profile.availableInCurrentConfig !== false && profile.model.trim() && profile.endpoint?.trim()
    && profile.contextWindowTokens > 0 && profile.maxOutputTokens > 0
    && (profile.apiKeyConfigured === true || profile.authentication?.mode === 'none'))
  if (ready.some(profile => profile.isDefault)) return 'configured'
  if (ready.length) return 'incomplete'
  const explicit = rows.some(profile => !profile.fileSources || Object.values(profile.fileSources).some(sources =>
    Array.isArray(sources) && sources.some(source => source !== 'default')))
  return explicit ? 'incomplete' : 'unconfigured'
}

export const firstUseStorageKey = (scope: string) => `kcoder.migration.first-use:${scope}`
export function firstUseSkipped(scope: string): boolean {
  try { return localStorage.getItem(firstUseStorageKey(scope)) === '1' } catch { return false }
}
export function skipFirstUse(scope: string): void {
  try { localStorage.setItem(firstUseStorageKey(scope), '1') } catch { /* The current view still dismisses when storage is disabled. */ }
}
