/** Display facts only: this cannot authorize continuation or replay a tool. */
export function failureRecoveryFacts(input: {
  /** Pass a decoded typed ProviderFailureDetails, never a diagnostic string. */
  providerFailure?: { category: string; context_preflight?: unknown }
  errorType?: string
  turnId?: string
  attemptId?: string
}) {
  const identity = input.turnId ?? input.attemptId ?? ''
  return {
    phase: input.providerFailure?.context_preflight
      ? ('context_preflight' as const)
      : input.providerFailure
        ? ('model_request' as const)
        : input.errorType === 'local_runtime_error'
          ? ('runtime' as const)
          : ('unknown' as const),
    committedStepsPreserved: /^turn-\d+(?:-retry-[0-9a-f-]+)?$/.test(identity),
    // retryable/resume_safe describe provider transport; neither is a saved checkpoint.
    continuationSafety: 'server_validation_required' as const,
    uncommittedEffects: 'unknown' as const,
  }
}
