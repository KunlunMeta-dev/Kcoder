use super::*;
use kcoder_evolution::ProposalDraft;
use kcoder_types::evolution::{
    Channel, EVOLUTION_RECORD_VERSION, ProfileHints, ProposalChanges, ProposalLocation, SignalKind,
    UsageRecord, UsageTask,
};

struct Fixture {
    _temp: tempfile::TempDir,
    data_root: PathBuf,
    workspace: PathBuf,
    settings: kcoder_config::Settings,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let data_root = temp.path().join("config");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&data_root).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let mut settings = kcoder_config::Settings::default();
    settings.evolution.enabled = true;
    Fixture {
        _temp: temp,
        data_root,
        workspace,
        settings,
    }
}

impl Fixture {
    fn service(&self) -> EvolutionService {
        self.service_with(None, Vec::new())
    }

    fn service_with(
        &self,
        user_enabled: Option<bool>,
        models: Vec<ConfiguredModel>,
    ) -> EvolutionService {
        EvolutionService::new(EvolutionServiceInputs {
            settings: &self.settings,
            user_enabled,
            models,
            skills: None,
            workspace: Some(self.workspace.clone()),
            data_root: self.data_root.clone(),
            hooks: Arc::new(DefaultEngineHooks),
        })
    }

    fn user_store(&self) -> EvolutionStore {
        EvolutionStore::open(&self.data_root).unwrap()
    }
}

fn key(value: &str) -> TargetKey {
    TargetKey::parse(value).unwrap()
}

fn draft(store: &EvolutionStore, target: &str, lesson: &str) -> String {
    store
        .create_proposal(
            ProposalDraft {
                target_key: key(target),
                base_revision: String::new(),
                location: ProposalLocation::Overlay,
                changes: ProposalChanges {
                    lessons_add: vec![lesson.into()],
                    ..Default::default()
                },
                pattern_ids: Vec::new(),
                evidence_ids: Vec::new(),
                actor: ProposalActor::Auto,
            },
            1,
        )
        .unwrap()
        .proposal
        .proposal_id
}

fn usage(id: &str, thread: &str, turn: &str, target: &str) -> UsageRecord {
    UsageRecord {
        version: EVOLUTION_RECORD_VERSION,
        usage_id: id.into(),
        thread_id: thread.into(),
        turn_id: Some(turn.into()),
        attempt_id: None,
        tool_call_id: None,
        target_key: key(target),
        revision: TargetRevision::new("", 0),
        channel: Channel::Stable,
        task: UsageTask::default(),
        profile_hints: ProfileHints::default(),
        artifacts: Vec::new(),
        concurrent_targets: Vec::new(),
        started_at_ms: 1,
    }
}

#[test]
fn status_reads_without_creating_storage_and_uses_the_implemented_registry() {
    let fixture = fixture();
    let status = fixture.service().status().unwrap();
    assert!(status.enabled);
    assert_eq!(status.disabled_reason, None);
    assert_eq!(
        status.skill_file_edits_supported,
        crate::skill_file_evolution::skill_file_edits_supported()
    );
    for target in &status.targets {
        assert_eq!(
            target.implemented,
            IMPLEMENTED_TARGET_TYPES.contains(&target.target_type)
        );
    }
    assert_eq!(status.jobs.len(), 3);
    assert!(!fixture.data_root.join("evolution").exists());
}

