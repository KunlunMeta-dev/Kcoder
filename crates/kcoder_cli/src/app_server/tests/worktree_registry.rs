#[test]
fn managed_worktree_registry_saves_and_replaces_state() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().join("project-data");
    let store = ClientWorktreeStore {
        state_path: base.join("managed-worktrees.json"),
        lock_path: base.join("managed-worktrees.lock"),
        default_root: base.join("managed-worktrees"),
    };
    let _guard = store.lock().unwrap();
    let mut state = store.load().unwrap();
    state.settings.keep_count = 7;
    store.save(&state).unwrap();
    assert_eq!(store.load().unwrap().settings.keep_count, 7);
    state.settings.keep_count = 9;
    store.save(&state).unwrap();
    assert_eq!(store.load().unwrap().settings.keep_count, 9);
    assert_eq!(std::fs::read_dir(&base).unwrap().count(), 2);
}

#[tokio::test]
async fn root_sidebar_pinning_is_persistent_without_fabricating_workspace_records() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let initial = workspace_request(&engine, "runtime.workspaces.list", &json!({}))
        .await
        .unwrap();
    assert_eq!(initial["rootProjectPinned"], true);
    for pinned in [false, true, false] {
        workspace_request(
            &engine,
            "runtime.sidebar.projects.pin",
            &json!({
                "projectKey": workspace.path(), "rootProject": true, "pinned": pinned
            }),
        )
        .await
        .unwrap();
        let reader = runtime_context_test_engine(workspace.path(), None);
        let listed = workspace_request(&reader, "runtime.workspaces.list", &json!({}))
            .await
            .unwrap();
        assert_eq!(listed["rootProjectPinned"], pinned);
        assert!(listed["items"].as_array().unwrap().is_empty());
    }
    let other = tempfile::tempdir().unwrap();
    assert!(
        workspace_request(
            &engine,
            "runtime.sidebar.projects.pin",
            &json!({
                "projectKey": other.path(), "rootProject": true, "pinned": true
            })
        )
        .await
        .is_err()
    );
    assert!(
        workspace_request(
            &engine,
            "runtime.sidebar.projects.pin",
            &json!({
                "projectKey": workspace.path(), "rootProject": "true", "pinned": true
            })
        )
        .await
        .is_err()
    );
    assert_eq!(
        workspace_request(&engine, "runtime.workspaces.list", &json!({}))
            .await
            .unwrap()["rootProjectPinned"],
        false
    );
}

#[test]
fn workspace_state_lock_waits_for_a_brief_writer_but_has_a_deadline() {
    let root = tempfile::tempdir().unwrap();
    let make_store = || ClientWorkspaceStore {
        state_path: root.path().join("client-workspaces.json"),
        lock_path: root.path().join("client-workspaces.lock"),
    };
    let guard = make_store().lock().unwrap();
    let next = make_store();
    let (started, ready) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || { started.send(()).unwrap(); next.lock() });
    ready.recv().unwrap();
    std::thread::sleep(Duration::from_millis(15));
    drop(guard);
    drop(reader.join().unwrap().unwrap());
    let _held = make_store().lock().unwrap();
    let started = std::time::Instant::now();
    assert!(make_store().lock().is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn managed_worktree_registry_lock_errors_identify_the_operation() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().join("not-a-directory");
    std::fs::write(&base, b"preserve").unwrap();
    let store = ClientWorktreeStore {
        state_path: base.join("managed-worktrees.json"),
        lock_path: base.join("managed-worktrees.lock"),
        default_root: base.join("managed-worktrees"),
    };
    let error = store.lock().unwrap_err();
    assert!(error.to_string().contains("create worktree state directory"), "{error:#}");
    assert_eq!(std::fs::read(&base).unwrap(), b"preserve");
}

