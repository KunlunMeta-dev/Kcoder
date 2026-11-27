use super::*;
use crate::evolution::distill::gather_evidence_since;
use kcoder_types::evolution::{
    ArtifactRef, Channel, EVOLUTION_RECORD_VERSION, OutcomeObservation, OverlayCandidateState,
    OverlayContent, ProposalChanges, ProposalState, SignalKind, TargetRevision, UsageRecord,
};

#[test]
fn the_distill_cursor_skips_evidence_offered_to_the_previous_run() {
    let fixture = fixture(EvolutionMode::Propose);
    let store = fixture.project_store();
    super::jobs::seed_corrections(&store, &skill_key(), 6, 2, "outcome first");
    let now = super::super::now_ms();
    let (all, _) = gather_evidence_since(&store, &skill_key(), &[], &[], now, None);
    assert_eq!(all.len(), 6);
    // Seeded observations are older than the previous run's start.
    let (fresh, _) = gather_evidence_since(&store, &skill_key(), &[], &[], now, Some(10));
    assert!(fresh.is_empty());
}

fn terminal(id: &str, usage_id: &str, ok: bool, at: u64) -> OutcomeObservation {
    OutcomeObservation {
        version: EVOLUTION_RECORD_VERSION,
        observation_id: id.into(),
        usage_id: usage_id.into(),
        signal: SignalKind::TaskTerminal,
        metrics: kcoder_types::evolution::ObservationMetrics {
            success: Some(ok),
            ..Default::default()
        },
        categories: Vec::new(),
        cause: (!ok).then_some(kcoder_types::evolution::OutcomeCause::Target),
        attribution: kcoder_types::evolution::Attribution::Direct,
        confidence: 1.0,
        conflict: false,
        hard_failure: false,
        evidence_ref: None,
        source: "procedure".into(),
        observed_at_ms: at,
    }
}

#[tokio::test]
async fn the_classification_queue_survives_a_restart() {
    let provider = ScriptedProvider::with_texts(&[]);
    let settings = settings(EvolutionMode::Propose);
    let fixture = fixture_with(settings.clone(), provider.clone());
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "deploy");
    activate(engine, SKILL).await;
    end_turn(engine, guard);
    let guard = begin_turn(engine, "no, that is wrong");
    end_turn(engine, guard);
    assert_eq!(engine.evolution.lock_state().pending.len(), 1);
    let user = fixture.store(ScopeKind::User);
    let project = fixture.project_store();
    let persisted = user.read_classification_queue().unwrap().len()
        + project.read_classification_queue().unwrap().len();
    assert_eq!(persisted, 1);

    // A new engine over the same data (a restarted process) restores the
    // queue and classifies it.
    let restarted = engine_for(
        fixture.project.path(),
        fixture.data.path(),
        settings,
        provider.clone(),
        AppState::new(fixture.project.path()),
    );
    restarted.poll_idle_maintenance();
    assert!(wait_until(|| provider.request_count() > 0).await);
    wait_idle(&restarted).await;
    assert!(restarted.evolution.lock_state().pending.is_empty());
    assert!(user.read_classification_queue().unwrap().is_empty());
    assert!(project.read_classification_queue().unwrap().is_empty());
    // Another engine that still holds the item in memory does not classify
    // it again: the persisted queue is authoritative.
    let held = fixture.engine.evolution.lock_state().pending.clone();
    assert_eq!(held.len(), 1);
    assert!(
        fixture
            .engine
            .evolution
            .still_queued(held, &fixture.engine.cwd)
            .is_empty()
    );
}