#[test]
fn disabled_reasons_follow_training_project_and_model_availability() {
    let mut fixture = fixture();
    // A project layer turned the effective switch off while the user layer is on.
    fixture.settings.evolution.enabled = false;
    let status = fixture
        .service_with(Some(true), Vec::new())
        .status()
        .unwrap();
    assert!(status.enabled);
    assert_eq!(
        status.disabled_reason,
        Some(EvolutionDisabledReason::ProjectDisabled)
    );
    // The user switch off is reported by `enabled` alone.
    let status = fixture
        .service_with(Some(false), Vec::new())
        .status()
        .unwrap();
    assert!(!status.enabled);
    assert_eq!(status.disabled_reason, None);

    fixture.settings.evolution.enabled = true;
    fixture.settings.evolution.model = Some(kcoder_config::EvolutionModelRef {
        provider: "Acme".into(),
        model: "Fast-1".into(),
    });
    let other = ConfiguredModel {
        provider: "acme".into(),
        model: "fast-1".into(),
        available: true,
    };
    // Case-preserving match and no fallback to another catalog entry.
    let status = fixture
        .service_with(Some(true), vec![other.clone()])
        .status()
        .unwrap();
    assert_eq!(
        status.disabled_reason,
        Some(EvolutionDisabledReason::ModelUnavailable)
    );
    assert!(!status.model.available);
    let exact = ConfiguredModel {
        provider: "Acme".into(),
        model: "Fast-1".into(),
        available: true,
    };
    let status = fixture
        .service_with(Some(true), vec![other, exact])
        .status()
        .unwrap();
    assert_eq!(status.disabled_reason, None);
    assert!(status.model.available);

    fixture.settings.enable_training_mode();
    let status = fixture
        .service_with(Some(true), Vec::new())
        .status()
        .unwrap();
    assert_eq!(
        status.disabled_reason,
        Some(EvolutionDisabledReason::TrainingMode)
    );
}

#[test]
fn accept_reject_and_rollback_are_revision_checked() {
    let fixture = fixture();
    let store = fixture.user_store();
    let target = "skill:user_created:deploy";
    let id = draft(&store, target, "Run the smoke test before deploying");
    let service = fixture.service();
    let detail = service.read_target(&key(target)).unwrap();
    assert_eq!(detail.overlay.overlay_revision, "0");
    assert_eq!(detail.proposals.len(), 1);
    assert_eq!(detail.summary.pending_proposals, 1);

    let stale = service
        .decide(&key(target), &id, ProposalDecision::Accept, "7")
        .unwrap_err();
    assert_eq!(stale.code, "evolution_revision_conflict");

    let (summary, change) = service
        .decide(&key(target), &id, ProposalDecision::Accept, "0")
        .unwrap();
    assert_eq!(change, EvolutionChange::Promoted);
    assert_eq!(summary.pending_proposals, 0);
    let detail = service.read_target(&key(target)).unwrap();
    assert_eq!(
        detail.overlay.stable.lessons,
        "- Run the smoke test before deploying"
    );
    assert_eq!(detail.proposals[0].state, ProposalState::Promoted);

    let again = service
        .decide(
            &key(target),
            &id,
            ProposalDecision::Accept,
            &detail.overlay.overlay_revision,
        )
        .unwrap_err();
    assert_eq!(again.code, "evolution_invalid_transition");

    let (_, change) = service
        .decide(
            &key(target),
            &id,
            ProposalDecision::Rollback,
            &detail.overlay.overlay_revision,
        )
        .unwrap();
    assert_eq!(change, EvolutionChange::RolledBack);
    let detail = service.read_target(&key(target)).unwrap();
    assert_eq!(detail.overlay.stable.lessons, "");
    assert_eq!(detail.proposals[0].state, ProposalState::RolledBack);

    let second = draft(&store, target, "Tag the release");
    let (_, change) = service
        .decide(
            &key(target),
            &second,
            ProposalDecision::Reject,
            &detail.overlay.overlay_revision,
        )
        .unwrap();
    assert_eq!(change, EvolutionChange::Proposal);
    let rejected = store.read_proposal(&second).unwrap().unwrap();
    assert_eq!(rejected.state, ProposalState::Rejected);
    assert_eq!(rejected.last_actor(), Some(ProposalActor::User));

    let revision = service.overlay_revision(&key(target)).unwrap();
    let missing = service
        .decide(
            &key(target),
            "prop-missing",
            ProposalDecision::Reject,
            &revision,
        )
        .unwrap_err();
    assert_eq!(missing.code, "evolution_proposal_not_found");
}

