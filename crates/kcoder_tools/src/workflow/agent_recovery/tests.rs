//! Actual private Store/journal/State records, not proof of manager dispatch.
use super::*;
use kcoder_types::{BackgroundEventIdentity, workflow::*};
struct Unused;
#[async_trait]
impl AgentRunner for Unused {
    async fn run_agent(&self, _: String, _: usize) -> Result<String, crate::AgentError> {
        panic!("witness validation cannot execute a model")
    }
}
fn limits() -> WorkflowRunLimits {
    WorkflowRunLimits {
        max_concurrency: 2,
        max_agent_turns: 2,
        timeout_seconds: 20,
        unresolved_execution_limits: 0,
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    executor: ToolAgentExecutor,
    parent: AppState,
    owner: BackgroundRunKey,
    request: AgentRequest,
    prompt: String,
    options: AgentRunOptions,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        PrivateDirectory::open_or_create(temp.path()).unwrap();
        let parent = AppState::new(temp.path());
        parent.with_history_path(temp.path().join("parent.jsonl"));
        let library = kcoder_workflow::store::WorkflowStore::new(temp.path().join("library"));
        let draft = library.create("Original fixed definition", "").unwrap();
        let node:WorkflowNode=serde_json::from_value(json!({"id":"review","title":"Review","kind":"agent","prompt":"Readonly review","agentType":"review","maxTurns":2,"dependsOn":[],"position":{"x":0,"y":0},"allowedWritePaths":[],"acceptanceCriteria":[],"expectedArtifacts":[]})).unwrap();
        let applied = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
        let definition = library.save(&draft.id, applied.revision).unwrap();
        let bytes = serde_json::to_vec(&definition).unwrap();
        let run_dir = temp.path().join("runs/original-run");
        let store = WorkflowRunStore::create(
            run_dir.clone(),
            "original-run".into(),
            "Original".into(),
            "library".into(),
            "unused",
            &json!({"brief":"original"}),
            limits(),
        )
        .unwrap();
        let directory = PrivateDirectory::open_existing(&run_dir).unwrap();
        directory
            .atomic_replace(OsStr::new("definition.json"), &bytes)
            .unwrap();
        store.state.lock().unwrap().definition_sha256 = Some(digest(&bytes));
        store.persist_state().unwrap();
        let prompt = "Actual original readonly prompt".to_owned();
        let request = AgentRequest {
            model_selection: None,
            artifact_requirements: vec![],
            output_repair_only: false,
            prompt: "Readonly review".into(),
            agent_type: "review".into(),
            max_turns: 2,
            allowed_write_paths: vec![],
            acceptance_criteria: vec![],
            expected_artifacts: vec![],
            context_paths: vec![],
            out_of_scope: vec![],
            verification: vec![],
        };
        let mut root_task = Task::new("original-run", "Original Workflow");
        root_task.managed = true;
        root_task.kind = TaskKind::Workflow;
        root_task.delivery = TaskDelivery::Background;
        let original_owner = parent.start_background_task_run(root_task.clone()).unwrap();
        let mut child = Task::new("original-child", &prompt);
        child.managed = true;
        child.kind = TaskKind::Subagent;
        child.delivery = TaskDelivery::Foreground;
        child.parent_session_id = Some(parent.session_id());
        child.agent_kind = Some("review".into());
        child.max_turns = Some(2);
        let previous = parent.start_background_task_run(child).unwrap();
        store.record(WorkflowEvent::NodeStarted {
            node_id: "review".into(),
            iteration: None,
            attempt: 0,
            agent_id: Some(previous.agent_id.clone()),
        });
        store.record(WorkflowEvent::AgentStarted {
            agent_id: previous.agent_id.clone(),
            request: request.clone(),
        });
        store.record(WorkflowEvent::AgentFailed {
            agent_id: previous.agent_id.clone(),
            error: "owned fault".into(),
        });
        store.record(WorkflowEvent::NodeFailed {
            node_id: "review".into(),
            iteration: None,
            attempt: 0,
            agent_id: Some(previous.agent_id.clone()),
            error: "owned fault".into(),
            will_retry: false,
        });
        parent
            .commit_background_terminal(
                &BackgroundEventIdentity::terminal(previous.clone()),
                TaskStatus::Failed,
                None,
            )
            .unwrap();
        parent
            .commit_background_terminal(
                &BackgroundEventIdentity::terminal(original_owner),
                TaskStatus::Failed,
                None,
            )
            .unwrap();
        store.finish(Err("owned fault".into())).unwrap();
        store
            .begin_resume(&json!({"brief":"original"}), limits())
            .unwrap();
        let owner = parent.start_background_task_run(root_task).unwrap();
        store.record(WorkflowEvent::NodeStarted {
            node_id: "review".into(),
            iteration: None,
            attempt: 0,
            agent_id: Some(previous.agent_id.clone()),
        });
        store.record(WorkflowEvent::AgentStarted {
            agent_id: previous.agent_id.clone(),
            request: request.clone(),
        });
        let mut options = AgentRunOptions::with_allowed_write_paths(vec![]);
        options.context_mode = crate::SubagentContextMode::None;
        let cancellation = CancellationToken::new();
        let executor = ToolAgentExecutor {
            require_checkpoint_match: false,
            require_legacy_agent_request: false,
            verification_store: Some(store),
            isolate_context: true,
            pinned_model: None,
            native_parent_state: Some(parent.clone()),
            collaboration_artifacts: None,
            runner: Arc::new(Unused),
            arrangement_mode: false,
            resume_run_dir: None,
            checkpoint_run_dir: Some(run_dir.clone()),
            tool_run_dir: Some(run_dir),
            library_root: None,
            wait_root: None,
            run_id: "original-run".into(),
            cancellation,
        };
        Self {
            _temp: temp,
            executor,
            parent,
            owner,
            request,
            prompt,
            options,
        }
    }
    fn proof(&self) -> Arc<WorkflowAgentRecovery> {
        capture(
            &self.executor,
            "original-child",
            &self.request,
            &self.prompt,
            AgentKind::Review,
            &self.options,
        )
        .unwrap()
        .unwrap()
    }
    fn verify(&self, proof: &WorkflowAgentRecovery) -> Result<(), String> {
        proof.verify_restart(
            &self.parent,
            &self.owner,
            "original-child",
            &self.prompt,
            2,
            AgentKind::Review,
            &self.options,
        )
    }
}
#[test]
fn stored_resume_witness_binds_original_journal_definition_and_native_terminal() {
    let f = Fixture::new();
    let proof = f.proof();
    assert!(f.verify(&proof).is_ok());
    assert_eq!(proof.previous_child_run().agent_id, "original-child");
    assert!(
        f.parent
            .background_run_record(proof.previous_child_run())
            .unwrap()
            .terminal
            .is_some()
    );
    assert_eq!(
        format!("{proof:?}"),
        "WorkflowAgentRecovery { native_store: bound }"
    );
}
#[test]
fn owner_state_run_prompt_role_and_empty_allowlist_cannot_be_substituted() {
    let f = Fixture::new();
    let proof = f.proof();
    let other = tempfile::tempdir().unwrap();
    let other = AppState::new(other.path());
    assert!(
        proof
            .verify_restart(
                &other,
                &f.owner,
                "original-child",
                &f.prompt,
                2,
                AgentKind::Review,
                &f.options
            )
            .is_err()
    );
    let changed = BackgroundRunKey {
        run_id: "other-native-owner".into(),
        ..f.owner.clone()
    };
    assert!(
        proof
            .verify_restart(
                &f.parent,
                &changed,
                "original-child",
                &f.prompt,
                2,
                AgentKind::Review,
                &f.options
            )
            .is_err()
    );
    assert!(
        proof
            .verify_restart(
                &f.parent,
                &f.owner,
                "original-child",
                "changed prompt",
                2,
                AgentKind::Review,
                &f.options
            )
            .is_err()
    );
    assert!(
        proof
            .verify_restart(
                &f.parent,
                &f.owner,
                "original-child",
                &f.prompt,
                3,
                AgentKind::Review,
                &f.options
            )
            .is_err()
    );
    assert!(
        proof
            .verify_restart(
                &f.parent,
                &f.owner,
                "original-child",
                &f.prompt,
                2,
                AgentKind::General,
                &f.options
            )
            .is_err()
    );
    let mut narrowed = f.options.clone();
    narrowed.tool_allowlist = Some(vec![]);
    assert!(
        proof
            .verify_restart(
                &f.parent,
                &f.owner,
                "original-child",
                &f.prompt,
                2,
                AgentKind::Review,
                &narrowed
            )
            .is_err()
    );
}
#[test]
fn cancelled_changed_definition_and_replaced_journal_never_revive_a_proof() {
    for change in ["cancelled", "definition", "journal", "completed"] {
        let f = Fixture::new();
        let proof = f.proof();
        let root = f.executor.tool_run_dir.as_ref().unwrap();
        match change {
            "cancelled" => f.executor.cancellation.cancel(),
            "definition" => std::fs::write(root.join("definition.json"), b"{}").unwrap(),
            "journal" => std::fs::write(root.join("journal.jsonl"), b"{}\n").unwrap(),
            "completed" => f
                .parent
                .update_task("original-child", |task| task.status = TaskStatus::Completed)
                .unwrap(),
            _ => unreachable!(),
        }
        assert!(f.verify(&proof).is_err(), "{change}");
    }
}
#[test]
fn peer_request_change_and_nonresume_do_not_create_original_recovery_authority() {
    let mut f = Fixture::new();
    let mut changed = f.request.clone();
    changed.prompt.push_str(" peer edit");
    assert!(
        capture(
            &f.executor,
            "original-child",
            &changed,
            &f.prompt,
            AgentKind::Review,
            &f.options
        )
        .is_err()
    );
    f.executor.checkpoint_run_dir = None;
    assert!(
        capture(
            &f.executor,
            "original-child",
            &f.request,
            &f.prompt,
            AgentKind::Review,
            &f.options
        )
        .unwrap()
        .is_none()
    );
}