#[tokio::test]
async fn a_file_written_by_a_shell_command_is_tracked_through_the_turn_capture() {
    let fixture = fixture(EvolutionMode::Propose);
    let engine = &fixture.engine;
    let guard = begin_turn(engine, "write the deployment report");
    activate(engine, SKILL).await;
    std::fs::write(fixture.path("report.md"), "# Report\n\nAll good.\n").unwrap();
    tool_call(
        engine,
        "bash",
        serde_json::json!({"command": "printf '# Report' > report.md"}),
        "",
        false,
    );
    end_turn(engine, guard);
    let store = fixture.project_store();
    let artifacts = |store: &EvolutionStore| -> Vec<ArtifactRef> {
        store
            .read_amended_usages()
            .unwrap()
            .records
            .into_iter()
            .flat_map(|usage| usage.artifacts)
            .collect()
    };
    assert!(
        artifacts(&store).is_empty(),
        "tool-input tracking cannot see shell writes"
    );

    let sink = engine.evolution_turn_file_sink().unwrap();
    sink.record_turn_files(
        fixture.project.path(),
        &["report.md".into(), "../escape.md".into()],
    );
    // A replayed capture adds nothing new.
    sink.record_turn_files(fixture.project.path(), &["report.md".into()]);
    let tracked = artifacts(&store);
    assert_eq!(tracked.len(), 1);
    assert!(matches!(&tracked[0], ArtifactRef::File { path, .. } if path.ends_with("report.md")));
    let usage = store.read_amended_usages().unwrap().records.remove(0);
    assert!(usage.profile_hints.wrote_files);

    // A later outside edit is observed like any other artifact.
    std::fs::write(
        fixture.path("report.md"),
        "# Report\n\nAll good.\n\n## Outcome\nDeployed.\n",
    )
    .unwrap();
    engine
        .evolution
        .check_artifacts(&engine.cwd, super::super::now_ms());
    assert!(
        store
            .read_outcomes()
            .unwrap()
            .records
            .iter()
            .any(|item| item.signal == SignalKind::ArtifactEdit)
    );
}

#[tokio::test]
async fn idle_compaction_skips_small_journals_and_keeps_statistics() {
    let fixture = fixture(EvolutionMode::Propose);
    let store = fixture.project_store();
    let old = super::super::now_ms() - 400 * 24 * 60 * 60 * 1000;
    for index in 0..4u64 {
        let usage_id = format!("old-{index}");
        store
            .append_usage(&UsageRecord {
                version: EVOLUTION_RECORD_VERSION,
                usage_id: usage_id.clone(),
                thread_id: "t".into(),
                turn_id: None,
                attempt_id: None,
                tool_call_id: None,
                target_key: skill_key(),
                revision: TargetRevision::new("rev", 0),
                channel: Channel::Stable,
                task: Default::default(),
                profile_hints: Default::default(),
                artifacts: Vec::new(),
                concurrent_targets: Vec::new(),
                started_at_ms: old + index,
            })
            .unwrap();
        store
            .append_outcome(&terminal(
                &format!("o-{index}"),
                &usage_id,
                index % 2 == 0,
                old + index + 1,
            ))
            .unwrap();
    }
    let weights = kcoder_evolution::SignalWeights::from_settings(
        &crate::evolution::canary::recover_settings(&fixture.engine)
            .evolution
            .signals,
    );
    let before = store.rebuild_stats(&weights).unwrap();
    let settings = crate::evolution::canary::recover_settings(&fixture.engine);
    // Small journals are left alone at the idle poll.
    fixture.engine.maybe_compact_evolution(&settings, false);
    assert_eq!(store.read_usages().unwrap().records.len(), 4);
    fixture.engine.maybe_compact_evolution(&settings, true);
    assert!(store.read_usages().unwrap().records.is_empty());
    let after = store.stats(&weights).unwrap();
    assert_eq!(before.buckets.len(), after.buckets.len());
    let bucket = |stats: &kcoder_evolution::EvolutionStats| {
        *stats
            .bucket(
                &skill_key(),
                &TargetRevision::new("rev", 0),
                Channel::Stable,
            )
            .unwrap()
    };
    assert_eq!(bucket(&before).observations, bucket(&after).observations);
    assert!((bucket(&before).alpha - bucket(&after).alpha).abs() < 1e-9);
    assert!(store.read_state().unwrap().jobs.contains_key("compact"));
}