/// Hooks that approve instead of promoting (the Engine's `propose`
/// behavior) and record candidate discards.
#[derive(Default)]
struct ApprovingHooks {
    discarded: std::sync::Mutex<Vec<String>>,
}

impl EvolutionEngineHooks for ApprovingHooks {
    fn apply_proposal_accept(&self, request: ProposalAcceptRequest<'_>) -> ServiceResult<()> {
        request.store.update_rollout_ledger(|ledger| {
            ledger
                .approved
                .insert(request.proposal.proposal_id.clone(), request.now_ms);
        })?;
        Ok(())
    }

    fn discard_proposal_candidate(&self, _key: &TargetKey, proposal_id: &str) {
        self.discarded.lock().unwrap().push(proposal_id.to_string());
    }
}

#[test]
fn an_approval_is_a_proposal_change_and_rejection_cleans_candidates_and_the_ledger() {
    let fixture = fixture();
    let store = fixture.user_store();
    let target = "skill:user_created:approved";
    let id = draft(&store, target, "Run the smoke test first");
    let hooks = Arc::new(ApprovingHooks::default());
    let service = EvolutionService::new(EvolutionServiceInputs {
        settings: &fixture.settings,
        user_enabled: None,
        models: Vec::new(),
        skills: None,
        workspace: Some(fixture.workspace.clone()),
        data_root: fixture.data_root.clone(),
        hooks: hooks.clone(),
    });
    let (_, change) = service
        .decide(&key(target), &id, ProposalDecision::Accept, "0")
        .unwrap();
    assert_eq!(change, EvolutionChange::Proposal, "approved, not promoted");
    assert_eq!(
        store.read_proposal(&id).unwrap().unwrap().state,
        ProposalState::Draft
    );
    assert!(
        store
            .read_rollout_ledger()
            .unwrap()
            .approved
            .contains_key(&id)
    );

    let (_, change) = service
        .decide(&key(target), &id, ProposalDecision::Reject, "0")
        .unwrap();
    assert_eq!(change, EvolutionChange::Proposal);
    assert_eq!(*hooks.discarded.lock().unwrap(), std::slice::from_ref(&id));
    assert!(
        !store
            .read_rollout_ledger()
            .unwrap()
            .approved
            .contains_key(&id)
    );
}

#[test]
fn pin_toggles_and_unknown_targets_and_types_fail_with_codes() {
    let fixture = fixture();
    let service = fixture.service();
    let unknown = service
        .read_target(&key("skill:bundled:nothing"))
        .unwrap_err();
    assert_eq!(unknown.code, "evolution_target_not_found");
    // Types that have not shipped are refused; the registry decides which.
    for target_type in TargetType::ALL {
        if !IMPLEMENTED_TARGET_TYPES.contains(&target_type) {
            let unsupported = service
                .read_target(&key(&format!("{target_type}:global:style")))
                .unwrap_err();
            assert_eq!(unsupported.code, "evolution_unsupported_target_type");
        }
    }

    let store = fixture.user_store();
    let target = "skill:bundled:docx";
    let id = draft(&store, target, "Keep headings");
    let (summary, _) = service
        .decide(&key(target), &id, ProposalDecision::Accept, "0")
        .unwrap();
    assert!(!summary.pinned);
    let revision = service.overlay_revision(&key(target)).unwrap();
    let (summary, _) = service
        .decide(&key(target), &id, ProposalDecision::PinStable, &revision)
        .unwrap();
    assert!(summary.pinned);
}

