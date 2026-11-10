import { expect, it } from 'vitest'
import { migrationFirstUseStatus } from './migrationFirstUseState'
import type { ProviderProfile, ProviderSettings } from '@/kcoder/providerSettings'

const row: ProviderProfile = { id: 'Office', model: 'office-model', apiFormat: 'openai_chat_completions', endpoint: 'https://example.invalid/v1', contextWindowTokens: 32000, maxOutputTokens: 4096, apiKeyConfigured: true, isDefault: true }
const settings = (profiles: ProviderProfile[]): ProviderSettings => ({ profiles, restartRequired: false })
it('requires authoritative settings and separates loading/offline from an actual empty configuration', () => {
  expect(migrationFirstUseStatus(null)).toBe('unknown')
  expect(migrationFirstUseStatus(settings([]))).toBe('unconfigured')
  expect(migrationFirstUseStatus(settings([row]))).toBe('configured')
  expect(migrationFirstUseStatus(settings([{ ...row, apiKeyConfigured: false, authentication: { mode: 'none' } }]))).toBe('configured')
})
it('does not restart first-use import for explicit connections that still need credentials or a default', () => {
  expect(migrationFirstUseStatus(settings([{ ...row, apiKeyConfigured: false, fileSources: { endpoint: ['user'] } }]))).toBe('incomplete')
  expect(migrationFirstUseStatus(settings([{ ...row, isDefault: false }]))).toBe('incomplete')
  expect(migrationFirstUseStatus(settings([{ ...row, apiKeyConfigured: false, fileSources: { endpoint: ['default'] } }]))).toBe('unconfigured')
})