#[tokio::test]
async fn curator_archives_persistently_low_scores_and_carries_the_overlay() {
    let fixture = fixture(EvolutionMode::Auto);
    let project = fixture.project.path();
    let name = "auto-skill";
    write_skill(project, name, "Do the automated thing.");
    kcoder_tools::skill_telemetry::record_skill_created(project, name);
    kcoder_tools::skill_provenance::record_agent_created(project, name);
    let key = key(&format!("skill:agent_created:{name}"));
    let store = fixture.project_store();
    // 25 failing stable usages: a persistently low score.
    for index in 0..25u64 {
        let usage_id = format!("low-{index}");
        store
            .append_usage(&UsageRecord {
                version: EVOLUTION_RECORD_VERSION,
                usage_id: usage_id.clone(),
                thread_id: format!("t-{index}"),
                turn_id: None,
                attempt_id: None,
                tool_call_id: None,
                target_key: key.clone(),
                revision: TargetRevision::new("rev", 0),
                channel: Channel::Stable,
                task: Default::default(),
                profile_hints: Default::default(),
                artifacts: Vec::new(),
                concurrent_targets: Vec::new(),
                started_at_ms: 1 + index,
            })
            .unwrap();
        store
            .append_outcome(&terminal(
                &format!("lo-{index}"),
                &usage_id,
                false,
                2 + index,
            ))
            .unwrap();
    }
    let stable = OverlayContent {
        lessons: "- Check the inputs first.".into(),
        ..Default::default()
    };
    let document = store
        .write_stable_overlay(
            &key,
            None,
            "rev",
            &stable,
            kcoder_evolution::OverlaySlotSource::User,
            1,
        )
        .unwrap();
    // A running canary is stopped by the archive (pointer switch only).
    let proposal = super::canary::scanned_proposal(
        &store,
        &key,
        "rev",
        ProposalChanges {
            lessons_add: vec!["- Retry once.".into()],
            ..Default::default()
        },
    );
    let staged = store
        .stage_candidate(
            &key,
            Some(document.revision),
            "rev",
            &OverlayContent {
                lessons: "- Check the inputs first.\n- Retry once.".into(),
                ..Default::default()
            },
            &proposal.proposal_id,
            2,
        )
        .unwrap();
    store.start_canary(&key, staged.revision, 0.1, 3).unwrap();
    let proposal = store
        .transition_proposal(
            &proposal.proposal_id,
            proposal.revision,
            ProposalState::Canary,
            kcoder_types::evolution::ProposalActor::Auto,
            None,
            3,
        )
        .unwrap();

    let context = fixture
        .engine
        .base_tool_context(100_000, 60_000, 40_000, None);
    let output = kcoder_tools::SkillCuratorTool
        .call(
            serde_json::json!({"action": "run", "stale_after_days": 0, "archive_after_days": 3650}),
            &context,
        )
        .await
        .unwrap();
    let text: String = output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(text.contains("evolution score"), "{text}");
    assert!(
        fixture
            .path(&format!(".kcoder/skills/.archive/{name}/SKILL.md"))
            .is_file()
    );
    assert!(
        fixture
            .path(".kcoder/skills/deploy-check/SKILL.md")
            .is_file(),
        "user-created skills without scores stay"
    );
    let ledger = store.read_rollout_ledger().unwrap();
    assert!(ledger.archived_targets.contains(&key));
    let view = store.read_overlay(&key).unwrap().unwrap();
    assert_eq!(
        view.stable.as_ref(),
        Some(&stable),
        "overlay kept with the target"
    );
    assert_eq!(
        view.document.candidate.unwrap().state,
        OverlayCandidateState::RolledBack
    );
    assert_eq!(
        store
            .read_proposal(&proposal.proposal_id)
            .unwrap()
            .unwrap()
            .state,
        ProposalState::RolledBack
    );

    kcoder_tools::SkillCuratorTool
        .call(
            serde_json::json!({"action": "restore", "name": name}),
            &context,
        )
        .await
        .unwrap();
    assert!(
        !store
            .read_rollout_ledger()
            .unwrap()
            .archived_targets
            .contains(&key)
    );
    let (_, served) = store
        .serving_overlay(&key, Channel::Stable)
        .unwrap()
        .unwrap();
    assert_eq!(
        served, stable,
        "the restored skill serves its overlay again"
    );
}
