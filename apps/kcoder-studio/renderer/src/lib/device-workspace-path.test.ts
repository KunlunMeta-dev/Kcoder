import { expect, test } from 'vitest'
import { normalizeDevicePath } from './device-workspace-path'

// Device workspace paths become identity keys (task addresses, refresh RPC
// arguments) and UI text, so the namespace form must never survive the data
// entry point that feeds them.
test('device workspace paths drop the Windows namespace prefix', () => {
  const normalized = normalizeDevicePath('\\\\?\\C:\\Users\\kunlunmeta\\projects\\gpt-factory')
  expect(normalized).toBe('C:/Users/kunlunmeta/projects/gpt-factory')
  expect(normalized.includes('\\\\?\\')).toBe(false)
})

test('device workspace paths keep namespaces that cannot be rewritten losslessly', () => {
  expect(normalizeDevicePath('\\\\?\\D:\\project.')).toBe('\\\\?\\D:\\project.')
})