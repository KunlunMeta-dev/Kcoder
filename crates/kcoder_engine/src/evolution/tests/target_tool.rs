//! `tool_usage` target: recording, classification, retries and hints.

use super::*;
use crate::deferred_tool_dispatch::ModelToolRegistry;
use crate::evolution::target_tool::{
    MAX_TOOL_USAGES_PER_TURN, ToolFailure, argument_shape, classify_tool_failure,
    tool_base_revision, tool_target_key,
};
use async_trait::async_trait;
use kcoder_evolution::{OverlaySlotSource, overlay_marker, score_usage};
use kcoder_tools::{ToolContext, ToolError, ToolOutput, ToolSource};
use kcoder_types::evolution::{
    OutcomeCategory, OutcomeCause, OutcomeObservation, OverlayContent, SignalKind, TargetType,
};
use serde_json::{Value, json};

/// Fails with a target error for `mode: "bad"`, an environment error for
/// `mode: "net"` and succeeds otherwise.
struct ProbeTool {
    name: String,
}

#[async_trait]
impl Tool for ProbeTool {
    fn name(&self) -> String {
        self.name.clone()
    }

    fn description(&self) -> String {
        "Probe a path for test purposes.".into()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "mode": {"type": "string"},
                "timeout_ms": {"type": "integer"}
            },
            "required": ["path"]
        })
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        match input.get("mode").and_then(Value::as_str) {
            Some("bad") => Err(ToolError::Execution(
                "probe failed: unsupported mode".into(),
            )),
            Some("net") => Err(ToolError::Execution(
                "connection refused by the remote host".into(),
            )),
            _ => Ok(ToolOutput::text("probed")),
        }
    }
}

fn probe_key() -> TargetKey {
    key("tool_usage:builtin:probe")
}

fn tool_settings(enabled: bool) -> Settings {
    let mut settings = settings(EvolutionMode::Propose);
    settings.evolution.targets.tool_usage.enabled = Some(enabled);
    settings
}

fn tool_fixture_with(settings: Settings, names: &[&str], state: Option<AppState>) -> Fixture {
    let project = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut tools = ToolRegistry::new();
    for name in names {
        tools = tools.register(ProbeTool {
            name: (*name).to_string(),
        });
    }
    let engine = QueryEngine::new(
        ScriptedProvider::with_texts(&[]),
        state.unwrap_or_else(|| AppState::new(project.path())),
        tools,
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::with_path(data.path().join("memories.json"))),
        SkillRegistry::load_project_only(project.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        project.path().to_path_buf(),
    );
    engine.set_evolution_data_root(data.path().join("profile"));
    Fixture {
        project,
        data,
        engine,
    }
}

fn tool_fixture(enabled: bool) -> Fixture {
    tool_fixture_with(tool_settings(enabled), &["probe"], None)
}

/// Run one model tool call through the observed gate and persist it in the
/// transcript like a real turn; returns the result text.
async fn call(engine: &QueryEngine, name: &str, input: Value) -> String {
    let native = engine.active_tool_registry_for_mode(false);
    let deferred = engine.deferred_tools_snapshot();
    let id = format!("call-{}", engine.state.messages().len());
    let (output, ..) = engine
        .execute_model_request_tool_observed(
            &id,
            name,
            input.clone(),
            &kcoder_permissions::AutoAllowPrompt,
            ModelToolRegistry {
                native: &native,
                deferred: &deferred,
                arrangement_mode: false,
            },
        )
        .await
        .unwrap();
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: id.clone(),
            name: name.into(),
            input,
        }],
        usage: None,
    });
    engine
        .state
        .add_message(Message::user_content(vec![ContentBlock::ToolResult {
            tool_use_id: id,
            content: output.content.clone(),
            is_error: Some(output.is_error),
        }]));
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

fn observations_of<'a>(
    outcomes: &'a [OutcomeObservation],
    usage: &str,
) -> Vec<&'a OutcomeObservation> {
    outcomes
        .iter()
        .filter(|item| item.usage_id == usage)
        .collect()
}

fn named<'a>(items: &[&'a OutcomeObservation], part: &str) -> Option<&'a OutcomeObservation> {
    items.iter().copied().find(|item| {
        item.observation_id
            == crate::evolution::turns::observation(
                &item.usage_id,
                SignalKind::ToolResult,
                "tool_usage",
                &[part],
            )
            .observation_id
    })
}

