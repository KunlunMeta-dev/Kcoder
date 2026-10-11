use super::*;
use kcoder_types::workflow::{WorkflowDefinition, WorkflowNode};
use kcoder_workflow::store::WorkflowStore;

#[path = "legacy_recovery_tests.rs"]
mod legacy_recovery_tests;
#[path = "legacy_script_tests.rs"]
mod legacy_script_tests;

#[derive(Default)]
struct FixtureRunner {
    calls: Mutex<HashMap<String, usize>>,
    failures: Mutex<HashMap<String, usize>>,
    observation: Mutex<Option<(PathBuf, String)>>,
    observed: Mutex<Vec<(String, u32)>>,
}

impl FixtureRunner {
    fn calls(&self, name: &str) -> usize {
        self.calls.lock().unwrap().get(name).copied().unwrap_or(0)
    }
}

#[async_trait]
impl AgentRunner for FixtureRunner {
    async fn run_agent(&self, _: String, _: usize) -> Result<String, AgentError> {
        panic!("recovery fixtures must not call a model")
    }

    fn workflow_tool_is_read_only(&self, name: &str) -> bool {
        name == "fixture_read"
    }

    async fn run_workflow_tool(
        &self,
        _: &str,
        name: &str,
        _: Value,
    ) -> Result<(ToolOutput, bool), AgentError> {
        *self.calls.lock().unwrap().entry(name.into()).or_default() += 1;
        if let Some((root, run)) = self.observation.lock().unwrap().as_ref() {
            let node = crate::workflow_runs::read(root.clone(), run)
                .unwrap()
                .node_states
                .remove(0);
            self.observed
                .lock()
                .unwrap()
                .push((node.status, node.attempt));
        }
        let mut failures = self.failures.lock().unwrap();
        let remaining = failures.entry(name.into()).or_default();
        if *remaining > 0 {
            *remaining -= 1;
            return Ok((ToolOutput::error("controlled transient failure"), false));
        }
        Ok((ToolOutput::text("fixture complete"), true))
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    profile: PathBuf,
    library: WorkflowStore,
    context: ToolContext,
    manager: Arc<ExecutingWorkflowManager>,
    runner: Arc<FixtureRunner>,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let state = AppState::new(temp.path());
        let project = profile.join("projects/recovery");
        fs::create_dir_all(&project).unwrap();
        state.with_history_path(project.join("session.jsonl"));
        let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
        let runner = Arc::new(FixtureRunner::default());
        let context = ToolContext::new(state)
            .with_settings_persistence_path(Some(profile.join("settings.json")))
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager.clone());
        Self {
            _temp: temp,
            library: WorkflowStore::new(profile.join("workflow-library")),
            profile,
            context,
            manager,
            runner,
        }
    }

    fn save(&self, nodes: Value) -> WorkflowDefinition {
        let draft = self.library.create("Recovery fixture", "").unwrap();
        let nodes: Vec<WorkflowNode> = serde_json::from_value(nodes).unwrap();
        let draft = self
            .library
            .patch_nodes(&draft.id, draft.revision, nodes, vec![])
            .unwrap();
        self.library.save(&draft.id, draft.revision).unwrap()
    }

    async fn start(&self, input: Value) -> Value {
        let output = WorkflowTool.call(input, &self.context).await.unwrap();
        assert!(!output.is_error);
        let kcoder_types::ContentBlock::Text { text } = &output.content[0] else {
            panic!("text receipt")
        };
        serde_json::from_str(text).unwrap()
    }

    async fn run(&self, input: Value) -> Value {
        let receipt = self.start(input).await;
        self.manager
            .wait_for_completion(receipt["run_id"].as_str().unwrap())
            .await;
        receipt
    }

    fn observation(&self, run: &str) -> kcoder_types::workflow_runs::WorkflowRunSnapshot {
        crate::workflow_runs::read(self.profile.join("workflow-runs"), run).unwrap()
    }

    fn journal(&self, run: &str) -> Vec<Value> {
        fs::read_to_string(workflow_run_dir(&self.context, run).join("journal.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn assert_completed(&self, run: &str, saved: &WorkflowDefinition) {
        let task = self.context.state.task(run).unwrap();
        assert_eq!(task.status, TaskStatus::Completed, "{:?}", task.output);
        let finish: Value = serde_json::from_str(task.output.as_deref().unwrap()).unwrap();
        assert_eq!(finish["status"], "completed");
        assert_eq!(self.observation(run).status, "completed");
        let evidence = self
            .library
            .verification(&saved.id, saved.saved_version.unwrap())
            .unwrap();
        let latest = evidence
            .runs
            .iter()
            .filter(|item| item.run_id == run)
            .max_by_key(|item| item.resume_count)
            .unwrap();
        assert_eq!(latest.execution_status, "completed");
        assert!(latest.output_sha256.is_some());
    }
}

fn effect_then_tail() -> Value {
    json!([
        {"id":"effect","title":"Effect","kind":"tool","config":{"tool":{"name":"fixture_effect","arguments":{}}}},
        {"id":"tail","title":"Tail","kind":"tool","dependsOn":["effect"],"config":{"tool":{"name":"fixture_tail","arguments":{}}}}
    ])
}

#[tokio::test]
async fn omitted_resume_settings_keep_the_original_completed_effect_identity() {
    let fixture = Fixture::new();
    let saved = fixture.save(effect_then_tail());
    fixture
        .runner
        .failures
        .lock()
        .unwrap()
        .insert("fixture_tail".into(), 1);
    let first = fixture
        .run(
            json!({"definition_id":saved.id,"version":1,"timeout_seconds":60,"max_agent_turns":10}),
        )
        .await;
    let run = first["run_id"].as_str().unwrap();
    assert_eq!(fixture.observation(run).status, "failed");
    assert_eq!(fixture.runner.calls("fixture_effect"), 1);
    let resumed = fixture.run(json!({"resume":run})).await;
    assert_eq!(
        fixture.runner.calls("fixture_effect"),
        1,
        "omitted settings must not replay the effect"
    );
    assert_eq!(fixture.runner.calls("fixture_tail"), 2);
    assert_eq!(resumed["timeout_seconds"], 60);
    assert_eq!(resumed["max_agent_turns"], 10);
    fixture.assert_completed(run, &saved);
    let status = fixture.observation(run);
    assert!(
        status
            .node_states
            .iter()
            .find(|node| node.node_id == "effect")
            .unwrap()
            .reused
    );
}

#[tokio::test]
async fn omitted_reuse_settings_preserve_source_identity_and_explicit_settings_invalidate_it() {
    let fixture = Fixture::new();
    let saved = fixture.save(effect_then_tail());
    let first = fixture
        .run(
            json!({"definition_id":saved.id,"version":1,"timeout_seconds":60,"max_agent_turns":10,"max_concurrency":2}),
        )
        .await;
    let source = first["run_id"].as_str().unwrap();
    let old_state =
        fs::read(workflow_run_dir(&fixture.context, source).join("state.json")).unwrap();
    let reused = fixture
        .run(json!({"definition_id":saved.id,"version":1,"reuse_from_run":source}))
        .await;
    assert_eq!(fixture.runner.calls("fixture_effect"), 1);
    assert_eq!(reused["timeout_seconds"], 60);
    assert_eq!(reused["max_agent_turns"], 10);
    assert_eq!(reused["max_concurrency"], 2);
    fixture.assert_completed(reused["run_id"].as_str().unwrap(), &saved);
    assert_eq!(
        fs::read(workflow_run_dir(&fixture.context, source).join("state.json")).unwrap(),
        old_state
    );
    let changed = fixture
        .run(json!({"resume":source,"timeout_seconds":61,"max_agent_turns":11}))
        .await;
    assert_eq!(
        fixture.runner.calls("fixture_effect"),
        2,
        "explicit changes invalidate settings-bound checkpoints"
    );
    assert_eq!(changed["timeout_seconds"], 61);
    assert_eq!(changed["max_agent_turns"], 11);
    fixture.assert_completed(source, &saved);
}

#[tokio::test]
async fn legacy_missing_settings_use_compatible_defaults() {
    let fixture = Fixture::new();
    let saved = fixture.save(effect_then_tail());
    let first = fixture
        .run(json!({"definition_id":saved.id,"version":1}))
        .await;
    let run = first["run_id"].as_str().unwrap();
    let path = workflow_run_dir(&fixture.context, run).join("state.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state.as_object_mut().unwrap().remove("timeout_seconds");
    state.as_object_mut().unwrap().remove("max_agent_turns");
    atomic_write_file(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    let resumed = fixture.run(json!({"resume":run})).await;
    assert_eq!(resumed["timeout_seconds"], 1800);
    assert_eq!(resumed["max_agent_turns"], 60);
    assert_eq!(fixture.runner.calls("fixture_effect"), 1);
    fixture.assert_completed(run, &saved);
}

#[tokio::test]
async fn subgraph_skips_stay_namespaced_and_finish_root_verification() {
    let fixture = Fixture::new();
    let child = fixture.save(json!([
        {"id":"route","title":"Route","kind":"condition","config":{"condition":{"op":"equals","pointer":"/input/selected","value":true}}},
        {"id":"child_skip","title":"Unselected","kind":"code","dependsOn":["route"],"runIf":{"nodeId":"route","equals":true},"config":{"code":{"source":"throw new Error('unselected branch ran');"}}}
    ]));
    let sub = json!({"definitionId":child.id,"version":1,"arguments":{"selected":false}});
    let root = fixture.save(json!([
        {"id":"call_a","title":"A","kind":"subworkflow","config":{"subworkflow":sub}},
        {"id":"call_b","title":"B","kind":"subworkflow","config":{"subworkflow":sub}},
        {"id":"each","title":"Each","kind":"loop","config":{"loop":{"mode":"repeat","maxIterations":2,"body":sub}}},
        {"id":"route","title":"Route","kind":"condition","config":{"condition":{"op":"equals","pointer":"/input/selected","value":true}}},
        {"id":"root_skip","title":"Skip","kind":"code","dependsOn":["route"],"runIf":{"nodeId":"route","equals":true},"config":{"code":{"source":"throw new Error('unselected root branch ran');"}}},
        {"id":"check","title":"Check","kind":"code","dependsOn":["call_a","call_b","each"],"config":{"code":{"source":"return nodes.each.count;"},"resultCheck":{"source":"return result === 2 && nodes.call_a.skipped.length === 1 && nodes.call_b.skipped[0] === 'child_skip' && nodes.each.iterations.every(child => child.skipped[0] === 'child_skip');"}}}
    ]));
    let started = fixture.run(json!({"definition_id":root.id,"version":1,"args":{"selected":false},"verification_scenario":{"id":"nested","requiredCheckNodes":["check"],"expectedSkippedNodes":["root_skip"]}})).await;
    let run = started["run_id"].as_str().unwrap();
    fixture.assert_completed(run, &root);
    let evidence = fixture
        .library
        .verification(&root.id, 1)
        .unwrap()
        .runs
        .remove(0);
    assert_eq!(evidence.skipped_nodes, ["root_skip"]);
    assert_eq!(evidence.checked_nodes, ["check"]);
    assert_eq!(evidence.scenario.unwrap().status, "passed");
    let nested_skips: Vec<_> = fixture
        .journal(run)
        .into_iter()
        .filter(|event| {
            event["type"] == "node_skipped"
                && event["node_id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("sub-"))
        })
        .collect();
    assert_eq!(
        nested_skips.len(),
        4,
        "child diagnostic events must remain observable"
    );
}

#[tokio::test]
async fn read_only_retry_observation_uses_attempt_and_retrying_before_completion() {
    let fixture = Fixture::new();
    let saved = fixture.save(json!([
        {"id":"read","title":"Read","kind":"tool","config":{"tool":{"name":"fixture_read","arguments":{}},"failurePolicy":{"maxAttempts":2,"delayMs":250},"resultCheck":{"source":"return result.isError === false && result.content[0].text === 'fixture complete';"}}}
    ]));
    fixture
        .runner
        .failures
        .lock()
        .unwrap()
        .insert("fixture_read".into(), 1);
    let started = fixture
        .start(json!({"definition_id":saved.id,"version":1}))
        .await;
    let run = started["run_id"].as_str().unwrap();
    *fixture.runner.observation.lock().unwrap() =
        Some((fixture.profile.join("workflow-runs"), run.into()));
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = fixture.observation(run);
            if snapshot.node_states[0].status == "retrying" {
                assert_eq!(snapshot.node_states[0].attempt, 0);
                assert!(
                    snapshot.node_states[0]
                        .error
                        .as_deref()
                        .unwrap()
                        .contains("controlled transient failure")
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    fixture.manager.wait_for_completion(run).await;
    assert!(
        fixture
            .runner
            .observed
            .lock()
            .unwrap()
            .contains(&("running".into(), 1))
    );
    assert_eq!(fixture.runner.calls("fixture_read"), 2);
    fixture.assert_completed(run, &saved);
    let observation = fixture.observation(run);
    assert_eq!(observation.node_states[0].status, "completed");
    assert_eq!(observation.node_states[0].attempt, 1);
    assert!(observation.node_states[0].error.is_none());
    let events: Vec<_> = fixture
        .journal(run)
        .into_iter()
        .filter(|event| event["node_id"] == "read")
        .collect();
    assert_eq!(
        events
            .iter()
            .map(|event| (
                event["type"].as_str().unwrap(),
                event["attempt"].as_u64().unwrap_or(0)
            ))
            .collect::<Vec<_>>(),
        [
            ("node_started", 0),
            ("node_failed", 0),
            ("node_started", 1),
            ("node_completed", 1)
        ]
    );
    assert_eq!(events[1]["will_retry"], true);
}

#[tokio::test]
async fn pure_retry_exhaustion_and_nonretryable_checks_keep_correct_terminal_events() {
    for (kind, config, expected_attempt, expected_calls) in [
        (
            "code",
            json!({"code":{"source":"throw new Error('ordinary failure');"},"failurePolicy":{"maxAttempts":3}}),
            2,
            3,
        ),
        (
            "code",
            json!({"code":{"source":"return 1;"},"failurePolicy":{"maxAttempts":3},"resultCheck":{"source":"return false;"}}),
            0,
            1,
        ),
        (
            "code",
            json!({"code":{"source":"return 1;"},"failurePolicy":{"maxAttempts":3},"outputSchema":{"type":"string"}}),
            0,
            1,
        ),
        (
            "template",
            json!({"template":"{{/input/text}}".repeat(5),"failurePolicy":{"maxAttempts":3}}),
            0,
            1,
        ),
    ] {
        let fixture = Fixture::new();
        let saved = fixture.save(json!([{"id":"pure","title":"Pure","kind":kind,"config":config}]));
        let started = fixture
            .run(json!({"definition_id":saved.id,"version":1,"args":{"text":"x".repeat(15_000)}}))
            .await;
        let run = started["run_id"].as_str().unwrap();
        assert_eq!(
            fixture.context.state.task(run).unwrap().status,
            TaskStatus::Failed
        );
        let status = fixture.observation(run);
        assert_eq!(status.node_states[0].status, "failed");
        assert_eq!(status.node_states[0].attempt, expected_attempt);
        let failures: Vec<_> = fixture
            .journal(run)
            .into_iter()
            .filter(|event| event["type"] == "node_failed")
            .collect();
        assert_eq!(failures.len(), expected_calls);
        assert_eq!(failures.last().unwrap()["will_retry"], false);
        assert!(
            failures[..failures.len() - 1]
                .iter()
                .all(|event| event["will_retry"] == true)
        );
        assert_eq!(
            fixture.library.verification(&saved.id, 1).unwrap().runs[0].execution_status,
            "failed"
        );
    }
}

#[tokio::test]
async fn unknown_effect_cannot_be_bypassed_by_changed_recovery_settings() {
    let fixture = Fixture::new();
    let saved = fixture.save(effect_then_tail());
    let started = fixture
        .run(json!({"definition_id":saved.id,"version":1}))
        .await;
    let run = started["run_id"].as_str().unwrap();
    atomic_write_file(
        &workflow_run_dir(&fixture.context, run).join("tool-unknown.json"),
        br#"{"status":"pending"}"#,
    )
    .unwrap();
    for input in [
        json!({"resume":run,"timeout_seconds":60,"max_agent_turns":10}),
        json!({"definition_id":saved.id,"version":1,"reuse_from_run":run,"timeout_seconds":60,"max_agent_turns":10}),
    ] {
        let error = WorkflowTool
            .call(input, &fixture.context)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unknown"));
    }
    assert_eq!(fixture.runner.calls("fixture_effect"), 1);
    assert_eq!(fixture.runner.calls("fixture_tail"), 1);
    assert_eq!(fixture.observation(run).resume_count, 0);
}

#[tokio::test]
async fn changed_resume_input_clears_old_completed_projection_before_new_failure() {
    let fixture = Fixture::new();
    let saved = fixture.save(json!([
        {"id":"first","title":"First","kind":"code","config":{"code":{"source":"if (input.failFirst) throw new Error('new input rejected'); return {old: 'successful value'};"}}},
        {"id":"tail","title":"Tail","kind":"code","dependsOn":["first"],"config":{"code":{"source":"throw new Error('tail failure');"}}}
    ]));
    let started = fixture
        .run(json!({"definition_id":saved.id,"version":1,"args":{"failFirst":false}}))
        .await;
    let run = started["run_id"].as_str().unwrap();
    assert_eq!(fixture.observation(run).node_states[0].status, "completed");
    fixture
        .run(json!({"resume":run,"args":{"failFirst":true}}))
        .await;
    let status = fixture.observation(run);
    assert_eq!(status.resume_count, 1);
    assert_eq!(status.node_states[0].status, "failed");
    assert!(
        status.node_states[0]
            .error
            .as_deref()
            .unwrap()
            .contains("new input rejected")
    );
    assert!(status.node_states[0].output_preview.is_none());
    assert!(!status.node_states[0].reused);
    let evidence = fixture.library.verification(&saved.id, 1).unwrap();
    assert_eq!(evidence.total_run_count, 2);
    assert!(
        evidence
            .runs
            .iter()
            .all(|item| item.execution_status == "failed")
    );
    assert_ne!(evidence.runs[0].input_sha256, evidence.runs[1].input_sha256);
    assert!(
        fs::read_to_string(
            workflow_run_dir(&fixture.context, run).join("verification-output-0.json")
        )
        .unwrap()
        .contains("tail failure")
    );
}
