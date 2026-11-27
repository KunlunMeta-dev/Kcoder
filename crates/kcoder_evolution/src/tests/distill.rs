use super::*;
use crate::{
    DistilledPatternKind, EvidenceSample, copies_evidence, ngram_overlap, parse_distill_output,
    sample_evidence,
};
use serde_json::json;

fn sample(id: &str, category: &str, bytes: usize) -> EvidenceSample {
    EvidenceSample {
        evidence_id: id.into(),
        category: category.into(),
        text: "x".repeat(bytes),
    }
}

#[test]
fn evidence_sampling_is_bounded_per_category_and_in_total() {
    let mut candidates = Vec::new();
    for index in 0..20 {
        candidates.push(sample(&format!("a{index}"), "correction:structure", 100));
        candidates.push(sample(&format!("b{index}"), "procedure:failure", 100));
    }
    let selected = sample_evidence(candidates);
    assert_eq!(selected.len(), 16, "8 per category");
    assert_eq!(selected[0].evidence_id, "a19", "newest first");

    let large: Vec<_> = (0..40)
        .map(|index| sample(&format!("c{index}"), &format!("cat{index}"), 1500))
        .collect();
    let selected = sample_evidence(large);
    let total: usize = selected.iter().map(|item| item.text.len()).sum();
    assert!(total <= crate::DISTILL_EVIDENCE_MAX_BYTES);
    assert!(selected.len() < 40);
}

fn valid_output(target: &str) -> serde_json::Value {
    json!({
        "patterns": [{
            "id": "P-1", "kind": "target", "categories": ["structure"],
            "statement": "Reports need a summary section first.",
            "support": {"usages": 9, "sessions": 4, "users": 1},
            "counterEvidence": 1, "evidenceIds": ["ev-1", "ev-2"]
        }],
        "proposal": {"targetKey": target, "lessonsAdd": ["Start with a summary."]}
    })
}

#[test]
fn distill_output_is_strictly_validated() {
    let target = key("skill:bundled:docx");
    let offered = vec!["ev-1".to_string(), "ev-2".to_string()];
    let output =
        parse_distill_output(valid_output("skill:bundled:docx"), &target, &offered).unwrap();
    assert_eq!(output.patterns[0].kind, DistilledPatternKind::Target);

    let mut unknown = valid_output("skill:bundled:docx");
    unknown["patterns"][0]["score"] = json!(0.9);
    assert!(parse_distill_output(unknown, &target, &offered).is_err());

    let other = valid_output("skill:bundled:pptx");
    assert!(
        parse_distill_output(other, &target, &offered)
            .unwrap_err()
            .0
            .contains("being distilled"),
        "out-of-bounds target"
    );

    let mut uncited = valid_output("skill:bundled:docx");
    uncited["patterns"][0]["evidenceIds"] = json!(["ev-9"]);
    assert!(parse_distill_output(uncited, &target, &offered).is_err());

    let mut long = valid_output("skill:bundled:docx");
    long["proposal"]["lessonsAdd"] = json!(["y".repeat(700)]);
    assert!(parse_distill_output(long, &target, &offered).is_err());

    assert!(parse_distill_output(json!("not an object"), &target, &offered).is_err());
}

#[test]
fn copy_detection_works_without_word_separators() {
    let evidence = "第一幕：主角在雨夜走进咖啡馆，点了一杯热可可，然后开始回忆十年前的那个夏天。";
    assert!(copies_evidence(
        "第一幕：主角在雨夜走进咖啡馆，点了一杯热可可，然后开始回忆十年前的那个夏天。",
        [evidence]
    ));
    assert!(!copies_evidence(
        "开场先交代人物动机，再进入回忆，避免大段环境描写。",
        [evidence]
    ));
    assert_eq!(ngram_overlap("short", [evidence]), 0.0);
    let english = "Always run the full migration test suite before committing schema changes.";
    assert!(copies_evidence(&english.to_uppercase(), [english]));
}

#[test]
fn amendments_merge_into_usages_on_read() {
    let (_temp, store) = temp_store();
    store
        .append_usage(&usage(
            "u-1",
            "t-1",
            "skill:bundled:docx",
            Channel::Stable,
            1,
        ))
        .unwrap();
    let amendment = UsageAmendment {
        version: EVOLUTION_RECORD_VERSION,
        amendment_id: "am-1".into(),
        usage_id: "u-1".into(),
        profile_hints: ProfileHints {
            wrote_files: true,
            ..Default::default()
        },
        artifacts: vec![ArtifactRef::File {
            path: "/w/out.md".into(),
            content_hash: "sha256-aa".into(),
        }],
        artifact_evidence: Default::default(),
        concurrent_targets: Vec::new(),
        recorded_at_ms: 2,
    };
    store.append_usage_amendment(&amendment).unwrap();
    store.append_usage_amendment(&amendment).unwrap();
    let usages = store.read_amended_usages().unwrap();
    assert!(usages.records[0].profile_hints.wrote_files);
    assert_eq!(usages.records[0].artifacts.len(), 1);
    assert_eq!(store.read_usage_amendments().unwrap().stats.duplicates, 1);
    assert!(
        !store.read_usages().unwrap().records[0]
            .profile_hints
            .wrote_files
    );
}

#[test]
fn overlay_block_carries_target_and_revision_markers() {
    let block = crate::render_overlay_block(
        &key("skill:bundled:docx"),
        "sha256:1",
        3,
        &OverlayContent {
            lessons: "- Start with a summary.".into(),
            checklist: String::new(),
            examples: Vec::new(),
        },
    );
    assert!(block.starts_with(&crate::overlay_marker(&key("skill:bundled:docx"), 3)));
    assert!(block.contains("Start with a summary."));
    assert!(!block.contains("## Checklist"));
}
