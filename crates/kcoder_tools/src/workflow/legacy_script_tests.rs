use super::*;

const SCRIPT: &str =
    "await agent({prompt:'JS_FIRST'}); await agent({prompt:'JS_TAIL'}); return {ok:true};";

#[derive(Default)]
struct ScriptRunner {
    calls: Mutex<Vec<(String, usize)>>,
    tail_failed: Mutex<bool>,
}

#[async_trait]
impl AgentRunner for ScriptRunner {
    async fn run_agent(&self, prompt: String, turns: usize) -> Result<String, AgentError> {
        let label = if prompt.contains("JS_FIRST") {
            "first"
        } else {
            "tail"
        };
        self.calls.lock().unwrap().push((label.into(), turns));
        let mut failed = self.tail_failed.lock().unwrap();
        if label == "tail" && !*failed {
            *failed = true;
            return Err(AgentError::Execution("controlled JS tail failure".into()));
        }
        Ok(format!("synthetic completed {label}"))
    }
}

fn fixture() -> (Fixture, Arc<ScriptRunner>) {
    let mut fixture = Fixture::new();
    let runner = Arc::new(ScriptRunner::default());
    fixture.context = fixture.context.clone().with_agent_runner(runner.clone());
    (fixture, runner)
}

fn source(fixture: &Fixture, kind: &str) -> Value {
    match kind {
        "inline" => json!({"script":SCRIPT}),
        "name" => {
            let path = fixture
                .context
                .state
                .cwd()
                .join(".kcoder/workflows/legacy-script.js");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, SCRIPT).unwrap();
            json!({"name":"legacy-script"})
        }
        _ => {
            fs::write(fixture.context.state.cwd().join("legacy-script.js"), SCRIPT).unwrap();
            json!({"script_path":"legacy-script.js"})
        }
    }
}

fn remove_limits(fixture: &Fixture, run: &str) {
    let path = workflow_run_dir(&fixture.context, run).join("state.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state.as_object_mut().unwrap().remove("timeout_seconds");
    state.as_object_mut().unwrap().remove("max_agent_turns");
    atomic_write_file(&path, serde_json::to_vec(&state).unwrap()).unwrap();
}

fn completed_first_artifacts(fixture: &Fixture, run: &str) -> Vec<(PathBuf, Vec<u8>)> {
    for entry in fs::read_dir(workflow_run_dir(&fixture.context, run).join("agents")).unwrap() {
        let directory = entry.unwrap().path();
        let request: AgentRequest =
            serde_json::from_slice(&fs::read(directory.join("request.json")).unwrap()).unwrap();
        if request.prompt == "JS_FIRST" {
            return ["request.json", "output.md", "completed"]
                .into_iter()
                .map(|name| {
                    (
                        directory.join(name),
                        fs::read(directory.join(name)).unwrap(),
                    )
                })
                .collect();
        }
    }
    panic!("the successful first Agent must have durable artifacts")
}

fn assert_status(fixture: &Fixture, run: &str, expected: &str) {
    assert_eq!(fixture.observation(run).status, expected);
    let root = workflow_run_dir(&fixture.context, run);
    for name in ["state.json", "output.json"] {
        let value: Value = serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap();
        assert_eq!(value["status"], expected);
    }
    let task = fixture.context.state.task(run).unwrap();
    if expected == "completed" {
        assert_eq!(task.status, TaskStatus::Completed);
        let finish: Value = serde_json::from_str(task.output.as_deref().unwrap()).unwrap();
        assert_eq!(finish["status"], "completed");
        assert_eq!(finish["result"], json!({"ok":true}));
    } else {
        assert_eq!(task.status, TaskStatus::Failed);
        assert!(
            task.output
                .as_deref()
                .unwrap()
                .contains("workflow_recovery_settings_required")
        );
    }
}

#[tokio::test]
async fn legacy_script_custom_limits_block_all_sources_without_destroying_success_receipts() {
    for kind in ["inline", "name", "script_path"] {
        let (fixture, runner) = fixture();
        let mut input = source(&fixture, kind);
        input["timeout_seconds"] = json!(60);
        input["max_agent_turns"] = json!(10);
        let start = fixture.run(input).await;
        let run = start["run_id"].as_str().unwrap();
        assert_eq!(
            fixture.context.state.task(run).unwrap().status,
            TaskStatus::Failed
        );
        let before = completed_first_artifacts(&fixture, run);
        remove_limits(&fixture, run);
        let resume = fixture.run(json!({"resume":run})).await;
        assert_eq!(resume["execution_limits_unresolved"], true);
        assert_eq!(
            runner.calls.lock().unwrap().len(),
            2,
            "unproven resume must not start another Agent"
        );
        assert_status(&fixture, run, "failed");
        for (path, bytes) in &before {
            assert_eq!(&fs::read(path).unwrap(), bytes);
        }
        let restored = fixture
            .run(json!({"resume":run,"timeout_seconds":60,"max_agent_turns":10}))
            .await;
        assert_eq!(restored["execution_limits_unresolved"], false);
        assert_status(&fixture, run, "completed");
        assert_eq!(
            *runner.calls.lock().unwrap(),
            [
                ("first".into(), 10),
                ("tail".into(), 10),
                ("tail".into(), 10)
            ]
        );
        for (path, bytes) in before {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }
}

#[tokio::test]
async fn legacy_script_default_limits_prove_success_reuse_and_keep_failed_agent_retry() {
    for kind in ["inline", "name", "script_path"] {
        let (fixture, runner) = fixture();
        let start = fixture.run(source(&fixture, kind)).await;
        let run = start["run_id"].as_str().unwrap();
        remove_limits(&fixture, run);
        let resume = fixture.run(json!({"resume":run})).await;
        assert_eq!(resume["timeout_seconds"], 1800);
        assert_eq!(resume["max_agent_turns"], 60);
        assert_status(&fixture, run, "completed");
        assert_eq!(
            *runner.calls.lock().unwrap(),
            [
                ("first".into(), 60),
                ("tail".into(), 60),
                ("tail".into(), 60)
            ]
        );
    }
}

#[tokio::test]
async fn legacy_script_unproven_rejection_cannot_be_bypassed_by_a_second_omitted_resume() {
    let (fixture, runner) = fixture();
    let start = fixture
        .run(json!({"script":SCRIPT,"timeout_seconds":60,"max_agent_turns":10}))
        .await;
    let run = start["run_id"].as_str().unwrap();
    remove_limits(&fixture, run);
    for _ in 0..2 {
        fixture.run(json!({"resume":run})).await;
        assert_eq!(runner.calls.lock().unwrap().len(), 2);
        assert_status(&fixture, run, "failed");
    }
    fixture
        .run(json!({"resume":run,"timeout_seconds":60,"max_agent_turns":10}))
        .await;
    assert_status(&fixture, run, "completed");
    assert_eq!(
        *runner.calls.lock().unwrap(),
        [
            ("first".into(), 10),
            ("tail".into(), 10),
            ("tail".into(), 10)
        ]
    );
}