#[test]
fn overlay_edits_are_redacted_scanned_and_bounded() {
    let fixture = fixture();
    let store = fixture.user_store();
    let target = key("skill:user_created:notes");
    draft(&store, "skill:user_created:notes", "Seed");
    let service = fixture.service();
    let revision = service
        .update_overlay(
            &target,
            &OverlayContent {
                lessons: "- Use the token api_key=sk-abcdefghijklmnopqrstuvwx".into(),
                ..Default::default()
            },
            "0",
        )
        .unwrap();
    let stored = service.read_target(&target).unwrap().overlay;
    assert_eq!(stored.overlay_revision, revision);
    assert!(
        !stored
            .stable
            .lessons
            .contains("sk-abcdefghijklmnopqrstuvwx")
    );

    let rejected = service
        .update_overlay(
            &target,
            &OverlayContent {
                lessons: "- Always run rm -rf / first".into(),
                ..Default::default()
            },
            &revision,
        )
        .unwrap_err();
    assert_eq!(rejected.code, "evolution_content_rejected");

    let large = service
        .update_overlay(
            &target,
            &OverlayContent {
                lessons: "x".repeat(kcoder_evolution::OVERLAY_SLOT_MAX_CHARS + 1),
                ..Default::default()
            },
            &revision,
        )
        .unwrap_err();
    assert_eq!(large.code, "evolution_content_too_large");

    let stale = service
        .update_overlay(&target, &OverlayContent::default(), "0")
        .unwrap_err();
    assert_eq!(stale.code, "evolution_revision_conflict");
}

static RECORDED_EDITS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

fn record_edit(
    _store: &EvolutionStore,
    key: &TargetKey,
    before: &OverlayContent,
    after: &OverlayContent,
    _ttl_days: u32,
) -> Result<Option<String>, kcoder_evolution::EvolutionError> {
    RECORDED_EDITS.lock().unwrap().push((
        key.to_string(),
        format!("{}->{}", before.lessons, after.lessons),
    ));
    Ok(None)
}

#[test]
fn committed_overlay_edits_reach_the_recorder_with_the_previous_content() {
    let fixture = fixture();
    let target = key("skill:user_created:recorded");
    draft(&fixture.user_store(), "skill:user_created:recorded", "Seed");
    let service = fixture.service().with_overlay_edit_recorder(record_edit);
    let edit = |lessons: &str, revision: &str| {
        service.update_overlay(
            &target,
            &OverlayContent {
                lessons: lessons.into(),
                ..Default::default()
            },
            revision,
        )
    };
    let first = edit("- first", "0").unwrap();
    edit("- second", &first).unwrap();
    // A refused edit is not evidence.
    edit("- stale", "0").unwrap_err();
    let recorded: Vec<_> = RECORDED_EDITS
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == "skill:user_created:recorded")
        .map(|(_, change)| change.clone())
        .collect();
    assert_eq!(recorded, ["->- first", "- first->- second"]);
}

#[test]
fn ratings_are_idempotent_per_usage_and_require_an_active_switch() {
    let mut fixture = fixture();
    let store = fixture.user_store();
    store
        .append_usage(&usage("u1", "thread-1", "turn-1", "skill:bundled:docx"))
        .unwrap();
    store
        .append_usage(&usage("u2", "thread-1", "turn-1", "skill:bundled:xlsx"))
        .unwrap();
    let service = fixture.service();
    let request = RatingRequest {
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        tool_call_ids: Vec::new(),
        target_key: Some(key("skill:bundled:docx")),
        up: true,
        reason: Some("great, password=hunter2".into()),
    };
    assert!(service.rate(&request).unwrap());
    assert!(service.rate(&request).unwrap(), "identical replay");
    let ratings = |usage: &str| -> Vec<Option<f64>> {
        store
            .read_outcomes()
            .unwrap()
            .records
            .into_iter()
            .filter(|item| item.usage_id == usage && item.signal == SignalKind::Rating)
            .map(|item| item.metrics.rating_value)
            .collect()
    };
    assert_eq!(ratings("u1"), [Some(1.0)], "a replay appends nothing");
    let outcomes = store.read_outcomes().unwrap().records;
    let evidence = outcomes[0].evidence_ref.clone().unwrap();
    let snippet = store.read_evidence(&evidence, 2).unwrap().unwrap();
    assert!(!snippet.text.contains("hunter2"));

    let missing = RatingRequest {
        turn_id: "turn-9".into(),
        ..request.clone()
    };
    assert!(!service.rate(&missing).unwrap());
    let other_thread = RatingRequest {
        thread_id: "thread-2".into(),
        ..request.clone()
    };
    assert!(!service.rate(&other_thread).unwrap());

    fixture.settings.evolution.enabled = false;
    let error = fixture.service().rate(&request).unwrap_err();
    assert_eq!(error.code, "evolution_disabled");
}

