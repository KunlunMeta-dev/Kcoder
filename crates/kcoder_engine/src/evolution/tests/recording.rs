use super::*;
use kcoder_evolution::{OverlaySlotSource, RolloutPolicy, overlay_marker};
use kcoder_types::evolution::{Channel, OverlayContent};

fn lessons(text: &str) -> OverlayContent {
    OverlayContent {
        lessons: text.into(),
        ..Default::default()
    }
}

fn base_revision(fixture: &Fixture) -> String {
    let registry = fixture.engine.skill_registry.read().unwrap();
    kcoder_tools::evolution_service::skill_base_revision(registry.get(SKILL).unwrap())
}

#[tokio::test]
async fn activation_records_a_usage_with_channel_task_evidence_and_telemetry() {
    let fixture = fixture(EvolutionMode::Propose);
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "部署前检查一下，api_key=supersecretvalue1234");
    activate(engine, SKILL).await;
    end_turn(engine, guard);
    let store = fixture.project_store();
    let usages = store.read_amended_usages().unwrap().records;
    assert_eq!(usages.len(), 1);
    let usage = &usages[0];
    assert_eq!(usage.target_key, skill_key());
    assert_eq!(usage.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(usage.thread_id, engine.state.session_id());
    assert_eq!(usage.channel, Channel::Stable);
    assert_eq!(usage.revision.base_revision, base_revision(&fixture));
    assert!(usage.profile_hints.text_only, "settle amended the hints");
    let evidence = store
        .read_evidence(
            usage.task.evidence_ref.as_deref().unwrap(),
            super::super::now_ms(),
        )
        .unwrap()
        .unwrap();
    assert!(evidence.text.contains("部署前检查"));
    assert!(
        !evidence.text.contains("supersecretvalue1234"),
        "evidence is redacted"
    );
    assert!(usage.task.request_hash.is_some());
    // The legacy telemetry counter keeps working.
    let telemetry =
        kcoder_tools::skill_telemetry::load_project_usage(fixture.project.path()).unwrap();
    assert_eq!(telemetry.skills[SKILL].use_count, 1);

    // During a canary the channel follows the deterministic assignment.
    let key = skill_key();
    let document = store
        .stage_candidate(
            &key,
            None,
            &base_revision(&fixture),
            &lessons("- candidate lesson"),
            "prop-1",
            1,
        )
        .unwrap();
    store.start_canary(&key, document.revision, 0.5, 2).unwrap();
    let guard = begin_turn(engine, "再检查一次");
    let text = activate(engine, SKILL).await;
    let expected = canary_policy().assign_channel(&engine.state.session_id(), &key, true);
    assert_eq!(
        text.contains("candidate lesson"),
        expected == Channel::Candidate
    );
    end_turn(engine, guard);
    let usages = store.read_usages().unwrap().records;
    assert_eq!(usages.len(), 2);
    let expected = canary_policy().assign_channel(&engine.state.session_id(), &key, true);
    assert_eq!(usages[1].channel, expected);
}

#[tokio::test]
async fn disabled_training_and_workflow_draft_record_and_inject_nothing() {
    let mut disabled = settings(EvolutionMode::Propose);
    disabled.evolution.enabled = false;
    let mut training = settings(EvolutionMode::Propose);
    training.enable_training_mode();
    for (label, settings) in [
        ("disabled", disabled),
        ("training", training),
        ("draft", settings(EvolutionMode::Observe)),
    ] {
        let fixture = fixture_with(settings, ScriptedProvider::with_texts(&[]));
        if label == "draft" {
            fixture
                .engine
                .state
                .enter_workflow_draft_before_first_message()
                .unwrap();
        }
        // An accepted overlay exists, but must not be injected.
        let profile = fixture.data.path().join("profile");
        let root = kcoder_evolution::resolve_scope_root(
            &profile,
            &kcoder_evolution::EvolutionScope::Project {
                cwd: fixture.project.path().to_path_buf(),
            },
        )
        .unwrap();
        let store = EvolutionStore::open(&root).unwrap();
        store
            .write_stable_overlay(
                &skill_key(),
                None,
                &base_revision(&fixture),
                &lessons("- learned"),
                OverlaySlotSource::User,
                1,
            )
            .unwrap();
        let engine = &fixture.engine;
        let guard = begin_turn(engine, "check");
        let text = activate(engine, SKILL).await;
        end_turn(engine, guard);
        assert!(!text.contains("evolution_overlay"), "{label}: no injection");
        assert!(
            store.read_usages().unwrap().records.is_empty(),
            "{label}: no usage"
        );
        engine.poll_idle_maintenance();
        assert!(
            engine.evolution.lock_state().job.is_none(),
            "{label}: no job"
        );
    }
}

