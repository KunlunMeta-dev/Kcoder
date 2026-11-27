use super::*;
use serde_json::json;

#[cfg(target_os = "linux")]
#[path = "managed_relocation_tests.rs"]
mod managed_relocation_tests;

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    workspace: PathBuf,
    project: PathBuf,
    state: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let owner = PrivateDirectory::open_or_create(&profile).unwrap();
        owner.create_private_child(OsStr::new("projects")).unwrap();
        let workspace = root.path().join("aa-workspace");
        PrivateDirectory::open_or_create(&workspace).unwrap();
        let key = kcoder_config::Settings::project_data_dir(&workspace)
            .unwrap()
            .file_name()
            .unwrap()
            .to_owned();
        let projects = owner.open_child(OsStr::new("projects"), false).unwrap();
        let project = projects.create_private_child(&key).unwrap();
        project
            .atomic_replace(
                OsStr::new("original.jsonl"),
                b"owned transcript; lookup must not parse or hash this body\n",
            )
            .unwrap();
        let session = project
            .create_private_child(OsStr::new("original"))
            .unwrap();
        session
            .atomic_replace(
                OsStr::new("state.json"),
                &serde_json::to_vec(&json!({
                    "schema_version":1,"base_cwd":workspace,"cwd":workspace,
                }))
                .unwrap(),
            )
            .unwrap();
        let path = profile.join("projects").join(key);
        let state = path.join("original/state.json");
        Self {
            _root: root,
            profile,
            workspace,
            project: path,
            state,
        }
    }
    fn lookup(&self) -> ProfileWorkspaceLookup {
        ProfileWorkspaceLookup::capture(&self.profile).unwrap()
    }
    fn params(cursor: Option<String>, limit: u32) -> ThreadWorkspaceLookupParams {
        ThreadWorkspaceLookupParams {
            thread_id: "original".into(),
            cursor,
            limit: Some(limit),
        }
    }
    fn add_bad_project(&self) {
        let workspace = self._root.path().join("zz-workspace");
        PrivateDirectory::open_or_create(&workspace).unwrap();
        let key = kcoder_config::Settings::project_data_dir(&workspace)
            .unwrap()
            .file_name()
            .unwrap()
            .to_owned();
        let profile = PrivateDirectory::open_existing(&self.profile).unwrap();
        let project = profile
            .open_child(OsStr::new("projects"), false)
            .unwrap()
            .create_private_child(&key)
            .unwrap();
        project
            .atomic_replace(OsStr::new("original.jsonl"), b"owned\n")
            .unwrap();
        project
            .create_private_child(OsStr::new("original"))
            .unwrap()
            .atomic_replace(OsStr::new("state.json"), b"{corrupt")
            .unwrap();
    }
}

#[test]
fn old_unregistered_workspace_is_found_from_original_private_metadata_without_a_broker_or_registry_write()
 {
    let f = Fixture::new();
    let before = std::fs::read(&f.state).unwrap();
    let modified = std::fs::metadata(&f.state).unwrap().modified().unwrap();
    let result = f
        .lookup()
        .lookup(Fixture::params(None, 64), &CancellationToken::new())
        .unwrap();
    assert_eq!(
        result.completeness,
        ThreadWorkspaceLookupCompleteness::Complete
    );
    assert_eq!(
        result.candidates,
        [ThreadWorkspaceHintV1 {
            workspace_path: f.workspace.to_str().unwrap().into()
        }]
    );
    assert_eq!(std::fs::read(&f.state).unwrap(), before);
    assert_eq!(
        std::fs::metadata(&f.state).unwrap().modified().unwrap(),
        modified
    );
    assert!(!f.project.join("client-workspaces.json").exists());
    assert!(!f.project.join("client-workspaces.lock").exists());
}

