use super::*;
use crate::{OverlaySlotSource, ProposalDraft, StatusInputs, TargetSummaryInputs};
use kcoder_config::EvolutionSettings;

#[test]
fn summaries_and_status_project_store_state() {
    let (_temp, store) = temp_store();
    let docx = key("skill:bundled:docx");
    let settings = EvolutionSettings {
        enabled: true,
        ..Default::default()
    };
    let doc = store
        .write_stable_overlay(
            &docx,
            None,
            "base-1",
            &OverlayContent {
                lessons: "- lead with the summary".into(),
                ..Default::default()
            },
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    let stable_revision = doc.stable.as_ref().unwrap().revision;
    let mut record = usage("u-1", "t", "skill:bundled:docx", Channel::Stable, 5);
    record.revision = TargetRevision::new("base-1", stable_revision);
    store.append_usage(&record).unwrap();
    store.append_outcome(&success("o-1", "u-1", true)).unwrap();
    store
        .create_proposal(
            ProposalDraft {
                target_key: docx.clone(),
                base_revision: "base-1".into(),
                location: ProposalLocation::Overlay,
                changes: ProposalChanges {
                    lessons_add: vec!["Keep headings short.".into()],
                    ..Default::default()
                },
                pattern_ids: vec![],
                evidence_ids: vec![],
                actor: ProposalActor::Auto,
            },
            6,
        )
        .unwrap();
    let staged = store
        .stage_candidate(
            &docx,
            Some(doc.revision),
            "base-1",
            &OverlayContent {
                lessons: "- candidate".into(),
                ..Default::default()
            },
            "prop-x",
            7,
        )
        .unwrap();
    store.start_canary(&docx, staged.revision, 0.5, 8).unwrap();
    store
        .append_usage(&usage(
            "u-2",
            "t",
            "tool_usage:mcp:github.create_issue",
            Channel::Stable,
            9,
        ))
        .unwrap();

    let write_mode = |_: &TargetKey| EvolutionWriteMode::Overlay;
    let inputs = TargetSummaryInputs {
        settings: &settings,
        write_mode: &write_mode,
    };
    let summary = store.target_summary(&docx, &inputs).unwrap();
    assert!(summary.enabled);
    assert_eq!(summary.stable.observations, 1);
    assert_eq!(summary.stable.revision, format!("base-1@{stable_revision}"));
    assert!(summary.stable.mean > 0.5);
    let candidate = summary.candidate.as_ref().unwrap();
    assert_eq!(candidate.observations, 0);
    assert_eq!(summary.channel_traffic, Some(0.5));
    assert_eq!(summary.pending_proposals, 1);

    let skills = store
        .list_target_summaries(TargetType::Skill, &inputs)
        .unwrap();
    assert_eq!(skills.len(), 1);
    let tools = store
        .list_target_summaries(TargetType::ToolUsage, &inputs)
        .unwrap();
    assert_eq!(tools.len(), 1);
    assert!(!tools[0].enabled, "tool usage is disabled by default");

    store.record_model_usage(10, 4, 5).unwrap();
    let snapshot = store
        .status_snapshot(StatusInputs {
            settings: &settings,
            disabled_reason: None,
            model: EvolutionModelStatus {
                selection: EvolutionModelSelection::FollowSession,
                provider: None,
                model: None,
                available: true,
            },
            implemented_types: &[TargetType::Skill],
            jobs: Vec::new(),
            skill_file_edits_supported: false,
            now_ms: 10,
        })
        .unwrap();
    assert!(snapshot.disabled_reason.is_none());
    let skill_row = snapshot
        .targets
        .iter()
        .find(|row| row.target_type == TargetType::Skill)
        .unwrap();
    assert!(skill_row.implemented && skill_row.enabled);
    assert_eq!(
        (skill_row.learned_items, skill_row.pending_proposals),
        (1, 1)
    );
    assert_eq!(
        (
            snapshot.usage_this_month.input_tokens,
            snapshot.usage_this_month.output_tokens
        ),
        (4, 5)
    );

    let disabled = EvolutionSettings::default();
    let snapshot = store
        .status_snapshot(StatusInputs {
            settings: &disabled,
            disabled_reason: None,
            model: EvolutionModelStatus::default(),
            implemented_types: &[],
            jobs: Vec::new(),
            skill_file_edits_supported: false,
            now_ms: 10,
        })
        .unwrap();
    assert!(!snapshot.enabled);
    assert_eq!(
        snapshot.disabled_reason, None,
        "a disabled switch is reported by enabled=false"
    );
    let limited = EvolutionSettings {
        enabled: true,
        usage_limit: kcoder_config::EvolutionUsageLimit {
            monthly_max_tokens: Some(9),
        },
        ..Default::default()
    };
    let snapshot = store
        .status_snapshot(StatusInputs {
            settings: &limited,
            disabled_reason: None,
            model: EvolutionModelStatus::default(),
            implemented_types: &[],
            jobs: Vec::new(),
            skill_file_edits_supported: false,
            now_ms: 10,
        })
        .unwrap();
    assert_eq!(
        snapshot.disabled_reason,
        Some(EvolutionDisabledReason::UsageLimit)
    );
}