#[test]
fn keys_shapes_and_failure_classes_are_deterministic() {
    assert_eq!(
        tool_target_key("read", &ToolSource::Builtin).unwrap(),
        key("tool_usage:builtin:read")
    );
    assert_eq!(
        tool_target_key(
            "mcp__github__create_issue",
            &ToolSource::Mcp {
                server: "github".into(),
                tool: "create_issue".into()
            }
        )
        .unwrap(),
        key("tool_usage:mcp:github.create_issue")
    );
    assert_eq!(
        tool_target_key(
            "x",
            &ToolSource::Plugin {
                plugin: "acme".into(),
                server: "srv".into(),
                tool: "run".into()
            }
        )
        .unwrap(),
        key("tool_usage:plugin:acme.srv.run")
    );
    // Shapes keep field names and types, never values.
    let shape = argument_shape(&json!({"path": "secret-path", "n": 3, "opts": {"b": 1, "a": 2}}));
    assert_eq!(shape, "{n: number, opts: object{a, b}, path: string}");
    assert!(!shape.contains("secret-path"));
    assert_eq!(
        classify_tool_failure("Tool `x` input validation failed: timeout_ms", false),
        ToolFailure::InvalidArguments
    );
    assert_eq!(
        classify_tool_failure("connection refused", false),
        ToolFailure::Environment
    );
    assert_eq!(
        classify_tool_failure("anything", true),
        ToolFailure::Environment
    );
    assert_eq!(
        classify_tool_failure("file has no such section", false),
        ToolFailure::Target
    );
}

#[tokio::test]
async fn calls_record_one_usage_per_turn_with_classified_failures_and_retries() {
    let fixture = tool_fixture(true);
    let engine = &fixture.engine;
    let secret = "api_key=supersecretvalue1234";

    // Turn 1: a target failure, then success with changed arguments.
    let guard = begin_turn(engine, "probe it");
    call(engine, "probe", json!({"path": secret, "mode": "bad"})).await;
    call(engine, "probe", json!({"path": secret})).await;
    end_turn(engine, guard);
    // Turn 2: only an environment failure.
    let guard = begin_turn(engine, "probe the remote");
    call(engine, "probe", json!({"path": "y", "mode": "net"})).await;
    end_turn(engine, guard);
    // Turn 3: invalid arguments (missing `path`) and no recovery.
    let guard = begin_turn(engine, "probe without a path");
    call(engine, "probe", json!({"mode": "fast"})).await;
    end_turn(engine, guard);
    // Turn 4: a clean call.
    let guard = begin_turn(engine, "probe again");
    call(engine, "probe", json!({"path": "z"})).await;
    call(engine, "probe", json!({"path": "z"})).await;
    end_turn(engine, guard);

    let store = fixture.store(ScopeKind::User);
    let usages = store.read_usages().unwrap().records;
    assert_eq!(usages.len(), 4, "one usage per (turn, tool)");
    let base = {
        let tool = engine.tools.get("probe").unwrap();
        tool_base_revision(tool.as_ref())
    };
    for (index, usage) in usages.iter().enumerate() {
        assert_eq!(usage.target_key, probe_key());
        assert_eq!(
            usage.turn_id.as_deref(),
            Some(&*format!("turn-{}", index + 1))
        );
        assert_eq!(usage.revision.base_revision, base);
        assert!(!serde_json::to_string(usage).unwrap().contains(secret));
    }
    let outcomes = store.read_outcomes().unwrap().records;
    let weights = kcoder_evolution::SignalWeights::default();

    let first = observations_of(&outcomes, &usages[0].usage_id);
    let calls = named(&first, "calls").unwrap();
    assert_eq!(calls.metrics.success, Some(false));
    assert_eq!(calls.cause, Some(OutcomeCause::Target));
    assert_eq!(calls.metrics.retry_count, Some(1));
    assert_eq!(calls.metrics.extra["changedArgumentRetries"], 1.0);
    assert_eq!(calls.metrics.extra["recovered"], 1.0);
    assert_eq!(calls.categories[0].category, OutcomeCategory::Step);
    let evidence = store
        .read_evidence(
            calls.evidence_ref.as_deref().unwrap(),
            super::super::now_ms(),
        )
        .unwrap()
        .unwrap();
    assert!(
        evidence
            .text
            .contains("arguments shape: {mode: string, path: string}")
    );
    assert!(evidence.text.contains("recovered after 1 more call(s)"));
    assert!(!evidence.text.contains("supersecretvalue1234"));
    assert_eq!(named(&first, "final").unwrap().metrics.success, Some(true));
    let score = score_usage(first.iter().copied(), &weights).score.unwrap();
    assert!((score - 0.5).abs() < 1e-9, "recovered usage scores 0.5");

    let second = observations_of(&outcomes, &usages[1].usage_id);
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].cause, Some(OutcomeCause::Environment));
    assert_eq!(score_usage(second.iter().copied(), &weights).score, None);

    let third = observations_of(&outcomes, &usages[2].usage_id);
    let calls = named(&third, "calls").unwrap();
    assert_eq!(calls.metrics.extra["invalidArguments"], 1.0);
    assert_eq!(calls.categories[0].category, OutcomeCategory::Format);
    assert_eq!(named(&third, "final").unwrap().metrics.success, Some(false));
    assert_eq!(
        score_usage(third.iter().copied(), &weights).score,
        Some(0.0)
    );

    let fourth = observations_of(&outcomes, &usages[3].usage_id);
    assert_eq!(fourth.len(), 1);
    assert_eq!(fourth[0].metrics.extra["invocations"], 2.0);
    assert_eq!(
        score_usage(fourth.iter().copied(), &weights).score,
        Some(1.0)
    );
}

