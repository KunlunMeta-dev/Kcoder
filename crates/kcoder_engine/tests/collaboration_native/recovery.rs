//! One actual failed readonly member resumes without replaying completed effects.
use super::*;
use kcoder_types::BackgroundRunKey;

struct CountedNativeWrite(Arc<AtomicUsize>);
#[async_trait::async_trait]
impl Tool for CountedNativeWrite {
    fn name(&self) -> String {
        FileWriteTool.name()
    }
    fn description(&self) -> String {
        FileWriteTool.description()
    }
    fn input_schema(&self) -> Value {
        FileWriteTool.input_schema()
    }
    async fn call(&self, input: Value, context: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        FileWriteTool.call(input, context).await
    }
}
struct FailOnceVerifier {
    inner: FixedProvider,
    state: AppState,
    failed: AtomicBool,
    injected_failures: Arc<AtomicUsize>,
    calls: Arc<Mutex<BTreeMap<String, usize>>>,
    actors: Arc<Mutex<BTreeMap<String, Vec<BackgroundRunKey>>>>,
}
impl Provider for FailOnceVerifier {
    fn name(&self) -> &'static str {
        self.inner.name()
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let text = request
            .messages
            .iter()
            .map(|message| message.preview(128 * 1024))
            .collect::<Vec<_>>()
            .join("\n");
        let member = ["reader_a", "reader_b", "writer_a", "writer_b", "verify"]
            .into_iter()
            .find(|member| text.contains(&format!("member {member}")))
            .expect("explicit role fixture instruction");
        *self.calls.lock().unwrap().entry(member.into()).or_default() += 1;
        // Observe the actual manager-owned task/run. The Provider's diagnostic
        // session id and a role name never stand in for native actor identity.
        let tasks = self.state.tasks();
        let actual = tasks
            .values()
            .filter(|task| {
                task.kind == kcoder_state::TaskKind::Subagent
                    && task.managed
                    && task.parent_session_id.as_deref() == Some(self.state.session_id().as_str())
                    && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                    && task.description.contains(&format!("member {member}"))
            })
            .collect::<Vec<_>>();
        assert_eq!(
            actual.len(),
            1,
            "a Provider call must belong to one actual managed role: {member}"
        );
        let key = actual[0]
            .background_run
            .clone()
            .expect("actual managed run identity");
        self.actors
            .lock()
            .unwrap()
            .entry(member.into())
            .or_default()
            .push(key);
        if member == "verify" && !self.failed.swap(true, Ordering::SeqCst) {
            self.injected_failures.fetch_add(1, Ordering::SeqCst);
            return Err(ApiErrorKind::Api {
                error_type: "invalid_request_error".into(),
                message: "owned verifier permanent Provider fault before response".into(),
            });
        }
        self.inner.stream_messages(request)
    }
}
fn output_json(output: &ToolOutput) -> Value {
    serde_json::from_str(
        &output
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>(),
    )
    .unwrap()
}
async fn terminal(engine: &QueryEngine, id: &str) -> kcoder_state::Task {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            if let Some(task) = engine.state.task(id)
                && matches!(
                    task.status,
                    TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
                )
            {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn failed_readonly_member_resumes_same_native_workflow_without_replaying_successful_writes() {
    let temp = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::open_existing(temp.path()).unwrap();
    let workspace = root.create_private_child(OsStr::new("workspace")).unwrap();
    workspace
        .atomic_replace(OsStr::new("input.txt"), b"original input evidence")
        .unwrap();
    let profile = root.create_private_child(OsStr::new("profile")).unwrap();
    let settings = Settings {
        training_mode: true,
        permission_mode: kcoder_config::PermissionMode::Auto,
        allowed_tools: vec!["read".into(), "write".into(), "Workflow".into()],
        model: "owned-role-model".into(),
        max_tokens: Some(1024),
        max_retries: 0,
        ..super::settings_with_declared_provider()
    };
    profile
        .atomic_replace(
            OsStr::new("settings.json"),
            &serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
    let cwd = temp.path().join("workspace");
    let profile_path = temp.path().join("profile");
    let state = AppState::new(&cwd);
    let role_calls = Arc::new(Mutex::new(BTreeMap::new()));
    let actors = Arc::new(Mutex::new(BTreeMap::new()));
    let injected_failures = Arc::new(AtomicUsize::new(0));
    let writes = Arc::new(AtomicUsize::new(0));
    let provider: Arc<dyn Provider> = Arc::new(FailOnceVerifier {
        inner: FixedProvider {
            calls: Arc::new(AtomicUsize::new(0)),
            stages: Arc::new(Mutex::new(BTreeMap::new())),
            omit_write: false,
        },
        state: state.clone(),
        failed: AtomicBool::new(false),
        injected_failures: injected_failures.clone(),
        calls: role_calls.clone(),
        actors: actors.clone(),
    });
    let factory = Arc::new(NativeFixtureFactory {
        settings: settings.clone(),
        provider: provider.clone(),
    });
    let engine = QueryEngine::new(
        provider,
        state,
        ToolRegistry::new()
            .register(FileReadTool)
            .register(CountedNativeWrite(writes.clone()))
            .register(WorkflowTool),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(&cwd).unwrap(),
        Arc::new(DenyAllUserQuestioner),
        cwd.clone(),
    )
    .with_settings_persistence_path(profile_path.join("settings.json"))
    .with_client_model_configuration(factory);
    let library = kcoder_workflow::store::WorkflowStore::new(profile_path.join("workflow-library"));
    let draft = library
        .create(
            "Failed member native recovery",
            "Owned partial failure acceptance",
        )
        .unwrap();
    let applied = library
        .initialize_collaboration(&draft.id, draft.revision, &plan(), |_| Ok(()))
        .unwrap();
    let saved = library.save(&draft.id, applied.revision).unwrap();
    let observer = Arc::new(Launch::default());
    let first=engine.start_workflow_with_native_observer(json!({"definition_id":saved.id,"version":1,"args":{"brief":"Use original evidence and produce the report"},"timeout_seconds":20,"max_concurrency":4}),observer.clone()).await.unwrap();
    let first = output_json(&first);
    let run = first["run_id"].as_str().unwrap();
    let failed = terminal(&engine, run).await;
    assert_eq!(failed.status, TaskStatus::Failed);
    assert_eq!(
        injected_failures.load(Ordering::SeqCst),
        1,
        "the private fixture observed its one permanent verifier fault; public diagnostics need not reveal its body"
    );
    assert_eq!(
        std::fs::read_to_string(cwd.join("report.txt")).unwrap(),
        "final actual output"
    );
    assert_eq!(writes.load(Ordering::SeqCst), 2);
    let calls_before = role_calls.lock().unwrap().clone();
    assert_eq!(
        calls_before["verify"], 1,
        "the permanent fixture fault is not retried silently"
    );
    let old_verifier = actors.lock().unwrap()["verify"][0].clone();
    let old_root = failed
        .background_run
        .clone()
        .expect("actual original workflow manager run");
    assert!(
        engine
            .state
            .background_run_record(&old_verifier)
            .unwrap()
            .terminal
            .is_some()
    );
    let run_dir = std::path::Path::new(first["state_file"].as_str().unwrap())
        .parent()
        .unwrap();
    let old_evidence = std::fs::read(run_dir.join("collaboration-artifacts-v1.json")).unwrap();
    let before_file = std::fs::metadata(cwd.join("report.txt")).unwrap();
    let stored_run: Value =
        serde_json::from_slice(&std::fs::read(first["state_file"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(
        stored_run["native_definition"], false,
        "this fixture started an ordinary saved library definition, not a host-private fixed-source capsule"
    );
    let journal = std::path::Path::new(first["journal_file"].as_str().unwrap());
    assert!(journal.starts_with(run_dir));
    let before_journal = std::fs::read(journal).unwrap();
    // The formal same-run resume retains original definition, input, limits and
    // successfully validated checkpoints. No fixture checkpoint is manufactured.
    // The launch observer accepts new fixed launches only. Ordinary saved-library
    // resume uses the normal public Workflow entry, preserving its run guard.
    let resumed = engine.start_workflow(json!({"resume":run})).await.unwrap();
    let resumed = output_json(&resumed);
    assert_eq!(resumed["run_id"].as_str(), Some(run));
    let recovered = terminal(&engine, run).await;
    assert_eq!(
        recovered.status,
        TaskStatus::Completed,
        "run={run}; native_run={:?}; output={}",
        recovered.background_run,
        recovered
            .output
            .as_deref()
            .unwrap_or_default()
            .chars()
            .take(512)
            .collect::<String>()
    );
    assert_ne!(recovered.background_run.as_ref(), Some(&old_root));
    let calls_after = role_calls.lock().unwrap().clone();
    for member in ["reader_a", "reader_b", "writer_a", "writer_b"] {
        assert_eq!(
            calls_after[member], calls_before[member],
            "successful member must not call a Provider again: {member}"
        );
    }
    assert!(calls_after["verify"] > calls_before["verify"]);
    let verifier_runs = actors.lock().unwrap()["verify"].clone();
    assert!(
        verifier_runs
            .iter()
            .skip(1)
            .all(|key| key.agent_id == old_verifier.agent_id
                && key.parent_session_id == old_verifier.parent_session_id
                && key.run_id != old_verifier.run_id)
    );
    assert_eq!(
        writes.load(Ordering::SeqCst),
        2,
        "completed native writes must not replay"
    );
    assert_eq!(
        std::fs::read_to_string(cwd.join("report.txt")).unwrap(),
        "final actual output"
    );
    let after_file = std::fs::metadata(cwd.join("report.txt")).unwrap();
    assert_eq!(
        after_file.modified().unwrap(),
        before_file.modified().unwrap()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            (before_file.dev(), before_file.ino()),
            (after_file.dev(), after_file.ino())
        );
    }
    assert_eq!(
        std::fs::read(run_dir.join("collaboration-artifacts-v1.json")).unwrap(),
        old_evidence
    );
    let after_journal = std::fs::read(journal).unwrap();
    assert!(
        after_journal.starts_with(&before_journal),
        "original failed run journal remains append-only"
    );
    assert!(
        engine
            .state
            .background_run_record(&old_verifier)
            .unwrap()
            .terminal
            .is_some()
    );
}
