use super::*;
use serde_json::json;
use std::collections::BTreeMap;

fn usage() -> UsageRecord {
    UsageRecord {
        version: EVOLUTION_RECORD_VERSION,
        usage_id: "u-1".into(),
        thread_id: "thread-1".into(),
        turn_id: Some("turn-1".into()),
        attempt_id: None,
        tool_call_id: None,
        target_key: TargetKey::parse("skill:bundled:docx").unwrap(),
        revision: TargetRevision::new("rev-a", 2),
        channel: Channel::Candidate,
        task: UsageTask {
            request_hash: Some("abc".into()),
            ..Default::default()
        },
        profile_hints: ProfileHints {
            wrote_files: true,
            ..Default::default()
        },
        artifacts: vec![ArtifactRef::File {
            path: "out/report.docx".into(),
            content_hash: "sha256:00".into(),
        }],
        concurrent_targets: vec![TargetKey::parse("tool_usage:mcp:github.create_issue").unwrap()],
        started_at_ms: 1_700_000_000_000,
    }
}

#[test]
fn target_key_parses_and_preserves_case_and_inner_colons() {
    let key = TargetKey::parse("skill:Bundled:Docx:v2").unwrap();
    assert_eq!(key.target_type(), TargetType::Skill);
    assert_eq!(key.source(), "Bundled");
    assert_eq!(key.name(), "Docx:v2");
    assert_eq!(key.to_string(), "skill:Bundled:Docx:v2");
    assert_ne!(key, TargetKey::parse("skill:bundled:docx:v2").unwrap());
}

#[test]
fn target_key_rejects_malformed_values() {
    for value in [
        "",
        "skill",
        "skill:bundled",
        "skill::docx",
        "skill:bundled:",
        "unknown:bundled:docx",
        "Skill:bundled:docx",
        "skill:bun dled:docx",
        "skill:bundled: docx",
        "skill:bundled:do\ncx",
    ] {
        assert!(
            TargetKey::parse(value).is_err(),
            "{value:?} must be rejected"
        );
    }
    let long_name = format!("skill:user:{}", "n".repeat(TARGET_NAME_MAX_LEN + 1));
    assert!(TargetKey::parse(&long_name).is_err());
    assert!(matches!(
        TargetKey::parse("tool:mcp:x"),
        Err(EvolutionContractError::UnknownTargetType(kind)) if kind == "tool"
    ));
}

#[test]
fn target_key_serializes_as_string() {
    let key = TargetKey::parse("preference:user:global").unwrap();
    let value = serde_json::to_value(&key).unwrap();
    assert_eq!(value, json!("preference:user:global"));
    let back: TargetKey = serde_json::from_value(value).unwrap();
    assert_eq!(back, key);
    assert!(serde_json::from_value::<TargetKey>(json!("bad")).is_err());
}

#[test]
fn target_types_round_trip_through_wire_names() {
    for kind in TargetType::ALL {
        assert_eq!(TargetType::parse(kind.as_str()).unwrap(), kind);
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
    }
}

#[test]
fn usage_record_round_trips_in_camel_case_and_rejects_unknown_fields() {
    let record = usage();
    record.validate().unwrap();
    let value = serde_json::to_value(&record).unwrap();
    assert_eq!(value["usageId"], "u-1");
    assert_eq!(value["revision"]["baseRevision"], "rev-a");
    assert_eq!(value["revision"]["overlayRevision"], 2);
    assert_eq!(value["channel"], "candidate");
    assert_eq!(value["artifacts"][0]["kind"], "file");
    assert_eq!(value["artifacts"][0]["contentHash"], "sha256:00");
    assert_eq!(value["profileHints"]["wroteFiles"], true);
    let back: UsageRecord = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(back, record);

    let mut unknown = value;
    unknown["surprise"] = json!(true);
    assert!(serde_json::from_value::<UsageRecord>(unknown).is_err());
}

#[test]
fn usage_validation_rejects_unsafe_ids() {
    let mut record = usage();
    record.usage_id = "../escape".into();
    assert!(record.validate().is_err());
    let mut record = usage();
    record.thread_id = String::new();
    assert!(record.validate().is_err());
}

#[test]
fn outcome_observation_round_trips_with_defaults() {
    let value = json!({
        "version": 1,
        "observationId": "o-1",
        "usageId": "u-1",
        "signal": "correction",
        "metrics": {"correctionSeverity": 0.5},
        "categories": [{"category": "style", "domain": "dialogue", "confidence": 0.8}],
        "cause": "target",
        "source": "conversation",
        "observedAtMs": 5
    });
    let observation: OutcomeObservation = serde_json::from_value(value).unwrap();
    observation.validate().unwrap();
    assert_eq!(observation.attribution, Attribution::Direct);
    assert_eq!(observation.confidence, 1.0);
    assert!(!observation.conflict);
    assert_eq!(observation.categories[0].category, OutcomeCategory::Style);
    let encoded = serde_json::to_value(&observation).unwrap();
    assert_eq!(encoded["signal"], "correction");
    assert!(encoded.get("conflict").is_none());
    let back: OutcomeObservation = serde_json::from_value(encoded).unwrap();
    assert_eq!(back, observation);
}

