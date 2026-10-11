use super::*;
use crate::{SpecReviewWritebackRecord, review_writeback};
use std::fs;

fn review_fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    crate::init(temp.path()).unwrap();
    let root = temp.path().join(crate::SPECS_DIR);
    crate::config::config_set(&root, "schema", "spec-driven-superpowers").unwrap();
    let change = crate::new_change(temp.path(), "reviewed", None).unwrap();
    fs::write(
        change.join("review.md"),
        "# Review\n\n## Manual Adjustments\n\nKeep review note.\n",
    )
    .unwrap();
    fs::write(change.join("verification.md"), "# Verification\n\n## Previous Iterations\n\n- Previous evidence.\n\n## Manual Adjustments\n\nKeep verification note.\n").unwrap();
    (temp, change)
}

fn record() -> SpecReviewWritebackRecord {
    SpecReviewWritebackRecord {
        review_status: "findings-received".into(),
        findings_summary: vec!["accepted: missing regression".into()],
        accepted_followups: vec!["Add the accepted regression".into()],
        verification_notes: vec!["Retain the accepted regression evidence".into()],
    }
}

fn snapshot(change: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    ["review.md", "tasks.md", "plan.md", "verification.md"]
        .into_iter()
        .filter_map(|name| {
            fs::read(change.join(name))
                .ok()
                .map(|bytes| (change.join(name), bytes))
        })
        .collect()
}

#[test]
fn publication_review_preflight_retains_all_existing_files_when_required_artifacts_are_missing() {
    for missing in ["tasks.md", "plan.md", "verification.md"] {
        let (temp, change) = review_fixture();
        fs::remove_file(change.join(missing)).unwrap();
        if missing == "verification.md" {
            fs::create_dir(change.join(missing)).unwrap();
        }
        let before = snapshot(&change);
        assert!(review_writeback(temp.path(), "reviewed", record()).is_err());
        for (path, bytes) in before {
            assert_eq!(fs::read(&path).unwrap(), bytes, "{}", path.display());
        }
        assert!(!temp.path().join(crate::SPECS_DIR).join(JOURNAL).exists());
    }
}

#[test]
fn publication_review_second_and_last_files_recover_without_duplicate_followups() {
    for index in [2, 4] {
        let (temp, change) = review_fixture();
        let root = temp.path().join(crate::SPECS_DIR);
        FAIL_BEFORE_PUBLICATION.with(|fault| fault.set(Some(index)));
        let result = review_writeback(temp.path(), "reviewed", record());
        FAIL_BEFORE_PUBLICATION.with(|fault| fault.set(None));
        let report = result.unwrap();
        assert!(report.publication.committed && report.publication.recovery_pending);
        assert!(
            root.join(JOURNAL).exists(),
            "committed partial publication requires a durable journal"
        );
        recover_archives(&root).unwrap();
        assert!(!root.join(JOURNAL).exists());
        let before = snapshot(&change);
        let retry = review_writeback(temp.path(), "reviewed", record()).unwrap();
        assert!(retry.publication.committed && !retry.publication.recovery_pending);
        assert_eq!(snapshot(&change), before);
        let tasks = fs::read_to_string(change.join("tasks.md")).unwrap();
        assert_eq!(tasks.matches("Add the accepted regression").count(), 1);
        assert!(
            fs::read_to_string(change.join("review.md"))
                .unwrap()
                .contains("Keep review note.")
        );
        assert!(
            fs::read_to_string(change.join("verification.md"))
                .unwrap()
                .contains("Previous evidence.")
        );
    }
}

