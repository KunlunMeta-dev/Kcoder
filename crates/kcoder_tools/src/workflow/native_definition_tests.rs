use super::*;
use kcoder_types::workflow::{WorkflowDefinition, WorkflowStatus};
use kcoder_workflow::store::definition_fingerprint;
use sha2::{Digest, Sha256};

fn definition() -> WorkflowDefinition {
    serde_json::from_value(json!({
        "id":"native-fixed-local-graph","title":"Native fixed local graph","description":"Owned deterministic graph",
        "revision":7,"savedVersion":1,"status":"saved","createdAtMs":0,"updatedAtMs":0,
        "inputSchema":{"type":"object","additionalProperties":false,"required":["values"],"properties":{
            "values":{"type":"array","minItems":1,"items":{"type":"number"}},"factor":{"type":"integer","default":2}}},
        "nodes":[{"id":"calculate","kind":"code","title":"Calculate exact total","config":{
            "code":{"source":"return {total: input.values.reduce((a,b)=>a+b,0)*input.factor};"},
            "outputSchema":{"type":"object","additionalProperties":false,"required":["total"],"properties":{"total":{"type":"number"}}},
            "resultCheck":{"source":"return result.total === 10;"}}}]
    })).unwrap()
}
fn pin() -> Arc<WorkflowNativeDefinition> {
    let definition = definition();
    let args = json!({"values":[2,3],"factor":2});
    Arc::new(
        WorkflowNativeDefinition::from_pinned_definition(
            definition.clone(),
            &definition_fingerprint(&definition).unwrap(),
            args.clone(),
            &format!("{:x}", Sha256::digest(serde_json::to_vec(&args).unwrap())),
        )
        .unwrap(),
    )
}
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    state: AppState,
    runner: Arc<RecordingRunner>,
    manager: Arc<ExecutingWorkflowManager>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let state = AppState::new(root.path());
        let project = profile.join("projects/project");
        fs::create_dir_all(&project).unwrap();
        state.with_history_path(project.join("session.jsonl"));
        let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
        Self {
            _root: root,
            profile,
            state,
            manager,
            runner: Arc::new(RecordingRunner::default()),
        }
    }
    fn context(&self) -> ToolContext {
        ToolContext::new(self.state.clone())
            .with_settings_persistence_path(Some(self.profile.join("settings.json")))
            .with_agent_runner(self.runner.clone())
            .with_background_job_manager(self.manager.clone())
    }
}
#[derive(Default)]
struct Observer {
    launches: Mutex<Vec<WorkflowNativeLaunch>>,
    reject: bool,
}
impl WorkflowNativeLaunchObserver for Observer {
    fn before_dispatch(&self, launch: &WorkflowNativeLaunch) -> Result<(), ToolError> {
        self.launches.lock().unwrap().push(launch.clone());
        if self.reject {
            Err(ToolError::Execution("native_owner_commit_failed".into()))
        } else {
            Ok(())
        }
    }
}
fn call() -> Value {
    json!({"definition_id":"native-fixed-local-graph","version":1,"args_json":"{\"factor\":2,\"values\":[2,3]}"})
}