#[test]
fn outcome_validation_rejects_out_of_range_metrics() {
    let mut observation: OutcomeObservation = serde_json::from_value(json!({
        "version": 1, "observationId": "o-1", "usageId": "u-1", "signal": "rating",
        "metrics": {"ratingValue": 1.5}, "source": "explicit", "observedAtMs": 1
    }))
    .unwrap();
    assert!(observation.validate().is_err());
    observation.metrics.rating_value = Some(0.0);
    observation.confidence = f64::NAN;
    assert!(observation.validate().is_err());
}

#[test]
fn every_signal_and_category_has_a_snake_case_name() {
    let signals = json!([
        "artifact_edit",
        "artifact_kept",
        "artifact_discarded",
        "regenerated",
        "correction",
        "tool_result",
        "verification",
        "task_terminal",
        "rating",
        "exported"
    ]);
    let parsed: Vec<SignalKind> = serde_json::from_value(signals).unwrap();
    assert_eq!(parsed.len(), 10);
    let categories = json!([
        "accuracy",
        "missing",
        "extra",
        "structure",
        "style",
        "length",
        "format",
        "step",
        "scope",
        "other"
    ]);
    let parsed: Vec<OutcomeCategory> = serde_json::from_value(categories).unwrap();
    assert_eq!(parsed.len(), 10);
}

#[test]
fn proposal_state_machine_allows_only_documented_transitions() {
    use ProposalState::*;
    assert!(Draft.can_transition_to(Evaluated));
    assert!(Draft.can_transition_to(Canary));
    assert!(Evaluated.can_transition_to(Canary));
    assert!(Canary.can_transition_to(Promoted));
    assert!(Canary.can_transition_to(RolledBack));
    assert!(Promoted.can_transition_to(RolledBack));
    assert!(!Draft.can_transition_to(Promoted));
    assert!(!Rejected.can_transition_to(Draft));
    assert!(!RolledBack.can_transition_to(Canary));
    assert!(!Promoted.can_transition_to(Canary));
    assert!(Rejected.is_terminal() && RolledBack.is_terminal() && !Promoted.is_terminal());
}

