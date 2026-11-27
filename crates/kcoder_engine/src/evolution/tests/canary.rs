use super::*;
use crate::evolution::canary::recover_settings;
use crate::evolution::{EvolutionChangeEvent, EvolutionChangeSink};
use kcoder_evolution::ProposalDraft;
use kcoder_tools::evolution_service::{EvolutionChange, ProposalAcceptRequest};
use kcoder_types::evolution::{
    Attribution, Channel, EVOLUTION_RECORD_VERSION, ObservationMetrics, OutcomeObservation,
    OverlayCandidateState, Proposal, ProposalActor, ProposalChanges, ProposalExample,
    ProposalLocation, ProposalState, SafetyScanResult, SignalKind, TargetRevision, UsageRecord,
};

const LESSON: &str = "Lead with the deployment outcome, then the details.";

fn events(fixture: &Fixture) -> Arc<Mutex<Vec<EvolutionChangeEvent>>> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = Arc::clone(&events);
    let sink: EvolutionChangeSink = Arc::new(move |event| sink_events.lock().unwrap().push(event));
    fixture.engine.set_evolution_change_sink(Some(sink));
    events
}

fn changes(events: &Arc<Mutex<Vec<EvolutionChangeEvent>>>) -> Vec<EvolutionChange> {
    events
        .lock()
        .unwrap()
        .iter()
        .map(|event| event.change)
        .collect()
}

pub(super) fn scanned_proposal(
    store: &EvolutionStore,
    key: &TargetKey,
    base: &str,
    changes: ProposalChanges,
) -> Proposal {
    let created = store
        .create_proposal(
            ProposalDraft {
                target_key: key.clone(),
                base_revision: base.into(),
                location: ProposalLocation::Overlay,
                changes,
                pattern_ids: vec!["P-1".into()],
                evidence_ids: vec!["ev-1".into()],
                actor: ProposalActor::Auto,
            },
            super::super::now_ms(),
        )
        .unwrap()
        .proposal;
    store
        .record_proposal_review(
            &created.proposal_id,
            created.revision,
            Some(SafetyScanResult {
                passed: true,
                findings: Vec::new(),
            }),
            None,
            super::super::now_ms(),
        )
        .unwrap()
}

fn lesson_changes() -> ProposalChanges {
    ProposalChanges {
        lessons_add: vec![LESSON.into()],
        ..Default::default()
    }
}

fn skill_proposal(fixture: &Fixture) -> Proposal {
    let (_, _, _, base) = fixture.engine.evolution_skill_target(&skill_key()).unwrap();
    scanned_proposal(
        &fixture.project_store(),
        &skill_key(),
        &base,
        lesson_changes(),
    )
}

fn automate(fixture: &Fixture) {
    let settings = recover_settings(&fixture.engine);
    fixture.engine.run_evolution_automation(&settings, true);
}

fn proposal(fixture: &Fixture, id: &str) -> Proposal {
    fixture.project_store().read_proposal(id).unwrap().unwrap()
}

/// Seed `count` usages per channel inside the running canary window. The
/// candidate succeeds (`candidate_ok`) and the stable channel fails, or the
/// other way round.
fn seed_window(fixture: &Fixture, count: usize, candidate_ok: bool, hard_failure: bool) {
    let store = fixture.project_store();
    let document = store.overlay_document(&skill_key()).unwrap().unwrap();
    let candidate = document.candidate.clone().unwrap();
    let start = candidate.canary_started_at_ms.unwrap();
    let base = document.base_revision.clone();
    let stable_revision = document
        .stable
        .as_ref()
        .map(|slot| slot.revision)
        .unwrap_or(0);
    for index in 0..count {
        for (channel, revision, ok) in [
            (Channel::Stable, stable_revision, !candidate_ok),
            (Channel::Candidate, candidate.revision, candidate_ok),
        ] {
            let usage_id = format!("win-{channel:?}-{index}");
            store
                .append_usage(&UsageRecord {
                    version: EVOLUTION_RECORD_VERSION,
                    usage_id: usage_id.clone(),
                    thread_id: format!("thread-{channel:?}-{index}"),
                    turn_id: Some("turn-1".into()),
                    attempt_id: None,
                    tool_call_id: None,
                    target_key: skill_key(),
                    revision: TargetRevision::new(base.clone(), revision),
                    channel,
                    task: Default::default(),
                    profile_hints: Default::default(),
                    artifacts: Vec::new(),
                    concurrent_targets: Vec::new(),
                    started_at_ms: start + 1 + index as u64,
                })
                .unwrap();
            store
                .append_outcome(&OutcomeObservation {
                    version: EVOLUTION_RECORD_VERSION,
                    observation_id: format!("obs-{usage_id}"),
                    usage_id,
                    signal: SignalKind::TaskTerminal,
                    metrics: ObservationMetrics {
                        success: Some(ok),
                        ..Default::default()
                    },
                    categories: Vec::new(),
                    cause: (!ok).then_some(kcoder_types::evolution::OutcomeCause::Target),
                    attribution: Attribution::Direct,
                    confidence: 1.0,
                    conflict: false,
                    hard_failure: hard_failure && channel == Channel::Candidate,
                    evidence_ref: None,
                    source: "procedure".into(),
                    observed_at_ms: start + 2 + index as u64,
                })
                .unwrap();
        }
    }
}

