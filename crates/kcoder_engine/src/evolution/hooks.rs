//! Engine implementation of the management service hooks
//! (`kcoder_tools::evolution_service::EvolutionEngineHooks`).
//!
//! Skills keep the store-only acceptance (stage the overlay candidate and
//! promote it; canary automation arrives in phase 4). Preference proposals
//! become `pref.<scope>.<category>` entries in the user partition, and
//! project knowledge proposals become project memory; both always need the
//! user's acceptance. Job cancellation covers every evolution job of this
//! process.

use super::{JOBS, cancel_matching, wait_for_jobs};
use kcoder_evolution::{EvolutionError, EvolutionStore};
use kcoder_memory::MemoryManager;
use kcoder_memory::integrations::knowledge::MemoryReviewStore;
use kcoder_tools::evolution_service::{
    DefaultEngineHooks, EvolutionEngineHooks, EvolutionServiceError, ProposalAcceptRequest,
    ServiceResult,
};
use kcoder_types::evolution::{
    EvolutionJobKind, Proposal, ProposalActor, ProposalState, TargetKey, TargetType,
};
use kcoder_types::integrations::knowledge::{
    MemoryOrigin, MemoryProposal, MemoryProvenance, MemoryReview, MemoryReviewStatus,
};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// How long `cancel_jobs` waits for cancelled jobs to stop.
const CANCEL_WAIT: Duration = Duration::from_secs(5);

/// Cancel this process's evolution jobs whose storage lies under
/// `scope_root` (`None`: every job) and wait until they stopped. Returns
/// whether all of them stopped within the bound.
pub fn cancel_evolution_jobs(scope_root: Option<&Path>) -> bool {
    let ids = cancel_matching(|entry| {
        scope_root.is_none_or(|root| {
            entry.scope_root.starts_with(root) || root.starts_with(&entry.scope_root)
        })
    });
    wait_for_jobs(&ids, CANCEL_WAIT)
}

/// Evolution jobs currently running in this process.
pub fn running_evolution_jobs() -> Vec<(EvolutionJobKind, Option<TargetKey>)> {
    let jobs = JOBS.lock().unwrap_or_else(|error| error.into_inner());
    let mut running: Vec<_> = jobs
        .values()
        .map(|entry| (entry.kind, entry.target.clone()))
        .collect();
    running.sort();
    running
}

/// Hooks backed by this Engine build.
#[derive(Clone, Default)]
pub struct EngineEvolutionHooks {
    memory: Option<Arc<MemoryManager>>,
    review_store: Option<Arc<MemoryReviewStore>>,
    /// Workspace whose project skill store receives accepted new skills.
    workspace: Option<std::path::PathBuf>,
    /// Engine whose rollout automation handles skill proposals (phase 4).
    engine: Option<crate::QueryEngine>,
}

impl EngineEvolutionHooks {
    pub fn new(
        memory: Option<Arc<MemoryManager>>,
        review_store: Option<Arc<MemoryReviewStore>>,
    ) -> Self {
        Self {
            memory,
            review_store,
            workspace: None,
            engine: None,
        }
    }

    /// Route skill overlay acceptances through `engine`'s rollout: in
    /// `propose` mode accepting a draft approves it for evaluation and
    /// canary, accepting a canary promotes it.
    pub fn with_engine(mut self, engine: crate::QueryEngine) -> Self {
        self.engine = Some(engine);
        self
    }

    /// Workspace used to create skills from accepted "create skill"
    /// proposals.
    pub fn with_workspace(mut self, workspace: std::path::PathBuf) -> Self {
        self.workspace = Some(workspace);
        self
    }
}

fn operation_id(proposal_id: &str) -> String {
    format!("evolution-{proposal_id}")
}