#[tokio::test]
async fn overlay_is_injected_once_persisted_and_not_reinjected_on_restore() {
    // Observe mode still serves accepted stable overlays.
    let fixture = fixture(EvolutionMode::Observe);
    let engine = &fixture.engine;
    let store = fixture.project_store();
    let document = store
        .write_stable_overlay(
            &skill_key(),
            None,
            &base_revision(&fixture),
            &lessons("- Summarize failures first."),
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    let marker = overlay_marker(&skill_key(), document.stable.as_ref().unwrap().revision);
    let guard = begin_turn(engine, "deploy");
    let first = activate(engine, SKILL).await;
    end_turn(engine, guard);
    assert!(first.contains(&marker));
    assert!(first.contains("Summarize failures first."));
    let usage = &store.read_usages().unwrap().records[0];
    assert_eq!(
        usage.revision.overlay_revision,
        document.stable.as_ref().unwrap().revision
    );

    let guard = begin_turn(engine, "deploy again");
    let second = activate(engine, SKILL).await;
    end_turn(engine, guard);
    assert!(!second.contains(&marker), "already in the transcript");

    // A restored session sees the persisted block and does not inject again.
    let restored_state = AppState::new(fixture.project.path());
    for message in engine.state.messages() {
        restored_state.add_message(message);
    }
    let restored = engine_for(
        fixture.project.path(),
        fixture.data.path(),
        settings(EvolutionMode::Observe),
        ScriptedProvider::with_texts(&[]),
        restored_state,
    );
    let guard = begin_turn(&restored, "deploy once more");
    let third = activate(&restored, SKILL).await;
    end_turn(&restored, guard);
    assert!(!third.contains(&marker));
    assert!(restored.state.messages().iter().any(|message| match message {
        Message::User { content, .. } => content.iter().any(|block| matches!(
            block,
            ContentBlock::ToolResult { content, .. } if content.iter().any(|inner| matches!(inner, ContentBlock::Text { text } if text.contains(&marker)))
        )),
        _ => false,
    }));
}

#[tokio::test]
async fn overlay_needing_revalidation_is_not_injected_and_records_the_base_change() {
    let fixture = fixture(EvolutionMode::Propose);
    let engine = &fixture.engine;
    let store = fixture.project_store();
    store
        .write_stable_overlay(
            &skill_key(),
            None,
            "sha256:previous",
            &lessons("- stale lesson"),
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    let guard = begin_turn(engine, "deploy");
    let text = activate(engine, SKILL).await;
    end_turn(engine, guard);
    assert!(!text.contains("stale lesson"));
    assert!(
        store
            .overlay_document(&skill_key())
            .unwrap()
            .unwrap()
            .needs_revalidation
    );
    let state = store.read_state().unwrap();
    assert_eq!(
        state.distill[&skill_key()].user_edit_evidence.len(),
        1,
        "base change is evidence"
    );
}

#[tokio::test]
async fn domain_and_global_preferences_are_injected_where_relevant() {
    let fixture = fixture(EvolutionMode::Propose);
    let user = fixture.store(ScopeKind::User);
    let document = user
        .update_preference("pref.skill.length", Some("Keep summaries short."), 0, 1)
        .unwrap();
    user.update_preference(
        "pref.global.language",
        Some("Answer in Chinese."),
        document.revision,
        2,
    )
    .unwrap();
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "deploy");
    let text = activate(engine, SKILL).await;
    end_turn(engine, guard);
    assert!(text.contains("Keep summaries short."));
    assert!(
        !text.contains("Answer in Chinese."),
        "global preferences ride the session context"
    );
    let memory = engine.with_evolution_preferences(String::new());
    assert!(memory.contains("Answer in Chinese."));
}

/// Assignment uses the traffic the canary was started with (0.5 here).
fn canary_policy() -> RolloutPolicy {
    let mut policy =
        RolloutPolicy::from_settings(&settings(EvolutionMode::Propose).evolution, false);
    policy.candidate_traffic = 0.5;
    policy
}

/// Activate a skill through the real `skill` tool with a provider tool call
/// id, persisting the call and its result under that id.
async fn activate_with_call(engine: &QueryEngine, name: &str, call_id: &str) {
    let mut context = engine.base_tool_context(100_000, 60_000, 40_000, None);
    context.tool_call_id = Some(call_id.into());
    let output = kcoder_tools::SkillTool
        .call(serde_json::json!({ "skill": name }), &context)
        .await
        .unwrap();
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: call_id.into(),
            name: "skill".into(),
            input: serde_json::json!({ "skill": name }),
        }],
        usage: None,
    });
    engine
        .state
        .add_message(Message::user_content(vec![ContentBlock::ToolResult {
            tool_use_id: call_id.into(),
            content: output.content,
            is_error: Some(false),
        }]));
}

