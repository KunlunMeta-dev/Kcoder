use async_trait::async_trait;
use kcoder_state::orchestrate_store::{AcceptanceRecord, PlanStore};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Digest as _;

use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};

#[derive(Debug, Default)]
pub struct CreateWorkPlanTool;

#[derive(Debug, Default)]
pub struct EditWorkPlanTool;

#[derive(Debug, Default)]
pub struct AppendWorkNotepadTool;

#[derive(Debug, Default)]
pub struct RecordTaskAcceptanceTool;

#[derive(Debug, Default)]
pub struct RecordTaskAcceptancesTool;

#[derive(Debug, Default)]
pub struct ReopenTaskTool;

#[derive(Debug, Default)]
pub struct SelectActiveWorkTool;

#[derive(Debug, Default)]
pub struct PlanProgressTool;

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateWorkPlanInput {
    /// Short display-only identifier; a tool-generated opaque work_id determines state identity.
    display_slug: String,
    /// Complete Markdown plan conforming to strict orchestration syntax.
    plan: String,
    /// Whether to make the new work item active.
    #[serde(default = "default_true")]
    select_active: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct EditWorkPlanInput {
    work_id: String,
    expected_revision: u64,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct AppendWorkNotepadInput {
    work_id: String,
    /// One of learnings, decisions, issues, or verification.
    name: String,
    content: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RecordTaskAcceptanceInput {
    work_id: String,
    expected_revision: u64,
    task_key: String,
    result_digest: String,
    evidence_ids: Vec<String>,
    works: bool,
    conforms: bool,
    matches_contract: bool,
    honored_boundaries: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct TaskAcceptanceInput {
    task_key: String,
    result_digest: String,
    evidence_ids: Vec<String>,
    works: bool,
    conforms: bool,
    matches_contract: bool,
    honored_boundaries: bool,
}

impl TaskAcceptanceInput {
    fn into_record(self) -> AcceptanceRecord {
        AcceptanceRecord {
            task_key: self.task_key,
            result_digest: self.result_digest,
            evidence_ids: self.evidence_ids,
            works: self.works,
            conforms: self.conforms,
            matches_contract: self.matches_contract,
            honored_boundaries: self.honored_boundaries,
            accepted_at: chrono::Utc::now(),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RecordTaskAcceptancesInput {
    work_id: String,
    expected_revision: u64,
    /// Tasks to accept atomically in one validation wave and revision.
    acceptances: Vec<TaskAcceptanceInput>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReopenTaskInput {
    work_id: String,
    expected_revision: u64,
    task_key: String,
    reason: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SelectActiveWorkInput {
    work_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct PlanProgressInput {
    /// When omitted, read the explicitly selected active work item.
    #[serde(default)]
    work_id: Option<String>,
}

fn default_true() -> bool {
    true
}

fn store(ctx: &ToolContext) -> PlanStore {
    PlanStore::for_workspace(&ctx.state.cwd())
}

fn output_snapshot(snapshot: kcoder_state::orchestrate_store::WorkSnapshot) -> ToolOutput {
    ToolOutput::text(
        serde_json::to_string_pretty(&json!({
            "work_id": snapshot.work.work_id,
            "display_slug": snapshot.work.display_slug,
            "revision": snapshot.work.revision,
            "plan_sha256": snapshot.work.plan_sha256,
            "status": snapshot.work.status,
            "progress": snapshot.work.progress,
        }))
        .expect("serializing PlanStore result cannot fail"),
    )
}

fn truncate_evidence_subject(value: &str) -> String {
    const LIMIT: usize = 240;
    let mut subject = value.chars().take(LIMIT).collect::<String>();
    if value.chars().count() > LIMIT {
        subject.push('…');
    }
    subject
}

fn evidence_summary(record: &kcoder_state::orchestrate_store::AgentEvidence) -> Value {
    use kcoder_state::orchestrate_store::AgentEvidenceKind;

    let (kind, subject, detail) = match &record.evidence {
        AgentEvidenceKind::ProcessExit {
            command,
            exit_code,
            signal,
            raw_exit_code,
            ..
        } => (
            "process_exit",
            truncate_evidence_subject(command),
            json!({
                "exit_code": exit_code,
                "signal": signal,
                "raw_exit_code": raw_exit_code,
            }),
        ),
        AgentEvidenceKind::Artifact { path, .. } => {
            ("artifact", path.display().to_string(), Value::Null)
        }
        AgentEvidenceKind::Citation { url, .. } => {
            ("citation", truncate_evidence_subject(url), Value::Null)
        }
        AgentEvidenceKind::Manual { statement, .. } => {
            ("manual", truncate_evidence_subject(statement), Value::Null)
        }
        AgentEvidenceKind::Schema { subject, .. } => {
            ("schema", truncate_evidence_subject(subject), Value::Null)
        }
        AgentEvidenceKind::Visual { artifact_path, .. } => {
            ("visual", artifact_path.display().to_string(), Value::Null)
        }
        AgentEvidenceKind::NotApplicable { requirement, .. } => (
            "not_applicable",
            truncate_evidence_subject(requirement),
            Value::Null,
        ),
    };
    json!({
        "evidence_id": record.evidence_id,
        "agent_id": record.agent_id,
        "kind": kind,
        "subject": subject,
        "detail": detail,
        "recorded_at": record.recorded_at,
    })
}

fn execution_error(tool: &str, error: anyhow::Error) -> ToolError {
    ToolError::Execution(format!("{tool} failed: {error:#}"))
}

fn bind_unbound_active_goal(ctx: &ToolContext, work_id: &str) -> Result<(), ToolError> {
    let should_bind = ctx
        .state
        .goal()
        .is_some_and(|goal| goal.status.is_active() && goal.orchestrate_work_id.is_none());
    if should_bind {
        ctx.state
            .bind_goal_orchestrate_work(Some(work_id))
            .map_err(|error| execution_error("Orchestrate goal binding", error))?;
    }
    Ok(())
}

#[async_trait]
impl Tool for CreateWorkPlanTool {
    fn name(&self) -> String {
        "CreateWorkPlan".to_string()
    }

    fn description(&self) -> String {
        "Create a durable Orchestrate work with a validated immutable plan revision and optional active pointer. The tool chooses an opaque UUIDv4 work_id; it cannot write arbitrary paths. The plan must start with one `# ` title and then contain, in exact order, `## Context`, `## TODOs`, and `## Final Verification Wave`. TODOs use contiguous `- [ ] N.` items, each with exact indented `- artifacts:`, `- write_scope:`, `- acceptance:`, and `- verify:` metadata. Final checks use contiguous `- [ ] FN.` items, each with exactly one indented `- evidence:` line using only comma-separated `process_exit`, `artifact`, `citation`, `manual`, `schema`, `visual`, or `not_applicable`.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CreateWorkPlanInput))
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CreateWorkPlanInput = parse_input(&input)?;
        let snapshot = store(ctx)
            .create_work(
                &input.display_slug,
                &input.plan,
                &ctx.state.session_id(),
                input.select_active,
            )
            .map_err(|error| execution_error("CreateWorkPlan", error))?;
        if input.select_active {
            bind_unbound_active_goal(ctx, &snapshot.work.work_id)?;
        }
        Ok(output_snapshot(snapshot))
    }
}

#[async_trait]
impl Tool for EditWorkPlanTool {
    fn name(&self) -> String {
        "EditWorkPlan".to_string()
    }

    fn description(&self) -> String {
        "CAS-edit the current immutable Orchestrate plan by exact replacement. It validates the complete resulting Markdown and cannot change checkbox state or edit accepted task bodies.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(EditWorkPlanInput))
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: EditWorkPlanInput = parse_input(&input)?;
        store(ctx)
            .edit_plan(
                &input.work_id,
                input.expected_revision,
                &input.old_string,
                &input.new_string,
                input.replace_all,
            )
            .map(output_snapshot)
            .map_err(|error| execution_error("EditWorkPlan", error))
    }
}

#[async_trait]
impl Tool for AppendWorkNotepadTool {
    fn name(&self) -> String {
        "AppendWorkNotepad".to_string()
    }

    fn description(&self) -> String {
        "Append untrusted durable Markdown notes to one fixed notepad of an existing Orchestrate work. Notepad text never counts as trusted evidence.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(AppendWorkNotepadInput))
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: AppendWorkNotepadInput = parse_input(&input)?;
        store(ctx)
            .append_notepad(&input.work_id, &input.name, &input.content)
            .map(|path| {
                ToolOutput::text(format!("Orchestrate notepad updated: {}", path.display()))
            })
            .map_err(|error| execution_error("AppendWorkNotepad", error))
    }
}

#[async_trait]
impl Tool for RecordTaskAcceptanceTool {
    fn name(&self) -> String {
        "RecordTaskAcceptance".to_string()
    }

    fn description(&self) -> String {
        "Atomically record all four acceptance checks and trusted evidence references, then mark exactly one plan task complete using expected_revision CAS. This creates a new revision; when one verification wave supports multiple incomplete tasks, use RecordTaskAcceptances once so the remaining evidence does not become stale after the first checkbox update.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(RecordTaskAcceptanceInput))
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: RecordTaskAcceptanceInput = parse_input(&input)?;
        let work_id = input.work_id.clone();
        let task_key = input.task_key.clone();
        let result = store(ctx).record_acceptance(
            &input.work_id,
            input.expected_revision,
            AcceptanceRecord {
                task_key: input.task_key,
                result_digest: input.result_digest,
                evidence_ids: input.evidence_ids,
                works: input.works,
                conforms: input.conforms,
                matches_contract: input.matches_contract,
                honored_boundaries: input.honored_boundaries,
                accepted_at: chrono::Utc::now(),
            },
        );
        match result {
            Ok(snapshot) => {
                ctx.state.record_orchestrate_runtime_event_after_commit(
                    "plan_task_accepted",
                    Some(&work_id),
                    Some(&task_key),
                    None,
                    None,
                    serde_json::json!({"revision": snapshot.work.revision}),
                );
                Ok(output_snapshot(snapshot))
            }
            Err(error) => Err(execution_error("RecordTaskAcceptance", error)),
        }
    }
}

#[async_trait]
impl Tool for RecordTaskAcceptancesTool {
    fn name(&self) -> String {
        "RecordTaskAcceptances".to_string()
    }

    fn description(&self) -> String {
        "Atomically accept one or more plan tasks in a single expected_revision CAS. Use this whenever evidence from the same verification wave supports multiple tasks: every acceptance is validated first, all referenced evidence must belong to the current revision, and either every checkbox changes together or none changes.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(RecordTaskAcceptancesInput))
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: RecordTaskAcceptancesInput = parse_input(&input)?;
        let work_id = input.work_id.clone();
        let task_keys = input
            .acceptances
            .iter()
            .map(|acceptance| acceptance.task_key.clone())
            .collect::<Vec<_>>();
        let records = input
            .acceptances
            .into_iter()
            .map(TaskAcceptanceInput::into_record)
            .collect();
        let snapshot = store(ctx)
            .record_acceptances(&work_id, input.expected_revision, records)
            .map_err(|error| execution_error("RecordTaskAcceptances", error))?;
        for task_key in task_keys {
            ctx.state.record_orchestrate_runtime_event_after_commit(
                "plan_task_accepted",
                Some(&work_id),
                Some(&task_key),
                None,
                None,
                serde_json::json!({
                    "revision": snapshot.work.revision,
                    "batch": true,
                }),
            );
        }
        Ok(output_snapshot(snapshot))
    }
}

#[async_trait]
impl Tool for ReopenTaskTool {
    fn name(&self) -> String {
        "ReopenTask".to_string()
    }

    fn description(&self) -> String {
        "Atomically remove a task acceptance and reopen its checkbox with an explicit reason and expected_revision CAS.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(ReopenTaskInput))
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ReopenTaskInput = parse_input(&input)?;
        let work_id = input.work_id.clone();
        let task_key = input.task_key.clone();
        let result = store(ctx).reopen_task(
            &input.work_id,
            input.expected_revision,
            &input.task_key,
            &input.reason,
        );
        match result {
            Ok(snapshot) => {
                ctx.state.record_orchestrate_runtime_event_after_commit(
                    "plan_task_rejected",
                    Some(&work_id),
                    Some(&task_key),
                    None,
                    None,
                    serde_json::json!({
                        "revision": snapshot.work.revision,
                        "reason_sha256": format!("{:x}", sha2::Sha256::digest(input.reason.as_bytes())),
                    }),
                );
                Ok(output_snapshot(snapshot))
            }
            Err(error) => Err(execution_error("ReopenTask", error)),
        }
    }
}

#[async_trait]
impl Tool for SelectActiveWorkTool {
    fn name(&self) -> String {
        "SelectActiveWork".to_string()
    }

    fn description(&self) -> String {
        "Select one existing healthy Orchestrate work as the explicit active work pointer."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SelectActiveWorkInput))
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SelectActiveWorkInput = parse_input(&input)?;
        store(ctx)
            .select_active_work(&input.work_id)
            .map_err(|error| execution_error("SelectActiveWork", error))?;
        bind_unbound_active_goal(ctx, &input.work_id)?;
        Ok(ToolOutput::text(format!(
            "Active Orchestrate work: {}",
            input.work_id
        )))
    }
}

#[async_trait]
impl Tool for PlanProgressTool {
    fn name(&self) -> String {
        "PlanProgress".to_string()
    }

    fn description(&self) -> String {
        "Read and verify the current manifest, plan digest, revision, status, and progress for a work_id or the explicit active work. Also returns compact current_revision_evidence entries with the exact evidence_id values accepted by RecordTaskAcceptance(s), so callers never need to discover or parse evidence.jsonl manually.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(PlanProgressInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: PlanProgressInput = parse_input(&input)?;
        let store = store(ctx);
        let result = match input.work_id {
            Some(work_id) => store.read_work(&work_id),
            None => store.read_active_work(),
        };
        let snapshot = result.map_err(|error| execution_error("PlanProgress", error))?;
        let evidence = store
            .read_evidence(&snapshot.work.work_id)
            .map_err(|error| execution_error("PlanProgress evidence", error))?;
        let current_revision_evidence = evidence
            .records
            .iter()
            .filter(|record| record.revision == snapshot.work.revision)
            .map(evidence_summary)
            .collect::<Vec<_>>();
        Ok(ToolOutput::text(
            serde_json::to_string_pretty(&json!({
                "work_id": snapshot.work.work_id,
                "display_slug": snapshot.work.display_slug,
                "revision": snapshot.work.revision,
                "plan_sha256": snapshot.work.plan_sha256,
                "status": snapshot.work.status,
                "progress": snapshot.work.progress,
                "current_revision_evidence": current_revision_evidence,
                "evidence_store_degraded": evidence.degraded_trailing_record,
            }))
            .expect("serializing PlanProgress result cannot fail"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> String {
        "# P\n\n## Context\nC\n\n## TODOs\n- [ ] 1. T\n  - artifacts: a\n  - write_scope: a\n  - acceptance: a\n  - verify: a\n\n## Final Verification Wave\n- [ ] F1. V\n  - evidence: manual\n"
            .to_string()
    }

    #[test]
    fn progress_is_the_only_concurrency_safe_planstore_tool() {
        assert!(PlanProgressTool.is_concurrency_safe(&json!({})));
        assert!(!CreateWorkPlanTool.is_concurrency_safe(&json!({})));
        assert!(!EditWorkPlanTool.is_concurrency_safe(&json!({})));
        assert!(!AppendWorkNotepadTool.is_concurrency_safe(&json!({})));
        assert!(!RecordTaskAcceptancesTool.is_concurrency_safe(&json!({})));
    }

    #[test]
    fn schemas_never_accept_a_filesystem_root() {
        for schema in [
            CreateWorkPlanTool.input_schema(),
            EditWorkPlanTool.input_schema(),
            AppendWorkNotepadTool.input_schema(),
            RecordTaskAcceptanceTool.input_schema(),
            RecordTaskAcceptancesTool.input_schema(),
            ReopenTaskTool.input_schema(),
            SelectActiveWorkTool.input_schema(),
            PlanProgressTool.input_schema(),
        ] {
            let properties = schema["properties"].as_object().unwrap();
            assert!(!properties.contains_key("root"));
            assert!(!properties.contains_key("path"));
        }
    }

    #[tokio::test]
    async fn creating_active_work_binds_an_existing_unbound_goal_but_never_rebinds() {
        let temp = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(temp.path());
        state.enter_orchestrate_before_first_message().unwrap();
        state.set_goal("ship", None);
        let ctx = ToolContext::new(state.clone());

        CreateWorkPlanTool
            .call(
                json!({"display_slug": "first", "plan": plan(), "select_active": true}),
                &ctx,
            )
            .await
            .unwrap();
        let first = state
            .goal()
            .and_then(|goal| goal.orchestrate_work_id)
            .expect("goal should bind to the first active work");

        let second_output = CreateWorkPlanTool
            .call(
                json!({"display_slug": "second", "plan": plan(), "select_active": false}),
                &ctx,
            )
            .await
            .unwrap();
        let second: serde_json::Value = serde_json::from_str(&match &second_output.content[0] {
            kcoder_types::ContentBlock::Text { text } => text.clone(),
            _ => panic!("expected text"),
        })
        .unwrap();
        SelectActiveWorkTool
            .call(json!({"work_id": second["work_id"]}), &ctx)
            .await
            .unwrap();

        assert_ne!(first, second["work_id"].as_str().unwrap());
        assert_eq!(
            state.goal().unwrap().orchestrate_work_id.as_deref(),
            Some(first.as_str())
        );
    }

    #[tokio::test]
    async fn plan_progress_lists_compact_current_revision_evidence_ids() {
        use kcoder_state::orchestrate_store::{AgentEvidence, AgentEvidenceKind};

        let temp = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(temp.path());
        let ctx = ToolContext::new(state);
        let created = store(&ctx)
            .create_work("evidence", &plan(), "session-a", true)
            .unwrap();
        let saved = store(&ctx)
            .append_evidence(
                &created.work.work_id,
                AgentEvidence {
                    evidence_id: String::new(),
                    work_id: created.work.work_id.clone(),
                    revision: created.work.revision,
                    plan_sha256: created.work.plan_sha256.clone(),
                    agent_id: "verifier-a".to_string(),
                    workspace_digest: "digest".to_string(),
                    recorded_at: chrono::Utc::now(),
                    evidence: AgentEvidenceKind::ProcessExit {
                        tool: "bash".to_string(),
                        command: format!("pytest {}", "x".repeat(300)),
                        exit_code: Some(0),
                        signal: None,
                        cwd: temp.path().to_path_buf(),
                        raw_exit_code: true,
                    },
                },
            )
            .unwrap();

        let output = PlanProgressTool
            .call(json!({"work_id": created.work.work_id}), &ctx)
            .await
            .unwrap();
        let text = output
            .content
            .iter()
            .find_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text),
                _ => None,
            })
            .unwrap();
        let value: Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            value["current_revision_evidence"][0]["evidence_id"],
            saved.evidence_id
        );
        assert_eq!(
            value["current_revision_evidence"][0]["detail"]["exit_code"],
            0
        );
        assert!(
            value["current_revision_evidence"][0]["subject"]
                .as_str()
                .unwrap()
                .ends_with('…')
        );
    }
}
