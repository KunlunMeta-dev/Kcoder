//! Engine integration points used by the management service.
//!
//! The Engine evolution integration owns background jobs, signal recording
//! and proposal application. Until it installs its own implementation the
//! defaults below keep the RPCs and REPL commands working against the store.

use super::{ServiceResult, content};
use kcoder_evolution::{EvolutionError, EvolutionStore, OverlayDocument};
use kcoder_types::evolution::{
    EvolutionJobKind, OverlayCandidateState, Proposal, ProposalActor, ProposalLocation,
    ProposalState, TargetKey,
};
use std::path::Path;

/// An explicit rating of one turn. `thread_id` is already the resolved
/// thread (the child thread for subagent ratings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RatingRequest {
    pub thread_id: String,
    pub turn_id: String,
    /// Tool calls of the rated turn the client shows (for a skill, its
    /// `skill` calls). A usage whose recorded tool call is listed is
    /// addressed even when the client's turn id differs (a subagent view).
    pub tool_call_ids: Vec<String>,
    /// `None` rates every usage in the turn.
    pub target_key: Option<TargetKey>,
    pub up: bool,
    /// Optional user reason (at most 500 characters, not yet redacted).
    pub reason: Option<String>,
}

/// Inputs for accepting a proposal on behalf of the user.
pub struct ProposalAcceptRequest<'a> {
    pub store: &'a EvolutionStore,
    pub proposal: &'a Proposal,
    pub document: Option<&'a OverlayDocument>,
    /// Current base revision of the target.
    pub base_revision: String,
    pub now_ms: u64,
}

/// Engine-owned behavior behind the management operations.
pub trait EvolutionEngineHooks: Send + Sync {
    /// Cancel this process's evolution jobs that write under `scope_root`
    /// and wait until they stopped. Called before data is cleared.
    fn cancel_jobs(&self, _scope_root: &Path) -> ServiceResult<()> {
        Ok(())
    }

    /// Jobs currently running in this process.
    fn running_jobs(&self) -> Vec<(EvolutionJobKind, Option<TargetKey>)> {
        Vec::new()
    }

    /// Record a rating as outcome observations in `store`. Returns whether
    /// the rating stands there afterwards (an identical replay counts; a
    /// changed rating is appended and supersedes the earlier one).
    fn record_rating(
        &self,
        store: &EvolutionStore,
        request: &RatingRequest,
        evidence_ttl_days: u32,
    ) -> ServiceResult<bool> {
        super::rating::record(store, request, evidence_ttl_days)
    }

    /// Accept a proposal. The default promotes it directly; the Engine
    /// may instead approve it for evaluation and canary (the proposal then
    /// keeps its state) or promote a running canary.
    fn apply_proposal_accept(&self, request: ProposalAcceptRequest<'_>) -> ServiceResult<()> {
        default_accept(request)
    }

    /// The proposal was rejected or rolled back: drop what the Engine
    /// staged for it outside the evolution store (a skill-store
    /// candidate). Best effort; the store-side cleanup already happened.
    fn discard_proposal_candidate(&self, _key: &TargetKey, _proposal_id: &str) {}

    /// A promoted proposal is rolled back: restore the target's own files
    /// (a skill's `SKILL.md` and evolvable files) to what they were before
    /// the promotion. The overlay is reverted by the service either way.
    fn rollback_promoted_target_file(
        &self,
        _key: &TargetKey,
        _proposal_id: &str,
    ) -> ServiceResult<TargetFileRollback> {
        Ok(TargetFileRollback::NotApplicable)
    }
}

/// Result of [`EvolutionEngineHooks::rollback_promoted_target_file`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetFileRollback {
    /// The promotion never changed the target's files.
    NotApplicable,
    /// The files are back at their pre-promotion revision.
    Restored,
    /// The files were left alone; the message tells the user why.
    Refused(String),
}

/// Store-only defaults, used until the Engine integration provides hooks.
#[derive(Debug, Default, Clone, Copy)]
pub struct DefaultEngineHooks;

impl EvolutionEngineHooks for DefaultEngineHooks {}

fn transition(
    store: &EvolutionStore,
    proposal: &Proposal,
    to: ProposalState,
    now_ms: u64,
) -> ServiceResult<Proposal> {
    Ok(store.transition_proposal(
        &proposal.proposal_id,
        proposal.revision,
        to,
        ProposalActor::User,
        Some("accepted by user".into()),
        now_ms,
    )?)
}

/// Stage the proposal's content as the candidate and promote it. A user
/// acceptance skips the canary; the proposal records both steps with the
/// user as actor. A retry after a lost receipt finishes the proposal
/// transition when the overlay was already promoted.
pub fn default_accept(request: ProposalAcceptRequest<'_>) -> ServiceResult<()> {
    let ProposalAcceptRequest {
        store,
        proposal,
        document,
        base_revision: _,
        now_ms,
    } = request;
    if proposal.location == ProposalLocation::TargetFile {
        return Err(super::EvolutionServiceError::new(
            "evolution_unsupported_target_type",
            "direct target file edits are not supported by this target",
        ));
    }
    let key = &proposal.target_key;
    let own_candidate = document.and_then(|document| {
        document
            .candidate
            .as_ref()
            .filter(|candidate| candidate.proposal_id.as_deref() == Some(&proposal.proposal_id))
            .map(|candidate| (document.revision, candidate.state))
    });
    match proposal.state {
        ProposalState::Draft | ProposalState::Evaluated => {
            let current = store
                .read_overlay(key)?
                .and_then(|view| view.stable)
                .unwrap_or_default();
            let next = content::guard_overlay_content(&content::apply_changes(
                &current,
                &proposal.changes,
            ))?;
            let staged = store.stage_candidate(
                key,
                document.map(|document| document.revision),
                &proposal.base_revision,
                &next,
                &proposal.proposal_id,
                now_ms,
            )?;
            store.promote_candidate(key, staged.revision, now_ms)?;
            let canary = transition(store, proposal, ProposalState::Canary, now_ms)?;
            transition(store, &canary, ProposalState::Promoted, now_ms)?;
            Ok(())
        }
        ProposalState::Canary => {
            match own_candidate {
                Some((revision, OverlayCandidateState::Staged | OverlayCandidateState::Canary)) => {
                    store.promote_candidate(key, revision, now_ms)?;
                }
                Some((_, OverlayCandidateState::Promoted)) => {}
                _ => {
                    return Err(EvolutionError::InvalidOverlayState(
                        "the proposal's candidate is no longer staged",
                    )
                    .into());
                }
            }
            transition(store, proposal, ProposalState::Promoted, now_ms)?;
            Ok(())
        }
        from => Err(EvolutionError::InvalidTransition {
            from,
            to: ProposalState::Promoted,
        }
        .into()),
    }
}