fn sync_fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(crate::SPECS_DIR);
    let change = root.join("changes/rebased");
    fs::create_dir_all(change.join("specs")).unwrap();
    for domain in ["a", "b"] {
        fs::create_dir_all(root.join("specs").join(domain)).unwrap();
        fs::write(
            root.join("specs").join(domain).join("spec.md"),
            format!("# Spec: {domain}\n\n## Requirements\n\n### Requirement: login\nOld.\n"),
        )
        .unwrap();
        fs::write(change.join("specs").join(format!("{domain}.md")), "<!-- Keep team note -->\n\n## MODIFIED Requirements\n\n### Requirement: login\nOld.\n\n## Open Questions\n\nKeep open question.\n").unwrap();
    }
    crate::capture_base_snapshot(&root, &change).unwrap();
    for domain in ["a", "b"] {
        fs::write(
            root.join("specs").join(domain).join("spec.md"),
            format!("# Spec: {domain}\n\n## Requirements\n\n### Requirement: login\nNew.\n"),
        )
        .unwrap();
    }
    (temp, change)
}

#[test]
fn publication_sync_second_delta_and_final_base_snapshot_recover_together() {
    for index in [1, 2] {
        let (temp, change) = sync_fixture();
        let root = temp.path().join(crate::SPECS_DIR);
        FAIL_BEFORE_PUBLICATION.with(|fault| fault.set(Some(index)));
        let result = crate::sync(temp.path(), "rebased");
        FAIL_BEFORE_PUBLICATION.with(|fault| fault.set(None));
        let report = result.unwrap();
        assert!(
            report
                .publication
                .is_some_and(|receipt| receipt.committed && receipt.recovery_pending)
        );
        assert!(!report.base_updated);
        assert!(root.join(JOURNAL).exists());
        recover_archives(&root).unwrap();
        let base = crate::fingerprint::load_base_snapshot(&change).unwrap();
        assert!(
            base.requirements
                .iter()
                .all(|requirement| requirement.body.contains("New."))
        );
        for domain in ["a", "b"] {
            let delta =
                fs::read_to_string(change.join("specs").join(format!("{domain}.md"))).unwrap();
            assert!(delta.contains("New."));
            assert!(delta.contains("Keep team note") && delta.contains("Keep open question."));
        }
        let before = fs::read(change.join(".base.json")).unwrap();
        assert!(
            crate::sync(temp.path(), "rebased")
                .unwrap()
                .conflicts
                .is_empty()
        );
        assert_eq!(fs::read(change.join(".base.json")).unwrap(), before);
    }
}

#[test]
fn publication_pending_change_cannot_be_recovered_or_replaced_by_another_change() {
    let (temp, change) = review_fixture();
    let root = temp.path().join(crate::SPECS_DIR);
    let other = crate::new_change(temp.path(), "other", None).unwrap();
    FAIL_BEFORE_PUBLICATION.with(|fault| fault.set(Some(4)));
    let report = review_writeback(temp.path(), "reviewed", record());
    FAIL_BEFORE_PUBLICATION.with(|fault| fault.set(None));
    assert!(report.unwrap().publication.recovery_pending);
    let journal = fs::read(root.join(JOURNAL)).unwrap();
    let before = snapshot(&change);
    for result in [
        review_writeback(temp.path(), "other", record()).map(|_| ()),
        crate::sync(temp.path(), "other").map(|_| ()),
        crate::new_change(temp.path(), "new-change", None).map(|_| ()),
        crate::merge_change(&root, &other).map(|_| ()),
    ] {
        assert!(result.unwrap_err().to_string().contains("reviewed"));
        assert_eq!(fs::read(root.join(JOURNAL)).unwrap(), journal);
        assert_eq!(snapshot(&change), before);
    }
    review_writeback(temp.path(), "reviewed", record()).unwrap();
    assert!(!root.join(JOURNAL).exists());
}

#[test]
fn publication_review_reports_committed_even_when_final_directory_sync_needs_recovery() {
    let (temp, change) = review_fixture();
    FAIL_AFTER_JOURNAL_REMOVAL.with(|fault| fault.set(true));
    let report = review_writeback(temp.path(), "reviewed", record());
    FAIL_AFTER_JOURNAL_REMOVAL.with(|fault| fault.set(false));
    let receipt = report.unwrap().publication;
    assert!(receipt.committed && receipt.recovery_pending);
    let before = snapshot(&change);
    let retry = review_writeback(temp.path(), "reviewed", record()).unwrap();
    assert!(retry.publication.committed && !retry.publication.recovery_pending);
    assert_eq!(snapshot(&change), before);
}
