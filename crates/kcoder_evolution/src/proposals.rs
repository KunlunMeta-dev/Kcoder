//! Proposal store (`proposals/<id>.json`).

use crate::error::{EvolutionError, Result};
use crate::store::{EvolutionStore, open_child_if_exists, read_versioned_in, write_json_in};
use kcoder_types::evolution::{
    EVOLUTION_RECORD_VERSION, EvaluationResult, Proposal, ProposalActor, ProposalChanges,
    ProposalLocation, ProposalState, ProposalTransition, SafetyScanResult, TargetKey,
};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;

const PROPOSALS_DIR: &str = "proposals";
const MAX_PROPOSALS_LISTED: usize = 100_000;

/// Input for [`EvolutionStore::create_proposal`].
#[derive(Debug, Clone, PartialEq)]
pub struct ProposalDraft {
    pub target_key: TargetKey,
    pub base_revision: String,
    pub location: ProposalLocation,
    pub changes: ProposalChanges,
    pub pattern_ids: Vec<String>,
    pub evidence_ids: Vec<String>,
    pub actor: ProposalActor,
}

/// Result of an idempotent create.
#[derive(Debug, Clone, PartialEq)]
pub struct ProposalCreated {
    pub proposal: Proposal,
    /// False when the same proposal already existed (for example after an
    /// interrupted run was retried).
    pub created: bool,
}

/// `prop-<32 hex>`: SHA-256 over the target key, base revision, location
/// and changes. The same content against the same base revision always
/// yields the same id; any change of base revision yields a new one.
pub fn proposal_id(
    target_key: &TargetKey,
    base_revision: &str,
    location: ProposalLocation,
    changes: &ProposalChanges,
) -> Result<String> {
    let identity = serde_json::to_vec(&(target_key.to_string(), base_revision, location, changes))?;
    let digest = Sha256::digest(&identity);
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("prop-{hex}"))
}

fn file_name(id: &str) -> String {
    format!("{id}.json")
}

impl EvolutionStore {
    /// Create a draft proposal, or return the existing one with the same id.
    pub fn create_proposal(&self, draft: ProposalDraft, now_ms: u64) -> Result<ProposalCreated> {
        let id = proposal_id(
            &draft.target_key,
            &draft.base_revision,
            draft.location,
            &draft.changes,
        )?;
        let proposal = Proposal {
            version: EVOLUTION_RECORD_VERSION,
            proposal_id: id.clone(),
            target_key: draft.target_key,
            base_revision: draft.base_revision,
            location: draft.location,
            changes: draft.changes,
            pattern_ids: draft.pattern_ids,
            evidence_ids: draft.evidence_ids,
            safety_scan: None,
            evaluation: None,
            state: ProposalState::Draft,
            history: vec![ProposalTransition {
                from: None,
                to: ProposalState::Draft,
                actor: draft.actor,
                at_ms: now_ms,
                reason: None,
            }],
            revision: 1,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        };
        proposal.validate()?;
        if proposal.changes.is_empty() {
            return Err(EvolutionError::InvalidContent(
                "a proposal must change something",
            ));
        }
        let _lock = self.lock()?;
        let directory = self
            .directory()
            .open_child(OsStr::new(PROPOSALS_DIR), true)?;
        if let Some(existing) =
            read_versioned_in::<Proposal>(&directory, &file_name(&id), EVOLUTION_RECORD_VERSION)?
        {
            let same = existing.target_key == proposal.target_key
                && existing.base_revision == proposal.base_revision
                && existing.location == proposal.location
                && existing.changes == proposal.changes;
            if !same {
                return Err(EvolutionError::ProposalIdCollision(id));
            }
            return Ok(ProposalCreated {
                proposal: existing,
                created: false,
            });
        }
        write_json_in(&directory, &file_name(&id), &proposal)?;
        Ok(ProposalCreated {
            proposal,
            created: true,
        })
    }

