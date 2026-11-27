import type { TurnReviewEvidence } from '../../../../shared/generated/contracts'

export const reviewEvidenceFixture: TurnReviewEvidence = {
  version: 1, evidenceId: 'a'.repeat(64), threadId: 'thread-A', turnId: 'turn-A', attemptId: 'attempt-A',
  state: 'settled', omittedCount: 0,
  observations: [{
    ordinal: 1, toolCallId: 'call-1', toolName: 'bash', command: 'cargo test',
    executionObservedAtMs: 1792972800000, resultObservedAtMs: 1792972801000,
    outcome: 'recorded', toolFailed: true, process: { exitCode: 1, signal: null, cwd: '/workspace' },
    artifacts: [], validation: null, outputPreview: 'NATIVE_CHECK_FAILED', detailsTruncated: false,
  }],
}
