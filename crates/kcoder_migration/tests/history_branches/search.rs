use super::*;
use kcoder_migration::history_search::{HistorySearchSource, SearchNeedle, SearchPosition};

#[test]
fn selected_search_preserves_positions_and_never_returns_an_unselected_branch() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut selected = message("selected", Some("root"));
    selected["message"]["content"] = "selected needle".into();
    let mut old = message("old", Some("root"));
    old["message"]["content"] = "unselected needle".into();
    let (job, _, _) = archive(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        A,
        A,
        vec![message("root", None), old, selected],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let view = store.prepare(&job, &[]).unwrap().view_id;
    store.build(&job, &view, || true).unwrap();
    let source = HistorySearchSource::Branch {
        store: &store,
        root_job: &job,
        view_id: &view,
    };
    let page = source
        .page(
            &SearchNeedle::new("needle", true).unwrap(),
            SearchPosition::default(),
            10,
            |_| true,
        )
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].found.position, 1);
    assert_eq!(page.items[0].found.record, 2);
    assert_eq!(page.items[0].found.before, "selected ");
}