    pub fn read_proposal(&self, id: &str) -> Result<Option<Proposal>> {
        kcoder_types::evolution::validate_evolution_id("proposalId", id)?;
        let Some(directory) = open_child_if_exists(self.directory(), PROPOSALS_DIR)? else {
            return Ok(None);
        };
        read_versioned_in(&directory, &file_name(id), EVOLUTION_RECORD_VERSION)
    }

    /// All readable proposals, oldest first. Proposals of a newer format
    /// are skipped rather than failing the listing.
    pub fn list_proposals(&self) -> Result<Vec<Proposal>> {
        let Some(directory) = open_child_if_exists(self.directory(), PROPOSALS_DIR)? else {
            return Ok(Vec::new());
        };
        let mut proposals = Vec::new();
        for name in directory.entry_names_bounded(MAX_PROPOSALS_LISTED)? {
            let Some(text) = name.to_str() else { continue };
            if !text.starts_with("prop-") || !text.ends_with(".json") {
                continue;
            }
            match read_versioned_in::<Proposal>(&directory, text, EVOLUTION_RECORD_VERSION) {
                Ok(Some(proposal)) => proposals.push(proposal),
                Ok(None) | Err(EvolutionError::FutureVersion { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        proposals.sort_by(|left, right| {
            (left.created_at_ms, &left.proposal_id).cmp(&(right.created_at_ms, &right.proposal_id))
        });
        Ok(proposals)
    }

    fn update_proposal(
        &self,
        id: &str,
        expected_revision: u64,
        now_ms: u64,
        apply: impl FnOnce(&mut Proposal) -> Result<()>,
    ) -> Result<Proposal> {
        kcoder_types::evolution::validate_evolution_id("proposalId", id)?;
        let _lock = self.lock()?;
        let directory = open_child_if_exists(self.directory(), PROPOSALS_DIR)?
            .ok_or_else(|| EvolutionError::ProposalNotFound(id.to_string()))?;
        let mut proposal: Proposal =
            read_versioned_in(&directory, &file_name(id), EVOLUTION_RECORD_VERSION)?
                .ok_or_else(|| EvolutionError::ProposalNotFound(id.to_string()))?;
        if proposal.revision != expected_revision {
            return Err(EvolutionError::RevisionConflict {
                expected: Some(expected_revision),
                actual: Some(proposal.revision),
            });
        }
        apply(&mut proposal)?;
        proposal.revision += 1;
        proposal.updated_at_ms = now_ms;
        write_json_in(&directory, &file_name(id), &proposal)?;
        Ok(proposal)
    }

    /// Move a proposal to `to`, validating the state machine and recording
    /// the actor.
    pub fn transition_proposal(
        &self,
        id: &str,
        expected_revision: u64,
        to: ProposalState,
        actor: ProposalActor,
        reason: Option<String>,
        now_ms: u64,
    ) -> Result<Proposal> {
        self.update_proposal(id, expected_revision, now_ms, |proposal| {
            if !proposal.state.can_transition_to(to) {
                return Err(EvolutionError::InvalidTransition {
                    from: proposal.state,
                    to,
                });
            }
            proposal.history.push(ProposalTransition {
                from: Some(proposal.state),
                to,
                actor,
                at_ms: now_ms,
                reason,
            });
            proposal.state = to;
            Ok(())
        })
    }

    /// Attach safety-scan and/or evaluation results without changing state.
    /// Failed results are kept, never deleted.
    pub fn record_proposal_review(
        &self,
        id: &str,
        expected_revision: u64,
        safety_scan: Option<SafetyScanResult>,
        evaluation: Option<EvaluationResult>,
        now_ms: u64,
    ) -> Result<Proposal> {
        self.update_proposal(id, expected_revision, now_ms, |proposal| {
            if let Some(scan) = safety_scan {
                proposal.safety_scan = Some(scan);
            }
            if let Some(evaluation) = evaluation {
                proposal.evaluation = Some(evaluation);
            }
            Ok(())
        })
    }
}
