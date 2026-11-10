import { describe, expect, it } from 'vitest'
import { normalizeMessage } from './task-runtime/normalizers'
import type { TurnFileChangesCapture, TurnReviewEvidence } from '../../../shared/generated/contracts'

const capture: TurnFileChangesCapture = { version: 1, captureId: 'a'.repeat(64),
  threadId: 'thread-1', turnId: 'turn-1', attemptId: 'attempt-1', state: 'capturing',
  base: null, head: null, limitations: [], artifactId: null }

describe('Mobile compatibility with capture observation metadata', () => {
  it('keeps an unconfirmed capture separate from file changes and tool completion', () => {
    const message = normalizeMessage({ id: 'm', role: 'assistant', content: 'answer', timestampMs: 1,
      turnId: 'turn-1', attemptId: 'attempt-1', fileChangesCapture: capture })
    expect(message?.fileChangesCapture).toMatchObject({ state: 'unknown' })
    expect(message?.fileChanges).toBeUndefined()
    expect(message?.tools).toBeUndefined()
  })
  it('preserves legacy messages without inventing metadata and drops foreign attempt metadata', () => {
    const legacy = { id: 'm', role: 'assistant', content: 'answer', timestampMs: 1, turnId: 'turn-1' }
    expect(normalizeMessage(legacy)?.fileChangesCapture).toBeUndefined()
    expect(normalizeMessage({ ...legacy, attemptId: 'peer', fileChangesCapture: capture })?.fileChangesCapture).toBeUndefined()
  })
})


it('keeps Native evidence facts on Mobile without inventing a command success or accepting a peer attempt', () => {
  const evidence: TurnReviewEvidence = { version: 1, evidenceId: 'b'.repeat(64), threadId: 'thread-1', turnId: 'turn-1', attemptId: 'attempt-1', state: 'collecting', observations: [], omittedCount: 0 }
  const message = { id: 'review', role: 'assistant', content: '', timestampMs: 1, turnId: 'turn-1', attemptId: 'attempt-1', reviewEvidence: evidence }
  expect(normalizeMessage(message)?.reviewEvidence).toMatchObject({ state: 'unknown' })
  expect(normalizeMessage({ ...message, attemptId: 'peer' })?.reviewEvidence).toBeUndefined()
  expect(normalizeMessage({ ...message, reviewEvidence: undefined })?.reviewEvidence).toBeUndefined()
})
