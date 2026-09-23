import { describe, expect, it } from 'vitest'
import { providerSaveErrorKey, providerSaveOutcomeUnknown } from './providerValidationErrors'

describe('provider save outcome classification', () => {
  it('reports reasoning conflicts as a definite pre-save refusal', () => {
    const error = new Error('[provider_reasoning_policy] safe reason')
    expect(providerSaveOutcomeUnknown(error)).toBe(false)
    expect(providerSaveErrorKey(error)).toBe('localRuntime:providerSettings.reasoningPolicyConflict')
  })
  it.each([
    ['[provider_probe_timeout] fixture-only', 'timeout'],
    ['[provider_probe_network] fixture-only', 'network'],
    ['[provider_probe_authentication] fixture-only', 'authentication'],
    ['[provider_probe_changed] fixture-only', 'changed'],
  ])('keeps the pre-commit refusal %s distinct from a lost reply', (message, category) => {
    const error = new Error(message)
    expect(providerSaveOutcomeUnknown(error)).toBe(false)
    expect(providerSaveErrorKey(error)).toBe(`providerSettings.validation_${category}`)
  })

  it.each([
    new Error('RPC request timed out'),
    new Error('RPC timeout'),
    new Error('[provider_transaction_pending] reload required'),
    Object.assign(new Error('fixture-only'), { reason: 'connection' }),
  ])('requires recovery when commit status is uncertain', error => {
    expect(providerSaveOutcomeUnknown(error)).toBe(true)
  })

  it('never returns raw errors or secrets as translation keys', () => {
    for (const error of [new Error('fixture-secret'), 'fixture-secret', null]) {
      expect(providerSaveErrorKey(error)).toBe('providerSettings.saveFailed')
    }
  })
})
