#[path = "recovery_tests.rs"]
mod recovery_tests;

#[test]
fn source_selection_schema_rejects_empty_ambiguous_and_orphan_inputs() {
    use crate::Tool;
    let schema = super::WorkflowTool.input_schema();
    for input in [
        serde_json::json!({}),
        serde_json::json!({"args_json":"{}"}),
        serde_json::json!({"definition_id":"saved"}),
        serde_json::json!({"script":"return 1;","resume":"run-1"}),
        serde_json::json!({"script":"return 1;","version":1}),
        serde_json::json!({"script":"return 1;","args":{},"args_json":"{}"}),
    ] {
        assert!(
            kcoder_workflow::graph::validate_data(&schema, &input).is_err(),
            "{input}"
        );
    }
    for input in [
        serde_json::json!({"definition_id":"saved","version":1,"args_json":"{}"}),
        serde_json::json!({"script":"return args;","args":{"n":2}}),
        serde_json::json!({"resume":"run-1"}),
        serde_json::json!({"name":"project"}),
    ] {
        kcoder_workflow::graph::validate_data(&schema, &input).unwrap();
    }
    assert!(
        crate::input_schema::example_input_for_schema(&schema).is_none(),
        "do not suggest the invalid empty object as a complete call"
    );
}

use super::*;
use crate::background::BackgroundJobEvent;
use crate::{AgentError, BackgroundJobSpawner, SpawnError};
use kcoder_state::{AppState, Task, TaskKind, TaskStatus};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use tokio::sync::broadcast;

#[test]
fn rejects_unsafe_names_and_paths() {
    assert!(validate_workflow_name("review-changes_2").is_ok());
    assert!(validate_workflow_name("../escape").is_err());
    assert!(ensure_workspace_path(Path::new("/tmp/work/a.js"), Path::new("/tmp/work")).is_ok());
    assert!(ensure_workspace_path(Path::new("/tmp/escape.js"), Path::new("/tmp/work")).is_err());
}

#[cfg(windows)]
#[test]
fn workspace_path_containment_is_case_insensitive_on_windows() {
    assert!(
        ensure_workspace_path(
            Path::new(r"C:\WorkSpace\scripts\review.js"),
            Path::new(r"c:\workspace"),
        )
        .is_ok()
    );
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn secure_script_read_rejects_symlink_escape() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let outside = temp.path().join("outside.js");
    fs::write(&outside, "return 'outside';").unwrap();
    let link = workspace.join("escape.js");
    #[cfg(target_os = "linux")]
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&outside, &link).unwrap();

    assert!(securely_read_workspace_file(&link, &workspace).is_err());
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn artifact_io_does_not_follow_file_or_parent_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let run_dir = temp.path().join("run");
    secure_create_dir(&run_dir).unwrap();
    let outside = temp.path().join("outside.txt");
    fs::write(&outside, "outside").unwrap();
    let linked_file = run_dir.join("state.json");
    #[cfg(target_os = "linux")]
    std::os::unix::fs::symlink(&outside, &linked_file).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&outside, &linked_file).unwrap();

    assert!(secure_read_file(&linked_file, 1024).is_err());
    assert!(secure_append_file(&linked_file, b"-escaped").is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
    atomic_write_file(&linked_file, b"inside").unwrap();
    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
    assert_eq!(fs::read_to_string(&linked_file).unwrap(), "inside");

    let outside_dir = temp.path().join("outside-dir");
    fs::create_dir(&outside_dir).unwrap();
    let linked_dir = run_dir.join("agents");
    #[cfg(target_os = "linux")]
    std::os::unix::fs::symlink(&outside_dir, &linked_dir).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&outside_dir, &linked_dir).unwrap();
    assert!(secure_create_dir(&linked_dir.join("nested")).is_err());
    assert!(!outside_dir.join("nested").exists());
    assert!(atomic_write_file(&linked_dir.join("escaped"), b"no").is_err());
    assert!(!outside_dir.join("escaped").exists());
}

#[test]
fn cache_requires_atomic_completion_marker() {
    let temp = tempfile::tempdir().unwrap();
    let agent_dir = temp.path().join("agent");
    secure_create_dir(&agent_dir).unwrap();
    let request = AgentRequest {
        output_repair_only: false,
        prompt: "review".to_string(),
        agent_type: "review".to_string(),
        max_turns: 4,
        allowed_write_paths: Vec::new(),
        acceptance_criteria: Vec::new(),
        expected_artifacts: Vec::new(),
        context_paths: Vec::new(),
        out_of_scope: Vec::new(),
        verification: Vec::new(),
    };
    atomic_write_file(
        &agent_dir.join("request.json"),
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
    atomic_write_file(&agent_dir.join("output.md"), b"partial").unwrap();
    assert!(!cached_agent_request_matches(&agent_dir, &request));
    atomic_write_file(&agent_dir.join("completed"), b"ok\n").unwrap();
    assert!(cached_agent_request_matches(&agent_dir, &request));
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn saved_arguments_are_schema_aware_and_respect_coercion_options() {
    let temp = tempfile::tempdir().unwrap();
    let store = kcoder_workflow::store::WorkflowStore::new(temp.path().join("library"));
    let mut definition = store.create("Args", "").unwrap();
    definition.input_schema = Some(
        json!({"type":"object","required":["count"],"properties":{"count":{"type":"integer"},"label":{"type":"string","default":"test"}},"additionalProperties":false}),
    );
    let encoded = json!("{\"count\":3}");
    assert_eq!(
        prepare_model_arguments(
            &definition,
            &mut encoded.clone(),
            &crate::CoercionOptions::default()
        )
        .unwrap(),
        json!({"count":3,"label":"test"})
    );
    let scalar = json!("{\"count\":\"3\"}");
    assert!(
        prepare_model_arguments(
            &definition,
            &mut scalar.clone(),
            &crate::CoercionOptions::strict()
        )
        .is_err()
    );
    assert_eq!(
        prepare_model_arguments(
            &definition,
            &mut scalar.clone(),
            &crate::CoercionOptions::default()
        )
        .unwrap()["count"],
        3
    );
    assert!(
        prepare_model_arguments(
            &definition,
            &mut json!("{broken}"),
            &crate::CoercionOptions::default()
        )
        .is_err()
    );
    let mut missing = json!("{\"label\":\"provided\"}");
    assert!(
        prepare_model_arguments(
            &definition,
            &mut missing,
            &crate::CoercionOptions::default()
        )
        .is_err()
    );
    assert_eq!(missing, json!({"label":"provided"}));
    definition.input_schema = Some(json!({"type":"string"}));
    assert_eq!(
        prepare_model_arguments(
            &definition,
            &mut encoded.clone(),
            &crate::CoercionOptions::default()
        )
        .unwrap(),
        encoded
    );
    definition.input_schema = None;
    assert_eq!(
        prepare_model_arguments(
            &definition,
            &mut encoded.clone(),
            &crate::CoercionOptions::default()
        )
        .unwrap(),
        encoded
    );
}

#[tokio::test]
async fn resume_lease_is_exclusive_and_released_on_drop() {
    let temp = tempfile::tempdir().unwrap();
    let run_dir = temp.path().join("workflow-test");
    secure_create_dir(&run_dir).unwrap();
    let first = try_acquire_resume_lease(&run_dir).unwrap();
    assert!(try_acquire_resume_lease(&run_dir).is_err());
    drop(first);
    acquire_resume_lease(&run_dir)
        .await
        .expect("lease owner drop 后应在有界等待内重新获取");
}

#[cfg(any(target_os = "linux", windows))]
#[tokio::test]
async fn initial_run_does_not_ignore_resume_lease_conflict() {
    let temp = tempfile::tempdir().unwrap();
    let run_dir = temp.path().join("workflow-test");
    secure_create_dir(&run_dir).unwrap();
    let _resume = try_acquire_resume_lease(&run_dir).unwrap();

    let error = match acquire_initial_resume_lease(&run_dir).await {
        Err(error) => error,
        Ok(_) => panic!("initial run must not ignore a conflicting resume lease"),
    };

    assert!(
        error
            .to_string()
            .contains("workflow resume is already being prepared or is running"),
        "{error}"
    );
}

#[cfg(any(target_os = "linux", windows))]
#[tokio::test]
async fn resume_lease_waits_for_a_finishing_owner() {
    let temp = tempfile::tempdir().unwrap();
    let run_dir = temp.path().join("workflow-test");
    secure_create_dir(&run_dir).unwrap();
    let lease = try_acquire_resume_lease(&run_dir).unwrap();
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(lease);
    });

    let next = acquire_resume_lease(&run_dir)
        .await
        .expect("完成中的 workflow 应在有界等待后释放 lease");
    release.await.unwrap();
    drop(next);
}