#[tokio::test]
async fn auto_mode_canaries_without_an_evaluator_and_promotes_automatically() {
    let fixture = fixture(EvolutionMode::Auto);
    let events = events(&fixture);
    let draft = skill_proposal(&fixture);
    automate(&fixture);

    let store = fixture.project_store();
    let canary = proposal(&fixture, &draft.proposal_id);
    assert_eq!(canary.state, ProposalState::Canary);
    assert_eq!(canary.history.last().unwrap().actor, ProposalActor::Auto);
    let document = store.overlay_document(&skill_key()).unwrap().unwrap();
    let candidate = document.candidate.clone().unwrap();
    assert_eq!(candidate.state, OverlayCandidateState::Canary);
    assert!(
        candidate.traffic.unwrap() <= kcoder_evolution::NO_EVALUATOR_MAX_TRAFFIC,
        "no offline evaluator: reduced traffic"
    );
    assert_eq!(changes(&events), vec![EvolutionChange::Proposal]);

    // Below the doubled observation threshold nothing is decided.
    seed_window(&fixture, 20, true, false);
    automate(&fixture);
    assert_eq!(
        proposal(&fixture, &draft.proposal_id).state,
        ProposalState::Canary
    );

    seed_window(&fixture, 31, true, false);
    automate(&fixture);
    let promoted = proposal(&fixture, &draft.proposal_id);
    assert_eq!(promoted.state, ProposalState::Promoted);
    assert_eq!(promoted.history.last().unwrap().actor, ProposalActor::Auto);
    let (_, served) = store
        .serving_overlay(&skill_key(), Channel::Stable)
        .unwrap()
        .unwrap();
    assert!(served.lessons.contains(LESSON));
    assert_eq!(
        changes(&events),
        vec![EvolutionChange::Proposal, EvolutionChange::Promoted]
    );
    assert_eq!(
        events.lock().unwrap()[1].target_key.as_ref(),
        Some(&skill_key())
    );
}

#[tokio::test]
async fn a_hard_failure_rolls_back_by_pointer_and_keeps_the_candidate() {
    let fixture = fixture(EvolutionMode::Auto);
    let events = events(&fixture);
    let draft = skill_proposal(&fixture);
    automate(&fixture);
    seed_window(&fixture, 1, true, true);
    automate(&fixture);
    let rolled_back = proposal(&fixture, &draft.proposal_id);
    assert_eq!(rolled_back.state, ProposalState::RolledBack);
    assert!(
        rolled_back
            .history
            .last()
            .unwrap()
            .reason
            .as_deref()
            .unwrap()
            .contains("hard failure")
    );
    let view = fixture
        .project_store()
        .read_overlay(&skill_key())
        .unwrap()
        .unwrap();
    assert_eq!(
        view.document.candidate.as_ref().unwrap().state,
        OverlayCandidateState::RolledBack
    );
    assert!(
        view.candidate.unwrap().lessons.contains(LESSON),
        "content kept"
    );
    assert!(view.stable.is_none(), "stable never changed");
    assert_eq!(
        changes(&events),
        vec![EvolutionChange::Proposal, EvolutionChange::RolledBack]
    );
}

