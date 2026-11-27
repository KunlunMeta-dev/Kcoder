//! Shared self-evolution management service behind the `evolution/*` RPCs
//! and the REPL `/evolution` and `/rate` commands.
//!
//! Callers capture the effective settings, the configured model catalog,
//! the skill registry and the workspace once per request and build an
//! [`EvolutionService`]; every operation then resolves the user or project
//! scope partition, applies revision checks through `kcoder_evolution` and
//! returns typed projections. Background-job ownership, rating recording and
//! proposal application go through [`EvolutionEngineHooks`] so the Engine
//! integration can replace the defaults without touching the callers.
//!
//! Project-scope data lives under the user data root and never inside the
//! project. When the data root is inside the project (for example a
//! developer home inside the checkout) project data is skipped with a status
//! diagnostic and user scope keeps working.

mod content;
mod hooks;
mod rating;
mod targets;

pub use content::{apply_changes, guard_overlay_content, revert_changes};
pub use hooks::{
    DefaultEngineHooks, EvolutionEngineHooks, ProposalAcceptRequest, RatingRequest,
    TargetFileRollback,
};
pub use rating::RatableTurn;
pub use targets::{SkillOriginResolver, SkillTarget, skill_base_revision, skill_origin_source};

use kcoder_config::EvolutionSettings;
use kcoder_evolution::{
    EvolutionError, EvolutionScope, EvolutionStore, IMPLEMENTED_TARGET_TYPES, OverlaySlotSource,
    StatusInputs, TargetSummaryInputs, resolve_scope_root,
};
use kcoder_types::evolution::{
    EvolutionDisabledReason, EvolutionJobKind, EvolutionJobState, EvolutionJobStatus,
    EvolutionModelSelection, EvolutionModelStatus, EvolutionPattern, EvolutionProjectScopeIssue,
    EvolutionProposalSummary, EvolutionStatusSnapshot, EvolutionTargetSummary,
    EvolutionTargetTypeStatus, EvolutionUsageSummary, EvolutionWriteMode, OverlayContent,
    ProposalActor, ProposalState, TargetKey, TargetRevision, TargetType,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Default page size of [`EvolutionService::list_targets`].
pub const TARGETS_PAGE_DEFAULT: usize = 50;

/// Stable failure carrying an `evolution_*` RPC error code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct EvolutionServiceError {
    pub code: &'static str,
    pub message: String,
}

impl EvolutionServiceError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn disabled() -> Self {
        Self::new("evolution_disabled", "self-evolution is disabled")
    }

    fn not_found(key: &TargetKey) -> Self {
        Self::new(
            "evolution_target_not_found",
            format!("evolution target {key} was not found"),
        )
    }

    fn unsupported(target_type: TargetType) -> Self {
        Self::new(
            "evolution_unsupported_target_type",
            format!("evolution target type {target_type} is not supported yet"),
        )
    }

    fn conflict() -> Self {
        Self::new(
            "evolution_revision_conflict",
            "evolution data changed; reload before saving",
        )
    }
}

impl From<EvolutionError> for EvolutionServiceError {
    fn from(error: EvolutionError) -> Self {
        let code = match &error {
            // Overlay pointer states that do not allow the requested step.
            EvolutionError::InvalidOverlayState(_) => "evolution_invalid_transition",
            _ => error.code(),
        };
        Self::new(code, error.to_string())
    }
}

impl From<anyhow::Error> for EvolutionServiceError {
    fn from(error: anyhow::Error) -> Self {
        Self::new("evolution_storage_error", error.to_string())
    }
}

pub type ServiceResult<T> = std::result::Result<T, EvolutionServiceError>;

/// One configured model of the current target, as the session model
/// picker lists it. Evolution may only reference these; it never falls
/// back to the first catalog entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfiguredModel {
    pub provider: String,
    pub model: String,
    pub available: bool,
}

/// Which partition a target's data lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EvolutionScopeKind {
    User,
    Project,
}

/// `evolution/data/clear` scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClearScope {
    User,
    Project,
    All,
}

/// `evolution/proposal/decide` decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposalDecision {
    Accept,
    Reject,
    Rollback,
    PinStable,
}

/// What a mutation changed, for `evolution/changed` notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvolutionChange {
    Proposal,
    Promoted,
    RolledBack,
    Cleared,
}

/// Everything one request reads, captured by the caller.
pub struct EvolutionServiceInputs<'a> {
    /// Effective merged settings of the target.
    pub settings: &'a kcoder_config::Settings,
    /// `evolution.enabled` of the user settings layer, when it is known.
    /// Used to tell a project-level disable from a user-level one.
    pub user_enabled: Option<bool>,
    pub models: Vec<ConfiguredModel>,
    pub skills: Option<&'a kcoder_skills::SkillRegistry>,
    /// Working directory that selects the project partition.
    pub workspace: Option<PathBuf>,
    /// User data root (normally [`kcoder_evolution::default_data_root`]).
    pub data_root: PathBuf,
    pub hooks: Arc<dyn EvolutionEngineHooks>,
}