#[test]
fn loop_iteration_completion_does_not_complete_the_outer_node() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("observations");
    let store = WorkflowRunStore::create(
        temp.path().join("workflow-loop"),
        "workflow-loop".into(),
        "loop".into(),
        "inline".into(),
        "return null;",
        &Value::Null,
        WorkflowRunLimits {
            max_concurrency: 1,
            ..Default::default()
        },
    )
    .unwrap();
    *store.observation.lock().unwrap() = Some(
        crate::workflow_runs::RunObservation::start(
            root.clone(),
            kcoder_types::workflow_runs::WorkflowRunSnapshot {
                revision: 1,
                run_id: "workflow-loop".into(),
                definition_id: None,
                version: None,
                thread_id: "thread".into(),
                workspace: "owned".into(),
                status: "running".into(),
                error: None,
                started_at_ms: 1,
                updated_at_ms: 1,
                resume_count: 0,
                interaction_modified: false,
                node_states: vec![],
            },
        )
        .unwrap(),
    );
    store.record(WorkflowEvent::NodeStarted {
        node_id: "loop".into(),
        iteration: None,
        attempt: 0,
        agent_id: None,
    });
    store.record(WorkflowEvent::NodeStarted {
        node_id: "loop".into(),
        iteration: Some(0),
        attempt: 0,
        agent_id: Some("agent".into()),
    });
    store.record(WorkflowEvent::NodeCompleted {
        node_id: "loop".into(),
        iteration: Some(0),
        attempt: 0,
        agent_id: Some("agent".into()),
        output: json!("iteration done"),
    });
    let active = crate::workflow_runs::read(root.clone(), "workflow-loop").unwrap();
    assert_eq!(active.node_states[0].status, "running");
    assert_eq!(
        active.node_states[0].iteration_status.as_deref(),
        Some("completed")
    );
    assert!(active.node_states[0].finished_at_ms.is_none());
    store.record(WorkflowEvent::NodeCompleted {
        node_id: "loop".into(),
        iteration: None,
        attempt: 0,
        agent_id: None,
        output: json!(["iteration done"]),
    });
    assert_eq!(
        crate::workflow_runs::read(root, "workflow-loop")
            .unwrap()
            .node_states[0]
            .status,
        "completed"
    );
}

#[test]
fn rejected_repair_outputs_are_not_reused_but_original_outputs_are() {
    let temp = tempfile::tempdir().unwrap();
    let run_dir = temp.path().join("workflow-repair");
    let store = WorkflowRunStore::create(
        run_dir.clone(),
        "workflow-repair".into(),
        "repair".into(),
        "inline".into(),
        "return null;",
        &Value::Null,
        WorkflowRunLimits {
            max_concurrency: 1,
            ..Default::default()
        },
    )
    .unwrap();
    for (id, repair) in [("original", false), ("repair", true)] {
        let request:AgentRequest=serde_json::from_value(json!({"prompt":"output","agent_type":"general","max_turns":1,"output_repair_only":repair})).unwrap();
        store.record(WorkflowEvent::AgentStarted {
            agent_id: id.into(),
            request: request.clone(),
        });
        store.record(WorkflowEvent::AgentCompleted {
            agent_id: id.into(),
            output: "invalid json".into(),
        });
        let dir = run_dir.join("agents").join(id);
        assert!(cached_agent_request_matches(&dir, &request));
        store.record(WorkflowEvent::NodeFailed {
            node_id: "n".into(),
            iteration: None,
            attempt: 1,
            agent_id: Some(id.into()),
            error: "schema invalid".into(),
            will_retry: true,
        });
        assert_eq!(cached_agent_request_matches(&dir, &request), !repair);
    }
}