#[tokio::test]
async fn propose_mode_needs_acceptance_and_waits_for_the_user_to_promote() {
    let fixture = fixture(EvolutionMode::Propose);
    let events = events(&fixture);
    let draft = skill_proposal(&fixture);
    let store = fixture.project_store();
    automate(&fixture);
    assert_eq!(
        proposal(&fixture, &draft.proposal_id).state,
        ProposalState::Draft,
        "nothing runs before the user accepts"
    );

    let hooks = fixture.engine.evolution_hooks();
    hooks
        .apply_proposal_accept(ProposalAcceptRequest {
            store: &store,
            proposal: &draft,
            document: None,
            base_revision: draft.base_revision.clone(),
            now_ms: super::super::now_ms(),
        })
        .unwrap();
    assert!(
        store
            .read_rollout_ledger()
            .unwrap()
            .approved
            .contains_key(&draft.proposal_id)
    );
    automate(&fixture);
    assert_eq!(
        proposal(&fixture, &draft.proposal_id).state,
        ProposalState::Canary
    );

    seed_window(&fixture, 31, true, false);
    automate(&fixture);
    let waiting = proposal(&fixture, &draft.proposal_id);
    assert_eq!(waiting.state, ProposalState::Canary, "awaits the user");
    assert!(
        store
            .read_rollout_ledger()
            .unwrap()
            .awaiting_promotion
            .contains_key(&draft.proposal_id)
    );
    // A repeated decision does not notify twice.
    automate(&fixture);
    assert_eq!(
        changes(&events),
        vec![EvolutionChange::Proposal, EvolutionChange::Proposal]
    );

    let document = store.overlay_document(&skill_key()).unwrap();
    hooks
        .apply_proposal_accept(ProposalAcceptRequest {
            store: &store,
            proposal: &waiting,
            document: document.as_ref(),
            base_revision: waiting.base_revision.clone(),
            now_ms: super::super::now_ms(),
        })
        .unwrap();
    let promoted = proposal(&fixture, &draft.proposal_id);
    assert_eq!(promoted.state, ProposalState::Promoted);
    assert_eq!(promoted.history.last().unwrap().actor, ProposalActor::User);
    assert!(
        store
            .read_rollout_ledger()
            .unwrap()
            .awaiting_promotion
            .is_empty()
    );
    assert_eq!(changes(&events).last(), Some(&EvolutionChange::Promoted));
}

#[tokio::test]
async fn auto_mode_writes_preferences_but_project_knowledge_waits_for_the_user() {
    let fixture = fixture(EvolutionMode::Auto);
    let events = events(&fixture);
    let user = fixture.store(ScopeKind::User);
    let preference = scanned_proposal(
        &user,
        &key("preference:user:global.language"),
        "0",
        ProposalChanges {
            lessons_add: vec!["Answer in Chinese unless asked otherwise.".into()],
            ..Default::default()
        },
    );
    let knowledge = scanned_proposal(
        &fixture.project_store(),
        &key("project_knowledge:project:commands.abc123"),
        "project",
        ProposalChanges {
            examples: vec![ProposalExample {
                name: "Test command".into(),
                text: "Run the workspace test suite before release.".into(),
            }],
            ..Default::default()
        },
    );
    automate(&fixture);
    let document = user.read_preferences().unwrap();
    assert_eq!(
        document.items["pref.global.language"].value,
        "Answer in Chinese unless asked otherwise."
    );
    let written = user
        .read_proposal(&preference.proposal_id)
        .unwrap()
        .unwrap();
    assert_eq!(written.state, ProposalState::Promoted);
    assert_eq!(written.history.last().unwrap().actor, ProposalActor::Auto);
    assert_eq!(
        proposal(&fixture, &knowledge.proposal_id).state,
        ProposalState::Draft,
        "project knowledge always needs confirmation"
    );
    assert_eq!(changes(&events), vec![EvolutionChange::Promoted]);

    // A per-type narrowing to propose stops automatic preference writes.
    let mut settings = settings(EvolutionMode::Auto);
    settings.evolution.targets.preference.mode = Some(EvolutionMode::Propose);
    let narrowed = fixture_with(settings, ScriptedProvider::with_texts(&[]));
    let user = narrowed.store(ScopeKind::User);
    let pending = scanned_proposal(
        &user,
        &key("preference:user:global.tone"),
        "0",
        ProposalChanges {
            lessons_add: vec!["Keep a neutral tone.".into()],
            ..Default::default()
        },
    );
    automate(&narrowed);
    assert_eq!(
        user.read_proposal(&pending.proposal_id)
            .unwrap()
            .unwrap()
            .state,
        ProposalState::Draft
    );
}

