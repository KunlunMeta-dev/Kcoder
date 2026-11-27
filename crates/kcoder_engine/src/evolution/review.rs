//! Background skill review while self-evolution is enabled (plan section
//! 13.1).
//!
//! With evolution on, the base layer (skill files) and learned content have
//! one writer each, and the mode decides every automatic write. The review
//! therefore loses `skill_manage` and `remember` and gets three tools:
//!
//! - `evolution_review_finding`: a finding about an existing skill becomes
//!   `review finding` evidence for that target. It is model judgement: a
//!   candidate lesson that distillation may only promote when observed
//!   signals corroborate it; it never counts as support.
//! - `evolution_propose_skill`: a workflow no skill covers yet becomes a
//!   "create skill" proposal (`propose`), is created as an `AgentCreated`
//!   skill after the unattended write guard (`auto`), or is kept as
//!   evidence only (`observe`).
//! - `evolution_note`: what `remember` would have saved becomes preference
//!   or project knowledge evidence instead of a direct memory write.
//!
//! With evolution off the review keeps its Phase 0 behaviour unchanged.

use super::{EvolutionRuntime, ScopeKind, now_ms, redacted_snippet};
use async_trait::async_trait;
use kcoder_evolution::{EvolutionStore, ProposalDraft};
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolRegistry};
use kcoder_types::evolution::{
    EvolutionMode, ProposalActor, ProposalChanges, ProposalLocation, ProposalState,
    SafetyScanResult, TargetKey, TargetType,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;

pub(crate) const FINDING_TOOL: &str = "evolution_review_finding";
pub(crate) const PROPOSE_SKILL_TOOL: &str = "evolution_propose_skill";
pub(crate) const NOTE_TOOL: &str = "evolution_note";
/// Base revision recorded on "create skill" proposals.
pub(crate) const NEW_SKILL_BASE: &str = "new";

/// Shared context of the review tools.
#[derive(Clone)]
pub(crate) struct ReviewToolContext {
    pub(crate) runtime: Arc<EvolutionRuntime>,
    pub(crate) cwd: PathBuf,
    pub(crate) mode: EvolutionMode,
    pub(crate) ttl_days: u32,
    /// Existing skills: name → (target key, project scope).
    pub(crate) skills: Arc<std::collections::BTreeMap<String, (TargetKey, bool)>>,
    /// The real `skill_manage`, used only for `auto` skill creation.
    pub(crate) skill_manage: Option<Arc<dyn Tool>>,
}

/// Append a review evidence id to the target's distill cursor.
pub(crate) fn remember_review_evidence(
    store: &EvolutionStore,
    key: &TargetKey,
    evidence: &str,
) -> Result<(), kcoder_evolution::EvolutionError> {
    store.update_state(|state| {
        let cursor = state.distill.entry(key.clone()).or_default();
        if !cursor.review_findings.iter().any(|id| id == evidence) {
            cursor.review_findings.push(evidence.to_string());
        }
        let excess = cursor
            .review_findings
            .len()
            .saturating_sub(kcoder_evolution::USER_EDIT_EVIDENCE_MAX);
        cursor.review_findings.drain(..excess);
    })?;
    Ok(())
}

fn store_for(
    context: &ReviewToolContext,
    scope: ScopeKind,
) -> Result<Arc<EvolutionStore>, ToolError> {
    context
        .runtime
        .store(scope, &context.cwd)
        .ok_or_else(|| ToolError::Execution("self-evolution storage is unavailable".into()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FindingInput {
    skill: String,
    finding: String,
}

struct FindingTool(ReviewToolContext);

#[async_trait]
impl Tool for FindingTool {
    fn name(&self) -> String {
        FINDING_TOOL.into()
    }
    fn description(&self) -> String {
        "Record a finding about an existing skill (a lesson, pitfall or missing step seen in this \
         conversation). It is stored as review evidence for that skill and is not applied: the \
         self-evolution framework only turns it into a proposal when observed outcomes support it. \
         The skill file is never modified by this tool."
            .into()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"required":["skill","finding"],
            "properties":{"skill":{"type":"string","description":"Exact registered skill name"},
                "finding":{"type":"string","maxLength":1500}}})
    }
    async fn call(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: FindingInput = serde_json::from_value(input)
            .map_err(|error| ToolError::InvalidInput(error.to_string()))?;
        let (key, project) = self.0.skills.get(&input.skill).cloned().ok_or_else(|| {
            ToolError::InvalidInput(format!(
                "unknown skill `{}`; use an exact registered name, or propose a new skill",
                input.skill
            ))
        })?;
        let store = store_for(&self.0, EvolutionRuntime::scope_of(&key, project))?;
        let text = format!("review finding\n{}", redacted_snippet(&input.finding, 1500));
        let id = store
            .put_evidence(&text, now_ms(), self.0.ttl_days)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        remember_review_evidence(&store, &key, &id)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        Ok(ToolOutput::text(format!(
            "Recorded a review finding for {key}; it is evidence only and was not applied."
        )))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposeSkillInput {
    name: String,
    content: String,
}

struct ProposeSkillTool(ReviewToolContext);

/// Store a "create skill" proposal: location `target_file`, base revision
/// [`NEW_SKILL_BASE`], the full SKILL.md in `changes.diff`.
pub(crate) fn store_create_skill_proposal(
    store: &EvolutionStore,
    name: &str,
    content: &str,
    now: u64,
) -> Result<(String, bool), String> {
    let key = TargetKey::new(TargetType::Skill, "agent_created", name)
        .map_err(|error| error.to_string())?;
    let (redacted, changed) = kcoder_tools::session_read::redact_secrets(content);
    let scan = kcoder_tools::skill_guard::scan_skill_content(&redacted);
    let blocking: Vec<String> = scan
        .findings
        .iter()
        .filter(|finding| finding.level >= kcoder_tools::skill_guard::SkillRiskLevel::Medium)
        .map(|finding| format!("line {}: {}", finding.line, finding.message))
        .collect();
    let created = store
        .create_proposal(
            ProposalDraft {
                target_key: key,
                base_revision: NEW_SKILL_BASE.into(),
                location: ProposalLocation::TargetFile,
                changes: ProposalChanges {
                    diff: Some(redacted),
                    ..Default::default()
                },
                pattern_ids: Vec::new(),
                evidence_ids: Vec::new(),
                actor: ProposalActor::Auto,
            },
            now,
        )
        .map_err(|error| error.to_string())?;
    let mut findings = blocking.clone();
    if changed {
        findings.push("likely credentials were redacted".into());
    }
    let proposal = store
        .record_proposal_review(
            &created.proposal.proposal_id,
            created.proposal.revision,
            Some(SafetyScanResult {
                passed: blocking.is_empty(),
                findings,
            }),
            None,
            now,
        )
        .map_err(|error| error.to_string())?;
    if !blocking.is_empty() && proposal.state == ProposalState::Draft {
        let _ = store.transition_proposal(
            &proposal.proposal_id,
            proposal.revision,
            ProposalState::Rejected,
            ProposalActor::Auto,
            Some(format!("safety scan: {}", blocking.join("; "))),
            now,
        );
        return Ok((proposal.proposal_id, false));
    }
    Ok((proposal.proposal_id, true))
}

#[async_trait]
impl Tool for ProposeSkillTool {
    fn name(&self) -> String {
        PROPOSE_SKILL_TOOL.into()
    }
    fn description(&self) -> String {
        "Propose a new skill for a recurring workflow that no existing skill covers. Give the \
         skill name (lowercase letters, digits and hyphens) and the full SKILL.md with \
         frontmatter. Depending on the user's self-evolution mode the skill is stored as a \
         proposal for the user to confirm, created after a safety scan, or only recorded as \
         evidence. Existing skills cannot be changed with this tool; record a finding instead."
            .into()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"required":["name","content"],
            "properties":{"name":{"type":"string"},"content":{"type":"string","maxLength":20000}}})
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ProposeSkillInput = serde_json::from_value(input)
            .map_err(|error| ToolError::InvalidInput(error.to_string()))?;
        if self.0.skills.contains_key(&input.name) {
            return Err(ToolError::InvalidInput(format!(
                "skill `{}` already exists; record a finding for it instead",
                input.name
            )));
        }
        let store = store_for(&self.0, ScopeKind::User)?;
        match self.0.mode {
            EvolutionMode::Observe => {
                let text = format!(
                    "review proposed skill `{}`\n{}",
                    input.name,
                    redacted_snippet(&input.content, 3000)
                );
                store
                    .put_evidence(&text, now_ms(), self.0.ttl_days)
                    .map_err(|error| ToolError::Execution(error.to_string()))?;
                Ok(ToolOutput::text(
                    "Recorded as evidence only (observe mode); no skill was created.",
                ))
            }
            EvolutionMode::Propose => {
                let (id, passed) =
                    store_create_skill_proposal(&store, &input.name, &input.content, now_ms())
                        .map_err(ToolError::InvalidInput)?;
                Ok(ToolOutput::text(if passed {
                    format!("Stored proposal {id}; the user decides whether the skill is created.")
                } else {
                    format!("Proposal {id} was rejected by the safety scan; nothing was created.")
                }))
            }
            EvolutionMode::Auto => {
                let tool = self.0.skill_manage.clone().ok_or_else(|| {
                    ToolError::Execution("skill creation is unavailable in this session".into())
                })?;
                // The fork's context carries the background-review actor, so
                // skill_manage applies the unattended redaction and guard.
                tool.call(
                    json!({"action": "create", "name": input.name, "content": input.content}),
                    ctx,
                )
                .await
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteInput {
    fact: String,
    kind: String,
    category: String,
}

struct NoteTool(ReviewToolContext);

#[async_trait]
impl Tool for NoteTool {
    fn name(&self) -> String {
        NOTE_TOOL.into()
    }
    fn description(&self) -> String {
        "Record a durable user preference (`kind`: preference) or project fact (`kind`: \
         project_knowledge) seen in this conversation. It is stored as self-evolution evidence, \
         not written to memory; accepted proposals later become preferences or project knowledge."
            .into()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"required":["fact","kind","category"],
            "properties":{"fact":{"type":"string","maxLength":1000},
                "kind":{"enum":["preference","project_knowledge"]},
                "category":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,64}$"}}})
    }
    async fn call(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: NoteInput = serde_json::from_value(input)
            .map_err(|error| ToolError::InvalidInput(error.to_string()))?;
        let (target_type, source, scope) = match input.kind.as_str() {
            "preference" => (TargetType::Preference, "user", ScopeKind::User),
            "project_knowledge" => (TargetType::ProjectKnowledge, "project", ScopeKind::Project),
            other => return Err(ToolError::InvalidInput(format!("unknown kind `{other}`"))),
        };
        let name = if target_type == TargetType::Preference {
            format!("global.{}", input.category)
        } else {
            format!("{}.notes", input.category)
        };
        let key = TargetKey::new(target_type, source, name)
            .map_err(|error| ToolError::InvalidInput(error.to_string()))?;
        let store = store_for(&self.0, scope)?;
        let id = store
            .put_evidence(
                &format!(
                    "review note ({})\n{}",
                    input.kind,
                    redacted_snippet(&input.fact, 1000)
                ),
                now_ms(),
                self.0.ttl_days,
            )
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        remember_review_evidence(&store, &key, &id)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        Ok(ToolOutput::text(
            "Recorded as evidence; memory was not changed.",
        ))
    }
}

/// Tool names of the evolution-mode review.
pub(crate) fn review_tool_names() -> Vec<String> {
    vec![
        FINDING_TOOL.into(),
        PROPOSE_SKILL_TOOL.into(),
        NOTE_TOOL.into(),
        "skill".into(),
        "DiscoverSkills".into(),
    ]
}

/// Registry of the evolution-mode review: read-only skill views plus the
/// three evidence/proposal tools. `skill_manage` and `remember` are absent.
pub(crate) fn review_registry(base: &ToolRegistry, context: ReviewToolContext) -> ToolRegistry {
    let mut registry = ToolRegistry::new()
        .register(FindingTool(context.clone()))
        .register(ProposeSkillTool(context.clone()))
        .register(NoteTool(context));
    for name in ["skill", "DiscoverSkills"] {
        if let Some(tool) = base.get(name) {
            registry = registry.register_arc(tool);
        }
    }
    registry
}