#[test]
fn corrupt_unknown_schema_and_foreign_project_cwd_are_partial_never_absent_or_a_grant() {
    for bytes in [
        b"{corrupt".to_vec(),
        br#"{"schema_version":4294967295}"#.to_vec(),
        serde_json::to_vec(&json!({"schema_version":1,"base_cwd":"/different/owner"})).unwrap(),
    ] {
        let f = Fixture::new();
        let session = PrivateDirectory::open_existing(f.state.parent().unwrap()).unwrap();
        session
            .atomic_replace(OsStr::new("state.json"), &bytes)
            .unwrap();
        let result = f
            .lookup()
            .lookup(Fixture::params(None, 64), &CancellationToken::new())
            .unwrap();
        assert_eq!(
            result.completeness,
            ThreadWorkspaceLookupCompleteness::Partial
        );
        assert_eq!(result.issue_count, 1);
        assert!(result.candidates.is_empty());
    }
}

#[test]
fn opaque_pages_bind_original_query_and_replaying_a_page_does_not_duplicate_issues_or_tokens() {
    let f = Fixture::new();
    f.add_bad_project();
    let mut reader = f.lookup();
    let first = reader
        .lookup(Fixture::params(None, 1), &CancellationToken::new())
        .unwrap();
    let cursor = first.next_cursor.unwrap();
    let other = ThreadWorkspaceLookupParams {
        thread_id: "different".into(),
        cursor: Some(cursor.clone()),
        limit: Some(1),
    };
    assert!(reader.lookup(other, &CancellationToken::new()).is_err());
    let second = reader
        .lookup(
            Fixture::params(Some(cursor.clone()), 1),
            &CancellationToken::new(),
        )
        .unwrap();
    let repeated = reader
        .lookup(Fixture::params(Some(cursor), 1), &CancellationToken::new())
        .unwrap();
    assert_eq!(second, repeated);
    assert_eq!(second.issue_count, 1);
    assert_eq!(
        second.completeness,
        ThreadWorkspaceLookupCompleteness::Partial
    );
}

#[cfg(unix)]
#[test]
fn linked_state_sidecars_never_supply_workspace_hints() {
    use std::os::unix::fs::symlink;
    for link_kind in ["symlink", "hardlink"] {
        let f = Fixture::new();
        match link_kind {
            "symlink" => {
                let original = f.state.with_extension("held");
                std::fs::rename(&f.state, &original).unwrap();
                symlink(original, &f.state).unwrap();
            }
            "hardlink" => std::fs::hard_link(&f.state, f.state.with_extension("alias")).unwrap(),
            _ => unreachable!(),
        }
        let result = f
            .lookup()
            .lookup(Fixture::params(None, 64), &CancellationToken::new())
            .unwrap();
        assert_eq!(
            result.completeness,
            ThreadWorkspaceLookupCompleteness::Partial,
            "{link_kind}"
        );
        assert!(result.candidates.is_empty(), "{link_kind}");
    }
}

#[cfg(unix)]
#[test]
fn profile_and_projects_replacement_retire_original_cursors_even_with_reused_directory_times() {
    let f = Fixture::new();
    f.add_bad_project();
    let mut reader = f.lookup();
    let first = reader
        .lookup(Fixture::params(None, 1), &CancellationToken::new())
        .unwrap();
    let projects = f.profile.join("projects");
    let stamp = std::fs::metadata(&projects).unwrap().modified().unwrap();
    std::fs::rename(&projects, f.profile.join("held-projects")).unwrap();
    let fresh = PrivateDirectory::open_existing(&f.profile)
        .unwrap()
        .create_private_child(OsStr::new("projects"))
        .unwrap();
    drop(fresh);
    std::fs::File::open(&projects)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(stamp))
        .unwrap();
    assert!(
        reader
            .lookup(
                Fixture::params(first.next_cursor, 1),
                &CancellationToken::new()
            )
            .is_err()
    );
    let held = f._root.path().join("held-profile");
    std::fs::rename(&f.profile, &held).unwrap();
    PrivateDirectory::open_or_create(&f.profile).unwrap();
    assert!(
        reader
            .lookup(Fixture::params(None, 1), &CancellationToken::new())
            .is_err()
    );
}