/// The app-server numbers turns from its admission ledger (Hook-blocked
/// turns, compaction and resume do not renumber them), so a usage must carry
/// the running turn's attempt identity, never a recount of the live
/// messages. `/rate` resolves the same identity afterwards.
#[tokio::test]
async fn usages_take_the_attempt_turn_id_rather_than_a_live_message_count() {
    let fixture = fixture(EvolutionMode::Propose);
    let engine = &fixture.engine;
    let identity = kcoder_types::TurnAttemptIdentity {
        thread_id: engine.state.session_id(),
        turn_id: "turn-7".into(),
        attempt_id: "turn-7-retry-1".into(),
    };
    let scope = engine
        .state
        .history_attempt_scope(identity.clone())
        .unwrap();
    scope
        .run(async {
            let guard = begin_turn(engine, "check before deploying");
            activate_with_call(engine, SKILL, "toolu_skill_7").await;
            end_turn(engine, guard);
        })
        .await;
    let store = fixture.project_store();
    let usages = store.read_usages().unwrap().records;
    assert_eq!(usages.len(), 1);
    assert_eq!(
        usages[0].turn_id.as_deref(),
        Some("turn-7"),
        "only one real user message is live, yet the turn is the seventh"
    );
    assert_eq!(usages[0].attempt_id.as_deref(), Some("turn-7-retry-1"));
    assert_eq!(usages[0].tool_call_id.as_deref(), Some("toolu_skill_7"));
    assert_eq!(
        crate::evolution::latest_rating_turn_id(&engine.state).as_deref(),
        Some("turn-7"),
        "after the turn the tail of the transcript still belongs to it"
    );

    // A host without attempt records keeps the legacy `turn-N` numbering.
    let guard = begin_turn(engine, "and once more");
    activate_with_call(engine, SKILL, "provider call|not an id").await;
    end_turn(engine, guard);
    let usages = store.read_usages().unwrap().records;
    assert_eq!(usages.len(), 2);
    assert_eq!(usages[1].turn_id.as_deref(), Some("turn-2"));
    assert_eq!(usages[1].attempt_id, None);
    assert_eq!(
        usages[1].tool_call_id, None,
        "a call id that is not an evolution id is not kept, the usage still is"
    );
    assert_ne!(usages[0].usage_id, usages[1].usage_id);
    assert_eq!(
        crate::evolution::latest_rating_turn_id(&engine.state).as_deref(),
        Some("turn-2")
    );
}

/// A turn whose messages are appended without an attempt scope (for
/// example an aggregation follow-up) continues the turn it follows, as the
/// durable transcript projection groups it.
#[tokio::test]
async fn unscoped_follow_up_messages_continue_the_previous_attempt() {
    let fixture = fixture(EvolutionMode::Propose);
    let engine = &fixture.engine;
    let identity = kcoder_types::TurnAttemptIdentity {
        thread_id: engine.state.session_id(),
        turn_id: "turn-3".into(),
        attempt_id: "turn-3".into(),
    };
    engine
        .state
        .history_attempt_scope(identity)
        .unwrap()
        .run(async {
            engine
                .state
                .add_message(Message::user_text("start the release"));
            engine
                .state
                .add_message(Message::assistant_text("Started."));
        })
        .await;
    // Not a real user message: no new turn starts.
    engine.state.add_message(Message::runtime_text(
        "<system-reminder>background agents finished</system-reminder>",
    ));
    let guard = crate::turn_driver::TurnDriverActiveGuard::new(engine);
    activate_with_call(engine, SKILL, "toolu_follow_up").await;
    drop(guard);
    let usages = fixture.project_store().read_usages().unwrap().records;
    assert_eq!(usages.len(), 1);
    assert_eq!(usages[0].turn_id.as_deref(), Some("turn-3"));
    assert_eq!(usages[0].tool_call_id.as_deref(), Some("toolu_follow_up"));
}
