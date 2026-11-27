use super::*;
use kcoder_types::evolution::{
    Attribution, EVOLUTION_RECORD_VERSION, EvolutionDisabledReason, ObservationMetrics,
    OutcomeObservation, SignalKind, UsageRecord,
};

/// Seed `count` usages of the skill across `threads` threads, each with a
/// redacted correction observation and evidence.
pub(super) fn seed_corrections(
    store: &EvolutionStore,
    target: &TargetKey,
    count: usize,
    threads: usize,
    text: &str,
) -> Vec<String> {
    let mut evidence = Vec::new();
    for index in 0..count {
        let usage_id = format!("seed-{target}-{index}").replace(':', "-");
        store
            .append_usage(&UsageRecord {
                version: EVOLUTION_RECORD_VERSION,
                usage_id: usage_id.clone(),
                thread_id: format!("thread-{}", index % threads),
                turn_id: Some("turn-1".into()),
                attempt_id: None,
                tool_call_id: None,
                target_key: target.clone(),
                revision: kcoder_types::evolution::TargetRevision::new("rev", 0),
                channel: kcoder_types::evolution::Channel::Stable,
                task: Default::default(),
                profile_hints: Default::default(),
                artifacts: Vec::new(),
                concurrent_targets: Vec::new(),
                started_at_ms: 1 + index as u64,
            })
            .unwrap();
        let id = store
            .put_evidence(
                &format!("correction\n{text} #{index}"),
                super::super::now_ms(),
                90,
            )
            .unwrap();
        evidence.push(id.clone());
        store
            .append_outcome(&OutcomeObservation {
                version: EVOLUTION_RECORD_VERSION,
                observation_id: format!("obs-{usage_id}"),
                usage_id,
                signal: SignalKind::Correction,
                metrics: ObservationMetrics {
                    correction_severity: Some(0.8),
                    ..Default::default()
                },
                categories: vec![kcoder_types::evolution::CategoryAssessment {
                    category: kcoder_types::evolution::OutcomeCategory::Structure,
                    domain: None,
                    confidence: 0.9,
                }],
                cause: None,
                attribution: Attribution::Direct,
                confidence: 1.0,
                conflict: false,
                hard_failure: false,
                evidence_ref: Some(id),
                source: "conversation".into(),
                observed_at_ms: 2,
            })
            .unwrap();
    }
    evidence
}

fn distill_settings() -> kcoder_config::Settings {
    let mut settings = settings(EvolutionMode::Propose);
    settings.evolution.distill_min_usages = 4;
    settings
}

#[tokio::test]
async fn distill_waits_for_the_threshold_and_a_held_lease_blocks_it() {
    let provider = ScriptedProvider::with_texts(&[]);
    let fixture = fixture_with(distill_settings(), provider.clone());
    let store = fixture.project_store();
    seed_corrections(&store, &skill_key(), 3, 3, "summary first");
    fixture.engine.poll_idle_maintenance();
    wait_idle(&fixture.engine).await;
    assert_eq!(provider.request_count(), 0, "below distill_min_usages");

    seed_corrections(&store, &skill_key(), 6, 3, "summary first again");
    let lease = store
        .try_job_lease("distill", Some(&skill_key()))
        .unwrap()
        .unwrap();
    fixture.engine.poll_idle_maintenance();
    wait_idle(&fixture.engine).await;
    assert_eq!(provider.request_count(), 0, "another owner holds the lease");
    drop(lease);
}

#[tokio::test]
async fn disabling_evolution_cancels_a_running_job_and_discards_it() {
    let provider = Arc::new(ScriptedProvider {
        hang: true,
        ..Default::default()
    });
    let fixture = fixture_with(distill_settings(), provider.clone());
    seed_corrections(
        &fixture.project_store(),
        &skill_key(),
        8,
        3,
        "summary first",
    );
    fixture.engine.poll_idle_maintenance();
    assert!(
        wait_until(|| provider.request_count() > 0).await,
        "distill fork started"
    );
    assert!(
        super::super::running_evolution_jobs()
            .iter()
            .any(|(_, key)| key.as_ref() == Some(&skill_key()))
    );
    fixture.engine.settings.write().unwrap().evolution.enabled = false;
    fixture.engine.poll_idle_maintenance();
    wait_idle(&fixture.engine).await;
    assert!(fixture.engine.evolution.lock_state().job.is_none());
    assert!(fixture.project_store().list_proposals().unwrap().is_empty());
    assert!(
        !super::super::running_evolution_jobs()
            .iter()
            .any(|(_, key)| key.as_ref() == Some(&skill_key()))
    );
}

#[tokio::test]
async fn data_clear_hook_cancels_jobs_under_the_scope_root() {
    let provider = Arc::new(ScriptedProvider {
        hang: true,
        ..Default::default()
    });
    let fixture = fixture_with(distill_settings(), provider.clone());
    seed_corrections(
        &fixture.project_store(),
        &skill_key(),
        8,
        3,
        "summary first",
    );
    fixture.engine.poll_idle_maintenance();
    assert!(wait_until(|| provider.request_count() > 0).await);
    let hooks = fixture.engine.evolution_hooks();
    let root = fixture.data.path().join("profile");
    let stopped = tokio::task::spawn_blocking(move || hooks.cancel_jobs(&root))
        .await
        .unwrap();
    assert!(stopped.is_ok());
    wait_idle(&fixture.engine).await;
    assert!(fixture.engine.evolution.lock_state().job.is_none());
}

#[tokio::test]
async fn an_unavailable_configured_model_pauses_without_fallback() {
    let provider = ScriptedProvider::with_texts(&[]);
    let mut settings = settings(EvolutionMode::Propose);
    settings.evolution.model = Some(kcoder_config::EvolutionModelRef {
        provider: "removed-provider".into(),
        model: "gone".into(),
    });
    let fixture = fixture_with(settings, provider.clone());
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "deploy");
    activate(engine, SKILL).await;
    end_turn(engine, guard);
    let guard = begin_turn(engine, "wrong");
    end_turn(engine, guard);
    engine.poll_idle_maintenance();
    wait_idle(engine).await;
    assert_eq!(
        provider.request_count(),
        0,
        "never falls back to the session model"
    );
    assert_eq!(
        engine.evolution_paused_reason(),
        Some(EvolutionDisabledReason::ModelUnavailable)
    );
    assert_eq!(
        engine.evolution.lock_state().pending.len(),
        1,
        "work stays queued"
    );
    assert!(matches!(
        engine.request_evolution_distill(&skill_key()),
        super::super::DistillRequestOutcome::ModelUnavailable(_)
    ));
}

#[tokio::test]
async fn the_monthly_token_limit_pauses_model_jobs() {
    let provider = ScriptedProvider::with_texts(&[]);
    let mut settings = settings(EvolutionMode::Propose);
    settings.evolution.usage_limit.monthly_max_tokens = Some(100);
    let fixture = fixture_with(settings, provider.clone());
    fixture
        .store(ScopeKind::User)
        .record_model_usage(super::super::now_ms(), 90, 20)
        .unwrap();
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "deploy");
    activate(engine, SKILL).await;
    end_turn(engine, guard);
    let guard = begin_turn(engine, "wrong");
    end_turn(engine, guard);
    engine.poll_idle_maintenance();
    assert_eq!(provider.request_count(), 0);
    assert_eq!(
        engine.evolution_paused_reason(),
        Some(EvolutionDisabledReason::UsageLimit)
    );
}
