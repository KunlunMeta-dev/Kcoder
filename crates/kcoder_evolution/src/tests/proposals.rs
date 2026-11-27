use super::*;
use crate::{EvolutionError, ProposalDraft, proposal_id};

fn draft(base: &str, lesson: &str) -> ProposalDraft {
    ProposalDraft {
        target_key: key("skill:bundled:docx"),
        base_revision: base.into(),
        location: ProposalLocation::Overlay,
        changes: ProposalChanges {
            lessons_add: vec![lesson.into()],
            ..Default::default()
        },
        pattern_ids: vec!["P-1".into()],
        evidence_ids: vec!["ev-1".into()],
        actor: ProposalActor::Auto,
    }
}

#[test]
fn proposal_creation_is_idempotent_by_content_and_base_revision() {
    let (_temp, store) = temp_store();
    let first = store
        .create_proposal(draft("base-1", "Lead with the summary."), 1)
        .unwrap();
    assert!(first.created);
    assert!(first.proposal.proposal_id.starts_with("prop-"));
    let again = store
        .create_proposal(draft("base-1", "Lead with the summary."), 9)
        .unwrap();
    assert!(!again.created);
    assert_eq!(
        again.proposal, first.proposal,
        "the retried run sees the original"
    );
    let rebased = store
        .create_proposal(draft("base-2", "Lead with the summary."), 2)
        .unwrap();
    assert!(rebased.created);
    assert_ne!(rebased.proposal.proposal_id, first.proposal.proposal_id);
    assert_eq!(store.list_proposals().unwrap().len(), 2);
    let changes = draft("base-1", "Lead with the summary.").changes;
    assert_eq!(
        proposal_id(
            &key("skill:bundled:docx"),
            "base-1",
            ProposalLocation::Overlay,
            &changes
        )
        .unwrap(),
        first.proposal.proposal_id
    );
}

#[test]
fn empty_proposals_are_rejected() {
    let (_temp, store) = temp_store();
    let mut empty = draft("base-1", "x");
    empty.changes = ProposalChanges::default();
    assert!(store.create_proposal(empty, 1).is_err());
}

#[test]
fn transitions_follow_the_state_machine_with_revision_checks() {
    let (_temp, store) = temp_store();
    let created = store
        .create_proposal(draft("base-1", "x"), 1)
        .unwrap()
        .proposal;
    let id = created.proposal_id.clone();
    let invalid = store
        .transition_proposal(
            &id,
            1,
            ProposalState::Promoted,
            ProposalActor::Auto,
            None,
            2,
        )
        .unwrap_err();
    assert!(matches!(invalid, EvolutionError::InvalidTransition { .. }));
    assert_eq!(invalid.code(), "evolution_invalid_transition");

    let reviewed = store
        .record_proposal_review(
            &id,
            1,
            Some(SafetyScanResult {
                passed: true,
                findings: vec![],
            }),
            Some(EvaluationResult {
                completed: true,
                passed: true,
                wins: 3,
                losses: 1,
                ties: 0,
                hard_check_regressions: 0,
                diversity_delta: None,
                reason: None,
            }),
            3,
        )
        .unwrap();
    assert_eq!(reviewed.revision, 2);
    assert!(
        store
            .transition_proposal(
                &id,
                1,
                ProposalState::Evaluated,
                ProposalActor::Auto,
                None,
                4
            )
            .is_err(),
        "stale revision"
    );
    let evaluated = store
        .transition_proposal(
            &id,
            2,
            ProposalState::Evaluated,
            ProposalActor::Auto,
            None,
            4,
        )
        .unwrap();
    let canary = store
        .transition_proposal(
            &id,
            evaluated.revision,
            ProposalState::Canary,
            ProposalActor::User,
            None,
            5,
        )
        .unwrap();
    let rolled = store
        .transition_proposal(
            &id,
            canary.revision,
            ProposalState::RolledBack,
            ProposalActor::Auto,
            Some("explicit negative rating".into()),
            6,
        )
        .unwrap();
    assert_eq!(rolled.history.len(), 4);
    assert_eq!(rolled.history[2].actor, ProposalActor::User);
    assert_eq!(
        rolled.evaluation.as_ref().unwrap().wins,
        3,
        "results are kept"
    );
    assert!(
        store
            .transition_proposal(
                &id,
                rolled.revision,
                ProposalState::Canary,
                ProposalActor::User,
                None,
                7
            )
            .is_err()
    );
    assert!(matches!(
        store.transition_proposal(
            "prop-missing",
            1,
            ProposalState::Canary,
            ProposalActor::User,
            None,
            7
        ),
        Err(EvolutionError::ProposalNotFound(_))
    ));
    let summary = crate::proposal_summary(&rolled);
    assert_eq!(summary.diff, "+ x");
    assert_eq!(summary.created_at, "1970-01-01T00:00:00.001Z");
    assert_eq!(summary.actor, ProposalActor::Auto);
    assert_eq!(summary.evaluation.unwrap().win_rate, Some(0.75));
}