#[test]
fn cancellation_and_unknown_or_expired_cursor_do_not_fall_back_to_another_profile_scan() {
    let f = Fixture::new();
    let mut reader = f.lookup();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(reader.lookup(Fixture::params(None, 64), &cancel).is_err());
    assert!(
        reader
            .lookup(
                Fixture::params(Some("unrecognized".into()), 64),
                &CancellationToken::new()
            )
            .is_err()
    );
    f.add_bad_project();
    let first = reader
        .lookup(Fixture::params(None, 1), &CancellationToken::new())
        .unwrap();
    for snapshot in reader.snapshots.values_mut() {
        snapshot.born = Instant::now() - LIFETIME;
    }
    assert!(
        reader
            .lookup(
                Fixture::params(first.next_cursor, 1),
                &CancellationToken::new()
            )
            .is_err()
    );
}

#[test]
fn bounded_metadata_and_empty_creation_binding_fail_closed_without_reading_history_bodies() {
    for mode in ["oversized", "foreign-empty"] {
        let f = Fixture::new();
        if mode == "oversized" {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&f.state)
                .unwrap()
                .set_len(MAX_METADATA_BYTES + 1)
                .unwrap();
        } else {
            let project = PrivateDirectory::open_existing(&f.project).unwrap();
            project
                .atomic_replace(OsStr::new("original.jsonl"), b"")
                .unwrap();
            project
                .create_private_child(OsStr::new("client-sessions"))
                .unwrap()
                .create_private_child(OsStr::new("original"))
                .unwrap()
                .atomic_replace(
                    OsStr::new(super::super::THREAD_METADATA_FILE),
                    &serde_json::to_vec(&json!({
                        "version":1,"thread_id":"original","workspace":"/foreign/workspace",
                        "fields":{"permissionModeAtCreation":"default"},"updated_at":"1",
                    }))
                    .unwrap(),
                )
                .unwrap();
        }
        let result = f
            .lookup()
            .lookup(Fixture::params(None, 64), &CancellationToken::new())
            .unwrap();
        assert!(result.candidates.is_empty());
        assert_eq!(
            result.completeness,
            ThreadWorkspaceLookupCompleteness::Partial
        );
        assert_eq!(result.issue_count, 1);
    }
}

#[test]
fn controlled_native_subagent_and_channel_metadata_are_not_workspace_hints() {
    for field in ["native_subagent_outbox", "channel_task_source"] {
        let f = Fixture::new();
        // A malformed controlled field is also unavailable, never an ordinary task.
        let mut state = json!({"schema_version":1,"base_cwd":f.workspace,"cwd":f.workspace});
        state[field] = json!({"untrusted":"unknown"});
        PrivateDirectory::open_existing(f.state.parent().unwrap())
            .unwrap()
            .atomic_replace(
                OsStr::new("state.json"),
                &serde_json::to_vec(&state).unwrap(),
            )
            .unwrap();
        let result = f
            .lookup()
            .lookup(Fixture::params(None, 64), &CancellationToken::new())
            .unwrap();
        assert!(result.candidates.is_empty());
        assert_eq!(
            result.completeness,
            ThreadWorkspaceLookupCompleteness::Partial
        );
    }
}

#[test]
fn native_config_paths_keep_original_profile_when_readonly_overlay_lives_elsewhere() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("original-profile");
    let overlay = root.path().join("external/readonly-overlay.json");
    let paths = kcoder_config::SettingsLoader::new(root.path())
        .with_config_dir(&profile)
        .with_overlay_files(vec![overlay.clone()])
        .paths()
        .unwrap();
    assert_eq!(original_profile_root(&paths).unwrap(), profile);
    assert_ne!(
        original_profile_root(&paths).unwrap(),
        overlay.parent().unwrap()
    );
    let mut replaced = paths;
    replaced.user_settings = overlay;
    assert!(original_profile_root(&replaced).is_err());
}

#[test]
fn unrelated_project_without_the_requested_history_is_not_an_index_issue() {
    let f = Fixture::new();
    let unrelated = f.profile.join("projects/unrelated-legacy-project");
    std::fs::create_dir(&unrelated).unwrap();
    let result = f
        .lookup()
        .lookup(Fixture::params(None, 64), &CancellationToken::new())
        .unwrap();
    assert_eq!(
        result.completeness,
        ThreadWorkspaceLookupCompleteness::Complete
    );
    assert_eq!(result.issue_count, 0);
    assert_eq!(result.candidates.len(), 1);
}