#[cfg(unix)]
#[test]
fn managed_worktree_registry_save_preserves_directory_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o750)).unwrap();
    let store = ClientWorktreeStore {
        state_path: temp.path().join("managed-worktrees.json"),
        lock_path: temp.path().join("managed-worktrees.lock"),
        default_root: temp.path().join("managed-worktrees"),
    };
    store.save(&store.load().unwrap()).unwrap();
    assert_eq!(std::fs::metadata(temp.path()).unwrap().permissions().mode() & 0o777, 0o750);
    assert_eq!(std::fs::metadata(&store.state_path).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn managed_worktree_registry_save_errors_identify_the_operation() {
    let temp = tempfile::tempdir().unwrap();
    let store = ClientWorktreeStore {
        state_path: temp.path().join("managed-worktrees.json"),
        lock_path: temp.path().join("managed-worktrees.lock"),
        default_root: temp.path().join("managed-worktrees"),
    };
    let state = store.load().unwrap();
    std::fs::create_dir(&store.state_path).unwrap();
    let error = store.save(&state).unwrap_err();
    assert!(error.to_string().contains("save worktree state"), "{error:#}");
    assert!(store.state_path.is_dir());
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[test]
fn managed_worktree_registry_rejects_semantically_corrupt_records() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("managed");
    let path = root.join("task-1").join("repository");
    let store = ClientWorktreeStore {
        state_path: temp.path().join("managed-worktrees.json"),
        lock_path: temp.path().join("managed-worktrees.lock"),
        default_root: root.clone(),
    };
    let record = ClientManagedWorktree {
        worktree_id: "task-1".into(),
        path: path.to_string_lossy().into_owned(),
        repository_name: "repository".into(),
        revision: 1,
        lease_key: hex_sha256(path.to_string_lossy().as_bytes()),
        state: "active".into(),
        ..Default::default()
    };
    let state = || ClientWorktreeState {
        version: 2,
        settings: ClientWorktreeSettings {
            resolved_worktree_root: root.to_string_lossy().into_owned(),
            ..Default::default()
        },
        records: BTreeMap::from([(record.path.clone(), record.clone())]),
    };

    assert!(store.validate_state(&mut state()).is_ok());

    let mut mismatched_key = state();
    let record = mismatched_key.records.pop_first().unwrap().1;
    mismatched_key.records.insert("/tmp/forged".into(), record);
    assert!(store.validate_state(&mut mismatched_key).is_err());

    let mut outside_root = state();
    let record = outside_root.records.values_mut().next().unwrap();
    record.path = temp.path().join("outside").to_string_lossy().into_owned();
    let record = outside_root.records.pop_first().unwrap().1;
    outside_root.records.insert(record.path.clone(), record);
    assert!(store.validate_state(&mut outside_root).is_err());

    let mut forged_ref = state();
    forged_ref.records.values_mut().next().unwrap().snapshot_ref =
        Some("refs/heads/main".into());
    assert!(store.validate_state(&mut forged_ref).is_err());

    let mut incomplete_snapshot = state();
    incomplete_snapshot.records.values_mut().next().unwrap().state = "restorable".into();
    assert!(store.validate_state(&mut incomplete_snapshot).is_err());

    let mut missing_source = state();
    let record = missing_source.records.values_mut().next().unwrap();
    record.state = "restorable".into();
    record.snapshot_ref = Some(format!(
        "refs/kcoder/worktree-snapshots/{}",
        hex_sha256(record.path.as_bytes())
    ));
    record.snapshot_commit = Some("0123456789abcdef0123456789abcdef01234567".into());
    record.git_common_dir = Some(temp.path().join("git-common").to_string_lossy().into_owned());
    assert!(store.validate_state(&mut missing_source).is_err());
}

#[test]
fn managed_worktree_registry_rejects_unknown_future_version() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("managed");
    let store = ClientWorktreeStore {
        state_path: temp.path().join("managed-worktrees.json"),
        lock_path: temp.path().join("managed-worktrees.lock"),
        default_root: root.clone(),
    };
    std::fs::write(
        &store.state_path,
        serde_json::to_vec(&serde_json::json!({
            "version": 3,
            "settings": { "resolvedWorktreeRoot": root },
            "records": {}
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(store.load().unwrap_err().to_string().contains("newer than supported"));
}