/// Overlay slots of one target with the opaque document revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlaySlots {
    pub stable: OverlayContent,
    pub candidate: Option<OverlayContent>,
    pub overlay_revision: String,
}

/// `evolution/target/read` projection.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetDetail {
    pub summary: EvolutionTargetSummary,
    pub overlay: OverlaySlots,
    pub patterns: Vec<EvolutionPattern>,
    pub proposals: Vec<EvolutionProposalSummary>,
}

/// One preference row of `evolution/preference/list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreferenceRow {
    pub key: String,
    pub value: String,
    pub scope: String,
    pub evidence_count: u32,
    pub updated_at: String,
}

/// A captured, request-scoped evolution service.
pub struct EvolutionService {
    /// Settings as the user configured them (the master switch reflects the
    /// user layer even when a project or training mode disables it).
    view: EvolutionSettings,
    /// Whether collection is active right now.
    active: bool,
    disabled_reason: Option<EvolutionDisabledReason>,
    model: EvolutionModelStatus,
    skills: Vec<SkillTarget>,
    user_root: PathBuf,
    project_root: Option<Result<PathBuf, EvolutionProjectScopeIssue>>,
    hooks: Arc<dyn EvolutionEngineHooks>,
    overlay_edit_recorder: Option<OverlayEditRecorder>,
}

/// Records a user's overlay edit as explicit evidence for the next
/// distillation: `(store, key, before, after, evidence_ttl_days)`. The
/// Engine provides it (`kcoder_engine::evolution::record_overlay_user_edit`);
/// this crate cannot depend on the Engine.
pub type OverlayEditRecorder = fn(
    &EvolutionStore,
    &TargetKey,
    &OverlayContent,
    &OverlayContent,
    u32,
) -> Result<Option<String>, EvolutionError>;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn model_available(
    models: &[ConfiguredModel],
    reference: &kcoder_config::EvolutionModelRef,
) -> bool {
    models.iter().any(|model| {
        model.available && model.provider == reference.provider && model.model == reference.model
    })
}

/// Forget the rollout bookkeeping (approval, pending promotion, evaluation
/// attempts) of a proposal that reached a final state, so the Engine's
/// automation does not pick it up again. The proposal transition already
/// committed, so a failed ledger write is logged rather than returned.
fn settle_rollout(store: &EvolutionStore, proposal_id: &str) {
    if let Err(error) = store.update_rollout_ledger(|ledger| ledger.settle(proposal_id)) {
        tracing::warn!(%error, "rollout ledger not settled");
    }
}

/// Parse the opaque overlay revision handed out by [`OverlaySlots`].
fn parse_revision(value: &str) -> ServiceResult<Option<u64>> {
    match value.parse::<u64>() {
        Ok(0) => Ok(None),
        Ok(revision) => Ok(Some(revision)),
        Err(_) => Err(EvolutionServiceError::conflict()),
    }
}

fn check_expected(current: Option<u64>, expected: &str) -> ServiceResult<()> {
    if parse_revision(expected)? != current {
        return Err(EvolutionServiceError::conflict());
    }
    Ok(())
}

fn open_existing(root: &Path) -> ServiceResult<Option<EvolutionStore>> {
    if !root.join(kcoder_evolution::EVOLUTION_DIR_NAME).is_dir() {
        return Ok(None);
    }
    Ok(Some(EvolutionStore::open(root)?))
}

/// Evolution data root of a target: the directory of its user settings file
/// (the user configuration directory), or the default data root when the
/// target has no settings file. RPC and REPL share this rule.
pub fn data_root_for(user_settings: Option<&Path>) -> ServiceResult<PathBuf> {
    match user_settings.and_then(Path::parent) {
        Some(parent) => Ok(parent.to_path_buf()),
        None => Ok(kcoder_evolution::default_data_root()?),
    }
}

/// `evolution.enabled` stored in the user settings file, if present.
pub fn user_layer_enabled(user_settings: &Path) -> Option<bool> {
    kcoder_config::read_settings_file_if_present(user_settings)
        .ok()
        .flatten()
        .and_then(|document| document.pointer("/evolution/enabled").cloned())
        .and_then(|value| value.as_bool())
        // An absent key keeps the typed default.
        .or(Some(EvolutionSettings::default().enabled))
}

