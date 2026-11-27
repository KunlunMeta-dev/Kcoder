use super::*;
use crate::{EvolutionError, OVERLAY_SLOT_MAX_CHARS, OverlaySlotSource};

fn content(lessons: &str) -> OverlayContent {
    OverlayContent {
        lessons: lessons.into(),
        checklist: "- check".into(),
        examples: vec![ProposalExample {
            name: "short-report".into(),
            text: "示例".into(),
        }],
    }
}

#[test]
fn stable_writes_are_revision_checked() {
    let (_temp, store) = temp_store();
    let target = key("skill:bundled:docx");
    let created = store
        .write_stable_overlay(
            &target,
            None,
            "base-1",
            &content("A"),
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    assert_eq!(created.revision, 1);
    // A second creator racing on "absent" loses.
    let conflict = store
        .write_stable_overlay(
            &target,
            None,
            "base-1",
            &content("B"),
            OverlaySlotSource::User,
            2,
        )
        .unwrap_err();
    assert!(matches!(
        conflict,
        EvolutionError::RevisionConflict {
            expected: None,
            actual: Some(1)
        }
    ));
    assert_eq!(conflict.code(), "evolution_revision_conflict");
    // A stale expected revision loses too.
    let updated = store
        .write_stable_overlay(
            &target,
            Some(1),
            "base-1",
            &content("B"),
            OverlaySlotSource::User,
            3,
        )
        .unwrap();
    assert!(
        store
            .write_stable_overlay(
                &target,
                Some(1),
                "base-1",
                &content("C"),
                OverlaySlotSource::User,
                4
            )
            .is_err()
    );
    let view = store.read_overlay(&target).unwrap().unwrap();
    assert_eq!(view.document.revision, updated.revision);
    assert_eq!(view.stable.unwrap(), content("B"));
    assert_eq!(
        view.document.retained.len(),
        1,
        "previous stable revision kept"
    );
}

#[test]
fn slot_limit_rejects_instead_of_truncating() {
    let (_temp, store) = temp_store();
    let target = key("skill:bundled:docx");
    let too_long = OverlayContent {
        lessons: "字".repeat(OVERLAY_SLOT_MAX_CHARS + 1),
        ..Default::default()
    };
    let error = store
        .write_stable_overlay(&target, None, "b", &too_long, OverlaySlotSource::User, 1)
        .unwrap_err();
    assert!(matches!(error, EvolutionError::ContentTooLarge { .. }));
    assert_eq!(error.code(), "evolution_content_too_large");
    let bad_name = OverlayContent {
        examples: vec![ProposalExample {
            name: "../x".into(),
            text: String::new(),
        }],
        ..Default::default()
    };
    assert_eq!(
        store
            .write_stable_overlay(&target, None, "b", &bad_name, OverlaySlotSource::User, 1)
            .unwrap_err()
            .code(),
        "evolution_content_rejected"
    );
    assert!(store.overlay_document(&target).unwrap().is_none());
}

#[test]
fn canary_promotion_and_rollback_switch_pointers_only() {
    let (_temp, store) = temp_store();
    let target = key("skill:project:deploy-check");
    let doc = store
        .write_stable_overlay(
            &target,
            None,
            "base-1",
            &content("stable"),
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    let doc = store
        .stage_candidate(
            &target,
            Some(doc.revision),
            "base-1",
            &content("candidate"),
            "prop-1",
            2,
        )
        .unwrap();
    let candidate_revision = doc.candidate.as_ref().unwrap().revision;
    assert_eq!(
        doc.serving_revision(Channel::Candidate),
        doc.stable.as_ref().map(|s| s.revision)
    );
    let doc = store.start_canary(&target, doc.revision, 0.5, 3).unwrap();
    assert!(doc.canary_active());
    let (served, served_content) = store
        .serving_overlay(&target, Channel::Candidate)
        .unwrap()
        .unwrap();
    assert_eq!(served, candidate_revision);
    assert_eq!(served_content.lessons, "candidate");
    assert!(
        store
            .stage_candidate(
                &target,
                Some(doc.revision),
                "base-1",
                &content("x"),
                "prop-2",
                4
            )
            .is_err()
    );

    let doc = store.rollback_candidate(&target, doc.revision, 5).unwrap();
    assert!(!doc.canary_active());
    let view = store.read_overlay(&target).unwrap().unwrap();
    assert_eq!(
        view.candidate.unwrap().lessons,
        "candidate",
        "content kept after rollback"
    );
    assert_eq!(
        store
            .serving_overlay(&target, Channel::Candidate)
            .unwrap()
            .unwrap()
            .1
            .lessons,
        "stable"
    );

    let doc = store
        .stage_candidate(
            &target,
            Some(doc.revision),
            "base-1",
            &content("second"),
            "prop-3",
            6,
        )
        .unwrap();
    let doc = store.start_canary(&target, doc.revision, 0.1, 7).unwrap();
    let doc = store.promote_candidate(&target, doc.revision, 8).unwrap();
    assert_eq!(
        doc.stable.as_ref().unwrap().proposal_id.as_deref(),
        Some("prop-3")
    );
    assert_eq!(
        doc.candidate.as_ref().unwrap().state,
        OverlayCandidateState::Promoted
    );
    assert_eq!(
        store
            .serving_overlay(&target, Channel::Stable)
            .unwrap()
            .unwrap()
            .1
            .lessons,
        "second"
    );
    assert!(
        doc.retained.contains(&1),
        "the replaced stable revision is retained"
    );
}

#[test]
fn base_revision_change_requires_revalidation_before_serving() {
    let (_temp, store) = temp_store();
    let target = key("skill:bundled:docx");
    store
        .write_stable_overlay(
            &target,
            None,
            "base-1",
            &content("A"),
            OverlaySlotSource::User,
            1,
        )
        .unwrap();
    assert!(!store.observe_base_revision(&target, "base-1", 2).unwrap());
    assert!(store.observe_base_revision(&target, "base-2", 3).unwrap());
    let doc = store.overlay_document(&target).unwrap().unwrap();
    assert!(doc.needs_revalidation);
    assert!(
        store
            .serving_overlay(&target, Channel::Stable)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_overlay(&target)
            .unwrap()
            .unwrap()
            .stable
            .is_some(),
        "still shown"
    );
    // Idempotent while pending.
    assert!(store.observe_base_revision(&target, "base-2", 4).unwrap());
    assert_eq!(
        store.overlay_document(&target).unwrap().unwrap().revision,
        doc.revision
    );
    let doc = store
        .mark_revalidated(&target, doc.revision, "base-2", 5)
        .unwrap();
    assert!(!doc.needs_revalidation);
    assert!(
        store
            .serving_overlay(&target, Channel::Stable)
            .unwrap()
            .is_some()
    );
}

#[test]
fn pinned_overlays_never_serve_candidates() {
    let (_temp, store) = temp_store();
    let target = key("skill:bundled:docx");
    let doc = store
        .stage_candidate(&target, None, "base-1", &content("cand"), "prop-1", 1)
        .unwrap();
    let doc = store.start_canary(&target, doc.revision, 0.5, 2).unwrap();
    let doc = store
        .set_overlay_pinned(&target, doc.revision, true, 3)
        .unwrap();
    assert!(!doc.canary_active());
    assert!(
        store
            .serving_overlay(&target, Channel::Candidate)
            .unwrap()
            .is_none()
    );
    assert_eq!(store.list_overlay_documents().unwrap().len(), 1);
}