#[tokio::test]
async fn recording_is_capped_per_turn_and_needs_an_active_main_turn() {
    let names: Vec<String> = (0..10).map(|index| format!("probe{index}")).collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let fixture = tool_fixture_with(tool_settings(true), &refs, None);
    let engine = &fixture.engine;
    // Outside a turn driver nothing is recorded.
    call(engine, "probe0", json!({"path": "a"})).await;
    let guard = begin_turn(engine, "probe everything");
    for name in &refs {
        call(engine, name, json!({"path": "a"})).await;
        call(engine, name, json!({"path": "a"})).await;
    }
    end_turn(engine, guard);
    let usages = fixture
        .store(ScopeKind::User)
        .read_usages()
        .unwrap()
        .records;
    assert_eq!(usages.len(), MAX_TOOL_USAGES_PER_TURN);
    let mut keys: Vec<_> = usages
        .iter()
        .map(|usage| usage.target_key.clone())
        .collect();
    keys.dedup();
    assert_eq!(keys.len(), MAX_TOOL_USAGES_PER_TURN, "distinct tools");
}

#[tokio::test]
async fn hints_are_served_in_the_tool_result_once_per_session_and_on_first_errors() {
    let fixture = tool_fixture(true);
    let engine = &fixture.engine;
    let tool = engine.tools.get("probe").unwrap();
    let description = tool.description();
    let schema = tool.input_schema();
    let store = fixture.store(ScopeKind::User);
    let document = store
        .write_stable_overlay(
            &probe_key(),
            None,
            &tool_base_revision(tool.as_ref()),
            &OverlayContent {
                lessons: "- Pass `mode` only with a supported value.".into(),
                ..Default::default()
            },
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    let revision = document.stable.as_ref().unwrap().revision;
    let marker = overlay_marker(&probe_key(), revision);

    let guard = begin_turn(engine, "probe");
    let first = call(engine, "probe", json!({"path": "a"})).await;
    assert!(first.contains(&marker), "first call of the session");
    assert!(first.contains("supported value"));
    let second = call(engine, "probe", json!({"path": "a"})).await;
    assert!(!second.contains(&marker));
    // The model has seen the hint; this failure uses the `mode` it names.
    let failed = call(engine, "probe", json!({"path": "a", "mode": "bad"})).await;
    assert!(failed.contains(&marker), "first error of the turn");
    let failed_again = call(engine, "probe", json!({"path": "a", "mode": "bad"})).await;
    assert!(!failed_again.contains(&marker));
    end_turn(engine, guard);

    let guard = begin_turn(engine, "probe more");
    assert!(
        !call(engine, "probe", json!({"path": "b"}))
            .await
            .contains(&marker)
    );
    let environment = call(engine, "probe", json!({"path": "b", "mode": "net"})).await;
    assert!(
        !environment.contains(&marker),
        "environment errors get no hint"
    );
    assert!(
        call(engine, "probe", json!({"path": "b", "mode": "bad"}))
            .await
            .contains(&marker),
        "first error of a new turn"
    );
    end_turn(engine, guard);

    // The usage carries the served revision; following the hint and still
    // failing is a conflict.
    let usages = store.read_usages().unwrap().records;
    assert_eq!(usages[0].revision.overlay_revision, revision);
    let outcomes = store.read_outcomes().unwrap().records;
    let first_turn = observations_of(&outcomes, &usages[0].usage_id);
    assert!(named(&first_turn, "calls").unwrap().conflict);

    // Schema and description never change.
    let tool = engine.tools.get("probe").unwrap();
    assert_eq!(tool.description(), description);
    assert_eq!(tool.input_schema(), schema);
    assert!(!tool.description().contains("supported value"));

    // A restored session sees the persisted hint and does not get it again.
    let restored_state = AppState::new(fixture.project.path());
    for message in engine.state.messages() {
        restored_state.add_message(message);
    }
    let restored = QueryEngine::new(
        ScriptedProvider::with_texts(&[]),
        restored_state,
        ToolRegistry::new().register(ProbeTool {
            name: "probe".into(),
        }),
        PermissionEngine::from_settings(&tool_settings(true)),
        tool_settings(true),
        MemoryManager::global_only(MemoryStore::with_path(
            fixture.data.path().join("memories.json"),
        )),
        SkillRegistry::load_project_only(fixture.project.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        fixture.project.path().to_path_buf(),
    );
    restored.set_evolution_data_root(fixture.data.path().join("profile"));
    let guard = begin_turn(&restored, "probe after restore");
    let text = call(&restored, "probe", json!({"path": "c"})).await;
    end_turn(&restored, guard);
    assert!(!text.contains(&marker));
}

#[tokio::test]
async fn disabled_tool_usage_records_and_injects_nothing() {
    for enabled_master in [true, false] {
        let mut settings = tool_settings(false);
        settings.evolution.enabled = enabled_master;
        let fixture = tool_fixture_with(settings, &["probe"], None);
        let engine = &fixture.engine;
        let tool = engine.tools.get("probe").unwrap();
        let root = kcoder_evolution::resolve_scope_root(
            &fixture.data.path().join("profile"),
            &kcoder_evolution::EvolutionScope::User,
        )
        .unwrap();
        let store = EvolutionStore::open(&root).unwrap();
        store
            .write_stable_overlay(
                &probe_key(),
                None,
                &tool_base_revision(tool.as_ref()),
                &OverlayContent {
                    lessons: "- learned".into(),
                    ..Default::default()
                },
                OverlaySlotSource::User,
                1,
            )
            .unwrap();
        let guard = begin_turn(engine, "probe");
        let text = call(engine, "probe", json!({"path": "a", "mode": "bad"})).await;
        end_turn(engine, guard);
        assert!(!text.contains("evolution_overlay"));
        assert!(store.read_usages().unwrap().records.is_empty());
        assert!(store.read_outcomes().unwrap().records.is_empty());
    }
}

#[tokio::test]
async fn registered_tools_resolve_as_distillation_targets() {
    let fixture = tool_fixture(true);
    let engine = &fixture.engine;
    let (scope, body, base) = engine.evolution_distill_target(&probe_key()).unwrap();
    assert_eq!(scope, ScopeKind::User);
    assert!(body.contains("Probe a path for test purposes."));
    assert!(body.contains("path: string"));
    assert!(body.contains("600 characters"));
    let tool = engine.tools.get("probe").unwrap();
    assert_eq!(base, tool_base_revision(tool.as_ref()));
    assert!(
        engine
            .evolution_distill_target(&key("tool_usage:builtin:missing"))
            .is_none()
    );
}

#[test]
fn both_new_target_types_are_implemented() {
    assert!(kcoder_evolution::IMPLEMENTED_TARGET_TYPES.contains(&TargetType::ToolUsage));
    assert!(kcoder_evolution::IMPLEMENTED_TARGET_TYPES.contains(&TargetType::WorkflowTemplate));
    // Both stay off by default even when evolution is enabled.
    let defaults = kcoder_config::EvolutionSettings::default();
    assert!(!defaults.targets.type_enabled(TargetType::ToolUsage));
    assert!(!defaults.targets.type_enabled(TargetType::WorkflowTemplate));
}
