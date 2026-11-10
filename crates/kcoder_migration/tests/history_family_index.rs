use kcoder_migration::history_discovery::HistoryCatalog;
use kcoder_types::{external_history::HistorySourcePage, migration::MigrationSourceKind};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use uuid::Uuid;

fn id(index: u128) -> String {
    Uuid::from_u128(index + 1).to_string()
}
fn write(
    root: &Path,
    session: &str,
    physical: &str,
    parent: Option<&str>,
    modified: u64,
    archived: bool,
) -> PathBuf {
    let directory = if archived {
        root.join("archived_sessions")
    } else {
        root.join("sessions/2026/10/17")
    };
    fs::create_dir_all(&directory).unwrap();
    let file = directory.join(format!(
        "rollout-2026-10-17T00-00-00-{session}_{physical}.jsonl"
    ));
    let value = json!({"type":"session_meta","payload":{"id":session,"cli_version":"0.163.0","parent_thread_id":parent,"cwd":"/owned/source"}});
    fs::write(&file, format!("{value}\n")).unwrap();
    fs::File::open(&file)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(modified)))
        .unwrap();
    file
}
fn pages(catalog: &HistoryCatalog) -> Vec<HistorySourcePage> {
    let mut out = Vec::new();
    let mut cursor = None;
    loop {
        let page = catalog.page(cursor.as_deref(), |_| true).unwrap();
        cursor = page.next_cursor.clone();
        out.push(page);
        if cursor.is_none() {
            return out;
        }
    }
}
#[test]
fn explicit_index_orders_full_ancestry_before_ten_leaf_paging_without_changing_old_discovery() {
    let root = tempfile::tempdir().unwrap();
    for index in 0..13 {
        write(
            root.path(),
            &id(index),
            &id(index + 100),
            (index > 0).then(|| id(index - 1)).as_deref(),
            200 + index as u64,
            false,
        );
    }
    write(root.path(), &id(50), &id(150), None, 150, false);
    let old = HistoryCatalog::discover(root.path(), MigrationSourceKind::Codex, |_| true).unwrap();
    assert_eq!(
        old.page(None, |_| true).unwrap().items[0].source_session_id,
        id(12)
    );
    let indexed = HistoryCatalog::discover_codex_families(root.path(), |_| true).unwrap();
    let pages = pages(&indexed);
    assert_eq!(
        pages
            .iter()
            .map(|page| page.items.len())
            .collect::<Vec<_>>(),
        [10, 4]
    );
    assert!(pages.iter().all(|page| page.discovery_complete));
    let ordered: Vec<_> = pages
        .iter()
        .flat_map(|page| page.items.iter().map(|item| item.source_session_id.clone()))
        .collect();
    assert_eq!(ordered, (0..13).map(id).chain([id(50)]).collect::<Vec<_>>());
}
#[test]
fn conflicting_variants_cycles_and_missing_parents_stay_explicit_and_preserve_every_file() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &id(0), &id(100), None, 1, false);
    write(root.path(), &id(1), &id(101), None, 2, false);
    write(root.path(), &id(2), &id(102), Some(&id(0)), 3, false);
    write(root.path(), &id(2), &id(103), Some(&id(1)), 4, true);
    write(root.path(), &id(3), &id(104), Some(&id(2)), 5, false);
    write(root.path(), &id(4), &id(105), Some(&id(5)), 6, false);
    write(root.path(), &id(5), &id(106), Some(&id(4)), 7, false);
    write(root.path(), &id(6), &id(107), Some(&id(99)), 8, false);
    write(root.path(), &id(7), &id(108), Some(&id(99)), 9, false);
    let indexed = HistoryCatalog::discover_codex_families(root.path(), |_| true).unwrap();
    let page = indexed.page(None, |_| true).unwrap();
    assert_eq!(page.items.len(), 9);
    assert!(!page.discovery_complete);
    let count = |code: &str| {
        page.problems
            .iter()
            .find(|item| item.code == code)
            .unwrap()
            .count
    };
    assert_eq!(count("history_discovery_family_parent_conflict"), 1);
    assert_eq!(count("history_discovery_family_cycle"), 2);
    assert_eq!(count("history_discovery_family_parent_missing"), 1);
    assert!(
        page.items
            .iter()
            .filter(|item| item.source_session_id == id(2))
            .all(|item| item.preview_incomplete)
    );
    let positions: Vec<_> = page
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| item.parent_session_id.as_deref() == Some(&id(99)))
        .map(|(at, _)| at)
        .collect();
    assert_eq!(positions[1], positions[0] + 1);
}
#[test]
fn an_indexed_metadata_change_requires_new_discovery_instead_of_reordering_an_existing_cursor() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), &id(0), &id(100), None, 1, false);
    write(root.path(), &id(1), &id(101), None, 2, false);
    let child = write(root.path(), &id(2), &id(102), Some(&id(0)), 3, false);
    let indexed = HistoryCatalog::discover_codex_families(root.path(), |_| true).unwrap();
    let text = fs::read_to_string(&child).unwrap();
    fs::write(&child, text.replace(&id(0), &id(1))).unwrap();
    let error = indexed
        .page(None, |_| true)
        .err()
        .expect("changed observed header must not reuse the index");
    assert!(
        error
            .to_string()
            .contains("history_discovery_family_metadata_changed")
    );
}
#[test]
fn indexing_reads_only_the_bounded_header_and_cancellation_is_not_a_successful_partial_index() {
    let root = tempfile::tempdir().unwrap();
    let file = write(root.path(), &id(0), &id(100), None, 1, false);
    fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_len(64 * 1024 * 1024)
        .unwrap();
    let mut checks = 0;
    let catalog = HistoryCatalog::discover_codex_families(root.path(), |_| {
        checks += 1;
        true
    })
    .unwrap();
    assert!(
        checks < 100,
        "metadata indexing must not scan the sparse history body"
    );
    assert_eq!(catalog.page(None, |_| true).unwrap().items.len(), 1);
    let failed = HistoryCatalog::discover_codex_families(root.path(), |_| false)
        .err()
        .unwrap();
    assert!(failed.to_string().contains("history_discovery_cancelled"));
}