/// Plan section 7.1: a rating is explicit evidence and the user may change
/// it. The journal stays append-only; the latest rating stands for scoring.
#[test]
fn a_changed_rating_or_a_later_reason_supersedes_without_rewriting_history() {
    let fixture = fixture();
    let store = fixture.user_store();
    store
        .append_usage(&usage("u1", "thread-1", "turn-1", "skill:bundled:docx"))
        .unwrap();
    let service = fixture.service();
    let up = RatingRequest {
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        tool_call_ids: Vec::new(),
        target_key: None,
        up: true,
        reason: None,
    };
    let down = RatingRequest {
        up: false,
        ..up.clone()
    };
    assert!(service.rate(&up).unwrap());
    assert!(
        service.rate(&down).unwrap(),
        "the opposite rating is recorded"
    );
    assert!(service.rate(&down).unwrap(), "and replays idempotently");
    let with_reason = RatingRequest {
        reason: Some("missed the summary".into()),
        ..down.clone()
    };
    assert!(
        service.rate(&with_reason).unwrap(),
        "a later reason is recorded"
    );
    assert!(service.rate(&with_reason).unwrap());

    let observations: Vec<_> = store
        .read_outcomes()
        .unwrap()
        .records
        .into_iter()
        .filter(|item| item.signal == SignalKind::Rating)
        .collect();
    let values: Vec<_> = observations
        .iter()
        .map(|item| item.metrics.rating_value)
        .collect();
    assert_eq!(
        values,
        [Some(1.0), Some(0.0), Some(0.0)],
        "append-only history"
    );
    assert_eq!(
        observations[0].observation_id,
        super::rating::observation_id("u1")
    );
    let ids: std::collections::BTreeSet<_> = observations
        .iter()
        .map(|item| &item.observation_id)
        .collect();
    assert_eq!(ids.len(), 3, "every revision has its own id");
    assert!(observations[1].evidence_ref.is_none());
    assert!(observations[2].evidence_ref.is_some());

    // Only the standing rating is scored: a down rating, explicit negative.
    let refs: Vec<_> = observations.iter().collect();
    let score = kcoder_evolution::score_usage(refs, &kcoder_evolution::SignalWeights::default());
    assert_eq!(score.score, Some(0.0));
    assert!(score.explicit_negative);
    assert_eq!(score.contributing, 1);

    let (turns, truncated) = service.ratable_turns("thread-1", 10).unwrap();
    assert!(!truncated);
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].rating,
        Some(false),
        "the projection shows the latest"
    );

    // Changing back up supersedes again.
    assert!(service.rate(&up).unwrap());
    let (turns, _) = service.ratable_turns("thread-1", 10).unwrap();
    assert_eq!(turns[0].rating, Some(true));
}