/// Offer an accepted-for-review project knowledge proposal to the memory
/// candidate review store (status candidate, disabled until reviewed).
pub(crate) fn offer_review_candidate(
    store: &MemoryReviewStore,
    proposal_id: &str,
    title: &str,
    content: &str,
    category: &str,
    evidence_ids: &[String],
    now_ms: u64,
) {
    let provenance = evidence_ids
        .iter()
        .take(32)
        .map(|evidence| MemoryProvenance {
            kind: "evolution_evidence".into(),
            source_id: evidence.clone(),
            source_revision: proposal_id.to_string(),
            description: "Self-evolution evidence snippet (redacted)".into(),
        })
        .collect::<Vec<_>>();
    if provenance.is_empty() {
        return;
    }
    let proposal = MemoryProposal {
        title: title.to_string(),
        content: content.to_string(),
        category: category.to_string(),
        origin: MemoryOrigin::Observer,
        provenance,
        valid_until_ms: None,
    };
    if let Err(error) = store.propose(&operation_id(proposal_id), proposal, now_ms) {
        tracing::warn!(%error, "project knowledge candidate not offered for review");
    }
}

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

/// Draft/Evaluated → Canary → Promoted (a user acceptance skips the canary
/// but keeps both steps in the history). A retry after a lost receipt that
/// finds the proposal in Canary only finishes the promotion.
fn promote(store: &EvolutionStore, proposal: &Proposal, now_ms: u64) -> ServiceResult<()> {
    match proposal.state {
        ProposalState::Draft | ProposalState::Evaluated => {
            let canary = transition(store, proposal, ProposalState::Canary, now_ms)?;
            transition(store, &canary, ProposalState::Promoted, now_ms)?;
        }
        ProposalState::Canary => {
            transition(store, proposal, ProposalState::Promoted, now_ms)?;
        }
        from => {
            return Err(EvolutionError::InvalidTransition {
                from,
                to: ProposalState::Promoted,
            }
            .into());
        }
    }
    Ok(())
}

impl EngineEvolutionHooks {
    /// Accept a "create skill" proposal: create the skill through
    /// `skill_manage` with an unattended actor, so the same redaction and
    /// guard apply as for automatic creation.
    fn accept_create_skill(&self, request: &ProposalAcceptRequest<'_>) -> ServiceResult<()> {
        let proposal = request.proposal;
        let workspace = self.workspace.clone().ok_or_else(|| {
            EvolutionServiceError::new(
                "evolution_storage_error",
                "no workspace to create the skill in",
            )
        })?;
        let content = proposal.changes.diff.clone().ok_or_else(|| {
            EvolutionServiceError::new("evolution_invalid_proposal", "the proposal has no SKILL.md")
        })?;
        if proposal.state != ProposalState::Canary {
            let context = kcoder_tools::ToolContext::new(kcoder_state::AppState::new(&workspace))
                .with_skill_mutation_actor(kcoder_skills::SkillMutationActor::BackgroundReview {
                    session_id: "evolution".into(),
                    job_id: proposal.proposal_id.clone(),
                    agent_id: "evolution".into(),
                    tool_call_id: proposal.proposal_id.clone(),
                });
            let input = serde_json::json!({
                "action": "create",
                "name": proposal.target_key.name(),
                "content": content,
            });
            let created = futures::executor::block_on(kcoder_tools::Tool::call(
                &kcoder_tools::SkillManageTool,
                input,
                &context,
            ));
            if let Err(error) = created {
                // A retry after a lost receipt finds the skill already created.
                let exists = kcoder_skills::skill_revision(
                    &kcoder_tools::skill_provenance::project_skills_root(&workspace)
                        .join(proposal.target_key.name()),
                )
                .ok()
                .flatten()
                .is_some();
                if !exists {
                    return Err(EvolutionServiceError::new(
                        "evolution_content_rejected",
                        error.to_string(),
                    ));
                }
            }
        }
        promote(request.store, proposal, request.now_ms)
    }

    fn accept_preference(&self, request: &ProposalAcceptRequest<'_>) -> ServiceResult<()> {
        let proposal = request.proposal;
        let value = proposal.changes.lessons_add.first().ok_or_else(|| {
            EvolutionServiceError::new(
                "evolution_invalid_proposal",
                "preference proposal has no value",
            )
        })?;
        let key = format!("pref.{}", proposal.target_key.name());
        kcoder_evolution::parse_preference_key(&key)?;
        let (value, _) = kcoder_tools::session_read::redact_secrets(value);
        let document = request.store.read_preferences()?;
        // A lost receipt may already have stored the same value.
        if document
            .items
            .get(&key)
            .is_none_or(|entry| entry.value != value)
        {
            request.store.set_learned_preference(
                &key,
                &value,
                &proposal.evidence_ids,
                document.revision,
                request.now_ms,
            )?;
        }
        promote(request.store, proposal, request.now_ms)
    }