#[test]
fn concurrent_events_keep_journal_and_state_valid() {
    let temp = tempfile::tempdir().unwrap();
    let run_dir = temp.path().join("workflow-test");
    let store = WorkflowRunStore::create(
        run_dir.clone(),
        "workflow-test".to_string(),
        "parallel".to_string(),
        "inline".to_string(),
        "return null;",
        &Value::Null,
        WorkflowRunLimits {
            max_concurrency: 4,
            ..Default::default()
        },
    )
    .unwrap();
    let mut threads = Vec::new();
    for worker in 0..8 {
        let store = Arc::clone(&store);
        threads.push(std::thread::spawn(move || {
            for event in 0..100 {
                store.record(WorkflowEvent::Log {
                    message: format!("{worker}:{event}"),
                });
            }
        }));
    }
    for thread in threads {
        thread.join().unwrap();
    }

    let journal = fs::read_to_string(run_dir.join("journal.jsonl")).unwrap();
    assert_eq!(journal.lines().count(), 801);
    for line in journal.lines() {
        serde_json::from_str::<Value>(line).unwrap();
    }
    let state: WorkflowRunState =
        serde_json::from_slice(&fs::read(run_dir.join("state.json")).unwrap()).unwrap();
    assert_eq!(state.event_count, 800);
}