/// A client that cannot see the recorded turn id (a subagent view, a
/// reloaded legacy transcript) addresses the usage by its skill call.
#[test]
fn ratings_address_usages_by_their_recorded_tool_call() {
    let fixture = fixture();
    let store = fixture.user_store();
    let mut child = usage("u-child", "agent-1", "turn-2", "skill:bundled:docx");
    child.tool_call_id = Some("toolu_child_1".into());
    store.append_usage(&child).unwrap();
    let mut tool = usage("u-tool", "agent-1", "turn-2", "tool_usage:builtin:read");
    tool.tool_call_id = None;
    store.append_usage(&tool).unwrap();
    let service = fixture.service();
    let request = RatingRequest {
        thread_id: "agent-1".into(),
        turn_id: "assistant-item-7".into(),
        tool_call_ids: vec!["toolu_child_1".into()],
        target_key: None,
        up: true,
        reason: None,
    };
    assert!(service.rate(&request).unwrap());
    let rated: Vec<_> = store
        .read_outcomes()
        .unwrap()
        .records
        .into_iter()
        .map(|item| item.usage_id)
        .collect();
    assert_eq!(rated, ["u-child"], "only the addressed usage is rated");
    let unknown = RatingRequest {
        tool_call_ids: vec!["toolu_other".into()],
        ..request.clone()
    };
    assert!(!service.rate(&unknown).unwrap());

    // The projection lists only skill usages, with their calls and rating.
    let (turns, _) = service.ratable_turns("agent-1", 10).unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].turn_id, "turn-2");
    assert_eq!(turns[0].tool_call_ids, ["toolu_child_1"]);
    assert_eq!(turns[0].target_keys, [key("skill:bundled:docx")]);
    assert_eq!(turns[0].rating, Some(true));
    assert!(
        service
            .ratable_turns("thread-other", 10)
            .unwrap()
            .0
            .is_empty()
    );
}

#[test]
fn ratable_turns_are_newest_first_bounded_and_follow_the_rating_switch() {
    let mut fixture = fixture();
    let store = fixture.user_store();
    for turn in 1..=3_u64 {
        let mut record = usage(
            &format!("u{turn}"),
            "thread-1",
            &format!("turn-{turn}"),
            "skill:bundled:docx",
        );
        record.started_at_ms = turn;
        store.append_usage(&record).unwrap();
    }
    let (turns, truncated) = fixture.service().ratable_turns("thread-1", 2).unwrap();
    assert!(truncated);
    let ids: Vec<_> = turns.iter().map(|turn| turn.turn_id.as_str()).collect();
    assert_eq!(ids, ["turn-3", "turn-2"]);
    assert!(turns.iter().all(|turn| turn.rating.is_none()));

    fixture.settings.evolution.signals.rating_ui = false;
    let (turns, truncated) = fixture.service().ratable_turns("thread-1", 2).unwrap();
    assert!(
        turns.is_empty() && !truncated,
        "no control without the signal"
    );
    fixture.settings.evolution.enabled = false;
    let error = fixture.service().ratable_turns("thread-1", 2).unwrap_err();
    assert_eq!(error.code, "evolution_disabled");
}

#[test]
fn project_scope_inside_the_project_is_skipped_with_a_diagnostic() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("checkout");
    let data_root = workspace.join(".dev-home");
    std::fs::create_dir_all(workspace.join(".git")).unwrap();
    std::fs::create_dir_all(&data_root).unwrap();
    let mut settings = kcoder_config::Settings::default();
    settings.evolution.enabled = true;
    let service = EvolutionService::new(EvolutionServiceInputs {
        settings: &settings,
        user_enabled: None,
        models: Vec::new(),
        skills: None,
        workspace: Some(workspace.clone()),
        data_root: data_root.clone(),
        hooks: Arc::new(DefaultEngineHooks),
    });
    let status = service.status().unwrap();
    assert_eq!(
        status.diagnostics.project_scope_issue,
        Some(EvolutionProjectScopeIssue::DataRootInsideProject)
    );
    // User scope keeps working and nothing is written for the project.
    let (_, revision) = service.preferences().unwrap();
    assert_eq!(revision, "0");
    service
        .update_preference("pref.global.tone", Some("concise"), "0")
        .unwrap();
    assert!(
        !data_root
            .join(kcoder_evolution::EVOLUTION_PROJECTS_DIR_NAME)
            .exists()
    );
    assert!(!service.clear(ClearScope::Project).unwrap());
    assert!(service.clear(ClearScope::User).unwrap());
    assert!(service.preferences().unwrap().0.is_empty());
}

