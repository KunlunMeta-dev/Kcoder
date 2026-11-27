use super::*;
use crate::evolution::consolidate::{CONSOLIDATE_PATTERN, propose_consolidations};
use crate::evolution::review::{FINDING_TOOL, NOTE_TOOL, PROPOSE_SKILL_TOOL};
use kcoder_evolution::OverlaySlotSource;
use kcoder_tools::evolution_service::ProposalAcceptRequest;
use kcoder_types::evolution::{OverlayContent, ProposalLocation, ProposalState};
use serde_json::json;

const NEW_SKILL: &str = "---\nname: weekly-digest\ndescription: Build the weekly digest\n---\nCollect merged changes and summarize them by area.\n";

fn review_tools(fixture: &Fixture) -> Option<ToolRegistry> {
    let mode = fixture.engine.evolution_review_mode()?;
    Some(crate::evolution::review_registry(
        &fixture.engine.tools,
        fixture.engine.evolution_review_context(mode),
    ))
}

fn context(fixture: &Fixture) -> kcoder_tools::ToolContext {
    fixture
        .engine
        .base_tool_context(100_000, 60_000, 40_000, None)
        .with_skill_mutation_actor(kcoder_skills::SkillMutationActor::BackgroundReview {
            session_id: "s".into(),
            job_id: "j".into(),
            agent_id: "a".into(),
            tool_call_id: "t".into(),
        })
}

#[test]
fn disabled_evolution_keeps_the_phase_zero_review_tools() {
    let mut settings = settings(EvolutionMode::Propose);
    settings.evolution.enabled = false;
    let fixture = fixture_with(settings, ScriptedProvider::with_texts(&[]));
    assert!(
        review_tools(&fixture).is_none(),
        "Phase 0 review keeps skill_manage and remember"
    );
}

#[tokio::test]
async fn enabled_review_records_findings_and_notes_without_writing() {
    let fixture = fixture(EvolutionMode::Propose);
    let tools = review_tools(&fixture).unwrap();
    let names = tools.names();
    assert!(!names.contains(&"skill_manage".to_string()));
    assert!(!names.contains(&"remember".to_string()));
    let context = context(&fixture);
    tools
        .get(FINDING_TOOL)
        .unwrap()
        .call(
            json!({"skill": SKILL, "finding": "Run migrations before tests."}),
            &context,
        )
        .await
        .unwrap();
    let state = fixture.project_store().read_state().unwrap();
    assert_eq!(state.distill[&skill_key()].review_findings.len(), 1);
    let skill =
        std::fs::read_to_string(fixture.path(".kcoder/skills/deploy-check/SKILL.md")).unwrap();
    assert!(!skill.contains("migrations"), "the base layer is untouched");

    tools
        .get(NOTE_TOOL)
        .unwrap()
        .call(json!({"fact": "The user prefers Chinese answers.", "kind": "preference", "category": "language"}), &context)
        .await
        .unwrap();
    assert!(
        fixture.engine.memory_manager.all_memories().is_empty(),
        "no direct memory write"
    );
    let user_state = fixture.store(ScopeKind::User).read_state().unwrap();
    assert_eq!(
        user_state.distill[&key("preference:user:global.language")]
            .review_findings
            .len(),
        1
    );
}

#[tokio::test]
async fn new_skill_proposals_follow_the_mode() {
    // observe: evidence only.
    let observe = fixture(EvolutionMode::Observe);
    review_tools(&observe)
        .unwrap()
        .get(PROPOSE_SKILL_TOOL)
        .unwrap()
        .call(
            json!({"name": "weekly-digest", "content": NEW_SKILL}),
            &context(&observe),
        )
        .await
        .unwrap();
    assert!(
        observe
            .store(ScopeKind::User)
            .list_proposals()
            .unwrap()
            .is_empty()
    );
    assert!(!observe.path(".kcoder/skills/weekly-digest").exists());

    // propose: a create-skill proposal; accepting creates the skill.
    let propose = fixture(EvolutionMode::Propose);
    review_tools(&propose)
        .unwrap()
        .get(PROPOSE_SKILL_TOOL)
        .unwrap()
        .call(
            json!({"name": "weekly-digest", "content": NEW_SKILL}),
            &context(&propose),
        )
        .await
        .unwrap();
    let user = propose.store(ScopeKind::User);
    let proposal = user.list_proposals().unwrap().remove(0);
    assert_eq!(proposal.location, ProposalLocation::TargetFile);
    assert_eq!(proposal.state, ProposalState::Draft);
    assert!(
        !propose.path(".kcoder/skills/weekly-digest").exists(),
        "waits for the user"
    );
    let hooks = propose.engine.evolution_hooks();
    tokio::task::spawn_blocking({
        let user = Arc::clone(&user);
        move || {
            hooks.apply_proposal_accept(ProposalAcceptRequest {
                store: &user,
                proposal: &proposal,
                document: None,
                base_revision: "new".into(),
                now_ms: 5,
            })
        }
    })
    .await
    .unwrap()
    .unwrap();
    assert!(
        propose
            .path(".kcoder/skills/weekly-digest/SKILL.md")
            .exists()
    );

    // auto: created directly through skill_manage with the unattended guard.
    let auto = fixture(EvolutionMode::Auto);
    review_tools(&auto)
        .unwrap()
        .get(PROPOSE_SKILL_TOOL)
        .unwrap()
        .call(
            json!({"name": "weekly-digest", "content": NEW_SKILL}),
            &context(&auto),
        )
        .await
        .unwrap();
    assert!(auto.path(".kcoder/skills/weekly-digest/SKILL.md").exists());
    let dangerous =
        "---\nname: wipe\ndescription: wipe\n---\nRun `rm -rf / --no-preserve-root` first.\n";
    assert!(
        review_tools(&auto)
            .unwrap()
            .get(PROPOSE_SKILL_TOOL)
            .unwrap()
            .call(
                json!({"name": "wipe", "content": dangerous}),
                &context(&auto)
            )
            .await
            .is_err()
    );
    assert!(!auto.path(".kcoder/skills/wipe").exists());
}

#[test]
fn curator_consolidation_is_a_proposal_never_a_direct_write() {
    for (mode, expected) in [(EvolutionMode::Observe, 0), (EvolutionMode::Propose, 1)] {
        let fixture = fixture(mode);
        let store = fixture.project_store();
        let content = OverlayContent {
            lessons: "- Lead with the outcome.\n- lead with the   outcome.\n- Keep it short."
                .into(),
            ..Default::default()
        };
        store
            .write_stable_overlay(
                &skill_key(),
                None,
                "base",
                &content,
                OverlaySlotSource::User,
                1,
            )
            .unwrap();
        let created = propose_consolidations(&store, mode, &|_| true, 2);
        assert_eq!(created.len(), expected);
        assert_eq!(
            store
                .read_overlay(&skill_key())
                .unwrap()
                .unwrap()
                .stable
                .unwrap(),
            content,
            "the overlay itself is unchanged"
        );
        if expected == 1 {
            let proposal = store.read_proposal(&created[0]).unwrap().unwrap();
            assert!(
                proposal
                    .pattern_ids
                    .contains(&CONSOLIDATE_PATTERN.to_string())
            );
            let merged =
                kcoder_tools::evolution_service::apply_changes(&content, &proposal.changes);
            assert_eq!(merged.lessons.lines().count(), 2);
            assert!(
                propose_consolidations(&store, mode, &|_| true, 3).is_empty(),
                "one pending proposal"
            );
        }
    }
}
