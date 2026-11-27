import { describe, expect, test } from 'vitest'
import { getQuestionDisposition } from '../../../../shared/composerQuestionDisposition'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import type { ComputerUseDiagnostic, ComputerUseSnapshot } from '@/kcoder/computerUseState'
import { getComputerUseDisposition, getPlanDisposition } from './projection'

describe('composer status disposition', () => {
  test('an answer stays actionable until its authoritative delivery completes', () => {
    const record: AsyncQuestionRecord = {
      questionId: 'question', requestId: 'request', threadId: 'thread',
      sourceTurnId: 'turn', toolCallId: 'call', revision: 1, createdAtMs: 1,
      status: 'pending', questions: [{ id: 'item', header: 'Preference',
        question: 'How should the task proceed?', options: [], multiSelect: false }],
    }
    expect(getQuestionDisposition(record)).toBe('active')
    expect(getQuestionDisposition({ ...record, status: 'answer_saved' })).toBe('active')
    expect(getQuestionDisposition({ ...record, status: 'queued' })).toBe('active')
    expect(getQuestionDisposition({ ...record, status: 'delivery_unknown' })).toBe('attention')
    expect(getQuestionDisposition({ ...record, status: 'delivery_failed' })).toBe('attention')
    expect(getQuestionDisposition({ ...record, status: 'context_applied' })).toBe('hidden')
    expect(getQuestionDisposition({ ...record, status: 'cancelled' })).toBe('hidden')
    expect(getQuestionDisposition({ ...record, status: 'stale' })).toBe('hidden')
    expect(record.status).toBe('pending')
  })

  test('the plan exits the active region only after every step is complete', () => {
    expect(getPlanDisposition({ plan: [
      { step: 'Implement', status: 'completed' }, { step: 'Verify', status: 'pending' },
    ] })).toBe('active')
    expect(getPlanDisposition({ plan: [
      { step: 'Implement', status: 'completed' }, { step: 'Verify', status: 'completed' },
    ] })).toBe('hidden')
    expect(getPlanDisposition(null)).toBe('hidden')
    expect(getPlanDisposition({ plan: [
      { step: 'Recover', status: 'inProgress' },
    ] }, true)).toBe('attention')
    expect(getPlanDisposition({ plan: [
      { step: 'Recover', status: 'completed' },
    ] }, true)).toBe('hidden')
  })

  const normal: ComputerUseDiagnostic = {
    authorization: 'valid', channel: 'available', cleanup: 'unknown',
  }
  test.each([
    ['active', normal, 'active'],
    ['active', { ...normal, cleanup: 'failed' }, 'attention'],
    ['active', { ...normal, authorization: 'revoked' }, 'attention'],
    ['active', { ...normal, channel: 'unavailable' }, 'attention'],
    ['stopping', { authorization: 'revoked', channel: 'unavailable', cleanup: 'pending' }, 'active'],
    ['stopping', { ...normal, cleanup: 'unknown' }, 'attention'],
    ['unknown', undefined, 'attention'],
    ['stop_failed', undefined, 'attention'],
    ['stopped', undefined, 'hidden'],
    ['stopped', { ...normal, cleanup: 'confirmed' }, 'hidden'],
    ['stopped', { authorization: 'revoked', channel: 'unavailable', cleanup: 'confirmed' }, 'hidden'],
    ['stopped', { ...normal, cleanup: 'confirmed', failureCode: 'cleanup_failed' }, 'attention'],
    ['stopped', { authorization: 'revoked', channel: 'unavailable', cleanup: 'confirmed', failureCode: 'lease_revoked' }, 'attention'],
    ['stopped', { ...normal, cleanup: 'pending' }, 'attention'],
    ['stopped', { ...normal, cleanup: 'failed' }, 'attention'],
    ['stopped', { ...normal, cleanup: 'unknown' }, 'attention'],
    ['stopped', { ...normal, cleanup: 'confirmed', authorization: 'unknown' }, 'attention'],
    ['stopped', { ...normal, cleanup: 'confirmed', channel: 'unknown' }, 'attention'],
  ] as const)('host %s with %j projects to %s', (state, diagnostic, expected) => {
    const snapshot: ComputerUseSnapshot = {
      turnId: 'turn', state, diagnostic, recoveryAvailable: true,
    }
    expect(getComputerUseDisposition(snapshot)).toBe(expected)
  })

  test('a caller diagnostic cannot be replaced by a healthy stored observation', () => {
    expect(getComputerUseDisposition({ turnId: 'turn', state: 'stopped',
      diagnostic: { ...normal, cleanup: 'confirmed' } },
    { ...normal, cleanup: 'failed' })).toBe('attention')
    expect(getComputerUseDisposition(null, { ...normal, cleanup: 'failed' })).toBe('hidden')
  })
})
