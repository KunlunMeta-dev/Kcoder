use super::{key, temp_store};
use crate::PATTERNS_PER_TARGET_MAX;
use kcoder_types::evolution::{EvolutionPattern, EvolutionPatternScope, EvolutionPatternSupport};

fn pattern(id: &str, statement: &str, usages: u32) -> EvolutionPattern {
    EvolutionPattern {
        id: id.into(),
        categories: vec!["missed_step".into()],
        statement: statement.into(),
        support: EvolutionPatternSupport {
            usages,
            sessions: 1,
            users: 1,
        },
        counter_evidence: 0,
        scope: EvolutionPatternScope::TargetOverlay,
    }
}

#[test]
fn patterns_are_kept_per_target_and_the_latest_support_wins() {
    let (_temp, store) = temp_store();
    let review = key("skill:user_created:review");
    let deploy = key("skill:user_created:deploy");
    assert_eq!(store.read_patterns().unwrap().revision, 0);
    store
        .record_patterns(
            &review,
            &[(
                pattern("p1", "Run tests first", 2),
                vec!["ev-b".into(), "ev-a".into(), "ev-a".into()],
            )],
            10,
        )
        .unwrap();
    // The same model-chosen id under another target is a different pattern.
    store
        .record_patterns(
            &deploy,
            &[(pattern("p1", "Tag the release", 1), Vec::new())],
            11,
        )
        .unwrap();
    store
        .record_patterns(
            &review,
            &[
                (pattern("p1", "Run tests first", 5), Vec::new()),
                (pattern("bad id!", "skipped", 1), Vec::new()),
                (pattern("p2", &"x".repeat(900), 1), Vec::new()),
            ],
            20,
        )
        .unwrap();
    let document = store.read_patterns().unwrap();
    let review_patterns = document.patterns_of(&review);
    assert_eq!(review_patterns.len(), 2);
    let p1 = review_patterns
        .iter()
        .find(|item| item.pattern.id == "p1")
        .unwrap();
    assert_eq!(p1.pattern.support.usages, 5);
    assert!(
        p1.evidence_ids.is_empty(),
        "the latest record replaces the entry"
    );
    let p2 = review_patterns
        .iter()
        .find(|item| item.pattern.id == "p2")
        .unwrap();
    assert_eq!(
        p2.pattern.statement.chars().count(),
        crate::PATTERN_STATEMENT_MAX_CHARS
    );
    assert_eq!(
        document.patterns_of(&deploy)[0].pattern.statement,
        "Tag the release"
    );

    store.clear_all().unwrap();
    assert_eq!(store.read_patterns().unwrap().revision, 0);
}

#[test]
fn pattern_records_are_deduplicated_and_bounded() {
    let (_temp, store) = temp_store();
    let target = key("skill:user_created:bounded");
    store
        .record_patterns(
            &target,
            &[(
                pattern("p0", "first", 1),
                vec!["ev-b".into(), "ev-a".into(), "ev-a".into()],
            )],
            1,
        )
        .unwrap();
    assert_eq!(
        store.read_patterns().unwrap().patterns_of(&target)[0].evidence_ids,
        ["ev-a", "ev-b"]
    );
    for index in 1..=PATTERNS_PER_TARGET_MAX {
        store
            .record_patterns(
                &target,
                &[(pattern(&format!("p{index}"), "later", 1), Vec::new())],
                1 + index as u64,
            )
            .unwrap();
    }
    let document = store.read_patterns().unwrap();
    let patterns = document.patterns_of(&target);
    assert_eq!(patterns.len(), PATTERNS_PER_TARGET_MAX);
    assert!(
        patterns.iter().all(|item| item.pattern.id != "p0"),
        "the oldest pattern goes first"
    );
}
