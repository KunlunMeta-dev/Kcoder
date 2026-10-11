import { describe, expect, test } from 'vitest'
import { failureRecoveryFacts } from '../../../../shared/failureRecoveryFacts'

describe('failure recovery display facts', () => {
  test('provider transport retry flags never become checkpoint safety', () => {
    for (const resume_safe of [true, false]) {
      const providerFailure = { category: 'provider_error', retryable: true, resume_safe }
      expect(failureRecoveryFacts({ providerFailure, attemptId: 'turn-1-retry-abcdef' })).toEqual({
        phase: 'model_request', committedStepsPreserved: true,
        continuationSafety: 'server_validation_required', uncommittedEffects: 'unknown',
      })
    }
  })
  test('missing facts are unknown, not a successful checkpoint', () => {
    expect(failureRecoveryFacts({})).toMatchObject({ phase: 'unknown', committedStepsPreserved: false })
    expect(failureRecoveryFacts({ errorType: 'local_runtime_error', attemptId: 'optimistic-local' }))
      .toMatchObject({ phase: 'runtime', committedStepsPreserved: false })
  })
})
