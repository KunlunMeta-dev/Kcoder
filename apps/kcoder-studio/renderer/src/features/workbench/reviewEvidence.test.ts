import { describe, expect, it } from 'vitest'
import { normalizeReviewEvidence } from '../../../../shared/reviewEvidence'
import { reviewEvidenceFixture as evidence } from './reviewEvidence.test-support'
import { createResponseApiStreamState, emitResponseApiEvent } from '@/stream/responseApiStream'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { createRuntimeTaskStreamHandlers, runtimeMessagesToWorkbenchMessages } from './runtimePaneMessages'

describe('Native evidence provenance and terminal projections', () => {
  it('rejects legacy, wrong owners, malformed receipts and pretend completion', () => {
    expect(normalizeReviewEvidence(undefined)).toBeUndefined()
    for (const binding of [{ threadId: 'peer' }, { turnId: 'peer' }, { attemptId: 'peer' }]) expect(normalizeReviewEvidence(evidence, binding)).toBeUndefined()
    expect(normalizeReviewEvidence({ ...evidence, authorized: true })).toBeUndefined()
    expect(normalizeReviewEvidence({ ...evidence, state: 'settled', omittedCount: 1 })).toBeUndefined()
    const entry = evidence.observations[0]
    for (const changed of [
      { ...entry, outcome: 'denied' },
      { ...entry, resultObservedAtMs: null },
      { ...entry, process: { ...entry.process, exitCode: 2147483648 } },
    ]) expect(normalizeReviewEvidence({ ...evidence, observations: [changed] })).toBeUndefined()
  })
  it('restores unsettled records as unknown without mutating the source', () => {
    const pending = { ...evidence, state: 'collecting' as const, observations: [{ ...evidence.observations[0], outcome: 'pending' as const, process: null, toolFailed: null }] }
    expect(normalizeReviewEvidence(pending)).toMatchObject({ state: 'unknown', observations: [{ outcome: 'unknown' }] })
    expect(pending.state).toBe('collecting')
  })
  it.each(['completed', 'failed', 'interrupted'])('preserves Native failures through terminal transport %s', terminalStatus => {
    let messages: ReturnType<typeof reduceWorkbenchMessages> = []
    const handlers = createRuntimeTaskStreamHandlers({ deviceId: 'local', taskId: 'task-A' }, { onMessageAction: a => { messages = reduceWorkbenchMessages(messages, a) } })
    const state = createResponseApiStreamState()
    const base = { deviceId: 'local', taskId: 'task-A', subtaskId: 'attempt-A', attemptId: 'attempt-A', turnId: 'turn-A' }
    emitResponseApiEvent(handlers, 'response.created', { ...base, data: {} }, state)
    emitResponseApiEvent(handlers, terminalStatus === 'completed' ? 'response.completed' : 'response.failed', { ...base, data: { terminalStatus, value: 'All checks passed.', message: 'stopped', review_evidence: evidence } }, state)
    expect(messages.at(-1)?.reviewEvidence).toEqual(evidence)
    expect(runtimeMessagesToWorkbenchMessages([{ id: 'restored', role: 'assistant', content: '', turnId: 'turn-A', attemptId: 'attempt-A', reviewEvidence: evidence }]).at(-1)?.reviewEvidence).toEqual(evidence)
  })
})