#[tokio::test]
async fn fixed_native_graph_uses_original_run_store_runtime_and_observer_without_user_library() {
    let fixture = Fixture::new();
    let pin = pin();
    let observer = Arc::new(Observer::default());
    let context = fixture
        .context()
        .with_workflow_native_definition(pin.clone())
        .with_workflow_native_launch_observer(observer.clone());
    let result = WorkflowTool.call(call(), &context).await.unwrap();
    let kcoder_types::ContentBlock::Text { text } = &result.content[0] else {
        panic!("text")
    };
    let receipt: Value = serde_json::from_str(text).unwrap();
    let run = receipt["run_id"].as_str().unwrap();
    fixture.manager.wait_for_completion(run).await;
    let launches = observer.launches.lock().unwrap();
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].run_id, run);
    assert_eq!(launches[0].definition_sha256, pin.definition_sha256());
    assert_eq!(launches[0].inputs_sha256, pin.inputs_sha256());
    let directory = PathBuf::from(receipt["state_file"].as_str().unwrap())
        .parent()
        .unwrap()
        .to_path_buf();
    let persisted: WorkflowDefinition =
        serde_json::from_slice(&fs::read(directory.join("definition.json")).unwrap()).unwrap();
    assert_eq!(&persisted, pin.definition());
    let args: Value =
        serde_json::from_slice(&fs::read(directory.join("args.json")).unwrap()).unwrap();
    assert_eq!(args, json!({"factor":2,"values":[2,3]}));
    let state: Value =
        serde_json::from_slice(&fs::read(directory.join("state.json")).unwrap()).unwrap();
    assert_eq!(state["definition_sha256"], pin.definition_sha256());
    assert_eq!(state["status"], "completed");
    assert_eq!(state["native_definition"], true);
    let output: Value =
        serde_json::from_slice(&fs::read(directory.join("output.json")).unwrap()).unwrap();
    assert_eq!(
        output["result"]["outputs"][0]["output"],
        json!({"total":10})
    );
    assert_eq!(output["result"]["verification"]["status"], "passed");
    let evidence: kcoder_workflow::store::RuntimeVerification = serde_json::from_slice(
        &fs::read(directory.join("verification").join(format!("{run}-0.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(evidence.definition_sha256, pin.definition_sha256());
    assert_eq!(evidence.input_sha256, pin.inputs_sha256());
    assert_eq!(evidence.check_status, "passed");
    assert_eq!(evidence.checked_nodes, vec!["calculate"]);
    assert!(fixture.runner.0.lock().unwrap().is_empty());
    assert!(!fixture.profile.join("workflow-library").exists());
    assert_eq!(
        fixture.state.task(run).unwrap().status,
        TaskStatus::Completed
    );
}

#[tokio::test]
async fn explicit_resume_keeps_original_native_graph_and_terminal_evidence_without_user_library() {
    let fixture = Fixture::new();
    let context = fixture
        .context()
        .with_workflow_native_definition(pin())
        .with_workflow_native_launch_observer(Arc::new(Observer::default()));
    let result = WorkflowTool.call(call(), &context).await.unwrap();
    let kcoder_types::ContentBlock::Text { text } = &result.content[0] else {
        panic!("text")
    };
    let receipt: Value = serde_json::from_str(text).unwrap();
    let run = receipt["run_id"].as_str().unwrap();
    fixture.manager.wait_for_completion(run).await;
    let directory = PathBuf::from(receipt["state_file"].as_str().unwrap())
        .parent()
        .unwrap()
        .to_path_buf();
    let definition = fs::read(directory.join("definition.json")).unwrap();
    let first = directory.join("verification").join(format!("{run}-0.json"));
    let original_evidence = fs::read(&first).unwrap();
    WorkflowTool
        .call(json!({"resume":run}), &fixture.context())
        .await
        .unwrap();
    fixture.manager.wait_for_completion(run).await;
    assert_eq!(fs::read(first).unwrap(), original_evidence);
    assert_eq!(
        fs::read(directory.join("definition.json")).unwrap(),
        definition
    );
    let second: kcoder_workflow::store::RuntimeVerification = serde_json::from_slice(
        &fs::read(directory.join("verification").join(format!("{run}-1.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(second.artifact_attempt, Some(1));
    assert_eq!(second.check_status, "passed");
    assert!(!fixture.profile.join("workflow-library").exists());
    assert!(fixture.runner.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn legacy_saved_run_without_native_marker_resumes_with_original_library_admission() {
    let fixture = Fixture::new();
    let graph = definition();
    let library =
        kcoder_workflow::store::WorkflowStore::new(fixture.profile.join("workflow-library"));
    let draft = library
        .create_with_schema("Legacy saved graph", "", graph.input_schema.clone())
        .unwrap();
    let draft = library
        .upsert_node(&draft.id, draft.revision, graph.nodes[0].clone())
        .unwrap();
    let saved = library.save(&draft.id, draft.revision).unwrap();
    let context = fixture.context();
    let result = WorkflowTool
        .call(
            json!({"definition_id":saved.id,"version":1,
        "args":{"factor":2,"values":[2,3]}}),
            &context,
        )
        .await
        .unwrap();
    let kcoder_types::ContentBlock::Text { text } = &result.content[0] else {
        panic!("text")
    };
    let receipt: Value = serde_json::from_str(text).unwrap();
    let run = receipt["run_id"].as_str().unwrap();
    fixture.manager.wait_for_completion(run).await;
    let file = PathBuf::from(receipt["state_file"].as_str().unwrap());
    let mut old: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    old.as_object_mut().unwrap().remove("native_definition");
    atomic_write_file(&file, serde_json::to_vec(&old).unwrap()).unwrap();
    WorkflowTool
        .call(json!({"resume":run}), &context)
        .await
        .unwrap();
    fixture.manager.wait_for_completion(run).await;
    let restored: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    assert_eq!(restored["native_definition"], false);
    assert_eq!(restored["status"], "completed");
    assert_eq!(library.verification(&saved.id, 1).unwrap().runs.len(), 2);
    assert!(fixture.runner.0.lock().unwrap().is_empty());
}

struct PausedRunner {
    started: Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
    release: tokio::sync::Notify,
}
#[async_trait]
impl AgentRunner for PausedRunner {
    async fn run_agent(&self, _: String, _: usize) -> Result<String, AgentError> {
        panic!("the original workflow runner must supply its actual Agent identity")
    }
    async fn run_agent_session_with_options(
        &self,
        agent_id: String,
        _: String,
        _: usize,
        _: crate::AgentKind,
        _: AgentRunOptions,
    ) -> Result<String, AgentError> {
        self.started
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(agent_id)
            .unwrap();
        self.release.notified().await;
        Ok("Controlled Agent output; no model was invoked".into())
    }
}

#[tokio::test]
async fn native_control_proof_is_preserved_in_the_original_run_evidence() {
    let fixture = Fixture::new();
    let mut graph = definition();
    graph.nodes = vec![
        serde_json::from_value(
        json!({"id":"worker","title":"Controlled worker","prompt":"Controlled runtime association",
        "agentType":"general","maxTurns":1,"config":{"resultCheck":{"source":"return true;"}}}),
        )
        .unwrap(),
    ];
    let args = json!({"values":[2,3],"factor":2});
    let native = WorkflowNativeDefinition::from_pinned_definition(
        graph.clone(),
        &definition_fingerprint(&graph).unwrap(),
        args.clone(),
        &format!("{:x}", Sha256::digest(serde_json::to_vec(&args).unwrap())),
    )
    .unwrap();
    let (started, actual_agent) = tokio::sync::oneshot::channel();
    let runner = Arc::new(PausedRunner {
        started: Mutex::new(Some(started)),
        release: Default::default(),
    });
    let context = fixture
        .context()
        .with_agent_runner(runner.clone())
        .with_workflow_native_definition(Arc::new(native))
        .with_workflow_native_launch_observer(Arc::new(Observer::default()));
    let result = WorkflowTool.call(call(), &context).await.unwrap();
    let kcoder_types::ContentBlock::Text { text } = &result.content[0] else {
        panic!("text")
    };
    let receipt: Value = serde_json::from_str(text).unwrap();
    let run = receipt["run_id"].as_str().unwrap();
    let agent = tokio::time::timeout(Duration::from_secs(2), actual_agent)
        .await
        .unwrap()
        .unwrap();
    let projection_root = fixture.profile.join("workflow-runs");
    let original = crate::workflow_runs::read(projection_root.clone(), run).unwrap();
    let association = crate::workflow_runs::prepare_user_control(
        &projection_root,
        &fixture.profile.join("workflow-library"),
        &original.thread_id,
        &agent,
        "owned-control",
        &"a".repeat(64),
    )
    .unwrap()
    .unwrap();
    assert_eq!(association.run_id, run);
    assert_eq!(association.phase, "prepared");
    assert!(
        crate::workflow_runs::read(projection_root, run)
            .unwrap()
            .interaction_modified
    );
    runner.release.notify_one();
    fixture.manager.wait_for_completion(run).await;
    let directory = PathBuf::from(receipt["state_file"].as_str().unwrap())
        .parent()
        .unwrap()
        .to_path_buf();
    let evidence: kcoder_workflow::store::RuntimeVerification = serde_json::from_slice(
        &fs::read(directory.join("verification").join(format!("{run}-0.json"))).unwrap(),
    )
    .unwrap();
    assert!(evidence.interaction_modified);
    assert!(!fixture.profile.join("workflow-library").exists());
}

#[test]
fn wrong_definition_hash_version_schema_or_unfrozen_input_never_creates_a_native_pin() {
    let definition = definition();
    let args = json!({"factor":2,"values":[2,3]});
    let sha = definition_fingerprint(&definition).unwrap();
    let inputs = format!("{:x}", Sha256::digest(serde_json::to_vec(&args).unwrap()));
    assert!(
        WorkflowNativeDefinition::from_pinned_definition(
            definition.clone(),
            &"0".repeat(64),
            args.clone(),
            &inputs
        )
        .is_err()
    );
    assert!(
        WorkflowNativeDefinition::from_pinned_definition(
            definition.clone(),
            &sha,
            args.clone(),
            &"0".repeat(64)
        )
        .is_err()
    );
    assert!(
        WorkflowNativeDefinition::from_pinned_definition(
            definition.clone(),
            &sha,
            json!({"values":[2,3]}),
            &inputs
        )
        .is_err()
    );
    assert!(
        WorkflowNativeDefinition::from_pinned_definition(
            definition.clone(),
            &sha,
            json!({"values":"wrong","factor":2}),
            &inputs
        )
        .is_err()
    );
    let mut draft = definition.clone();
    draft.status = WorkflowStatus::Draft;
    assert!(
        WorkflowNativeDefinition::from_pinned_definition(draft, &sha, args.clone(), &inputs)
            .is_err()
    );
    let mut changed = definition;
    changed.description = "Changed source body".into();
    assert!(
        WorkflowNativeDefinition::from_pinned_definition(changed, &sha, args, &inputs).is_err()
    );
}

#[tokio::test]
async fn host_pin_without_owner_or_with_changed_selector_inputs_or_resume_dispatches_nothing() {
    let fixture = Fixture::new();
    let native = pin();
    assert!(
        WorkflowTool
            .call(
                call(),
                &fixture
                    .context()
                    .with_workflow_native_definition(native.clone())
            )
            .await
            .is_err()
    );
    let observer = Arc::new(Observer::default());
    let context = fixture
        .context()
        .with_workflow_native_definition(native)
        .with_workflow_native_launch_observer(observer.clone());
    for value in [
        json!({"definition_id":"other-definition","version":1,"args":{"factor":2,"values":[2,3]}}),
        json!({"definition_id":"native-fixed-local-graph","version":2,"args":{"factor":2,"values":[2,3]}}),
        json!({"definition_id":"native-fixed-local-graph","version":1,"args":{"factor":3,"values":[2,3]}}),
        json!({"definition_id":"native-fixed-local-graph","version":1,"args":{"values":[2,3]}}),
        json!({"script":"return 10;","args":{"factor":2,"values":[2,3]}}),
        json!({"resume":"old-run"}),
        json!({"definition_id":"native-fixed-local-graph","version":1,"reuse_from_run":"old-run","args":{"factor":2,"values":[2,3]}}),
    ] {
        assert!(WorkflowTool.call(value, &context).await.is_err());
    }
    assert!(observer.launches.lock().unwrap().is_empty());
    assert!(fixture.manager.handles.lock().unwrap().is_empty());
    assert!(fixture.runner.0.lock().unwrap().is_empty());
    assert!(!fixture.profile.join("workflow-runs").exists());
    assert!(!fixture.profile.join("workflow-library").exists());
}

#[tokio::test]
async fn tool_json_cannot_install_a_native_definition_or_select_a_missing_shipped_graph() {
    let fixture = Fixture::new();
    let mut forged = call();
    forged["native_definition"] = serde_json::to_value(definition()).unwrap();
    assert!(WorkflowTool.call(forged, &fixture.context()).await.is_err());
    assert!(WorkflowTool.call(call(), &fixture.context()).await.is_err());
    assert!(!fixture.profile.join("workflow-runs").exists());
    assert!(fixture.runner.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rejected_original_owner_keeps_failed_receipt_and_starts_no_runtime_work() {
    let fixture = Fixture::new();
    let observer = Arc::new(Observer {
        reject: true,
        ..Default::default()
    });
    let context = fixture
        .context()
        .with_workflow_native_definition(pin())
        .with_workflow_native_launch_observer(observer.clone());
    let error = WorkflowTool.call(call(), &context).await.unwrap_err();
    assert!(error.to_string().contains("native_owner_commit_failed"));
    let launches = observer.launches.lock().unwrap();
    assert_eq!(launches.len(), 1);
    assert_eq!(
        crate::workflow_runs::read(fixture.profile.join("workflow-runs"), &launches[0].run_id)
            .unwrap()
            .status,
        "failed"
    );
    assert!(fixture.manager.handles.lock().unwrap().is_empty());
    assert!(fixture.runner.0.lock().unwrap().is_empty());
    assert!(!fixture.profile.join("workflow-library").exists());
}