impl EvolutionService {
    pub fn new(inputs: EvolutionServiceInputs<'_>) -> Self {
        let settings = inputs.settings;
        let effective = &settings.evolution;
        let mut view = effective.clone();
        let user_enabled = inputs.user_enabled.unwrap_or(effective.enabled);
        view.enabled = user_enabled;
        let model_refs = [
            &view.model,
            &view.stage_models.classifier,
            &view.stage_models.distill,
            &view.stage_models.eval,
        ];
        let models_ok = model_refs
            .into_iter()
            .flatten()
            .all(|reference| model_available(&inputs.models, reference));
        let disabled_reason = if !view.enabled {
            None
        } else if settings.training_mode {
            Some(EvolutionDisabledReason::TrainingMode)
        } else if !effective.enabled {
            Some(EvolutionDisabledReason::ProjectDisabled)
        } else if !models_ok {
            Some(EvolutionDisabledReason::ModelUnavailable)
        } else {
            None
        };
        let model = match &view.model {
            Some(reference) => EvolutionModelStatus {
                selection: EvolutionModelSelection::Configured,
                provider: Some(reference.provider.clone()),
                model: Some(reference.model.clone()),
                available: model_available(&inputs.models, reference),
            },
            None => EvolutionModelStatus {
                selection: EvolutionModelSelection::FollowSession,
                provider: None,
                model: None,
                available: true,
            },
        };
        let active = view.enabled
            && effective.enabled
            && !settings.training_mode
            && !matches!(
                disabled_reason,
                Some(
                    EvolutionDisabledReason::TrainingMode
                        | EvolutionDisabledReason::ProjectDisabled
                )
            );
        let skills = inputs
            .skills
            .map(|registry| targets::skill_targets(registry, effective))
            .unwrap_or_default();
        let project_root = inputs.workspace.map(|cwd| {
            resolve_scope_root(&inputs.data_root, &EvolutionScope::Project { cwd }).map_err(
                |error| match error {
                    EvolutionError::ScopeInsideProject(_) => {
                        EvolutionProjectScopeIssue::DataRootInsideProject
                    }
                    _ => EvolutionProjectScopeIssue::Unavailable,
                },
            )
        });
        Self {
            view,
            active,
            disabled_reason,
            model,
            skills,
            user_root: inputs.data_root,
            project_root,
            hooks: inputs.hooks,
            overlay_edit_recorder: None,
        }
    }

    /// Record successful `update_overlay` edits as evidence while
    /// evolution is active.
    pub fn with_overlay_edit_recorder(mut self, recorder: OverlayEditRecorder) -> Self {
        self.overlay_edit_recorder = Some(recorder);
        self
    }

    /// Whether evolution currently collects signals on this target.
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn skill_targets(&self) -> &[SkillTarget] {
        &self.skills
    }

    fn project_issue(&self) -> Option<EvolutionProjectScopeIssue> {
        self.project_root
            .as_ref()
            .and_then(|root| root.as_ref().err().copied())
    }

    fn scope_root(&self, scope: EvolutionScopeKind) -> ServiceResult<&Path> {
        match scope {
            EvolutionScopeKind::User => Ok(&self.user_root),
            EvolutionScopeKind::Project => match &self.project_root {
                Some(Ok(root)) => Ok(root),
                Some(Err(EvolutionProjectScopeIssue::DataRootInsideProject)) => {
                    Err(EvolutionServiceError::new(
                        "evolution_storage_error",
                        "project evolution data is unavailable because the data root is inside the project",
                    ))
                }
                _ => Err(EvolutionServiceError::new(
                    "evolution_storage_error",
                    "project evolution data is unavailable for this workspace",
                )),
            },
        }
    }

    /// Existing stores readable for this request, user scope first.
    fn readable_stores(&self) -> ServiceResult<Vec<(EvolutionScopeKind, EvolutionStore)>> {
        let mut stores = Vec::new();
        if let Some(store) = open_existing(&self.user_root)? {
            stores.push((EvolutionScopeKind::User, store));
        }
        if let Some(Ok(root)) = &self.project_root
            && let Some(store) = open_existing(root)?
        {
            stores.push((EvolutionScopeKind::Project, store));
        }
        Ok(stores)
    }