#[test]
fn proposal_round_trips_and_validates_history() {
    let proposal = Proposal {
        version: EVOLUTION_RECORD_VERSION,
        proposal_id: "prop-0123".into(),
        target_key: TargetKey::parse("skill:user_created:weekly-report").unwrap(),
        base_revision: "rev-a".into(),
        location: ProposalLocation::Overlay,
        changes: ProposalChanges {
            lessons_add: vec!["Lead with the summary.".into()],
            ..Default::default()
        },
        pattern_ids: vec!["P-1".into()],
        evidence_ids: vec!["ev-1".into()],
        safety_scan: Some(SafetyScanResult {
            passed: true,
            findings: vec![],
        }),
        evaluation: Some(EvaluationResult {
            completed: true,
            passed: true,
            wins: 6,
            losses: 2,
            ties: 1,
            hard_check_regressions: 0,
            diversity_delta: None,
            reason: None,
        }),
        state: ProposalState::Evaluated,
        history: vec![ProposalTransition {
            from: None,
            to: ProposalState::Draft,
            actor: ProposalActor::Auto,
            at_ms: 1,
            reason: None,
        }],
        revision: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    proposal.validate().unwrap();
    assert_eq!(proposal.evaluation.as_ref().unwrap().win_rate(), Some(0.75));
    let value = serde_json::to_value(&proposal).unwrap();
    assert_eq!(value["state"], "evaluated");
    assert_eq!(value["changes"]["lessonsAdd"][0], "Lead with the summary.");
    assert_eq!(value["history"][0]["actor"], "auto");
    let back: Proposal = serde_json::from_value(value).unwrap();
    assert_eq!(back, proposal);

    let mut empty = proposal;
    empty.history.clear();
    assert!(empty.validate().is_err());
}

#[test]
fn status_snapshot_serializes_for_rpc() {
    let snapshot = EvolutionStatusSnapshot {
        enabled: true,
        mode: EvolutionMode::Observe,
        disabled_reason: Some(EvolutionDisabledReason::ModelUnavailable),
        model: EvolutionModelStatus {
            selection: EvolutionModelSelection::Configured,
            provider: Some("KunLun".into()),
            model: Some("Model-X".into()),
            available: false,
        },
        targets: vec![EvolutionTargetTypeStatus {
            target_type: TargetType::ProjectKnowledge,
            enabled: true,
            implemented: false,
            learned_items: 0,
            pending_proposals: 0,
        }],
        usage_this_month: EvolutionUsageSummary::from(&EvolutionMonthUsage {
            month: "2026-11".into(),
            input_tokens: 3,
            output_tokens: 4,
        }),
        jobs: vec![EvolutionJobStatus {
            kind: EvolutionJobKind::Distill,
            target_key: Some(TargetKey::parse("skill:bundled:docx").unwrap()),
            state: EvolutionJobState::Idle,
            last_run_at: Some("2026-11-24T00:00:00Z".into()),
        }],
        skill_file_edits_supported: false,
        diagnostics: Default::default(),
    };
    let value = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(value["mode"], "observe");
    assert_eq!(value["disabledReason"], "model_unavailable");
    assert!(value["usageThisMonth"].get("estimatedCost").is_none());
    assert_eq!(value["jobs"][0]["lastRunAt"], "2026-11-24T00:00:00Z");
    assert_eq!(value["model"]["selection"], "configured");
    assert_eq!(value["model"]["provider"], "KunLun");
    assert_eq!(value["targets"][0]["type"], "project_knowledge");
    assert_eq!(value["targets"][0]["learnedItems"], 0);
    assert_eq!(value["usageThisMonth"]["inputTokens"], 3);
    assert_eq!(value["jobs"][0]["kind"], "distill");
    assert_eq!(value["jobs"][0]["targetKey"], "skill:bundled:docx");
    let back: EvolutionStatusSnapshot = serde_json::from_value(value).unwrap();
    assert_eq!(back, snapshot);
}

#[test]
fn target_summary_matches_the_rpc_contract_shape() {
    let summary = EvolutionTargetSummary {
        target_key: TargetKey::parse("skill:bundled:docx").unwrap(),
        target_type: TargetType::Skill,
        source: "bundled".into(),
        name: "docx".into(),
        enabled: true,
        evolution_mode: EvolutionWriteMode::Overlay,
        stable: EvolutionScore {
            revision: TargetRevision::new("rev-a", 0).label(),
            mean: 0.5,
            lower: 0.1,
            upper: 0.9,
            observations: 0,
        },
        candidate: None,
        channel_traffic: Some(0.5),
        pending_proposals: 1,
        needs_revalidation: false,
        pinned: false,
    };
    let value = serde_json::to_value(&summary).unwrap();
    assert_eq!(value["type"], "skill");
    assert_eq!(value["evolutionMode"], "overlay");
    assert_eq!(value["stable"]["revision"], "rev-a@0");
    assert_eq!(value["channelTraffic"], 0.5);
    assert!(value.get("candidate").is_none());
    let back: EvolutionTargetSummary = serde_json::from_value(value).unwrap();
    assert_eq!(back, summary);

    let content = OverlayContent {
        lessons: "- 先给结论".into(),
        checklist: String::new(),
        examples: vec![ProposalExample {
            name: "short".into(),
            text: "ab".into(),
        }],
    };
    assert_eq!(content.char_count(), 6 + 5 + 2);
    let encoded = serde_json::to_value(&content).unwrap();
    assert!(encoded.get("checklist").is_none());
    assert_eq!(encoded["examples"][0]["name"], "short");
    let evaluation = EvaluationResult {
        completed: true,
        passed: false,
        wins: 1,
        losses: 3,
        ties: 2,
        hard_check_regressions: 1,
        diversity_delta: Some(-0.2),
        reason: None,
    };
    let projected = EvolutionEvaluationSummary::from(&evaluation);
    assert_eq!(projected.win_rate, Some(0.25));
    assert_eq!(
        serde_json::to_value(&projected).unwrap()["hardCheckRegressions"],
        1
    );
}

#[test]
fn evolution_modes_order_from_narrow_to_wide() {
    assert!(EvolutionMode::Observe < EvolutionMode::Propose);
    assert!(EvolutionMode::Propose < EvolutionMode::Auto);
    assert_eq!(EvolutionMode::default(), EvolutionMode::Observe);
}

#[test]
fn usage_amendment_merges_hints_artifacts_and_targets_once() {
    let mut record = usage();
    record.profile_hints = ProfileHints::default();
    let amendment = UsageAmendment {
        version: EVOLUTION_RECORD_VERSION,
        amendment_id: "a-1".into(),
        usage_id: record.usage_id.clone(),
        profile_hints: ProfileHints {
            ran_commands: true,
            ..Default::default()
        },
        artifacts: vec![
            ArtifactRef::File {
                path: "out/report.docx".into(),
                content_hash: "sha256:11".into(),
            },
            ArtifactRef::File {
                path: "out/notes.md".into(),
                content_hash: "sha256:22".into(),
            },
        ],
        artifact_evidence: BTreeMap::from([("out/notes.md".into(), "ev-1".into())]),
        concurrent_targets: vec![record.target_key.clone()],
        recorded_at_ms: 1,
    };
    amendment.validate().unwrap();
    record.apply_amendment(&amendment);
    assert!(record.profile_hints.ran_commands);
    assert!(!record.profile_hints.text_only);
    assert_eq!(
        record.artifacts.len(),
        2,
        "the first baseline of a path wins"
    );
    assert!(matches!(
        &record.artifacts[0],
        ArtifactRef::File { content_hash, .. } if content_hash == "sha256:00"
    ));
    assert_eq!(
        record.concurrent_targets.len(),
        1,
        "self is never concurrent"
    );

    let mut invalid = amendment.clone();
    invalid.artifact_evidence = BTreeMap::from([("x".into(), "bad id".into())]);
    assert!(invalid.validate().is_err());
}
