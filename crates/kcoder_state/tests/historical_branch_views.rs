use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{
    historical_branch::*, imported_transcript::HistoricalCodexItemRef,
    migration::MigrationSourceKind,
};
fn recipe(store: &ExternalHistoryStore) -> HistoricalBranchRecipe {
    let snapshot = kcoder_types::external_history::ExternalHistorySnapshot {
        origin: kcoder_types::external_history::ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_instance: "owned-branch-storage-fixture".into(),
            source_session_id: "synthetic".into(),
            source_artifact_id: None,
            source_format: "fixture/1".into(),
            adapter_revision: "raw/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        source_bytes: 0,
        source_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(),
        record_limit: 1,
        original: None,
    };
    let mut import = store
        .begin("owned-branch-storage-fixture", &snapshot)
        .unwrap();
    import.stage_source(&mut &b""[..], &mut |_| true).unwrap();
    let archive = import.finish(&mut |_| true).unwrap().receipt.archive_id;

    HistoricalBranchRecipe {
        revision: "fixture/v1".into(),
        normalization_revision: "records/v1".into(),
        source: MigrationSourceKind::Codex,
        sources: vec![HistoricalBranchSource {
            archive_id: archive,
            projection_fingerprint: "b".repeat(64),
        }],
    }
}
fn plan(count: u64) -> HistoricalBranchPlan {
    HistoricalBranchPlan {
        selection_sha256: "c".repeat(64),
        total_items: count,
        structural_complete: true,
        source_records_with_diagnostics: 0,
        issues: vec![],
    }
}
fn items(count: u64) -> Vec<HistoricalCodexItemRef> {
    (0..count)
        .map(|record| HistoricalCodexItemRef {
            source_index: 0,
            record,
            replacement_index: None,
            omitted_blocks: vec![],
        })
        .collect()
}

#[test]
fn branch_indexes_commit_in_order_and_survive_restart_with_ten_item_pages() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let recipe = recipe(&store);
    let id = store.branch_id(&recipe).unwrap();
    let mut view = store.prepare_branch(&recipe).unwrap();
    assert_eq!(
        view.progress().unwrap().stage,
        HistoricalBranchStage::Planned
    );
    view.begin().unwrap();
    view.checked(42).unwrap();
    view.set_plan(&plan(25)).unwrap();
    view.append(0, &items(25)[..10], |_| true).unwrap();
    drop(view);
    let mut view = store.branch(&id, true).unwrap();
    view.begin().unwrap();
    view.set_plan(&plan(25)).unwrap();
    view.append(0, &items(25), |_| true).unwrap();
    assert_eq!(view.finish().unwrap().stage, HistoricalBranchStage::Ready);
    drop(view);
    drop(store);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let view = store.branch(&id, false).unwrap();
    assert_eq!(view.page(0).unwrap().items.len(), 10);
    assert_eq!(view.page(10).unwrap().next_cursor, Some(20));
    assert_eq!(view.page(20).unwrap().items.len(), 5);
    assert!(view.page(25).unwrap().items.is_empty());
    assert!(view.page(26).is_err());
}

#[test]
fn readers_and_cancel_remain_available_while_one_writer_owns_the_view() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut view = store.prepare_branch(&recipe(&store)).unwrap();
    let id = view.progress().unwrap().view_id;
    view.begin().unwrap();
    view.set_plan(&plan(3)).unwrap();
    assert!(store.branch(&id, true).is_err());
    assert_eq!(
        store.branch(&id, false).unwrap().progress().unwrap().stage,
        HistoricalBranchStage::Saving
    );
    store.cancel_branch(&id).unwrap();
    assert!(view.cancel_requested().unwrap());
    assert!(view.append(0, &items(3), |_| true).is_err());
    let stopped = view.stop(true, None).unwrap();
    assert_eq!(stopped.stage, HistoricalBranchStage::Cancelled);
    assert!(view.begin().is_err());
    assert!(view.resume(stopped.sequence - 1).is_err());
    view.resume(stopped.sequence).unwrap();
    view.begin().unwrap();
    view.set_plan(&plan(3)).unwrap();
    view.append(0, &items(3), |_| true).unwrap();
    view.finish().unwrap();
}

#[test]
fn cancellation_inside_a_batch_rolls_back_only_that_batch_and_replays_are_checked() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut view = store.prepare_branch(&recipe(&store)).unwrap();
    let id = view.progress().unwrap().view_id;
    view.begin().unwrap();
    view.set_plan(&plan(4)).unwrap();
    view.append(0, &items(4)[..2], |_| true).unwrap();
    assert!(
        view.append(2, &items(4)[2..], |position| position < 3)
            .is_err()
    );
    assert_eq!(view.progress().unwrap().written_items, 2);
    let mut changed = items(1);
    changed[0].record = 99;
    assert!(view.append(0, &changed, |_| true).is_err());
    let mut changed_plan = plan(4);
    changed_plan.structural_complete = false;
    drop(view);
    let mut view = store.branch(&id, true).unwrap();
    view.begin().unwrap();
    assert!(view.set_plan(&changed_plan).is_err());
    view.set_plan(&plan(4)).unwrap();
    view.append(0, &items(4), |_| true).unwrap();
    view.finish().unwrap();
}

#[test]
fn recipes_paths_and_foreign_profiles_cannot_change_an_existing_view_binding() {
    let root = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let view = store.prepare_branch(&recipe(&store)).unwrap();
    let id = view.progress().unwrap().view_id;
    drop(view);
    let other = ExternalHistoryStore::open(peer.path()).unwrap();
    assert_ne!(id, other.branch_id(&recipe(&store)).unwrap());
    assert!(other.branch(&id, false).is_err());
    assert!(store.branch("../outside", false).is_err());
    let mut bad = recipe(&store);
    bad.sources.push(bad.sources[0].clone());
    assert!(store.prepare_branch(&bad).is_err());
    let mut bad = recipe(&store);
    bad.sources[0].archive_id = "../../private".into();
    assert!(store.prepare_branch(&bad).is_err());
}

#[test]
fn plan_and_index_budgets_are_enforced_before_a_ready_receipt_is_published() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut view = store.prepare_branch(&recipe(&store)).unwrap();
    view.begin().unwrap();
    assert!(view.set_plan(&plan(1_000_001)).is_err());
    view.set_plan(&plan(1)).unwrap();
    assert!(view.finish().is_err());
    let mut bad = items(1);
    bad[0].source_index = 2;
    assert!(view.append(0, &bad, |_| true).is_err());
    bad = items(1);
    bad[0].omitted_blocks = vec![2, 1];
    assert!(view.append(0, &bad, |_| true).is_err());
    assert!(view.append(0, &[], |_| true).is_err());
    assert!(view.page(0).is_err());
}