#[test]
fn preferences_are_revision_checked_and_clear_removes_data() {
    let fixture = fixture();
    let service = fixture.service();
    let revision = service
        .update_preference("pref.global.tone", Some("Concise answers"), "0")
        .unwrap();
    assert_eq!(revision, "1");
    let stale = service
        .update_preference("pref.global.tone", None, "0")
        .unwrap_err();
    assert_eq!(stale.code, "evolution_revision_conflict");
    let (rows, current) = service.preferences().unwrap();
    assert_eq!(current, "1");
    assert_eq!(rows[0].scope, "global");
    let invalid = service
        .update_preference("tone", Some("x"), "1")
        .unwrap_err();
    assert_eq!(invalid.code, "evolution_content_rejected");
    service
        .update_preference("pref.global.tone", None, "1")
        .unwrap();
    assert!(service.preferences().unwrap().0.is_empty());

    draft(&fixture.user_store(), "skill:bundled:docx", "Keep");
    assert!(service.clear(ClearScope::All).unwrap());
    assert!(
        service
            .list_targets(TargetType::Skill, None, None)
            .unwrap()
            .0
            .is_empty()
    );
}

#[test]
fn target_listing_pages_by_key() {
    let fixture = fixture();
    let store = fixture.user_store();
    for name in ["a", "b", "c"] {
        draft(&store, &format!("skill:bundled:{name}"), "Lesson");
    }
    let service = fixture.service();
    let (page, next) = service
        .list_targets(TargetType::Skill, None, Some(2))
        .unwrap();
    assert_eq!(page.len(), 2);
    let next = next.unwrap();
    assert_eq!(next, "skill:bundled:b");
    let (rest, after) = service
        .list_targets(TargetType::Skill, Some(&next), Some(2))
        .unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].name, "c");
    assert!(after.is_none());
}

#[test]
fn target_reads_show_the_recorded_patterns_of_that_target() {
    let fixture = fixture();
    let target = key("skill:user_created:patterned");
    let store = fixture.user_store();
    draft(&store, "skill:user_created:patterned", "Seed");
    let pattern = |id: &str, usages: u32| kcoder_types::evolution::EvolutionPattern {
        id: id.into(),
        categories: vec!["structure".into()],
        statement: format!("statement {id}"),
        support: kcoder_types::evolution::EvolutionPatternSupport {
            usages,
            sessions: 1,
            users: 1,
        },
        counter_evidence: 0,
        scope: kcoder_types::evolution::EvolutionPatternScope::TargetOverlay,
    };
    store
        .record_patterns(&target, &[(pattern("P-1", 3), Vec::new())], 1)
        .unwrap();
    store
        .record_patterns(
            &target,
            &[
                (pattern("P-1", 7), Vec::new()),
                (pattern("P-2", 2), Vec::new()),
            ],
            2,
        )
        .unwrap();
    store
        .record_patterns(
            &key("skill:user_created:other"),
            &[(pattern("P-9", 1), Vec::new())],
            3,
        )
        .unwrap();
    let patterns = fixture.service().read_target(&target).unwrap().patterns;
    let ids: Vec<_> = patterns.iter().map(|pattern| pattern.id.as_str()).collect();
    assert_eq!(ids, ["P-1", "P-2"]);
    assert_eq!(patterns[0].support.usages, 7, "latest support");
}

#[test]
fn change_sets_apply_and_revert() {
    let base = OverlayContent {
        lessons: "- Keep A\n- Old B".into(),
        ..Default::default()
    };
    let changes = ProposalChanges {
        lessons_add: vec!["New C".into()],
        lessons_revise: vec![kcoder_types::evolution::LessonRevision {
            from: "Old B".into(),
            to: "New B".into(),
        }],
        lessons_remove: vec!["Keep A".into()],
        checklist_edits: vec!["Check D".into()],
        ..Default::default()
    };
    let applied = apply_changes(&base, &changes);
    assert_eq!(applied.lessons, "- New B\n- New C");
    assert_eq!(applied.checklist, "- Check D");
    let reverted = revert_changes(&applied, &changes);
    assert_eq!(reverted.lessons, "- Old B\n- Keep A");
    assert_eq!(reverted.checklist, "");
}
