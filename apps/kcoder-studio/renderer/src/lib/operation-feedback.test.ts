import { expect, test } from 'vitest'
import { operationFailure } from '../../../shared/operationFailure'
import { operationFeedback } from './operation-feedback'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
import { ResourceClientError } from '@/features/integration-resources/controller'
import i18n from '@/i18n'

test('remote write errors remain unknown unless their pre-admission meaning is established', () => {
  for (const error of [new Error('lost response'),
    new GatewayRpcError('write failed', -32602, undefined, 'runtime-session', 'remote'),
    new ResourceClientError('OFFICE_OPERATION_PENDING', 'reconcile_original'),
    { uncertain: true, recovery: 'none', message: 'scheduled time must be in the future' },
    { recovery: 'future_recovery' }, null]) {
    expect(operationFailure(error).outcome).toBe('unknown')
  }
  expect(operationFailure(new GatewayRpcError('scheduled time must be in the future', -32602)).outcome).toBe('rejected')
  expect(operationFailure(new ResourceClientError('OFFICE_POLICY_DENIED', 'none')).outcome).toBe('rejected')
})

test('a missing receipt is never proof of rejection even when the read itself was rejected', () => {
  const error = new ResourceClientError('OFFICE_ACTION_NOT_FOUND', 'none')
  expect(operationFailure(error)).toEqual({ outcome: 'unknown', reason: 'receipt_missing' })
})

test('localized recovery copy never includes raw transport or credential details', async () => {
  const language = i18n.language
  try {
    for (const locale of ['zh-CN', 'en']) {
      await i18n.changeLanguage(locale)
      const result = operationFeedback(new Error('SECRET_PAYLOAD https://user:secret@private/'))
      expect(result.message).not.toMatch(/SECRET|secret|operation_errors/)
      expect(result.outcome).toBe('unknown')
      expect(operationFeedback(new Error('scheduled time must be in the future')).message)
        .toBe(i18n.t('operation_errors.schedule_time_passed', { ns: 'common' }))
    }
  } finally { await i18n.changeLanguage(language) }
})
