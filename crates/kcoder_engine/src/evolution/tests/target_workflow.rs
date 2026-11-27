//! `workflow_template` target: run usages, distinct outcomes and templates
//! applied only to newly started runs.

use super::*;
use crate::deferred_tool_dispatch::ModelToolRegistry;
use crate::evolution::target_workflow::{agent_template, run_usage_id};
use async_trait::async_trait;
use kcoder_evolution::{OverlaySlotSource, overlay_marker};
use kcoder_state::{Task, TaskKind};
use kcoder_tools::{ToolContext, ToolError, ToolOutput};
use kcoder_types::TaskStatus;
use kcoder_types::evolution::{OutcomeCause, OverlayContent, SignalKind};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Fake launcher: `spawn_agent` finishes in the foreground with a status
/// chosen by its message; `Workflow` starts or resumes a background run.
struct Launcher {
    name: &'static str,
    inputs: Arc<Mutex<Vec<Value>>>,
    next: AtomicUsize,
}

#[async_trait]
impl Tool for Launcher {
    fn name(&self) -> String {
        self.name.into()
    }

    fn description(&self) -> String {
        "Fake run launcher.".into()
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.inputs.lock().unwrap().push(input.clone());
        let n = self.next.fetch_add(1, Ordering::SeqCst);
        if self.name == "Workflow" {
            if let Some(run) = input.get("resume").and_then(Value::as_str) {
                if let Some(mut task) = ctx.state.task(run) {
                    task.status = TaskStatus::Running;
                    ctx.state.upsert_task(task);
                }
                return Ok(ToolOutput::text(
                    json!({"run_id": run, "status": "running", "resumed": true}).to_string(),
                ));
            }
            let run = format!("wf-{n}");
            let mut task = Task::new(&run, "Workflow: test");
            task.kind = TaskKind::Workflow;
            task.status = TaskStatus::Running;
            ctx.state.upsert_task(task);
            return Ok(ToolOutput::text(
                json!({"run_id": run, "status": "running", "resumed": false}).to_string(),
            ));
        }
        let message = input
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let agent = format!("agent-{n}");
        let mut task = Task::new(&agent, "Agent");
        task.kind = TaskKind::Subagent;
        task.usage.input_tokens = 1000;
        task.usage.output_tokens = 200;
        let (status, output) = if message.starts_with("FAIL") {
            (TaskStatus::Failed, "assertion mismatch in report")
        } else if message.starts_with("NET") {
            (TaskStatus::Failed, "provider error: connection refused")
        } else if message.starts_with("CANCEL") {
            (TaskStatus::Cancelled, "cancelled")
        } else if message.starts_with("UNKNOWN") {
            (TaskStatus::Unknown("lost".into()), "")
        } else if message.starts_with("BACKGROUND") {
            (TaskStatus::Running, "")
        } else {
            (TaskStatus::Completed, "done")
        };
        task.status = status.clone();
        task.output = Some(output.into());
        ctx.state.upsert_task(task);
        let output =
            ToolOutput::text(json!({"agent_id": agent, "status": status.as_str()}).to_string());
        Ok(if status == TaskStatus::Failed {
            ToolOutput {
                is_error: true,
                ..output
            }
        } else {
            output
        })
    }
}

struct Launchers {
    fixture: Fixture,
    agent_inputs: Arc<Mutex<Vec<Value>>>,
    workflow_inputs: Arc<Mutex<Vec<Value>>>,
}

fn template_settings(enabled: bool) -> Settings {
    let mut settings = settings(EvolutionMode::Propose);
    settings.evolution.targets.workflow_template.enabled = Some(enabled);
    settings
}

fn launchers(settings: Settings) -> Launchers {
    let project = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let agent_inputs = Arc::new(Mutex::new(Vec::new()));
    let workflow_inputs = Arc::new(Mutex::new(Vec::new()));
    let tools = ToolRegistry::new()
        .register(Launcher {
            name: "spawn_agent",
            inputs: Arc::clone(&agent_inputs),
            next: AtomicUsize::new(0),
        })
        .register(Launcher {
            name: "Workflow",
            inputs: Arc::clone(&workflow_inputs),
            next: AtomicUsize::new(0),
        });
    let engine = QueryEngine::new(
        ScriptedProvider::with_texts(&[]),
        AppState::new(project.path()),
        tools,
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::with_path(data.path().join("memories.json"))),
        SkillRegistry::load_project_only(project.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        project.path().to_path_buf(),
    );
    engine.set_evolution_data_root(data.path().join("profile"));
    Launchers {
        fixture: Fixture {
            project,
            data,
            engine,
        },
        agent_inputs,
        workflow_inputs,
    }
}

