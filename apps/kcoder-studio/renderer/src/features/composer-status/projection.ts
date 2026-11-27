import type { RuntimePlanEventPayload } from '@/types/api'
import type { ComputerUseDiagnostic, ComputerUseSnapshot } from '@/kcoder/computerUseState'
import type { StatusDisposition } from '../../../../shared/composerQuestionDisposition'

export function getPlanDisposition(
  plan: RuntimePlanEventPayload | null | undefined,
  stale = false
): StatusDisposition {
  if (!plan?.plan.some(step => step.status !== 'completed')) return 'hidden'
  return stale ? 'attention' : 'active'
}

export function getComputerUseDisposition(
  snapshot: ComputerUseSnapshot | null | undefined,
  diagnostics?: ComputerUseDiagnostic
): StatusDisposition {
  if (!snapshot) return 'hidden'
  if (snapshot.state === 'unknown' || snapshot.state === 'stop_failed') return 'attention'

  const facts = diagnostics ?? snapshot.diagnostic
  if (facts) {
    if (
      facts.failureCode ||
      facts.authorization === 'unknown' ||
      facts.channel === 'unknown' ||
      facts.cleanup === 'failed'
    ) return 'attention'

    // Active hosts report cleanup as unknown because release has not begun.
    if (snapshot.state === 'active') {
      return facts.authorization === 'revoked' || facts.channel === 'unavailable'
        ? 'attention'
        : 'active'
    }
    if (facts.cleanup === 'unknown') return 'attention'
    if (snapshot.state === 'stopped' && facts.cleanup !== 'confirmed') return 'attention'
  }

  // A confirmed stop may revoke its grant and close its channel normally.
  // Recovery availability is a capability, not evidence of outstanding work.
  return snapshot.state === 'stopped' ? 'hidden' : 'active'
}