#[tokio::test]
async fn skill_file_targets_stage_in_the_store_slot_and_publish_on_promotion() {
    let mut settings = settings(EvolutionMode::Auto);
    settings.evolution.targets.skill.allow_file_edits = Some(true);
    let fixture = fixture_with(settings, ScriptedProvider::with_texts(&[]));
    let skill_md = fixture.path(".kcoder/skills/deploy-check/SKILL.md");
    let stable_text = std::fs::read_to_string(&skill_md).unwrap();
    let draft = skill_proposal(&fixture);
    automate(&fixture);
    assert_eq!(
        proposal(&fixture, &draft.proposal_id).state,
        ProposalState::Canary
    );

    // Older readers and the stable slot still see the stable skill.
    let skills = kcoder_skills::SkillStore::open(&fixture.path(".kcoder/skills")).unwrap();
    let (candidate, state) = skills.read_candidate(SKILL).unwrap().unwrap();
    assert_eq!(state, kcoder_skills::SkillCandidateState::Staged);
    assert_eq!(candidate.proposal_id, draft.proposal_id);
    assert_eq!(std::fs::read_to_string(&skill_md).unwrap(), stable_text);
    let registry = SkillRegistry::load_project_only(fixture.project.path()).unwrap();
    assert!(!registry.get(SKILL).unwrap().content.contains(LESSON));

    seed_window(&fixture, 31, true, false);
    automate(&fixture);
    assert_eq!(
        proposal(&fixture, &draft.proposal_id).state,
        ProposalState::Promoted
    );
    let published = std::fs::read_to_string(&skill_md).unwrap();
    assert!(published.contains(kcoder_tools::skill_file_evolution::LEARNED_BLOCK_BEGIN));
    assert!(published.contains(LESSON));
    assert!(skills.read_candidate(SKILL).unwrap().is_none());
    // The overlay restarts empty for the new base revision, so the lesson
    // is not injected twice.
    let (_, _, _, base) = fixture.engine.evolution_skill_target(&skill_key()).unwrap();
    let document = fixture
        .project_store()
        .overlay_document(&skill_key())
        .unwrap()
        .unwrap();
    assert_eq!(document.base_revision, base);
    let (_, served) = fixture
        .project_store()
        .serving_overlay(&skill_key(), Channel::Stable)
        .unwrap()
        .unwrap();
    assert!(served.lessons.is_empty());
}

#[tokio::test]
async fn a_skill_file_rollback_discards_the_store_candidate() {
    let mut settings = settings(EvolutionMode::Auto);
    settings.evolution.targets.skill.allow_file_edits = Some(true);
    let fixture = fixture_with(settings, ScriptedProvider::with_texts(&[]));
    let skill_md = fixture.path(".kcoder/skills/deploy-check/SKILL.md");
    let stable_text = std::fs::read_to_string(&skill_md).unwrap();
    let draft = skill_proposal(&fixture);
    automate(&fixture);
    seed_window(&fixture, 1, true, true);
    automate(&fixture);
    assert_eq!(
        proposal(&fixture, &draft.proposal_id).state,
        ProposalState::RolledBack
    );
    let skills = kcoder_skills::SkillStore::open(&fixture.path(".kcoder/skills")).unwrap();
    assert!(skills.read_candidate(SKILL).unwrap().is_none());
    assert_eq!(std::fs::read_to_string(&skill_md).unwrap(), stable_text);
}

/// A skill-file proposal taken through canary to promotion, with the
/// skill's text before it.
fn promoted_skill_file(fixture: &Fixture) -> (Proposal, String) {
    let skill_md = fixture.path(".kcoder/skills/deploy-check/SKILL.md");
    let stable_text = std::fs::read_to_string(&skill_md).unwrap();
    let draft = skill_proposal(fixture);
    automate(fixture);
    seed_window(fixture, 31, true, false);
    automate(fixture);
    let promoted = proposal(fixture, &draft.proposal_id);
    assert_eq!(promoted.state, ProposalState::Promoted);
    assert!(std::fs::read_to_string(&skill_md).unwrap().contains(LESSON));
    (promoted, stable_text)
}

