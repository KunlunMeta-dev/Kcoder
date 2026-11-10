use super::*;
fn binding() -> ToolLinkBinding<'static> {
    ToolLinkBinding {
        source: "fixture-source",
        normalization: "fixture/1",
        selection: "fixture-selection",
        resource_guard: None,
    }
}
#[test]
fn pending_tool_schema_is_unpublished_but_ready_schema_loss_is_never_hidden() {
    let root = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    let scope = "fixture-tool-initialization";
    let metadata = projection::schema_binding(&directory, scope).unwrap();
    projection::publish_schema_marker(&directory, "schema-intent.json", &metadata).unwrap();
    let writer = directory
        .try_exclusive_lock(OsStr::new("build.lock"))
        .unwrap()
        .unwrap();
    let opened = files::open_database_in(directory, scope, true, BUDGET)
        .unwrap()
        .unwrap();
    assert!(
        open(
            PrivateDirectory::open_existing(root.path()).unwrap(),
            scope,
            None,
            binding(),
            None,
            false
        )
        .unwrap()
        .is_none()
    );
    drop(opened);
    let writable = open(
        PrivateDirectory::open_existing(root.path()).unwrap(),
        scope,
        None,
        binding(),
        Some(writer),
        true,
    )
    .unwrap()
    .unwrap();
    assert!(
        open(
            PrivateDirectory::open_existing(root.path()).unwrap(),
            scope,
            None,
            binding(),
            None,
            false
        )
        .unwrap()
        .is_some()
    );
    writable.connection.execute_batch("DROP INDEX links_lookup; DROP INDEX links_turn; DROP TABLE links; DROP TABLE link_records; DROP TABLE link_header;").unwrap();
    assert!(
        open(
            PrivateDirectory::open_existing(root.path()).unwrap(),
            scope,
            None,
            binding(),
            None,
            false
        )
        .is_err()
    );
    drop(writable);
    assert!(
        open(
            PrivateDirectory::open_existing(root.path()).unwrap(),
            scope,
            None,
            binding(),
            None,
            true
        )
        .is_err()
    );
}
#[test]
fn valid_legacy_tool_links_need_no_markers_but_empty_legacy_schema_is_not_assumed_pending() {
    let root = tempfile::tempdir().unwrap();
    let scope = "fixture-tool-legacy";
    let value = open(
        PrivateDirectory::open_existing(root.path()).unwrap(),
        scope,
        None,
        binding(),
        None,
        true,
    )
    .unwrap()
    .unwrap();
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    directory
        .remove_regular_file(OsStr::new("schema-intent.json"))
        .unwrap();
    directory
        .remove_regular_file(OsStr::new("schema-ready.json"))
        .unwrap();
    assert!(
        open(
            PrivateDirectory::open_existing(root.path()).unwrap(),
            scope,
            None,
            binding(),
            None,
            false
        )
        .unwrap()
        .is_some()
    );
    value.connection.execute_batch("DROP INDEX links_lookup; DROP INDEX links_turn; DROP TABLE links; DROP TABLE link_records; DROP TABLE link_header;").unwrap();
    drop(value);
    assert!(
        open(
            PrivateDirectory::open_existing(root.path()).unwrap(),
            scope,
            None,
            binding(),
            None,
            false
        )
        .is_err()
    );
    assert!(
        open(
            PrivateDirectory::open_existing(root.path()).unwrap(),
            scope,
            None,
            binding(),
            None,
            true
        )
        .is_err()
    );
}
