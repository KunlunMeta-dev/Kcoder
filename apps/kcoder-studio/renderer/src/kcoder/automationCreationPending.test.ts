import { hookTargetScope } from './gatewayHookConfiguration'
import { beforeEach, expect, test } from 'vitest'
import {
  automationPendingKey,
  clearAutomationPending,
  readAutomationPending,
  saveAutomationPending,
} from './automationCreationPending'

beforeEach(() => sessionStorage.clear())
test('pending identities are scoped to the actual account, target and workspace', () => {
  const server = { id: 'owned', transport: 'local' as const, profile: 'one' }
  const key = automationPendingKey(server, '/workspace')
  saveAutomationPending(key, 'original')
  expect(
    readAutomationPending(automationPendingKey({ ...server, profile: 'two' }, '/workspace'))
  ).toBeNull()
  expect(readAutomationPending(automationPendingKey(server, '/other'))).toBeNull()
  expect(readAutomationPending(key)).toBe('original')
})
test('an old completion cannot clear a replacement pending operation', () => {
  saveAutomationPending('owned-key', 'replacement')
  expect(clearAutomationPending('owned-key', 'original')).toBe(false)
  expect(readAutomationPending('owned-key')).toBe('replacement')
  expect(clearAutomationPending('owned-key', 'replacement')).toBe(true)
})
test('concurrent preparation cannot replace an unresolved locator before dispatch', () => {
  saveAutomationPending('owned-key', 'original')
  expect(() => saveAutomationPending('owned-key', 'replacement')).toThrow()
  expect(readAutomationPending('owned-key')).toBe('original')
})

test('registered default changes preserve the pending request for an explicit workspace', () => {
  const server = { id: 'owned', transport: 'local' as const, workspacePath: '/default-before' }
  saveAutomationPending(automationPendingKey(server, '/active-project'), 'original')
  expect(
    readAutomationPending(
      automationPendingKey({ ...server, workspacePath: '/default-after' }, '/active-project')
    )
  ).toBe('original')
})
test('previous keys remain recoverable without merging different original operations', () => {
  const server = { id: 'owned', transport: 'local' as const, workspacePath: '/default-before' }
  const oldKey = `kcoder.automation.pending:${JSON.stringify([hookTargetScope(server), '/active-project'])}`
  sessionStorage.setItem(oldKey, 'old-original')
  const key = automationPendingKey(
    { ...server, workspacePath: '/default-after' },
    '/active-project'
  )
  expect(readAutomationPending(key)).toBe('old-original')
  expect(() => saveAutomationPending(key, 'duplicate')).toThrow()
  sessionStorage.setItem(key, 'new-original')
  expect(clearAutomationPending(key, 'old-original')).toBe(false)
  expect(clearAutomationPending(key, 'new-original')).toBe(true)
  expect(readAutomationPending(key)).toBe('old-original')
  expect(clearAutomationPending(key, 'old-original')).toBe(true)
  expect(sessionStorage.getItem(oldKey)).toBeNull()
})