/// The management service the RPCs use, with this engine's hooks.
fn management_service(fixture: &Fixture) -> kcoder_tools::evolution_service::EvolutionService {
    let settings = recover_settings(&fixture.engine);
    let registry = fixture.engine.skill_registry.read().unwrap();
    kcoder_tools::evolution_service::EvolutionService::new(
        kcoder_tools::evolution_service::EvolutionServiceInputs {
            settings: &settings,
            user_enabled: None,
            models: Vec::new(),
            skills: Some(&registry),
            workspace: Some(fixture.project.path().to_path_buf()),
            data_root: fixture.data.path().join("profile"),
            hooks: fixture.engine.evolution_hooks(),
        },
    )
}

#[tokio::test]
async fn rolling_back_a_promoted_skill_file_restores_the_previous_skill() {
    let mut settings = settings(EvolutionMode::Auto);
    settings.evolution.targets.skill.allow_file_edits = Some(true);
    let fixture = fixture_with(settings, ScriptedProvider::with_texts(&[]));
    let (promoted, stable_text) = promoted_skill_file(&fixture);
    let service = management_service(&fixture);
    let revision = service.overlay_revision(&skill_key()).unwrap();
    let (_, change, notice) = service
        .decide_with_notice(
            &skill_key(),
            &promoted.proposal_id,
            kcoder_tools::evolution_service::ProposalDecision::Rollback,
            &revision,
        )
        .unwrap();
    assert_eq!(change, EvolutionChange::RolledBack);
    assert_eq!(notice, None);
    assert_eq!(
        std::fs::read_to_string(fixture.path(".kcoder/skills/deploy-check/SKILL.md")).unwrap(),
        stable_text
    );
    assert_eq!(
        proposal(&fixture, &promoted.proposal_id).state,
        ProposalState::RolledBack
    );
}

#[tokio::test]
async fn a_skill_edited_after_promotion_keeps_the_edit_and_the_user_is_told() {
    let mut settings = settings(EvolutionMode::Auto);
    settings.evolution.targets.skill.allow_file_edits = Some(true);
    let fixture = fixture_with(settings, ScriptedProvider::with_texts(&[]));
    let (promoted, _) = promoted_skill_file(&fixture);
    let skill_md = fixture.path(".kcoder/skills/deploy-check/SKILL.md");
    let edited = format!(
        "{}\nA line the user added.\n",
        std::fs::read_to_string(&skill_md).unwrap()
    );
    std::fs::write(&skill_md, &edited).unwrap();
    let service = management_service(&fixture);
    let revision = service.overlay_revision(&skill_key()).unwrap();
    let (_, change, notice) = service
        .decide_with_notice(
            &skill_key(),
            &promoted.proposal_id,
            kcoder_tools::evolution_service::ProposalDecision::Rollback,
            &revision,
        )
        .unwrap();
    assert_eq!(change, EvolutionChange::RolledBack);
    assert!(
        notice
            .as_deref()
            .is_some_and(|text| text.contains("edited after")),
        "{notice:?}"
    );
    assert_eq!(std::fs::read_to_string(&skill_md).unwrap(), edited);
}

#[tokio::test]
async fn tool_usage_proposals_canary_at_reduced_traffic_like_any_overlay_target() {
    let mut settings = settings(EvolutionMode::Auto);
    settings.evolution.targets.tool_usage.enabled = Some(true);
    let fixture = fixture_with(settings, ScriptedProvider::with_texts(&[]));
    let events = events(&fixture);
    let key = key("tool_usage:builtin:skill");
    let (scope, _, base) = fixture.engine.evolution_distill_target(&key).unwrap();
    assert_eq!(scope, ScopeKind::User);
    let user = fixture.store(ScopeKind::User);
    let draft = scanned_proposal(
        &user,
        &key,
        &base,
        ProposalChanges {
            lessons_add: vec!["Pass the exact skill name.".into()],
            ..Default::default()
        },
    );
    automate(&fixture);
    let canary = user.read_proposal(&draft.proposal_id).unwrap().unwrap();
    assert_eq!(canary.state, ProposalState::Canary);
    let candidate = user
        .overlay_document(&key)
        .unwrap()
        .unwrap()
        .candidate
        .unwrap();
    assert!(candidate.traffic.unwrap() <= kcoder_evolution::NO_EVALUATOR_MAX_TRAFFIC);
    assert!(
        canary
            .history
            .last()
            .unwrap()
            .reason
            .as_deref()
            .unwrap()
            .contains("no offline evaluator")
    );
    assert_eq!(changes(&events), vec![EvolutionChange::Proposal]);
}
