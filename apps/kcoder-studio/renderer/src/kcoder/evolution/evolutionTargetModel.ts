import type {
  EvolutionDecision,
  EvolutionProposalState,
  EvolutionProposalSummary,
  EvolutionTargetReadResult,
} from './evolutionContract'

/**
 * TargetKey published by the target on an extension-inventory item. Clients
 * never construct keys; without one the evolution section stays hidden.
 */
export function inventoryTargetKey(item: { targetKey?: string | null }): string | null {
  const key = item.targetKey
  return typeof key === 'string' && key.trim() ? key : null
}

/** Decisions are checked against the overlay revision last read from `evolution/target/read`. */
export function targetDecisionRevision(read: EvolutionTargetReadResult): string {
  return read.overlay.overlayRevision
}

const DECISIONS: Record<EvolutionProposalState, EvolutionDecision[]> = {
  draft: ['accept', 'reject'],
  evaluated: ['accept', 'reject'],
  canary: ['accept', 'reject', 'pin_stable'],
  promoted: ['rollback'],
  rolled_back: [],
  rejected: [],
}

/** Decisions offered for one proposal; the server still enforces valid transitions. */
export function proposalDecisions(proposal: EvolutionProposalSummary): EvolutionDecision[] {
  return DECISIONS[proposal.state] ?? []
}

/**
 * Accepting a draft/evaluated proposal approves its evaluation and canary
 * rollout; accepting a canary promotes it to stable.
 */
export function decisionLabelKey(
  proposal: EvolutionProposalSummary,
  decision: EvolutionDecision
): 'approve' | 'promote' | Exclude<EvolutionDecision, 'accept'> {
  if (decision !== 'accept') return decision
  return proposal.state === 'canary' ? 'promote' : 'approve'
}

export function latestPromotedProposal(proposals: EvolutionProposalSummary[]) {
  return [...proposals]
    .filter(proposal => proposal.state === 'promoted')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}