#[test]
fn ambiguous_or_unverified_metadata_never_regains_a_guessed_parent_from_the_page_preview() {
    let root = tempfile::tempdir().unwrap();
    let duplicate = write(root.path(), &id(0), &id(100), None, 1, false);
    fs::write(duplicate, format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{}\",\"parent_thread_id\":\"{}\",\"parent_thread_id\":\"{}\"}}}}\n", id(0), id(90), id(91))).unwrap();
    let mismatch = write(root.path(), &id(1), &id(101), Some(&id(90)), 2, false);
    let value = fs::read_to_string(&mismatch)
        .unwrap()
        .replace(&id(1), &id(99));
    fs::write(mismatch, value).unwrap();
    let indexed = HistoryCatalog::discover_codex_families(root.path(), |_| true).unwrap();
    let page = indexed.page(None, |_| true).unwrap();
    assert!(!page.discovery_complete);
    assert_eq!(page.items.len(), 2);
    assert!(page.items.iter().all(|item| item.preview_incomplete));
    assert!(
        page.items
            .iter()
            .all(|item| item.parent_session_id.is_none())
    );
}

#[test]
fn an_unrecognized_structured_source_does_not_claim_a_verified_root_family() {
    let root = tempfile::tempdir().unwrap();
    let file = write(root.path(), &id(0), &id(100), None, 1, false);
    fs::write(file, format!("{}\n", json!({"type":"session_meta","payload":{"id":id(0),"source":{"unrecognized_parent_shape":{"id":id(99)}}}}))).unwrap();
    let indexed = HistoryCatalog::discover_codex_families(root.path(), |_| true).unwrap();
    let page = indexed.page(None, |_| true).unwrap();
    assert!(!page.discovery_complete);
    assert!(page.items[0].preview_incomplete);
    assert!(page.items[0].parent_session_id.is_none());
}

#[test]
fn a_catalog_exhausting_the_aggregate_header_budget_remains_incomplete_without_losing_rows() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("sessions/2026/10/17");
    fs::create_dir_all(&directory).unwrap();
    for index in 0..1025 {
        let session = id(index);
        let mut value = json!({"type":"session_meta","payload":{"id":session,"parent_thread_id":null,"padding":""}});
        let base = value.to_string().len();
        value["payload"]["padding"] = serde_json::Value::String("x".repeat(65535 - base));
        let bytes = format!("{value}\n");
        assert_eq!(bytes.len(), 65536);
        fs::write(
            directory.join(format!(
                "rollout-2026-10-17T00-00-00-{session}_{}.jsonl",
                id(index + 10000)
            )),
            bytes,
        )
        .unwrap();
    }
    let indexed = HistoryCatalog::discover_codex_families(root.path(), |_| true).unwrap();
    let page = indexed.page(None, |_| true).unwrap();
    assert_eq!(page.total_items, 1025);
    assert!(!page.discovery_complete);
    assert!(
        page.problems
            .iter()
            .any(|problem| problem.code == "history_discovery_family_budget_exceeded")
    );
    fs::remove_file(directory.join(format!(
        "rollout-2026-10-17T00-00-00-{}_{}.jsonl",
        id(1024),
        id(11024)
    )))
    .unwrap();
    let exact = HistoryCatalog::discover_codex_families(root.path(), |_| true).unwrap();
    let exact_page = exact.page(None, |_| true).unwrap();
    assert_eq!(exact_page.total_items, 1024);
    assert!(
        exact_page.discovery_complete,
        "an entirely observed catalog at the inclusive limit is complete"
    );
}

#[test]
fn registry_family_mode_retains_cursor_authority_and_rejects_other_sources_without_io() {
    use kcoder_migration::discovery::{DiscoveryRoots, SourceRegistry};
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".codex");
    for index in 0..12 {
        write(
            &root,
            &id(index),
            &id(100 + index),
            index.checked_sub(1).map(id).as_deref(),
            index as u64 + 1,
            false,
        );
    }
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: home.path().into(),
        codex_home: None,
        claude_config_dir: None,
        project: None,
    });
    let mut checked = false;
    assert!(
        registry
            .discover_history_families(MigrationSourceKind::ClaudeCode, |_| {
                checked = true;
                true
            })
            .err()
            .unwrap()
            .to_string()
            .contains("family_source_unsupported")
    );
    assert!(!checked);
    let first = registry
        .discover_history_families(MigrationSourceKind::Codex, |_| true)
        .unwrap();
    assert_eq!(first.items.len(), 10);
    assert_eq!(first.items[0].source_session_id, id(0));
    let second = registry
        .history_page(&first.catalog_id, first.next_cursor.as_deref(), |_| true)
        .unwrap();
    assert_eq!(second.items.len(), 2);
    assert_eq!(second.items[1].source_session_id, id(11));
    let basic = registry
        .discover_history(MigrationSourceKind::Codex, |_| true)
        .unwrap();
    assert_eq!(basic.items[0].source_session_id, id(11));
}