async fn launch(engine: &QueryEngine, name: &str, input: Value) -> String {
    let native = engine.active_tool_registry_for_mode(false);
    let deferred = engine.deferred_tools_snapshot();
    let (output, ..) = engine
        .execute_model_request_tool_observed(
            "launch",
            name,
            input,
            &kcoder_permissions::AutoAllowPrompt,
            ModelToolRegistry {
                native: &native,
                deferred: &deferred,
                arrangement_mode: false,
            },
        )
        .await
        .unwrap();
    output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn review_key() -> TargetKey {
    key("workflow_template:agent:review")
}

fn review_base() -> String {
    agent_template("spawn_agent", &json!({"agent_type": "review"}))
        .unwrap()
        .1
}

fn content(lessons: &str, checklist: &str) -> OverlayContent {
    OverlayContent {
        lessons: lessons.into(),
        checklist: checklist.into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn each_run_is_one_usage_with_distinct_terminal_outcomes() {
    let setup = launchers(template_settings(true));
    let engine = &setup.fixture.engine;
    let guard = begin_turn(engine, "review the change");
    for message in [
        "ok",
        "FAIL first",
        "CANCEL",
        "UNKNOWN",
        "NET down",
        "BACKGROUND",
    ] {
        launch(
            engine,
            "spawn_agent",
            json!({"agent_type": "review", "message": message}),
        )
        .await;
    }
    end_turn(engine, guard);
    let store = setup.fixture.store(ScopeKind::User);
    let usages = store.read_usages().unwrap().records;
    assert_eq!(usages.len(), 6);
    assert!(usages.iter().all(|usage| usage.target_key == review_key()));
    assert!(
        usages
            .iter()
            .all(|usage| !usage.task.arguments.as_deref().unwrap().contains("FAIL")),
        "launch summaries never carry the delegated message"
    );
    let outcome = |index: usize| {
        let id = run_usage_id(&format!("agent-{index}"));
        store
            .read_outcomes()
            .unwrap()
            .records
            .into_iter()
            .filter(|item| item.usage_id == id && item.signal == SignalKind::TaskTerminal)
            .collect::<Vec<_>>()
    };
    let completed = &outcome(0)[0];
    assert_eq!(completed.metrics.success, Some(true));
    assert_eq!(completed.metrics.extra["completed"], 1.0);
    assert_eq!(completed.metrics.extra["inputTokens"], 1000.0);
    let failed = &outcome(1)[0];
    assert_eq!(failed.metrics.success, Some(false));
    assert_eq!(failed.cause, Some(OutcomeCause::Target));
    assert!(failed.evidence_ref.is_some());
    let cancelled = &outcome(2)[0];
    assert_eq!(cancelled.metrics.success, None);
    assert_eq!(cancelled.metrics.extra["cancelled"], 1.0);
    assert_eq!(
        cancelled.metrics.retry_count,
        Some(1),
        "re-spawn after a failure"
    );
    let unknown = &outcome(3)[0];
    assert_eq!(unknown.metrics.success, None);
    assert_eq!(unknown.metrics.extra["unknown"], 1.0);
    let environment = &outcome(4)[0];
    assert_eq!(environment.cause, Some(OutcomeCause::Environment));
    let weights = kcoder_evolution::SignalWeights::default();
    for (index, expected) in [
        (0, Some(1.0)),
        (1, Some(0.0)),
        (2, None),
        (3, None),
        (4, None),
    ] {
        let items = outcome(index);
        assert_eq!(
            kcoder_evolution::score_usage(items.iter(), &weights).score,
            expected,
            "run {index}"
        );
    }
    // The background run is observed once its task finishes.
    assert!(outcome(5).is_empty());
    let mut task = engine.state.task("agent-5").unwrap();
    task.status = TaskStatus::Completed;
    engine.state.upsert_task(task);
    engine.evolution_observe_runs();
    assert_eq!(outcome(5)[0].metrics.success, Some(true));
}

#[tokio::test]
async fn templates_apply_only_to_new_runs_and_resumes_keep_their_revision() {
    let setup = launchers(template_settings(true));
    let engine = &setup.fixture.engine;
    let user = setup.fixture.store(ScopeKind::User);
    let document = user
        .write_stable_overlay(
            &review_key(),
            None,
            &review_base(),
            &content("- Report findings by severity.", "- turn_budget: 70"),
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    let marker = overlay_marker(&review_key(), document.stable.as_ref().unwrap().revision);

    let guard = begin_turn(engine, "review");
    launch(
        engine,
        "spawn_agent",
        json!({"agent_type": "review", "message": "Review the diff."}),
    )
    .await;
    launch(
        engine,
        "spawn_agent",
        json!({"agent_type": "review", "message": "Review again.", "max_turns": 100}),
    )
    .await;
    end_turn(engine, guard);
    {
        let inputs = setup.agent_inputs.lock().unwrap();
        let message = inputs[0]["message"].as_str().unwrap();
        assert!(message.starts_with("Review the diff."));
        assert!(message.contains(&marker));
        assert!(message.contains("Report findings by severity."));
        assert!(!message.contains("turn_budget"));
        assert_eq!(
            inputs[0]["max_turns"], 70,
            "suggested budget fills an omitted cap"
        );
        assert_eq!(inputs[1]["max_turns"], 100, "an explicit cap is kept");
    }
    let usages = user.read_usages().unwrap().records;
    assert_eq!(
        usages[0].revision.overlay_revision,
        document.stable.as_ref().unwrap().revision
    );
    // Recorded templates resolve for distillation from their latest run.
    let (scope, body, base) = engine.evolution_distill_target(&review_key()).unwrap();
    assert_eq!(scope, ScopeKind::User);
    assert_eq!(base, review_base());
    assert!(body.contains("turn_budget: N"));

    // Workflow runs: guidance goes to the start receipt of new runs only.
    let project = setup.fixture.project_store();
    let workflow_key = key("workflow_template:named:nightly");
    let first = project
        .write_stable_overlay(
            &workflow_key,
            None,
            "script",
            &content("- Split the work per package.", ""),
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    let first_revision = first.stable.as_ref().unwrap().revision;
    let receipt = launch(engine, "Workflow", json!({"name": "nightly"})).await;
    assert!(receipt.contains(&overlay_marker(&workflow_key, first_revision)));
    assert_eq!(
        setup.workflow_inputs.lock().unwrap()[0],
        json!({"name": "nightly"}),
        "workflow launch parameters are not changed"
    );
    let second = project
        .write_stable_overlay(
            &workflow_key,
            Some(first.revision),
            "script",
            &content("- Run packages in dependency order.", ""),
            OverlaySlotSource::User,
            2,
        )
        .unwrap();
    let second_revision = second.stable.as_ref().unwrap().revision;
    assert_ne!(first_revision, second_revision);
    let resumed = launch(engine, "Workflow", json!({"resume": "wf-0"})).await;
    assert!(
        !resumed.contains("evolution_overlay"),
        "a resume gets nothing"
    );
    let runs: Vec<_> = project
        .read_usages()
        .unwrap()
        .records
        .into_iter()
        .filter(|usage| usage.usage_id == run_usage_id("wf-0"))
        .collect();
    assert_eq!(runs.len(), 1, "the resume reuses the original usage");
    assert_eq!(runs[0].revision.overlay_revision, first_revision);
    let mut task = engine.state.task("wf-0").unwrap();
    task.status = TaskStatus::Completed;
    engine.state.upsert_task(task);
    engine.evolution_observe_runs();
    let terminal: Vec<_> = project
        .read_outcomes()
        .unwrap()
        .records
        .into_iter()
        .filter(|item| item.usage_id == run_usage_id("wf-0"))
        .collect();
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0].metrics.success, Some(true));
    assert_eq!(terminal[0].metrics.retry_count, Some(1), "one resume");

    // A newly started run uses the new revision.
    let receipt = launch(engine, "Workflow", json!({"name": "nightly"})).await;
    assert!(receipt.contains(&overlay_marker(&workflow_key, second_revision)));
    let latest = project
        .read_usages()
        .unwrap()
        .records
        .into_iter()
        .find(|usage| usage.usage_id == run_usage_id("wf-2"))
        .unwrap();
    assert_eq!(latest.revision.overlay_revision, second_revision);
}

#[tokio::test]
async fn disabled_templates_record_and_apply_nothing() {
    let setup = launchers(template_settings(false));
    let engine = &setup.fixture.engine;
    setup
        .fixture
        .store(ScopeKind::User)
        .write_stable_overlay(
            &review_key(),
            None,
            &review_base(),
            &content("- learned", "turn_budget: 61"),
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    let guard = begin_turn(engine, "review");
    launch(
        engine,
        "spawn_agent",
        json!({"agent_type": "review", "message": "Review."}),
    )
    .await;
    let receipt = launch(engine, "Workflow", json!({"name": "nightly"})).await;
    end_turn(engine, guard);
    assert_eq!(
        setup.agent_inputs.lock().unwrap()[0],
        json!({"agent_type": "review", "message": "Review."})
    );
    assert!(!receipt.contains("evolution_overlay"));
    assert!(
        setup
            .fixture
            .store(ScopeKind::User)
            .read_usages()
            .unwrap()
            .records
            .is_empty()
    );
    assert!(
        setup
            .fixture
            .project_store()
            .read_usages()
            .unwrap()
            .records
            .is_empty()
    );
}
