import { afterEach, expect, test, vi } from 'vitest'
import { isCloudConnectionUiAvailable } from './cloudConnectionAvailability'
import { APP_TABS, DEFAULT_APP_KEY } from '@/config/apps'

vi.mock('@/lib/runtime-mode', () => ({ isLocalFirstAppRuntime: () => true }))
afterEach(() => document.querySelector('meta[name="kcoder-rpc-token"]')?.remove())

test('Gateway clients do not advertise the unsupported legacy cloud account', () => {
  const meta = document.createElement('meta')
  meta.name = 'kcoder-rpc-token'
  meta.content = 'fixture'
  document.head.append(meta)
  expect(isCloudConnectionUiAvailable()).toBe(false)
})

test('internal application routing stays compatible while display names use KCoder', () => {
  expect(DEFAULT_APP_KEY).toBe('studio')
  expect(APP_TABS.find(tab => tab.key === DEFAULT_APP_KEY)?.label).toBe('KCoder Studio')
  expect(APP_TABS.map(tab => tab.label).join(' ')).not.toMatch(/wework|wegent|codex/i)
})
