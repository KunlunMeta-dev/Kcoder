import { expect, test } from 'vitest'
import { computerUseConsent } from './computerUseConsent'
import { notifyAccountContextChange } from './accountContextEvents'

test('consent is isolated by target and task, revocable, and cleared on account change', () => {
  computerUseConsent.set('local-consent', 'one', true)
  expect(computerUseConsent.has('local-consent', 'one')).toBe(true)
  expect(computerUseConsent.has('local-consent', 'two')).toBe(false)
  expect(computerUseConsent.has('remote-consent', 'one')).toBe(false)
  computerUseConsent.set('local-consent', 'one', false)
  expect(computerUseConsent.has('local-consent', 'one')).toBe(false)
  computerUseConsent.set('local-consent', 'one', true)
  notifyAccountContextChange('local-consent')
  expect(computerUseConsent.has('local-consent', 'one')).toBe(false)
})
