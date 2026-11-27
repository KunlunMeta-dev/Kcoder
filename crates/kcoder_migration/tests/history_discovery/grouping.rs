use super::*;
use std::{
    fs::FileTimes,
    time::{Duration, UNIX_EPOCH},
};

fn dated(path: &Path, seconds: u64) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(seconds)))
        .unwrap();
}

#[test]
fn physical_families_stay_adjacent_across_ten_leaf_pages_with_main_first() {
    let root = tempfile::tempdir().unwrap();
    let other = "22222222-2222-4222-8222-222222222222";
    dated(&claude_file(root.path(), SESSION), 1);
    dated(&claude_file(root.path(), other), 200);
    for n in 0..12 {
        let file = root.path().join(format!(
            "projects/project-label/{SESSION}/subagents/agent-child-{n:02}.jsonl"
        ));
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{}\n").unwrap();
        dated(&file, if n == 0 { 300 } else { 100 - n });
    }
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let first = catalog.page(None, |_| true).unwrap();
    let second = catalog
        .page(first.next_cursor.as_deref(), |_| true)
        .unwrap();
    assert_eq!(first.items.len(), 10);
    assert_eq!(second.items.len(), 4);
    assert!(first.items[0].agent_id.is_none());
    let rows = first
        .items
        .iter()
        .chain(second.items.iter())
        .collect::<Vec<_>>();
    assert!(
        rows[..13]
            .iter()
            .all(|row| row.source_session_id == SESSION)
    );
    assert_eq!(rows[13].source_session_id, other);
    assert_eq!(
        rows.iter()
            .map(|row| &row.source_handle)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        14
    );
    let parent = catalog
        .capture(&rows[0].source_handle, &mut |_, _| true)
        .unwrap();
    assert_eq!(
        parent.snapshot().origin.title.as_deref(),
        Some("Original custom title")
    );
}

#[test]
fn identical_source_ids_in_different_project_directories_do_not_merge_families() {
    let root = tempfile::tempdir().unwrap();
    dated(&claude_file(root.path(), SESSION), 1);
    let peer = root
        .path()
        .join(format!("projects/another-project/{SESSION}.jsonl"));
    fs::create_dir_all(peer.parent().unwrap()).unwrap();
    fs::write(&peer, "{}\n").unwrap();
    dated(&peer, 200);
    let child = root.path().join(format!(
        "projects/project-label/{SESSION}/subagents/agent-child.jsonl"
    ));
    fs::create_dir_all(child.parent().unwrap()).unwrap();
    fs::write(&child, "{}\n").unwrap();
    dated(&child, 300);
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    assert_eq!(page.items.len(), 3);
    assert!(page.items[0].agent_id.is_none());
    assert!(page.items[1].agent_id.is_some());
    assert!(page.items[2].agent_id.is_none());
}

#[test]
fn codex_preview_preserves_explicit_parent_without_truncating_invalid_ids() {
    let root = tempfile::tempdir().unwrap();
    let parent = "22222222-2222-4222-8222-222222222222";
    for key in ["parent_thread_id", "forked_from_id"] {
        let file = codex_file(root.path(), SESSION, SESSION, false, false);
        let value = json!({"type":"session_meta","payload":{"id":SESSION,"thread_name":"Original fork title",key:parent}});
        fs::write(&file, value.to_string() + "\n").unwrap();
        let catalog = HistoryCatalog::discover(root.path(), Kind::Codex, |_| true).unwrap();
        let page = catalog.page(None, |_| true).unwrap();
        assert_eq!(page.items[0].parent_session_id.as_deref(), Some(parent));
        assert_eq!(page.items[0].title.as_deref(), Some("Original fork title"));
        assert_eq!(
            catalog
                .capture(&page.items[0].source_handle, &mut |_, _| true)
                .unwrap()
                .snapshot()
                .origin
                .parent_session_id
                .as_deref(),
            Some(parent)
        );
        let invalid =
            json!({"type":"session_meta","payload":{"id":SESSION,key:format!("{parent}suffix")}});
        fs::write(&file, invalid.to_string() + "\n").unwrap();
        let catalog = HistoryCatalog::discover(root.path(), Kind::Codex, |_| true).unwrap();
        assert!(
            catalog.page(None, |_| true).unwrap().items[0]
                .parent_session_id
                .is_none()
        );
    }
}