#[test]
fn runtime_cancellation_persists_cancelled_terminal_state() {
    let temp = tempfile::tempdir().unwrap();
    let run_dir = temp.path().join("workflow-cancelled");
    let store = WorkflowRunStore::create(
        run_dir.clone(),
        "workflow-cancelled".to_string(),
        "cancelled".to_string(),
        "inline".to_string(),
        "return null;",
        &Value::Null,
        WorkflowRunLimits {
            max_concurrency: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let task_state = AppState::new(temp.path());
    let mut task = Task::new("workflow-cancelled", "cancelled workflow");
    task.kind = TaskKind::Workflow;
    task.status = TaskStatus::Running;
    task_state.upsert_task(task);

    let output = finish_workflow_result(
        &store,
        &task_state,
        "workflow-cancelled",
        Err(WorkflowError::Cancelled),
    );

    assert!(output.is_error);
    let state: WorkflowRunState =
        serde_json::from_slice(&fs::read(run_dir.join("state.json")).unwrap()).unwrap();
    assert_eq!(state.status, "cancelled");
    assert_eq!(
        task_state.task("workflow-cancelled").unwrap().status,
        TaskStatus::Cancelled
    );
    let persisted: Value =
        serde_json::from_slice(&fs::read(run_dir.join("output.json")).unwrap()).unwrap();
    assert_eq!(persisted["status"], "cancelled");
}

#[test]
fn preview_is_unicode_safe() {
    assert_eq!(preview("你好世界", 2), "你好...");
    assert_eq!(preview("你好", 2), "你好");
}

#[derive(Default)]
struct RecordingRunner(
    Mutex<Vec<String>>,
    Mutex<Vec<String>>,
    Mutex<Vec<Option<Vec<String>>>>,
    Mutex<Vec<crate::SubagentContextMode>>,
);

#[async_trait]
impl AgentRunner for RecordingRunner {
    async fn run_agent(&self, prompt: String, _max_turns: usize) -> Result<String, AgentError> {
        Ok(format!("done:{prompt}"))
    }

    async fn run_agent_session_with_options(
        &self,
        agent_id: String,
        prompt: String,
        _max_turns: usize,
        _agent_kind: crate::AgentKind,
        options: AgentRunOptions,
    ) -> Result<String, AgentError> {
        self.0.lock().unwrap().push(agent_id);
        self.1.lock().unwrap().push(prompt);
        self.2.lock().unwrap().push(options.tool_allowlist);
        self.3.lock().unwrap().push(options.context_mode);
        Ok("agent result".to_string())
    }
}

struct ExecutingWorkflowManager {
    state: AppState,
    tx: broadcast::Sender<BackgroundJobEvent>,
    handles: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

struct FailingResumeManager {
    tx: broadcast::Sender<BackgroundJobEvent>,
}

impl FailingResumeManager {
    fn new() -> Self {
        let (tx, _) = broadcast::channel(4);
        Self { tx }
    }
}

impl BackgroundJobSpawner for FailingResumeManager {
    fn spawn(
        &self,
        _description: String,
        _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        _max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        Err(SpawnError::TooManyConcurrent {
            running: 1,
            limit: 1,
        })
    }

    fn respawn_workflow(
        &self,
        _id: String,
        _description: String,
        _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        _max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        Err(SpawnError::TooManyConcurrent {
            running: 1,
            limit: 1,
        })
    }

    fn subscribe(&self) -> broadcast::Receiver<BackgroundJobEvent> {
        self.tx.subscribe()
    }

    fn abort(&self, _id: &str) -> bool {
        false
    }
}

impl ExecutingWorkflowManager {
    fn new(state: AppState) -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            state,
            tx,
            handles: Mutex::new(HashMap::new()),
        }
    }

    async fn wait_for_completion(&self, workflow_id: &str) {
        self.wait_for_completion_with_timeout(workflow_id, std::time::Duration::from_secs(5))
            .await;
    }

    async fn wait_for_completion_with_timeout(
        &self,
        workflow_id: &str,
        timeout: std::time::Duration,
    ) {
        let mut handle = self
            .handles
            .lock()
            .unwrap()
            .remove(workflow_id)
            .unwrap_or_else(|| panic!("workflow {workflow_id} has no tracked task"));
        match tokio::time::timeout(timeout, &mut handle).await {
            Ok(result) => {
                result.unwrap_or_else(|error| panic!("workflow {workflow_id} task failed: {error}"))
            }
            Err(_) => {
                handle.abort();
                if tokio::time::timeout(std::time::Duration::from_secs(1), &mut handle)
                    .await
                    .is_err()
                {
                    panic!(
                        "workflow {workflow_id} task timed out and did not terminate after abort"
                    );
                }
                panic!("workflow {workflow_id} task did not finish before timeout; task aborted");
            }
        }
    }
}

impl BackgroundJobSpawner for ExecutingWorkflowManager {
    fn spawn(
        &self,
        _description: String,
        _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        _max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        panic!("workflow test must use spawn_workflow_with_id")
    }

    fn spawn_workflow_with_id(
        &self,
        id: String,
        description: String,
        mut work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        _max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let mut task = Task::new(&id, description);
        task.kind = TaskKind::Workflow;
        task.status = TaskStatus::Running;
        self.state.upsert_task(task);
        let state = self.state.clone();
        let task_id = id.clone();
        let handle = tokio::spawn(async move {
            let output = work.as_mut().await;
            // The workflow future holds the resume lease; drop it before exposing the test task's completion boundary.
            drop(work);
            let mut task = state.task(&task_id).unwrap();
            task.output = Some(
                output
                    .content
                    .iter()
                    .filter_map(|block| {
                        if let kcoder_types::ContentBlock::Text { text } = block {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            task.status = if output.is_error {
                TaskStatus::Failed
            } else {
                TaskStatus::Completed
            };
            state.upsert_task(task);
        });
        assert!(
            self.handles
                .lock()
                .unwrap()
                .insert(id.clone(), handle)
                .is_none(),
            "workflow {id} already has a tracked task"
        );
        Ok(id)
    }

    fn subscribe(&self) -> broadcast::Receiver<BackgroundJobEvent> {
        self.tx.subscribe()
    }

    fn abort(&self, _id: &str) -> bool {
        false
    }
}

async fn wait_for_workflow_status(run_dir: &Path, expected: &str) {
    for _ in 0..200 {
        let status = fs::read(run_dir.join("state.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|state| state["status"].as_str().map(str::to_string));
        if status.as_deref() == Some(expected) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("workflow did not reach status {expected}");
}

#[tokio::test]
async fn graph_nodes_do_not_inherit_the_parent_launch_request() {
    let runner = Arc::new(RecordingRunner::default());
    let executor = ToolAgentExecutor {
        require_checkpoint_match: false,
        require_legacy_agent_request: false,
        verification_store: None,
        isolate_context: true,
        runner: runner.clone(),
        arrangement_mode: false,
        resume_run_dir: None,
        checkpoint_run_dir: None,
        tool_run_dir: None,
        library_root: None,
        wait_root: None,
        run_id: String::new(),
        cancellation: CancellationToken::new(),
    };
    let request: AgentRequest = serde_json::from_value(
        json!({"prompt":"Return node result", "agent_type":"general", "max_turns":2}),
    )
    .unwrap();
    executor.execute("node", request).await.unwrap();
    assert_eq!(
        runner.3.lock().unwrap().as_slice(),
        &[crate::SubagentContextMode::None]
    );
}

#[tokio::test]
async fn graph_output_repair_forces_empty_agent_tool_allowlist() {
    let runner = Arc::new(RecordingRunner::default());
    let executor = ToolAgentExecutor {
        require_checkpoint_match: false,
        require_legacy_agent_request: false,
        verification_store: None,
        isolate_context: false,
        runner: runner.clone(),
        arrangement_mode: false,
        resume_run_dir: None,
        checkpoint_run_dir: None,
        tool_run_dir: None,
        library_root: None,
        wait_root: None,
        run_id: String::new(),
        cancellation: CancellationToken::new(),
    };
    let request:AgentRequest=serde_json::from_value(json!({"prompt":"format only","agent_type":"general","max_turns":1,"output_repair_only":true})).unwrap();
    executor.execute("repair-agent", request).await.unwrap();
    assert_eq!(
        runner.2.lock().unwrap().as_slice(),
        &[Some(Vec::<String>::new())]
    );
}

#[tokio::test]
async fn graph_parallel_nodes_have_durable_independent_run_observations() {
    struct BlockingRunner {
        entered: AtomicU64,
        release: Arc<tokio::sync::Semaphore>,
        outputs: Mutex<HashMap<String, String>>,
    }
    #[async_trait]
    impl AgentRunner for BlockingRunner {
        async fn run_agent(&self, prompt: String, _: usize) -> Result<String, AgentError> {
            Ok(prompt)
        }
        async fn run_agent_session_with_options(
            &self,
            id: String,
            prompt: String,
            _turns: usize,
            _kind: crate::AgentKind,
            _options: AgentRunOptions,
        ) -> Result<String, AgentError> {
            self.entered.fetch_add(1, Ordering::SeqCst);
            let permit = self.release.acquire().await.unwrap();
            permit.forget();
            let output = format!("actual-output:{prompt}");
            self.outputs.lock().unwrap().insert(id, output.clone());
            Ok(output)
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    let library = kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
    let mut def = library.create("parallel", "").unwrap();
    for id in ["left", "right"] {
        def = library
            .upsert_node(
                &def.id,
                def.revision,
                serde_json::from_value(json!({"id":id,"title":id,"prompt":id})).unwrap(),
            )
            .unwrap();
    }
    let def = library.save(&def.id, def.revision).unwrap();
    let state = AppState::new(temp.path());
    let project = profile.join("projects/p");
    fs::create_dir_all(&project).unwrap();
    state.with_history_path(project.join("s.jsonl"));
    let runner = Arc::new(BlockingRunner {
        entered: AtomicU64::new(0),
        release: Arc::new(tokio::sync::Semaphore::new(0)),
        outputs: Mutex::new(HashMap::new()),
    });
    let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
    let abort = CancellationToken::new();
    let ctx = ToolContext::new(state)
        .with_abort_token(abort.clone())
        .with_settings_persistence_path(Some(profile.join("settings.json")))
        .with_agent_runner(runner.clone())
        .with_background_job_manager(manager.clone());
    let out = WorkflowTool
        .call(json!({"definition_id":def.id,"version":1}), &ctx)
        .await
        .unwrap();
    let kcoder_types::ContentBlock::Text { text } = &out.content[0] else {
        panic!("text")
    };
    let reply: Value = serde_json::from_str(text).unwrap();
    let id = reply["run_id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while runner.entered.load(Ordering::SeqCst) != 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let root = profile.join("workflow-runs");
    let active = crate::workflow_runs::read(root.clone(), id).unwrap();
    assert_eq!(active.node_states.len(), 2);
    assert!(active.node_states.iter().all(|n| n.status == "running"));
    assert_ne!(
        active.node_states[0].agent_id,
        active.node_states[1].agent_id
    );
    runner.release.add_permits(2);
    manager.wait_for_completion(id).await;
    let done = crate::workflow_runs::read(root.clone(), id).unwrap();
    assert_eq!(done.status, "completed");
    assert!(done.node_states.iter().all(|n| n.status == "completed"));
    let left = done
        .node_states
        .iter()
        .find(|n| n.node_id == "left")
        .unwrap();
    let expected = runner
        .outputs
        .lock()
        .unwrap()
        .get(left.agent_id.as_ref().unwrap())
        .unwrap()
        .clone();
    assert_eq!(
        crate::workflow_runs::output(root.clone(), id, "left", 0, 65536).unwrap()["text"],
        expected
    );
    let updated = library
        .update_metadata(
            &def.id,
            def.revision,
            "parallel",
            "",
            Some(json!({"type":"object","required":["required_field"]})),
        )
        .unwrap();
    library.save(&updated.id, updated.revision).unwrap();
    let failed = WorkflowTool
        .call(json!({"definition_id":def.id,"version":2,"args":{}}), &ctx)
        .await
        .unwrap();
    let kcoder_types::ContentBlock::Text { text } = &failed.content[0] else {
        panic!("text")
    };
    let failed: Value = serde_json::from_str(text).unwrap();
    assert_eq!(failed["status"], "needs_input");
    assert!(failed.get("run_id").is_none());
    assert_eq!(failed["missing_fields"][0]["name"], "required_field");
    assert_eq!(runner.entered.load(Ordering::SeqCst), 2);
    assert_eq!(crate::workflow_runs::list(root.clone()).unwrap().len(), 1);
    let cancelled = WorkflowTool
        .call(json!({"definition_id":def.id,"version":1}), &ctx)
        .await
        .unwrap();
    let kcoder_types::ContentBlock::Text { text } = &cancelled.content[0] else {
        panic!("text")
    };
    let cancelled: Value = serde_json::from_str(text).unwrap();
    let cancelled_id = cancelled["run_id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while runner.entered.load(Ordering::SeqCst) != 4 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    abort.cancel();
    manager.wait_for_completion(cancelled_id).await;
    let cancelled = crate::workflow_runs::read(root, cancelled_id).unwrap();
    assert_eq!(cancelled.status, "cancelled");
    assert!(
        cancelled
            .node_states
            .iter()
            .all(|n| n.status == "cancelled")
    );
}

#[tokio::test]
async fn named_scenarios_are_wired_through_the_public_tool_and_resume_keeps_old_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    let library = kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
    let draft = library.create("Named cases", "").unwrap();
    let node=serde_json::from_value(json!({"id":"check","title":"Check","kind":"code","config":{"code":{"source":"return {count: input.value};"},"resultCheck":{"source":"return Number.isInteger(result.count) && result.count === input.value;"}}})).unwrap();
    let draft = library
        .upsert_node(&draft.id, draft.revision, node)
        .unwrap();
    let saved = library.save(&draft.id, draft.revision).unwrap();
    let state = AppState::new(temp.path());
    let project = profile.join("projects/project");
    fs::create_dir_all(&project).unwrap();
    state.with_history_path(project.join("session.jsonl"));
    let runner = Arc::new(RecordingRunner::default());
    let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
    let context = ToolContext::new(state.clone())
        .with_settings_persistence_path(Some(profile.join("settings.json")))
        .with_agent_runner(runner.clone())
        .with_background_job_manager(manager.clone());
    assert!(WorkflowTool.call(json!({"script":"return 1;","verification_scenario":{"id":"script","requiredCheckNodes":["check"]}}),&context).await.unwrap_err().to_string().contains("pinned definition"));
    assert!(WorkflowTool.call(json!({"definition_id":saved.id,"version":1,"verification_scenario":{"id":"bad","requiredCheckNodes":[],"status":"passed"}}),&context).await.is_err());
    assert!(library.verification(&saved.id, 1).unwrap().runs.is_empty());
    let output=WorkflowTool.call(json!({"definition_id":saved.id,"version":1,"args":{"value":1},"verification_scenario_json":serde_json::to_string(&json!({"id":"first","requiredCheckNodes":["check"],"expectedSkippedNodes":[]})).unwrap()}),&context).await.unwrap();
    let kcoder_types::ContentBlock::Text { text } = &output.content[0] else {
        panic!("text")
    };
    let started: Value = serde_json::from_str(text).unwrap();
    let run_id = started["run_id"].as_str().unwrap();
    manager.wait_for_completion(run_id).await;
    assert_eq!(
        library.verification(&saved.id, 1).unwrap().runs[0]
            .scenario
            .as_ref()
            .unwrap()
            .status,
        "passed"
    );
    WorkflowTool.call(json!({"resume":run_id,"args":{"value":2},"verification_scenario":{"id":"second","requiredCheckNodes":["check"],"expectedSkippedNodes":[]}}),&context).await.unwrap();
    manager.wait_for_completion(run_id).await;
    let evidence = library.verification(&saved.id, 1).unwrap();
    assert_eq!(evidence.total_run_count, 2);
    let ids: std::collections::BTreeSet<_> = evidence
        .runs
        .iter()
        .map(|run| run.scenario.as_ref().unwrap().request.id.as_str())
        .collect();
    assert_eq!(ids, ["first", "second"].into_iter().collect());
    assert!(
        evidence
            .runs
            .iter()
            .all(|run| run.scenario.as_ref().unwrap().status == "passed")
    );
    assert_ne!(evidence.runs[0].input_sha256, evidence.runs[1].input_sha256);
    assert_ne!(
        evidence.runs[0].artifact_attempt,
        evidence.runs[1].artifact_attempt
    );
    assert!(runner.0.lock().unwrap().is_empty());
}

#[test]
fn named_case_schema_rejects_model_verdicts_scripts_and_duplicate_encoding_channels() {
    let schema = WorkflowTool.input_schema();
    let good = json!({"definition_id":"saved","version":1,"verification_scenario":{"id":"case","requiredCheckNodes":["check"],"expectedSkippedNodes":[]}});
    assert!(kcoder_workflow::graph::validate_data(&schema, &good).is_ok());
    for bad in [
        json!({"script":"return 1;","verification_scenario":{"id":"case","requiredCheckNodes":["check"]}}),
        json!({"definition_id":"saved","version":1,"verification_scenario":{"id":"case","requiredCheckNodes":["check"],"status":"passed"}}),
        json!({"definition_id":"saved","version":1,"verification_scenario":{"id":"case","requiredCheckNodes":[]}}),
        json!({"definition_id":"saved","version":1,"verification_scenario":{"id":"case","requiredCheckNodes":["check"]},"verification_scenario_json":"{}"}),
    ] {
        assert!(
            kcoder_workflow::graph::validate_data(&schema, &bad).is_err(),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn checkpoint_new_saved_version_reuses_prefix_and_keeps_source_history() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    let library = kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
    let mut draft = library.create("Checkpoint fixture", "").unwrap();
    for (id, depends) in [
        ("first", vec![]),
        ("second", vec!["first"]),
        ("third", vec!["second"]),
    ] {
        let node = serde_json::from_value(
            json!({"id":id,"title":id,"prompt":id,"agentType":"review","dependsOn":depends}),
        )
        .unwrap();
        draft = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
    }
    let first = library.save(&draft.id, draft.revision).unwrap();
    let state = AppState::new(temp.path());
    let project = profile.join("projects/checkpoint");
    fs::create_dir_all(&project).unwrap();
    state.with_history_path(project.join("session.jsonl"));
    let runner = Arc::new(RecordingRunner::default());
    let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
    let context = ToolContext::new(state.clone())
        .with_settings_persistence_path(Some(profile.join("settings.json")))
        .with_agent_runner(runner.clone())
        .with_background_job_manager(manager.clone());
    let started = WorkflowTool
        .call(
            json!({"definition_id":first.id,"version":1,"args":{"marker":"saved-input"}}),
            &context,
        )
        .await
        .unwrap();
    let kcoder_types::ContentBlock::Text { text } = &started.content[0] else {
        panic!("expected text")
    };
    let started: Value = serde_json::from_str(text).unwrap();
    let source = started["run_id"].as_str().unwrap();
    manager.wait_for_completion(source).await;
    assert_eq!(runner.0.lock().unwrap().len(), 3);
    let source_dir = workflow_run_dir(&context, source);
    let old_state = fs::read(source_dir.join("state.json")).unwrap();
    let old_journal = fs::read(source_dir.join("journal.jsonl")).unwrap();
    let mut changed = first.nodes[2].clone();
    changed.prompt = "changed third node".into();
    let draft = library
        .upsert_node(&first.id, first.revision, changed)
        .unwrap();
    let second = library.save(&draft.id, draft.revision).unwrap();
    let started = WorkflowTool
        .call(
            json!({"definition_id":second.id,"version":2,"reuse_from_run":source}),
            &context,
        )
        .await
        .unwrap();
    let kcoder_types::ContentBlock::Text { text } = &started.content[0] else {
        panic!("expected text")
    };
    let started: Value = serde_json::from_str(text).unwrap();
    let target = started["run_id"].as_str().unwrap();
    assert_ne!(source, target);
    assert_eq!(started["version"], 2);
    manager.wait_for_completion(target).await;
    assert_eq!(state.task(target).unwrap().status, TaskStatus::Completed);
    assert_eq!(
        runner.0.lock().unwrap().len(),
        4,
        "only changed third node executes"
    );
    assert!(runner.1.lock().unwrap()[3].contains("saved-input"));
    assert_eq!(fs::read(source_dir.join("state.json")).unwrap(), old_state);
    assert_eq!(
        fs::read(source_dir.join("journal.jsonl")).unwrap(),
        old_journal
    );
    let journal =
        fs::read_to_string(workflow_run_dir(&context, target).join("journal.jsonl")).unwrap();
    assert_eq!(
        journal
            .lines()
            .filter(|line| line.contains("node_reused"))
            .count(),
        2
    );
    let status = crate::workflow_runs::read(profile.join("workflow-runs"), target).unwrap();
    assert_eq!(
        status.node_states.iter().filter(|node| node.reused).count(),
        2
    );
    // Reconstruct a pre-checkpoint run to ensure upgrading does not change old Agent receipt identities.
    fs::remove_dir_all(source_dir.join("checkpoints")).unwrap();
    let mut old: Value = serde_json::from_slice(&old_state).unwrap();
    old.as_object_mut().unwrap().remove("checkpoint_format");
    atomic_write_file(
        &source_dir.join("state.json"),
        serde_json::to_vec(&old).unwrap(),
    )
    .unwrap();
    for entry in fs::read_dir(source_dir.join("agents")).unwrap() {
        let entry = entry.unwrap();
        let request: AgentRequest =
            serde_json::from_slice(&fs::read(entry.path().join("request.json")).unwrap()).unwrap();
        let index = ["first", "second", "third"]
            .iter()
            .position(|prompt| request.prompt.starts_with(prompt))
            .unwrap();
        fs::rename(
            entry.path(),
            source_dir
                .join("agents")
                .join(format!("{source}-n{index}-i0-a0")),
        )
        .unwrap();
    }
    WorkflowTool
        .call(json!({"resume":source}), &context)
        .await
        .unwrap();
    manager.wait_for_completion(source).await;
    assert_eq!(
        runner.0.lock().unwrap().len(),
        4,
        "legacy successful Agent receipts must survive the upgrade"
    );
    // Model/policy changes must rerun new-format Agents even when their prompt/request is identical.
    let requests_before = runner.1.lock().unwrap().clone();
    let mut changed_context = context.clone();
    changed_context.runtime_model = Some("changed-model".into());
    changed_context.allowed_shell_prefixes = vec!["restricted-command".into()];
    WorkflowTool
        .call(json!({"resume":target}), &changed_context)
        .await
        .unwrap();
    manager.wait_for_completion(target).await;
    assert_eq!(
        runner.0.lock().unwrap().len(),
        7,
        "new-format cache misses must never fall back to request-only Agent reuse"
    );
    let after = runner.1.lock().unwrap();
    assert_eq!(after[4], requests_before[0]);
    assert_eq!(after[5], requests_before[1]);
    assert_eq!(after[6], requests_before[3]);
}

#[test]
fn checkpoint_reuse_schema_requires_explicit_source_and_saved_target() {
    let schema = WorkflowTool.input_schema();
    assert!(
        kcoder_workflow::graph::validate_data(
            &schema,
            &json!({"definition_id":"saved","version":2,"reuse_from_run":"workflow-old"})
        )
        .is_ok()
    );
    for invalid in [
        json!({"script":"return 1;","reuse_from_run":"workflow-old"}),
        json!({"resume":"workflow-old","reuse_from_run":"workflow-old"}),
        json!({"definition_id":"saved","reuse_from_run":"workflow-old"}),
    ] {
        assert!(kcoder_workflow::graph::validate_data(&schema, &invalid).is_err());
    }
}

#[tokio::test]
async fn published_definition_executes_explicit_version_and_rejects_mixed_sources() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    let library = kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
    let draft = library.create("Published review", "").unwrap();
    let node = serde_json::from_value(
        json!({"id":"review","title":"Review","prompt":"inspect","agentType":"review"}),
    )
    .unwrap();
    let draft = library
        .upsert_node(&draft.id, draft.revision, node)
        .unwrap();
    let saved = library.save(&draft.id, draft.revision).unwrap();
    let state = AppState::new(temp.path());
    let project = profile.join("projects/project");
    fs::create_dir_all(&project).unwrap();
    state.with_history_path(project.join("session.jsonl"));
    let runner = Arc::new(RecordingRunner::default());
    let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
    let context = ToolContext::new(state.clone())
        .with_settings_persistence_path(Some(profile.join("settings.json")))
        .with_agent_runner(runner.clone())
        .with_background_job_manager(manager.clone());
    assert!(
        WorkflowTool
            .call(
                json!({"definition_id":saved.id,"version":1,"script":"return 1"}),
                &context
            )
            .await
            .is_err()
    );
    assert!(
        WorkflowTool
            .call(json!({"definition_id":saved.id}), &context)
            .await
            .is_err()
    );
    assert!(
        WorkflowTool
            .call(
                json!({"definition_id":saved.id,"version":1,"resume":"workflow-invalid"}),
                &context
            )
            .await
            .is_err()
    );
    let output = WorkflowTool
        .call(
            json!({"definition_id":saved.id,"version":1,"args":{"marker":"first-saved-args"}}),
            &context,
        )
        .await
        .unwrap();
    let kcoder_types::ContentBlock::Text { text } = &output.content[0] else {
        panic!("expected text")
    };
    let result: Value = serde_json::from_str(text).unwrap();
    let run_id = result["run_id"].as_str().unwrap();
    manager.wait_for_completion(run_id).await;
    assert_eq!(state.task(run_id).unwrap().status, TaskStatus::Completed);
    assert_eq!(runner.0.lock().unwrap().len(), 1);
    assert!(runner.1.lock().unwrap()[0].contains("first-saved-args"));
    let resumed = WorkflowTool
        .call(
            json!({"resume":run_id,"args":{"marker":"replacement-saved-args"}}),
            &context,
        )
        .await
        .unwrap();
    let kcoder_types::ContentBlock::Text { text } = &resumed.content[0] else {
        panic!("expected text")
    };
    let reference: Value = serde_json::from_str(text).unwrap();
    assert_eq!(reference["run_id"], run_id);
    assert_eq!(reference["definition_id"], saved.id);
    assert_eq!(reference["version"], 1);
    assert_eq!(reference["title"], "Published review");
    manager.wait_for_completion(run_id).await;
    assert_eq!(
        runner.0.lock().unwrap().len(),
        2,
        "changed args must not reuse the old output"
    );
    assert!(runner.1.lock().unwrap()[1].contains("replacement-saved-args"));
    assert!(!runner.1.lock().unwrap()[1].contains("first-saved-args"));

    assert_eq!(
        library.read_saved(&saved.id, Some(1)).unwrap().revision,
        saved.revision
    );
}

#[tokio::test]
async fn lossless_args_run_without_silently_accepting_flattened_fields() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("projects/project");
    fs::create_dir_all(&project).unwrap();
    let state = AppState::new(temp.path());
    state.with_history_path(project.join("session.jsonl"));
    let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
    let context = ToolContext::new(state)
        .with_agent_runner(Arc::new(RecordingRunner::default()))
        .with_background_job_manager(manager.clone());
    for input in [
        json!({"script":"return args;","args":"","mode":"audit"}),
        json!({"script":"return args;","args":null,"args_json":"{}"}),
    ] {
        assert!(WorkflowTool.call(input, &context).await.is_err());
    }
    for args in [
        json!({"count":20,"descending":true,"items":["1","2","3"]}),
        json!(["1", "2", "3"]),
        json!({"item":["1","2","3"]}),
    ] {
        for field in ["args", "args_json"] {
            let mut input = json!({"script":"return args;"});
            input[field] = if field == "args_json" {
                json!(serde_json::to_string(&args).unwrap())
            } else {
                args.clone()
            };
            crate::coerce_input(&mut input, &WorkflowTool.input_schema());
            let output = WorkflowTool.call(input, &context).await.unwrap();
            let kcoder_types::ContentBlock::Text { text } = &output.content[0] else {
                panic!("text expected")
            };
            let receipt: Value = serde_json::from_str(text).unwrap();
            manager
                .wait_for_completion(receipt["run_id"].as_str().unwrap())
                .await;
            let output_path = PathBuf::from(receipt["output_file"].as_str().unwrap());
            let stored: Value = serde_json::from_slice(&fs::read(&output_path).unwrap()).unwrap();
            let persisted: Value = serde_json::from_slice(
                &fs::read(output_path.parent().unwrap().join("args.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(persisted, args, "persisted arguments via {field}");
            assert_eq!(stored["result"], args, "executed arguments via {field}");
        }
    }
}

#[tokio::test]
async fn tool_runs_embedded_script_and_persists_session_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let project_dir = temp.path().join("projects/project");
    fs::create_dir_all(&project_dir).unwrap();
    let state = AppState::new(temp.path());
    state.with_history_path(project_dir.join("session-1.jsonl"));
    let runner = Arc::new(RecordingRunner::default());
    let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
    let context = ToolContext::new(state.clone())
        .with_agent_runner(runner.clone())
        .with_background_job_manager(manager.clone());

    let output = WorkflowTool
        .call(
            json!({
                "script": "return await agent({prompt: 'inspect', agent_type: 'review'});",
                "args": {"unused": true}
            }),
            &context,
        )
        .await
        .unwrap();
    let text = match &output.content[0] {
        kcoder_types::ContentBlock::Text { text } => text,
        other => panic!("unexpected workflow output: {other:?}"),
    };
    let start: Value = serde_json::from_str(text).unwrap();
    let run_id = start["run_id"].as_str().unwrap();
    let output_path = PathBuf::from(start["output_file"].as_str().unwrap());

    for _ in 0..100 {
        if output_path.exists()
            && state
                .task(run_id)
                .is_some_and(|task| task.status == TaskStatus::Completed)
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    manager.wait_for_completion(run_id).await;

    assert!(output_path.exists());
    let run_dir = output_path.parent().unwrap();
    assert!(run_dir.join("script.js").exists());
    assert!(run_dir.join("state.json").exists());
    assert!(run_dir.join("journal.jsonl").exists());
    assert!(
        run_dir
            .join("agents")
            .join(format!("{run_id}-agent-1"))
            .join("request.json")
            .exists()
    );
    assert!(
        run_dir
            .join("agents")
            .join(format!("{run_id}-agent-1"))
            .join("completed")
            .exists()
    );
    let final_output: Value = serde_json::from_slice(&fs::read(&output_path).unwrap()).unwrap();
    assert_eq!(final_output["result"], "agent result");
    {
        let agent_ids = runner.0.lock().unwrap();
        assert_eq!(agent_ids.as_slice(), &[format!("{run_id}-agent-1")]);
    }

    assert!(state.remove_task(run_id));

    let resumed = WorkflowTool
        .call(json!({"resume": run_id}), &context)
        .await
        .unwrap();
    let resumed_text = match &resumed.content[0] {
        kcoder_types::ContentBlock::Text { text } => text,
        other => panic!("unexpected resume output: {other:?}"),
    };
    let resumed_start: Value = serde_json::from_str(resumed_text).unwrap();
    assert_eq!(resumed_start["resumed"], true);
    assert_eq!(state.task(run_id).unwrap().kind, TaskKind::Workflow);
    wait_for_workflow_status(run_dir, "completed").await;
    manager.wait_for_completion(run_id).await;
    assert_eq!(
        runner.0.lock().unwrap().as_slice(),
        &[format!("{run_id}-agent-1")],
        "resume should reuse the completed agent result"
    );
    let journal = fs::read_to_string(run_dir.join("journal.jsonl")).unwrap();
    assert!(journal.contains("workflow_resumed"));
    assert!(journal.contains("agent_reused"));

    WorkflowTool
        .call(
            json!({"resume": run_id, "args": {"unused": false}}),
            &context,
        )
        .await
        .unwrap();
    wait_for_workflow_status(run_dir, "completed").await;
    manager.wait_for_completion(run_id).await;
    assert_eq!(
        runner.0.lock().unwrap().len(),
        1,
        "unused args must not invalidate an unchanged agent request"
    );
    let state: Value = serde_json::from_slice(
        &secure_read_file(&run_dir.join("state.json"), 1024 * 1024).unwrap(),
    )
    .unwrap();
    assert_eq!(state["agent_started"], 1);
    assert_eq!(state["agent_completed"], 1);
    assert_eq!(state["agent_reused"], 1);

    struct DropFlag(Arc<std::sync::atomic::AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let drop_flag = DropFlag(dropped.clone());
    let timeout_id = "workflow-timeout-cleanup";
    manager
        .spawn_workflow_with_id(
            timeout_id.to_string(),
            "timeout cleanup".to_string(),
            Box::pin(async move {
                let _drop_flag = drop_flag;
                std::future::pending::<ToolOutput>().await
            }),
            None,
        )
        .unwrap();
    let waiting_manager = manager.clone();
    let waiter = tokio::spawn(async move {
        waiting_manager
            .wait_for_completion_with_timeout(timeout_id, std::time::Duration::from_millis(10))
            .await;
    });
    let panic = waiter.await.unwrap_err();
    assert!(panic.is_panic());
    let payload = panic.into_panic();
    let message = payload
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| payload.downcast_ref::<&str>().copied())
        .unwrap();
    assert_eq!(
        message,
        "workflow workflow-timeout-cleanup task did not finish before timeout; task aborted"
    );
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn resume_reruns_agent_when_args_change_its_request() {
    let temp = tempfile::tempdir().unwrap();
    let project_dir = temp.path().join("projects/project");
    fs::create_dir_all(&project_dir).unwrap();
    let state = AppState::new(temp.path());
    state.with_history_path(project_dir.join("session-1.jsonl"));
    let runner = Arc::new(RecordingRunner::default());
    let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
    let context = ToolContext::new(state)
        .with_agent_runner(runner.clone())
        .with_background_job_manager(manager.clone());

    let output = WorkflowTool
        .call(
            json!({
                "script": "return await agent({prompt: args.prompt, agent_type: 'review'});",
                "args": {"prompt": "first"}
            }),
            &context,
        )
        .await
        .unwrap();
    let text = match &output.content[0] {
        kcoder_types::ContentBlock::Text { text } => text,
        other => panic!("unexpected workflow output: {other:?}"),
    };
    let start: Value = serde_json::from_str(text).unwrap();
    let run_id = start["run_id"].as_str().unwrap();
    let run_dir = PathBuf::from(start["state_file"].as_str().unwrap())
        .parent()
        .unwrap()
        .to_path_buf();
    wait_for_workflow_status(&run_dir, "completed").await;
    manager.wait_for_completion(run_id).await;
    for _ in 0..100 {
        if runner.0.lock().unwrap().len() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    WorkflowTool
        .call(
            json!({"resume": run_id, "args": {"prompt": "second"}}),
            &context,
        )
        .await
        .unwrap();
    wait_for_workflow_status(&run_dir, "completed").await;
    manager.wait_for_completion(run_id).await;
    for _ in 0..100 {
        if runner.0.lock().unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(runner.0.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn failed_resume_spawn_rolls_back_state_and_arguments() {
    let temp = tempfile::tempdir().unwrap();
    let project_dir = temp.path().join("projects/project");
    fs::create_dir_all(&project_dir).unwrap();
    let state = AppState::new(temp.path());
    state.with_history_path(project_dir.join("session-1.jsonl"));
    let runner = Arc::new(RecordingRunner::default());
    let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
    let context = ToolContext::new(state.clone())
        .with_agent_runner(runner.clone())
        .with_background_job_manager(manager.clone());
    let output = WorkflowTool
        .call(
            json!({
                "script": "return await agent(args.prompt);",
                "args": {"prompt": "original"}
            }),
            &context,
        )
        .await
        .unwrap();
    let text = match &output.content[0] {
        kcoder_types::ContentBlock::Text { text } => text,
        other => panic!("unexpected workflow output: {other:?}"),
    };
    let started: Value = serde_json::from_str(text).unwrap();
    let run_id = started["run_id"].as_str().unwrap();
    let run_dir = PathBuf::from(started["state_file"].as_str().unwrap())
        .parent()
        .unwrap()
        .to_path_buf();
    wait_for_workflow_status(&run_dir, "completed").await;
    manager.wait_for_completion(run_id).await;

    let failing_context = ToolContext::new(state)
        .with_agent_runner(runner)
        .with_background_job_manager(Arc::new(FailingResumeManager::new()));
    let error = WorkflowTool
        .call(
            json!({"resume": run_id, "args": {"prompt": "replacement"}}),
            &failing_context,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("too many concurrent"));
    let persisted: Value = serde_json::from_slice(
        &secure_read_file(&run_dir.join("state.json"), 1024 * 1024).unwrap(),
    )
    .unwrap();
    assert_eq!(persisted["status"], "completed");
    let args: Value =
        serde_json::from_slice(&secure_read_file(&run_dir.join("args.json"), 1024 * 1024).unwrap())
            .unwrap();
    assert_eq!(args["prompt"], "original");
    assert!(
        fs::read_to_string(run_dir.join("journal.jsonl"))
            .unwrap()
            .contains("workflow_resume_rolled_back")
    );
}