    fn summary_inputs<'a>(
        &'a self,
        write_mode: &'a dyn Fn(&TargetKey) -> EvolutionWriteMode,
    ) -> TargetSummaryInputs<'a> {
        TargetSummaryInputs {
            settings: &self.view,
            write_mode,
        }
    }

    fn skill(&self, key: &TargetKey) -> Option<&SkillTarget> {
        self.skills.iter().find(|skill| &skill.key == key)
    }

    /// Skills follow their write mode; every other target evolves through
    /// its overlay.
    fn write_mode(&self, key: &TargetKey) -> EvolutionWriteMode {
        self.skill(key)
            .map_or(EvolutionWriteMode::Overlay, |skill| skill.write_mode)
    }

    fn has_data(store: &EvolutionStore, key: &TargetKey) -> ServiceResult<bool> {
        Ok(store.overlay_document(key)?.is_some()
            || store
                .list_proposals()?
                .iter()
                .any(|proposal| &proposal.target_key == key))
    }

    /// Scope of a target: the registry decides for skills, project
    /// knowledge is always project-scoped, otherwise existing project data
    /// wins and user scope is the default.
    fn scope_of(&self, key: &TargetKey) -> ServiceResult<EvolutionScopeKind> {
        if let Some(skill) = self.skill(key) {
            return Ok(skill.scope);
        }
        if key.target_type() == TargetType::ProjectKnowledge {
            return Ok(EvolutionScopeKind::Project);
        }
        if let Some(Ok(root)) = &self.project_root
            && let Some(store) = open_existing(root)?
            && Self::has_data(&store, key)?
        {
            return Ok(EvolutionScopeKind::Project);
        }
        Ok(EvolutionScopeKind::User)
    }

    fn ensure_implemented(target_type: TargetType) -> ServiceResult<()> {
        if !IMPLEMENTED_TARGET_TYPES.contains(&target_type) {
            return Err(EvolutionServiceError::unsupported(target_type));
        }
        Ok(())
    }

    /// Resolve a target for a single-target operation: implemented type,
    /// known target, scope and (when `write`) an opened store.
    fn target_store(
        &self,
        key: &TargetKey,
        write: bool,
    ) -> ServiceResult<(EvolutionScopeKind, Option<EvolutionStore>)> {
        Self::ensure_implemented(key.target_type())?;
        let scope = self.scope_of(key)?;
        let root = self.scope_root(scope)?;
        let store = if write {
            Some(EvolutionStore::open(root)?)
        } else {
            open_existing(root)?
        };
        let known = self.skill(key).is_some()
            || match &store {
                Some(store) => Self::has_data(store, key)?,
                None => false,
            };
        if !known {
            return Err(EvolutionServiceError::not_found(key));
        }
        Ok((scope, store))
    }

    fn base_revision(&self, key: &TargetKey, store: &EvolutionStore) -> ServiceResult<String> {
        if let Some(skill) = self.skill(key) {
            return Ok(skill.base_revision.clone());
        }
        Ok(store
            .overlay_document(key)?
            .map(|document| document.base_revision)
            .unwrap_or_default())
    }

    fn empty_summary(&self, key: &TargetKey) -> EvolutionTargetSummary {
        EvolutionTargetSummary {
            target_key: key.clone(),
            target_type: key.target_type(),
            source: key.source().to_string(),
            name: key.name().to_string(),
            enabled: self.view.target_enabled(key),
            evolution_mode: self.write_mode(key),
            stable: kcoder_evolution::BetaEvidence::default().score(
                &TargetRevision::new(
                    self.skill(key)
                        .map(|skill| skill.base_revision.clone())
                        .unwrap_or_default(),
                    0,
                ),
                kcoder_evolution::BetaPrior::UNIFORM,
            ),
            candidate: None,
            channel_traffic: None,
            pending_proposals: 0,
            needs_revalidation: false,
            pinned: false,
        }
    }

    fn summary(
        &self,
        key: &TargetKey,
        store: Option<&EvolutionStore>,
    ) -> ServiceResult<EvolutionTargetSummary> {
        match store {
            Some(store) => {
                let write_mode = |key: &TargetKey| self.write_mode(key);
                Ok(store.target_summary(key, &self.summary_inputs(&write_mode))?)
            }
            None => Ok(self.empty_summary(key)),
        }
    }

    /// `evolution/status`.
    pub fn status(&self) -> ServiceResult<EvolutionStatusSnapshot> {
        let now = now_ms();
        let mut snapshot = EvolutionStatusSnapshot {
            enabled: self.view.enabled,
            mode: self.view.mode,
            disabled_reason: self.disabled_reason,
            model: self.model.clone(),
            targets: TargetType::ALL
                .into_iter()
                .map(|target_type| EvolutionTargetTypeStatus {
                    target_type,
                    enabled: self.view.enabled && self.view.targets.type_enabled(target_type),
                    implemented: IMPLEMENTED_TARGET_TYPES.contains(&target_type),
                    learned_items: 0,
                    pending_proposals: 0,
                })
                .collect(),
            usage_this_month: EvolutionUsageSummary::default(),
            jobs: Vec::new(),
            skill_file_edits_supported: crate::skill_file_evolution::skill_file_edits_supported(),
            diagnostics: Default::default(),
        };
        let mut last_runs = std::collections::BTreeMap::<&str, u64>::new();
        for (_, store) in self.readable_stores()? {
            let part = store.status_snapshot(StatusInputs {
                settings: &self.view,
                // Reasons are merged below across both scopes.
                disabled_reason: None,
                model: self.model.clone(),
                implemented_types: IMPLEMENTED_TARGET_TYPES,
                jobs: Vec::new(),
                skill_file_edits_supported: crate::skill_file_evolution::skill_file_edits_supported(
                ),
                now_ms: now,
            })?;
            for (total, item) in snapshot.targets.iter_mut().zip(part.targets) {
                total.learned_items = total.learned_items.saturating_add(item.learned_items);
                total.pending_proposals = total
                    .pending_proposals
                    .saturating_add(item.pending_proposals);
            }
            let usage = &mut snapshot.usage_this_month;
            usage.input_tokens = usage
                .input_tokens
                .saturating_add(part.usage_this_month.input_tokens);
            usage.output_tokens = usage
                .output_tokens
                .saturating_add(part.usage_this_month.output_tokens);
            let diagnostics = &mut snapshot.diagnostics;
            diagnostics.duplicate_records += part.diagnostics.duplicate_records;
            diagnostics.invalid_records += part.diagnostics.invalid_records;
            diagnostics.future_records += part.diagnostics.future_records;
            diagnostics.torn_tail |= part.diagnostics.torn_tail;
            let state = store.read_state()?;
            for kind in ["classify", "distill", "eval"] {
                if let Some(at) = state.jobs.get(kind).and_then(|job| job.last_run_at_ms) {
                    let entry = last_runs.entry(kind).or_default();
                    *entry = (*entry).max(at);
                }
            }
        }
        snapshot.diagnostics.project_scope_issue = self.project_issue();
        if snapshot.disabled_reason.is_none()
            && self.view.enabled
            && self
                .view
                .usage_limit
                .monthly_max_tokens
                .is_some_and(|limit| {
                    snapshot
                        .usage_this_month
                        .input_tokens
                        .saturating_add(snapshot.usage_this_month.output_tokens)
                        >= limit
                })
        {
            snapshot.disabled_reason = Some(EvolutionDisabledReason::UsageLimit);
        }
        let running = self.hooks.running_jobs();
        snapshot.jobs = [
            (EvolutionJobKind::Classify, "classify"),
            (EvolutionJobKind::Distill, "distill"),
            (EvolutionJobKind::Eval, "eval"),
        ]
        .into_iter()
        .map(|(kind, name)| {
            let target = running
                .iter()
                .find(|(running_kind, _)| *running_kind == kind)
                .map(|(_, target)| target.clone());
            let state = if target.is_some() {
                EvolutionJobState::Running
            } else if self.view.enabled && snapshot.disabled_reason.is_some() {
                EvolutionJobState::Paused
            } else {
                EvolutionJobState::Idle
            };
            EvolutionJobStatus {
                kind,
                target_key: target.flatten(),
                state,
                last_run_at: last_runs
                    .get(name)
                    .map(|at| kcoder_evolution::rfc3339_from_unix_ms(*at)),
            }
        })
        .collect();
        Ok(snapshot)
    }

    /// `evolution/targets/list`: registry targets plus every target with
    /// data, sorted by key, paged after `cursor` (the last key returned).
    pub fn list_targets(
        &self,
        target_type: TargetType,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> ServiceResult<(Vec<EvolutionTargetSummary>, Option<String>)> {
        let mut summaries = std::collections::BTreeMap::<TargetKey, EvolutionTargetSummary>::new();
        for (scope, store) in self.readable_stores()? {
            let write_mode = |key: &TargetKey| self.write_mode(key);
            for summary in
                store.list_target_summaries(target_type, &self.summary_inputs(&write_mode))?
            {
                // A registry skill reads from its own scope; stale data of the
                // other scope must not shadow it.
                if self
                    .skill(&summary.target_key)
                    .is_some_and(|skill| skill.scope != scope)
                {
                    continue;
                }
                summaries.insert(summary.target_key.clone(), summary);
            }
        }
        if target_type == TargetType::Skill {
            for skill in &self.skills {
                summaries
                    .entry(skill.key.clone())
                    .or_insert_with(|| self.empty_summary(&skill.key));
            }
        }
        let limit = limit.unwrap_or(TARGETS_PAGE_DEFAULT).max(1);
        let mut items: Vec<_> = summaries
            .into_iter()
            .filter(|(key, _)| cursor.is_none_or(|cursor| key.to_string().as_str() > cursor))
            .map(|(_, summary)| summary)
            .take(limit + 1)
            .collect();
        let next = (items.len() > limit).then(|| {
            items.truncate(limit);
            items
                .last()
                .map(|summary| summary.target_key.to_string())
                .unwrap_or_default()
        });
        Ok((items, next))
    }

    /// `evolution/target/read`.
    pub fn read_target(&self, key: &TargetKey) -> ServiceResult<TargetDetail> {
        let (_, store) = self.target_store(key, false)?;
        let Some(store) = store else {
            return Ok(TargetDetail {
                summary: self.empty_summary(key),
                overlay: OverlaySlots {
                    stable: OverlayContent::default(),
                    candidate: None,
                    overlay_revision: "0".into(),
                },
                patterns: Vec::new(),
                proposals: Vec::new(),
            });
        };
        let view = store.read_overlay(key)?;
        let overlay = match view {
            Some(view) => OverlaySlots {
                stable: view.stable.unwrap_or_default(),
                candidate: view.candidate.filter(|_| {
                    view.document.candidate.as_ref().is_some_and(|candidate| {
                        matches!(
                            candidate.state,
                            kcoder_types::evolution::OverlayCandidateState::Staged
                                | kcoder_types::evolution::OverlayCandidateState::Canary
                        )
                    })
                }),
                overlay_revision: view.document.revision.to_string(),
            },
            None => OverlaySlots {
                stable: OverlayContent::default(),
                candidate: None,
                overlay_revision: "0".into(),
            },
        };
        let proposals = store
            .list_proposals()?
            .iter()
            .filter(|proposal| &proposal.target_key == key)
            .rev()
            .map(kcoder_evolution::proposal_summary)
            .collect();
        // Patterns distillation recorded for this target, latest first;
        // one entry per pattern id with its latest support.
        let patterns = store
            .read_patterns()?
            .patterns_of(key)
            .into_iter()
            .map(|stored| stored.pattern.clone())
            .collect();
        Ok(TargetDetail {
            summary: self.summary(key, Some(&store))?,
            overlay,
            patterns,
            proposals,
        })
    }

    /// `evolution/proposal/decide`. `expected_revision` is the overlay
    /// revision the client last read.
    pub fn decide(
        &self,
        key: &TargetKey,
        proposal_id: &str,
        decision: ProposalDecision,
        expected_revision: &str,
    ) -> ServiceResult<(EvolutionTargetSummary, EvolutionChange)> {
        self.decide_with_notice(key, proposal_id, decision, expected_revision)
            .map(|(summary, change, _)| (summary, change))
    }

    /// [`Self::decide`] plus a message for the user when part of the
    /// decision could not be carried out (a rolled-back skill file that was
    /// edited after its promotion keeps the edit).
    pub fn decide_with_notice(
        &self,
        key: &TargetKey,
        proposal_id: &str,
        decision: ProposalDecision,
        expected_revision: &str,
    ) -> ServiceResult<(EvolutionTargetSummary, EvolutionChange, Option<String>)> {
        let (_, store) = self.target_store(key, true)?;
        let store = store.expect("write access opens the store");
        let now = now_ms();
        let document = store.overlay_document(key)?;
        check_expected(
            document.as_ref().map(|document| document.revision),
            expected_revision,
        )?;
        if decision == ProposalDecision::PinStable {
            let document = document.ok_or_else(|| {
                EvolutionServiceError::new(
                    "evolution_invalid_transition",
                    "a target without an overlay cannot be pinned",
                )
            })?;
            store.set_overlay_pinned(key, document.revision, !document.pinned_stable, now)?;
            return Ok((
                self.summary(key, Some(&store))?,
                EvolutionChange::Proposal,
                None,
            ));
        }
        let proposal = store
            .read_proposal(proposal_id)?
            .filter(|proposal| &proposal.target_key == key)
            .ok_or_else(|| {
                EvolutionServiceError::new(
                    "evolution_proposal_not_found",
                    format!("proposal {proposal_id} was not found for {key}"),
                )
            })?;
        let candidate_of_proposal = document.as_ref().and_then(|document| {
            document
                .candidate
                .as_ref()
                .filter(|candidate| candidate.proposal_id.as_deref() == Some(proposal_id))
                .map(|candidate| (document.revision, candidate.state))
        });
        use kcoder_types::evolution::OverlayCandidateState as Candidate;
        let mut notice = None;
        let change = match decision {
            ProposalDecision::Accept => {
                self.hooks.apply_proposal_accept(ProposalAcceptRequest {
                    store: &store,
                    proposal: &proposal,
                    document: document.as_ref(),
                    base_revision: self.base_revision(key, &store)?,
                    now_ms: now,
                })?;
                // An approval for evaluation and canary leaves the proposal
                // in its state; only a promotion changes what is served.
                let promoted = store
                    .read_proposal(proposal_id)?
                    .is_some_and(|proposal| proposal.state == ProposalState::Promoted);
                if promoted {
                    EvolutionChange::Promoted
                } else {
                    EvolutionChange::Proposal
                }
            }
            ProposalDecision::Reject => {
                if !matches!(
                    proposal.state,
                    ProposalState::Draft | ProposalState::Evaluated | ProposalState::Canary
                ) {
                    return Err(EvolutionError::InvalidTransition {
                        from: proposal.state,
                        to: ProposalState::Rejected,
                    }
                    .into());
                }
                if let Some((revision, Candidate::Staged | Candidate::Canary)) =
                    candidate_of_proposal
                {
                    store.rollback_candidate(key, revision, now)?;
                }
                self.hooks.discard_proposal_candidate(key, proposal_id);
                store.transition_proposal(
                    proposal_id,
                    proposal.revision,
                    ProposalState::Rejected,
                    ProposalActor::User,
                    Some("rejected by user".into()),
                    now,
                )?;
                settle_rollout(&store, proposal_id);
                EvolutionChange::Proposal
            }
            ProposalDecision::Rollback => {
                match proposal.state {
                    ProposalState::Canary => {
                        if let Some((revision, Candidate::Staged | Candidate::Canary)) =
                            candidate_of_proposal
                        {
                            store.rollback_candidate(key, revision, now)?;
                        }
                        self.hooks.discard_proposal_candidate(key, proposal_id);
                    }
                    ProposalState::Promoted => {
                        // Files first: a refusal still reverts the overlay
                        // and tells the user what was kept.
                        if let TargetFileRollback::Refused(message) =
                            self.hooks.rollback_promoted_target_file(key, proposal_id)?
                        {
                            notice = Some(message);
                        }
                        if let Some(document) = document.as_ref() {
                            let current = store
                                .read_overlay(key)?
                                .and_then(|view| view.stable)
                                .unwrap_or_default();
                            let reverted = revert_changes(&current, &proposal.changes);
                            if reverted != current {
                                store.write_stable_overlay(
                                    key,
                                    Some(document.revision),
                                    &document.base_revision,
                                    &reverted,
                                    OverlaySlotSource::User,
                                    now,
                                )?;
                            }
                        }
                    }
                    from => {
                        return Err(EvolutionError::InvalidTransition {
                            from,
                            to: ProposalState::RolledBack,
                        }
                        .into());
                    }
                }
                store.transition_proposal(
                    proposal_id,
                    proposal.revision,
                    ProposalState::RolledBack,
                    ProposalActor::User,
                    Some("rolled back by user".into()),
                    now,
                )?;
                settle_rollout(&store, proposal_id);
                EvolutionChange::RolledBack
            }
            ProposalDecision::PinStable => unreachable!("handled above"),
        };
        Ok((self.summary(key, Some(&store))?, change, notice))
    }

    /// `evolution/overlay/update`: a user edit of the stable slot. Text is
    /// redacted and scanned before anything is written.
    pub fn update_overlay(
        &self,
        key: &TargetKey,
        content: &OverlayContent,
        expected_revision: &str,
    ) -> ServiceResult<String> {
        let content = guard_overlay_content(content)?;
        let (_, store) = self.target_store(key, true)?;
        let store = store.expect("write access opens the store");
        let expected = parse_revision(expected_revision)?;
        let base = self.base_revision(key, &store)?;
        let before = store
            .read_overlay(key)?
            .and_then(|view| view.stable)
            .unwrap_or_default();
        let document = store.write_stable_overlay(
            key,
            expected,
            &base,
            &content,
            OverlaySlotSource::User,
            now_ms(),
        )?;
        // The edit is committed; failing to keep it as evidence only loses
        // a distillation hint, so it never fails the request.
        if self.active
            && let Some(record) = self.overlay_edit_recorder
            && let Err(error) = record(&store, key, &before, &content, self.view.evidence_ttl_days)
        {
            tracing::warn!(%error, "overlay edit evidence not recorded");
        }
        Ok(document.revision.to_string())
    }

    /// `evolution/preference/list`.
    pub fn preferences(&self) -> ServiceResult<(Vec<PreferenceRow>, String)> {
        let Some(store) = open_existing(&self.user_root)? else {
            return Ok((Vec::new(), "0".into()));
        };
        let document = store.read_preferences()?;
        let rows = document
            .items
            .iter()
            .filter_map(|(key, entry)| {
                let (scope, _) = kcoder_evolution::parse_preference_key(key).ok()?;
                Some(PreferenceRow {
                    key: key.clone(),
                    value: entry.value.clone(),
                    scope: scope.to_string(),
                    evidence_count: u32::try_from(entry.evidence_ids.len()).unwrap_or(u32::MAX),
                    updated_at: kcoder_evolution::rfc3339_from_unix_ms(entry.updated_at_ms),
                })
            })
            .collect();
        Ok((rows, document.revision.to_string()))
    }

    /// `evolution/preference/update`; `None` deletes the preference.
    pub fn update_preference(
        &self,
        key: &str,
        value: Option<&str>,
        expected_revision: &str,
    ) -> ServiceResult<String> {
        let expected = expected_revision
            .parse::<u64>()
            .map_err(|_| EvolutionServiceError::conflict())?;
        let value = value.map(|value| {
            let (redacted, _) = crate::session_read::redact_secrets(value);
            redacted
        });
        if let Some(value) = &value {
            content::scan_text(value)?;
        }
        let store = EvolutionStore::open(&self.user_root)?;
        let document = store.update_preference(key, value.as_deref(), expected, now_ms())?;
        Ok(document.revision.to_string())
    }

    /// `evolution/rate` and `/rate`. Returns whether the rating is recorded.
    pub fn rate(&self, request: &RatingRequest) -> ServiceResult<bool> {
        if !self.active {
            return Err(EvolutionServiceError::disabled());
        }
        if !self.view.signals.rating_ui {
            return Ok(false);
        }
        if let Some(key) = &request.target_key {
            Self::ensure_implemented(key.target_type())?;
        }
        let mut recorded = false;
        for (_, store) in self.readable_stores()? {
            recorded |= self
                .hooks
                .record_rating(&store, request, self.view.evidence_ttl_days)?;
        }
        Ok(recorded)
    }

    /// `evolution/ratings/list`: the turns of `thread_id` that
    /// [`Self::rate`] would accept, newest first and at most `limit`, with
    /// the rating that stands for each. Empty while the rating control
    /// signal is off. The second value reports whether turns were left out.
    pub fn ratable_turns(
        &self,
        thread_id: &str,
        limit: usize,
    ) -> ServiceResult<(Vec<RatableTurn>, bool)> {
        if !self.active {
            return Err(EvolutionServiceError::disabled());
        }
        if !self.view.signals.rating_ui {
            return Ok((Vec::new(), false));
        }
        let mut turns: Vec<RatableTurn> = Vec::new();
        for (_, store) in self.readable_stores()? {
            for turn in rating::ratable_turns(&store, thread_id)? {
                // A turn can have usages in both scopes (user and project skills).
                match turns.iter_mut().find(|known| known.turn_id == turn.turn_id) {
                    Some(known) => rating::merge_ratable_turn(known, turn),
                    None => turns.push(turn),
                }
            }
        }
        turns.sort_by(|left, right| {
            right
                .started_at_ms
                .cmp(&left.started_at_ms)
                .then_with(|| left.turn_id.cmp(&right.turn_id))
        });
        let truncated = turns.len() > limit;
        turns.truncate(limit);
        Ok((turns, truncated))
    }

    /// Cancel this process's evolution jobs in every available scope, for
    /// example after the master switch was turned off.
    pub fn cancel_jobs(&self) -> ServiceResult<()> {
        self.hooks.cancel_jobs(&self.user_root)?;
        if let Some(Ok(root)) = &self.project_root {
            self.hooks.cancel_jobs(root)?;
        }
        Ok(())
    }

    /// `evolution/data/clear`. Owned running jobs of each cleared scope are
    /// cancelled and awaited first.
    pub fn clear(&self, scope: ClearScope) -> ServiceResult<bool> {
        let scopes: &[EvolutionScopeKind] = match scope {
            ClearScope::User => &[EvolutionScopeKind::User],
            ClearScope::Project => &[EvolutionScopeKind::Project],
            ClearScope::All => &[EvolutionScopeKind::User, EvolutionScopeKind::Project],
        };
        let mut cleared = true;
        for scope in scopes {
            let root = match self.scope_root(*scope) {
                Ok(root) => root,
                // Nothing of an unavailable project partition can exist.
                Err(_) if *scope == EvolutionScopeKind::Project => {
                    cleared &= self.project_root.is_none();
                    continue;
                }
                Err(error) => return Err(error),
            };
            self.hooks.cancel_jobs(root)?;
            if let Some(store) = open_existing(root)? {
                store.clear_all()?;
            }
        }
        Ok(cleared)
    }

    /// Resolve a proposal id prefix (as REPL users type it) to the full id
    /// and its target, across both scopes.
    pub fn find_proposal(&self, id_or_prefix: &str) -> ServiceResult<(TargetKey, String)> {
        let mut matches = Vec::new();
        for (_, store) in self.readable_stores()? {
            for proposal in store.list_proposals()? {
                if proposal.proposal_id == id_or_prefix
                    || proposal.proposal_id.starts_with(id_or_prefix)
                {
                    matches.push((proposal.target_key.clone(), proposal.proposal_id.clone()));
                }
            }
        }
        matches.sort();
        matches.dedup();
        match matches.len() {
            1 => Ok(matches.remove(0)),
            0 => Err(EvolutionServiceError::new(
                "evolution_proposal_not_found",
                format!("proposal {id_or_prefix} was not found"),
            )),
            _ => Err(EvolutionServiceError::new(
                "evolution_proposal_not_found",
                format!("proposal prefix {id_or_prefix} is ambiguous"),
            )),
        }
    }

    /// Current overlay revision of a target (`"0"` without an overlay).
    pub fn overlay_revision(&self, key: &TargetKey) -> ServiceResult<String> {
        Ok(self.read_target(key)?.overlay.overlay_revision)
    }
}

#[cfg(test)]
mod tests;