    fn accept_project_knowledge(&self, request: &ProposalAcceptRequest<'_>) -> ServiceResult<()> {
        let proposal = request.proposal;
        let example = proposal.changes.examples.first().ok_or_else(|| {
            EvolutionServiceError::new(
                "evolution_invalid_proposal",
                "knowledge proposal has no content",
            )
        })?;
        let already_promoted = proposal.state == ProposalState::Canary;
        if !already_promoted {
            if let Some(review) = &self.review_store
                && let Ok(Some(candidate)) =
                    review.read_operation_result(&operation_id(&proposal.proposal_id))
            {
                if candidate.review_status == MemoryReviewStatus::Candidate {
                    review
                        .review(
                            &format!("{}-accept", operation_id(&proposal.proposal_id)),
                            &candidate.id,
                            candidate.revision,
                            MemoryReview::Accept {
                                edited_content: None,
                            },
                            request.now_ms,
                        )
                        .map_err(EvolutionServiceError::from)?;
                }
            } else if let Some(memory) = &self.memory {
                let category = proposal
                    .target_key
                    .name()
                    .split('.')
                    .next()
                    .unwrap_or("project_knowledge");
                memory
                    .remember_auto(category, &format!("{}: {}", example.name, example.text))
                    .map_err(EvolutionServiceError::from)?;
            } else {
                return Err(EvolutionServiceError::new(
                    "evolution_storage_error",
                    "project memory is not available in this host",
                ));
            }
        }
        promote(request.store, proposal, request.now_ms)
    }
}

impl EvolutionEngineHooks for EngineEvolutionHooks {
    fn cancel_jobs(&self, scope_root: &Path) -> ServiceResult<()> {
        if cancel_evolution_jobs(Some(scope_root)) {
            Ok(())
        } else {
            Err(EvolutionServiceError::new(
                "evolution_job_busy",
                "evolution jobs did not stop in time; retry",
            ))
        }
    }

    fn running_jobs(&self) -> Vec<(EvolutionJobKind, Option<TargetKey>)> {
        running_evolution_jobs()
    }

    fn apply_proposal_accept(&self, request: ProposalAcceptRequest<'_>) -> ServiceResult<()> {
        if let Some(engine) = &self.engine
            && let Some(result) = engine.accept_skill_proposal(&request)
        {
            return result;
        }
        match request.proposal.target_key.target_type() {
            TargetType::Preference => self.accept_preference(&request),
            TargetType::ProjectKnowledge => self.accept_project_knowledge(&request),
            TargetType::Skill
                if request.proposal.location
                    == kcoder_types::evolution::ProposalLocation::TargetFile
                    && request.proposal.base_revision == super::review::NEW_SKILL_BASE =>
            {
                self.accept_create_skill(&request)
            }
            TargetType::Skill | TargetType::ToolUsage | TargetType::WorkflowTemplate => {
                DefaultEngineHooks.apply_proposal_accept(request)
            }
        }
    }

    fn discard_proposal_candidate(&self, key: &TargetKey, proposal_id: &str) {
        if let Some(engine) = &self.engine {
            engine.discard_evolution_skill_candidate(key, proposal_id);
        }
    }

    fn rollback_promoted_target_file(
        &self,
        key: &TargetKey,
        proposal_id: &str,
    ) -> ServiceResult<kcoder_tools::evolution_service::TargetFileRollback> {
        match &self.engine {
            Some(engine) => engine
                .restore_evolution_skill_file(key, proposal_id)
                .map_err(|message| EvolutionServiceError::new("evolution_storage_error", message)),
            None => Ok(kcoder_tools::evolution_service::TargetFileRollback::NotApplicable),
        }
    }
}
