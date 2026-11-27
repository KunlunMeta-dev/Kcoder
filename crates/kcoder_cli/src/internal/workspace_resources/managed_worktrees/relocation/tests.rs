use super::*;
use crate::managed_worktrees::registry::ClientWorktreeSettings;
use kcoder_config::storage::StorageCoordinator;
use kcoder_types::{
    StorageLaunchIntent, StorageLocationRecord, StorageMigrationComponent, StorageMigrationPhase,
    StorageMigrationPlan, StorageTargetBinding,
};
use std::process::Command;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    source: PathBuf,
    target: PathBuf,
    repository: PathBuf,
    path: PathBuf,
    store: ClientWorktreeStore,
    control: PrivateDirectory,
}

#[test]
fn managed_worktree_reference_preflight_reads_registered_metadata_without_git_or_workspace_walks() {
    let fixture = Fixture::new();
    let registry = std::fs::read(&fixture.store.state_path).unwrap();
    let candidates = std::collections::BTreeSet::from([
        fixture.path.clone(),
        fixture.store.default_root.clone(),
    ]);
    // A metadata-only rejection must not inspect Git or working-tree contents.
    std::fs::rename(
        &fixture.repository,
        fixture.root.join("retained-repository"),
    )
    .unwrap();
    let paths =
        profile_relocation_reference_paths(&fixture.source, &fixture.target, &candidates).unwrap();
    assert!(paths.contains(&fixture.store.default_root));
    assert!(paths.contains(&fixture.path));
    assert_eq!(std::fs::read(&fixture.store.state_path).unwrap(), registry);
    assert!(
        profile_relocation_reference_paths(&fixture.source, &fixture.source, &candidates)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn managed_worktree_reference_preflight_preserves_external_roots_and_missing_registries() {
    let fixture = Fixture::new();
    let mut state = fixture.store.load().unwrap();
    state.records.clear();
    state.settings.resolved_worktree_root = utf8(&fixture.root.join("external-worktrees"))
        .unwrap()
        .into();
    fixture.store.save(&state).unwrap();
    let candidates = std::collections::BTreeSet::from([fixture.path.clone()]);
    assert!(
        profile_relocation_reference_paths(&fixture.source, &fixture.target, &candidates)
            .unwrap()
            .is_empty()
    );
    let source = fixture.root.join("empty-profile");
    let _source = PrivateDirectory::open_or_create(&source).unwrap();
    assert!(
        profile_relocation_reference_paths(
            &source,
            &fixture.target,
            &std::collections::BTreeSet::from([source.join("unknown-workspace")])
        )
        .unwrap()
        .is_empty()
    );
    assert!(!source.join("projects").exists());
}

#[cfg(unix)]
#[test]
fn managed_worktree_reference_preflight_keeps_distinct_case_sensitive_external_directories() {
    let fixture = Fixture::new();
    let external = fixture
        .store
        .default_root
        .with_file_name("MANAGED-WORKTREES");
    std::fs::create_dir_all(&external).unwrap();
    assert_ne!(
        directory(&external)
            .unwrap()
            .portable_directory_handle_identity()
            .unwrap(),
        directory(&fixture.store.default_root)
            .unwrap()
            .portable_directory_handle_identity()
            .unwrap()
    );
    let candidates = std::collections::BTreeSet::from([fixture.path.clone(), external.clone()]);
    let affected =
        profile_relocation_reference_paths(&fixture.source, &fixture.target, &candidates).unwrap();
    assert!(affected.contains(&fixture.path));
    assert!(!affected.contains(&external));
}

#[cfg(windows)]
#[tokio::test]
async fn managed_worktree_reference_preflight_matches_candidate_and_registry_case_aliases_by_full_id()
 {
    let fixture = Fixture::new();
    let source_alias = fixture.source.with_file_name(
        fixture
            .source
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_ascii_uppercase(),
    );
    assert_eq!(
        PrivateDirectory::open_existing(&source_alias)
            .unwrap()
            .portable_directory_handle_identity()
            .unwrap(),
        directory(&fixture.source)
            .unwrap()
            .portable_directory_handle_identity()
            .unwrap(),
        "owned fixture requires a case-insensitive directory"
    );
    let root_alias = source_alias.join(
        fixture
            .store
            .default_root
            .strip_prefix(&fixture.source)
            .unwrap(),
    );
    let path_alias = root_alias.join(
        fixture
            .path
            .strip_prefix(&fixture.store.default_root)
            .unwrap(),
    );
    let mut state = fixture.store.load().unwrap();
    state.settings.resolved_worktree_root = utf8(&root_alias).unwrap().into();
    let mut record = state.records.remove(utf8(&fixture.path).unwrap()).unwrap();
    record.path = utf8(&path_alias).unwrap().into();
    record.lease_key.clear();
    state.records.insert(record.path.clone(), record);
    fixture.store.save(&state).unwrap();
    let missing = path_alias.join("not-created-descendant");
    let external = fixture.root.join("external-project/not-created-descendant");
    let mixed = PathBuf::from(format!(r"\\?\{}", fixture.path.display()).replacen(
        r"\repository",
        "/repository",
        1,
    ));
    let candidates = std::collections::BTreeSet::from([
        fixture.path.clone(),
        missing.clone(),
        mixed.clone(),
        external.clone(),
        PathBuf::from(r"\\not-a-host.invalid\share\workspace"),
    ]);
    let registry = std::fs::read(&fixture.store.state_path).unwrap();
    let affected =
        profile_relocation_reference_paths(&fixture.source, &fixture.target, &candidates).unwrap();
    assert_eq!(
        affected,
        std::collections::BTreeSet::from([fixture.path.clone(), missing, mixed])
    );
    assert_eq!(std::fs::read(&fixture.store.state_path).unwrap(), registry);
    // The real owner also rejects an alias without any Gateway/Mobile references.
    let error = fixture
        .store
        .relocation_preview(&fixture.source, &fixture.target)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("STORAGE_MANAGED_WORKTREE_INTERNAL_ALIAS_UNSUPPORTED")
    );
    assert_eq!(std::fs::read(&fixture.store.state_path).unwrap(), registry);
}

#[cfg(windows)]
#[test]
#[ignore = "requires a distinct actual 8.3 alias on the owned local volume"]
fn managed_worktree_reference_preflight_matches_an_actual_owned_short_path_alias() {
    use std::{
        ffi::OsString,
        os::windows::ffi::{OsStrExt, OsStringExt},
    };
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let fixture = Fixture::new();
    let wide = fixture
        .path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // SAFETY: wide is a live NUL-terminated owned path; a null output queries its size.
    let size = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
    assert!(size > 0, "actual owned short-path prerequisite unavailable");
    let mut output = vec![0; size as usize];
    // SAFETY: output has the reported writable UTF-16 capacity.
    let length = unsafe { GetShortPathNameW(wide.as_ptr(), output.as_mut_ptr(), size) };
    assert!(length > 0 && length < size);
    output.truncate(length as usize);
    let alias = PathBuf::from(OsString::from_wide(&output));
    assert_ne!(
        alias, fixture.path,
        "8.3 is disabled: this explicit prerequisite run is not a pass"
    );
    assert!(
        alias
            .components()
            .any(|part| part.as_os_str().to_string_lossy().contains('~')),
        "a distinct actual short-name component is required"
    );
    assert_eq!(
        PrivateDirectory::open_existing(&alias)
            .unwrap()
            .portable_directory_handle_identity()
            .unwrap(),
        directory(&fixture.path)
            .unwrap()
            .portable_directory_handle_identity()
            .unwrap()
    );
    let candidate = alias.join("not-created-descendant");
    let candidates = std::collections::BTreeSet::from([candidate.clone()]);
    assert_eq!(
        profile_relocation_reference_paths(&fixture.source, &fixture.target, &candidates).unwrap(),
        candidates
    );
}

fn command(cwd: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command.args(args).current_dir(cwd).env_clear();
    for key in ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", crate::git::NULL_DEVICE_PATH)
        .env("GIT_CONFIG_SYSTEM", crate::git::NULL_DEVICE_PATH)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    let output = command.output().expect("owned Git fixture requires Git");
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            assert!(entry.file_type().unwrap().is_file());
            std::fs::copy(entry.path(), destination).unwrap();
        }
    }
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(temp.path()).unwrap();
        let source = root.join("原数据 old");
        let target = root.join("新数据 final");
        let repository = root.join("external-repository");
        std::fs::create_dir_all(&repository).unwrap();
        command(&repository, &["init", "--initial-branch=main"]);
        std::fs::write(repository.join("tracked.txt"), b"original\n").unwrap();
        std::fs::write(repository.join(".gitignore"), b"ignored/\n").unwrap();
        command(&repository, &["add", "."]);
        command(
            &repository,
            &[
                "-c",
                "user.name=Owned Fixture",
                "-c",
                "user.email=fixture@kcoder.local",
                "commit",
                "-m",
                "baseline",
            ],
        );
        let base = source.join("projects").join("owned-project");
        let store = ClientWorktreeStore::from_client_storage_root(base.join("sessions"), true);
        let path = store.default_root.join("task-a").join("repository");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        command(
            &repository,
            &["worktree", "add", "--detach", utf8(&path).unwrap(), "HEAD"],
        );
        let record = ClientManagedWorktree {
            worktree_id: "task-a".into(),
            path: utf8(&path).unwrap().into(),
            repository_name: "repository".into(),
            source_path: Some(utf8(&repository).unwrap().into()),
            revision: 7,
            base_commit: Some(command(&repository, &["rev-parse", "HEAD"]).trim().into()),
            lease_key: hex_sha256(utf8(&path).unwrap().as_bytes()),
            state: "active".into(),
            created_at: 10,
            updated_at: 20,
            archived_conversations: vec![ClientWorktreeConversation {
                device_id: "device-stable".into(),
                task_id: "task-stable".into(),
                thread_id: "thread-stable".into(),
                workspace_path: utf8(&path).unwrap().into(),
                title: "preserved title".into(),
                created_at: 11,
                updated_at: 12,
                ..Default::default()
            }],
            ..Default::default()
        };
        store
            .save(&ClientWorktreeState {
                version: 2,
                settings: ClientWorktreeSettings {
                    resolved_worktree_root: utf8(&store.default_root).unwrap().into(),
                    ..Default::default()
                },
                records: BTreeMap::from([(record.path.clone(), record)]),
            })
            .unwrap();
        let control = PrivateDirectory::open_or_create(&root.join("operation-control")).unwrap();
        Self {
            _temp: temp,
            root,
            source,
            target,
            repository,
            path,
            store,
            control,
        }
    }

    fn target_store(&self) -> ClientWorktreeStore {
        ClientWorktreeStore::from_client_storage_root(
            mapped(&self.store.state_path, &self.source, &self.target)
                .parent()
                .unwrap()
                .join("sessions"),
            true,
        )
    }

    fn dirty(&self) {
        std::fs::write(self.path.join("tracked.txt"), b"staged\n").unwrap();
        command(&self.path, &["add", "tracked.txt"]);
        std::fs::write(self.path.join("tracked.txt"), b"staged\nunstaged\n").unwrap();
        std::fs::write(self.path.join("未跟踪.bin"), b"untracked\0bytes").unwrap();
        std::fs::create_dir(self.path.join("ignored")).unwrap();
        std::fs::write(self.path.join("ignored/retained.bin"), b"ignored content").unwrap();
    }
}

fn published_fixture(
    fixture: &Fixture,
    operation: &str,
) -> (
    StorageCoordinator,
    StoragePublishedComponent,
    PrivateDirectory,
) {
    let (mut coordinator, control) =
        copying_fixture(&fixture.root, &fixture.source, &fixture.target, operation);
    coordinator
        .publish_component(
            operation,
            kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
            &Default::default(),
        )
        .unwrap();
    let published = coordinator
        .open_published_component(operation, kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN)
        .unwrap();
    (coordinator, published, control)
}

fn copying_fixture(
    root: &Path,
    source: &Path,
    target: &Path,
    operation: &str,
) -> (StorageCoordinator, PrivateDirectory) {
    let home = root.join(format!("publication-home-{operation}"));
    std::fs::create_dir(&home).unwrap();
    let from = kcoder_config::storage::resolve_storage_paths(
        &kcoder_config::storage::StorageResolveInput {
            home: Some(home.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: operation.into(),
        original: None,
        from,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: target.into(),
            cache_root: root.join("new-cache"),
            operation_id: Some(operation.into()),
        },
        components: vec![StorageMigrationComponent {
            domain: kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: source.into(),
            destination: target.into(),
            source_identity: directory(source).unwrap().directory_identity().unwrap(),
            estimated_bytes: 0,
        }],
        target_bindings: vec![StorageTargetBinding {
            path: target.into(),
            existing_ancestor: root.into(),
            ancestor_identity: directory(root).unwrap().directory_identity().unwrap(),
        }],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    };
    let mut coordinator = StorageCoordinator::acquire(&home).unwrap();
    coordinator.begin(plan).unwrap();
    coordinator
        .advance(
            operation,
            StorageMigrationPhase::Planned,
            StorageMigrationPhase::Stopping,
        )
        .unwrap();
    coordinator
        .advance(
            operation,
            StorageMigrationPhase::Stopping,
            StorageMigrationPhase::Stopped,
        )
        .unwrap();
    coordinator
        .advance(
            operation,
            StorageMigrationPhase::Stopped,
            StorageMigrationPhase::Copying,
        )
        .unwrap();
    let control = coordinator.offline_operation_directory(operation).unwrap();
    (coordinator, control)
}

#[tokio::test]
async fn managed_worktree_relocation_public_api_issues_held_workspace_facts_for_actual_publication()
{
    let fixture = Fixture::new();
    fixture.dirty();
    let expected = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    let (_coordinator, published, control) = published_fixture(&fixture, "published-worktree");
    let target = fixture.target_store();
    let verified = fixture
        .store
        .relocate(
            &target,
            "published-worktree",
            &control,
            &expected,
            &published,
        )
        .await
        .unwrap();
    assert!(!verified.summary().source_registration_preserved);
    assert_eq!(verified.workspace_facts().len(), 1);
    let fact = &verified.workspace_facts()[0];
    assert_eq!(fact.operation_id(), "published-worktree");
    assert_eq!(fact.worktree_id(), "task-a");
    assert_eq!(fact.source_record_revision(), 7);
    assert_eq!(fact.source_path(), fixture.path);
    assert_eq!(
        fact.destination_path(),
        mapped(&fixture.path, &fixture.source, &fixture.target)
    );
    assert_eq!(
        fact.relative_path(),
        fixture.path.strip_prefix(&fixture.source).unwrap()
    );
    assert_eq!(fact.source_registry_identity(), &expected.registry.identity);
    assert_eq!(
        fact.source_directory_identity(),
        fact.source_directory().directory_identity().unwrap()
    );
    assert_eq!(
        fact.target_directory_identity(),
        fact.target_directory().directory_identity().unwrap()
    );
    assert_ne!(
        fact.source_directory_identity(),
        fact.target_directory_identity()
    );
    fact.verify().unwrap();
    fixture
        .store
        .verify_relocation(
            &target,
            "published-worktree",
            &control,
            &expected,
            &published,
        )
        .await
        .unwrap();

    // Keep the exact .git file object while replacing its containing directory.
    // A path or file-only proof cannot establish workspace identity continuity.
    let moved = fixture.root.join("retained-published-workspace");
    std::fs::rename(fact.destination_path(), &moved).unwrap();
    std::fs::create_dir(fact.destination_path()).unwrap();
    std::fs::rename(moved.join(".git"), fact.destination_path().join(".git")).unwrap();
    assert!(fact.verify().is_err());
}

#[tokio::test]
async fn managed_worktree_relocation_public_api_rejects_raw_copy_and_wrong_operation_proof() {
    let raw = Fixture::new();
    let expected = raw
        .store
        .relocation_snapshot(&raw.source, &raw.target)
        .await
        .unwrap()
        .unwrap();
    copy_tree(&raw.source, &raw.target);
    let owned = Fixture::new();
    let (_coordinator, published, control) = published_fixture(&owned, "published-worktree");
    let binding = expected.entries[0].git.as_ref().unwrap();
    let original = read_path(&binding.admin.join("gitdir")).unwrap();
    assert!(
        raw.store
            .relocate(
                &raw.target_store(),
                "published-worktree",
                &control,
                &expected,
                &published
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("published_component_mismatch")
    );
    assert_eq!(read_path(&binding.admin.join("gitdir")).unwrap(), original);
    assert!(
        read_optional(&control, &receipt_name(&raw.store.state_path))
            .unwrap()
            .is_none()
    );

    let owned_snapshot = owned
        .store
        .relocation_snapshot(&owned.source, &owned.target)
        .await
        .unwrap()
        .unwrap();
    assert!(
        owned
            .store
            .relocate(
                &owned.target_store(),
                "wrong-operation",
                &control,
                &owned_snapshot,
                &published
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("published_component_mismatch")
    );
    assert!(
        read_optional(&control, &receipt_name(&owned.store.state_path))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn managed_worktree_relocation_preserves_dirty_content_and_does_not_repair_broken_peer() {
    let fixture = Fixture::new();
    fixture.dirty();
    let peer = fixture.root.join("external-peer");
    command(
        &fixture.repository,
        &["worktree", "add", "--detach", utf8(&peer).unwrap(), "HEAD"],
    );
    let peer_pointer = std::fs::read_to_string(peer.join(".git")).unwrap();
    let peer_admin = PathBuf::from(peer_pointer.trim().strip_prefix("gitdir: ").unwrap());
    let peer_registration = read_path(&peer_admin.join("gitdir")).unwrap();
    // A broad `git worktree repair target` would rewrite this peer file.
    std::fs::write(peer.join(".git"), b"unknown broken peer pointer\n").unwrap();
    let peer_stamp = read_path(&peer.join(".git")).unwrap();
    let mut original: Value =
        serde_json::from_slice(&std::fs::read(&fixture.store.state_path).unwrap()).unwrap();
    original["unsettledBusinessReceipt"] =
        json!({"state":"unknown", "requestId":"same-request", "userText": fixture.path});
    std::fs::write(
        &fixture.store.state_path,
        serde_json::to_vec(&original).unwrap(),
    )
    .unwrap();

    assert!(
        fixture
            .store
            .relocation_preview(&fixture.source, &fixture.target)
            .await
            .unwrap()
    );
    let expected = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    let source_registry = std::fs::read(&fixture.store.state_path).unwrap();
    let original_admin = expected.entries[0].git.as_ref().unwrap().admin.clone();
    let original_index = read_path(&original_admin.join("index")).unwrap();
    copy_tree(&fixture.source, &fixture.target);
    let target_store = fixture.target_store();
    let result = fixture
        .store
        .relocate_core(&target_store, "operation-one", &fixture.control, &expected)
        .await
        .unwrap();
    assert!(!result.source_registration_preserved);
    assert_eq!(result.redirected_worktrees, vec![fixture.path.clone()]);
    fixture
        .store
        .verify_relocation_core(&target_store, "operation-one", &fixture.control, &expected)
        .await
        .unwrap();
    let receipt_before =
        read_optional(&fixture.control, &receipt_name(&fixture.store.state_path)).unwrap();
    let relocated_registration = read_path(&original_admin.join("gitdir")).unwrap();
    let relocated_registry = read_path(&target_store.state_path).unwrap();
    fixture
        .store
        .relocate_core(&target_store, "operation-one", &fixture.control, &expected)
        .await
        .unwrap();
    assert_eq!(
        read_optional(&fixture.control, &receipt_name(&fixture.store.state_path)).unwrap(),
        receipt_before
    );
    assert_eq!(
        read_path(&original_admin.join("gitdir")).unwrap(),
        relocated_registration
    );
    assert_eq!(
        read_path(&target_store.state_path).unwrap(),
        relocated_registry
    );
    assert!(
        fixture
            .store
            .relocate_core(
                &target_store,
                "another-operation",
                &fixture.control,
                &expected
            )
            .await
            .is_err()
    );
    assert_eq!(read_path(&peer.join(".git")).unwrap(), peer_stamp);
    assert_eq!(
        read_path(&peer_admin.join("gitdir")).unwrap(),
        peer_registration
    );
    assert_eq!(
        read_path(&original_admin.join("index")).unwrap(),
        original_index
    );
    assert_eq!(
        std::fs::read(&fixture.store.state_path).unwrap(),
        source_registry
    );
    let target_path = mapped(&fixture.path, &fixture.source, &fixture.target);
    assert_eq!(
        std::fs::read(target_path.join("tracked.txt")).unwrap(),
        b"staged\nunstaged\n"
    );
    assert_eq!(
        std::fs::read(target_path.join("未跟踪.bin")).unwrap(),
        b"untracked\0bytes"
    );
    assert_eq!(
        std::fs::read(target_path.join("ignored/retained.bin")).unwrap(),
        b"ignored content"
    );
    let state = target_store.load().unwrap();
    let record = state.records.get(utf8(&target_path).unwrap()).unwrap();
    assert_eq!(record.worktree_id, "task-a");
    assert_eq!(record.revision, 7);
    assert_eq!(record.archived_conversations[0].thread_id, "thread-stable");
    assert_eq!(
        record.archived_conversations[0].workspace_path,
        utf8(&target_path).unwrap()
    );
    let actual: Value =
        serde_json::from_slice(&std::fs::read(&target_store.state_path).unwrap()).unwrap();
    assert_eq!(
        actual["unsettledBusinessReceipt"],
        original["unsettledBusinessReceipt"]
    );
}

#[tokio::test]
async fn managed_worktree_relocation_retains_archive_commit_old_ref_and_restore_binding() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.path.join("archived.txt"),
        b"archived untracked content\n",
    )
    .unwrap();
    command(&fixture.path, &["add", "-A"]);
    command(
        &fixture.path,
        &[
            "-c",
            "user.name=Owned Fixture",
            "-c",
            "user.email=fixture@kcoder.local",
            "commit",
            "-m",
            "owned snapshot",
        ],
    );
    let commit = command(&fixture.path, &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let reference = format!(
        "refs/kcoder/worktree-snapshots/{}",
        hex_sha256(utf8(&fixture.path).unwrap().as_bytes())
    );
    command(&fixture.path, &["update-ref", &reference, &commit]);
    command(
        &fixture.repository,
        &["worktree", "remove", utf8(&fixture.path).unwrap()],
    );
    let mut state = fixture.store.load().unwrap();
    let record = state.records.values_mut().next().unwrap();
    record.state = "restorable".into();
    record.snapshot_ref = Some(reference.clone());
    record.snapshot_commit = Some(commit.clone());
    record.git_common_dir = Some(utf8(&fixture.repository.join(".git")).unwrap().into());
    fixture.store.save(&state).unwrap();
    let expected = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    copy_tree(&fixture.source, &fixture.target);
    let target_store = fixture.target_store();
    fixture
        .store
        .relocate_core(
            &target_store,
            "archive-operation",
            &fixture.control,
            &expected,
        )
        .await
        .unwrap();
    fixture
        .store
        .verify_relocation_core(
            &target_store,
            "archive-operation",
            &fixture.control,
            &expected,
        )
        .await
        .unwrap();
    let state = target_store.load().unwrap();
    let record = state.records.values().next().unwrap();
    assert_eq!(record.snapshot_commit.as_deref(), Some(commit.as_str()));
    assert_eq!(record.archived_conversations[0].thread_id, "thread-stable");
    assert_ne!(record.snapshot_ref.as_deref(), Some(reference.as_str()));
    assert_eq!(
        command(&fixture.repository, &["rev-parse", &reference]).trim(),
        commit
    );
    assert_eq!(
        command(
            &fixture.repository,
            &["rev-parse", record.snapshot_ref.as_ref().unwrap()]
        )
        .trim(),
        commit
    );
    // Exercise Git's real restoration from the owner-converted archival record.
    let restored = Path::new(&record.path);
    std::fs::create_dir_all(restored.parent().unwrap()).unwrap();
    command(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "--detach",
            &record.path,
            record.snapshot_ref.as_ref().unwrap(),
        ],
    );
    assert_eq!(
        std::fs::read(restored.join("archived.txt")).unwrap(),
        b"archived untracked content\n"
    );
}

#[tokio::test]
async fn managed_worktree_relocation_external_root_is_preserved_byte_for_byte() {
    let fixture = Fixture::new();
    let external = fixture.root.join("explicit-external-managed");
    let moved = external.join("task-a/repository");
    std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
    command(
        &fixture.repository,
        &[
            "worktree",
            "move",
            utf8(&fixture.path).unwrap(),
            utf8(&moved).unwrap(),
        ],
    );
    let mut state = fixture.store.load().unwrap();
    state.settings.worktree_root = utf8(&external).unwrap().into();
    state.settings.resolved_worktree_root = utf8(&external).unwrap().into();
    let mut record = state.records.pop_first().unwrap().1;
    record.path = utf8(&moved).unwrap().into();
    record.lease_key = hex_sha256(record.path.as_bytes());
    record.archived_conversations[0].workspace_path = record.path.clone();
    state.records.insert(record.path.clone(), record);
    fixture.store.save(&state).unwrap();
    let before = std::fs::read(&fixture.store.state_path).unwrap();
    let expected = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    assert!(expected.entries.is_empty());
    copy_tree(&fixture.source, &fixture.target);
    let target = fixture.target_store();
    let result = fixture
        .store
        .relocate_core(&target, "external-operation", &fixture.control, &expected)
        .await
        .unwrap();
    assert!(result.source_registration_preserved);
    assert_eq!(std::fs::read(&target.state_path).unwrap(), before);
    assert!(moved.join("tracked.txt").exists());
}

#[tokio::test]
async fn managed_worktree_relocation_missing_registry_does_not_initialize_anything() {
    let temp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(temp.path()).unwrap();
    let source = root.join("source");
    std::fs::create_dir(&source).unwrap();
    let store =
        ClientWorktreeStore::from_client_storage_root(source.join("missing/sessions"), true);
    assert!(
        !store
            .relocation_preview(&source, &root.join("target"))
            .await
            .unwrap()
    );
    assert!(
        store
            .relocation_snapshot(&source, &root.join("target"))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(std::fs::read_dir(source).unwrap().count(), 0);
    assert!(!root.join("target").exists());
}

#[tokio::test]
async fn managed_worktree_relocation_preview_preserves_and_blocks_unregistered_managed_entries() {
    let fixture = Fixture::new();
    let unknown = fixture.store.default_root.join("unknown-owner");
    std::fs::create_dir(&unknown).unwrap();
    std::fs::write(unknown.join("owned-by-someone-else"), b"preserve unknown").unwrap();
    let error = fixture
        .store
        .relocation_preview(&fixture.source, &fixture.target)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("unregistered_managed_entry"));
    assert_eq!(
        std::fs::read(unknown.join("owned-by-someone-else")).unwrap(),
        b"preserve unknown"
    );
    assert!(!fixture.target.exists());
    assert!(
        read_optional(&fixture.control, &receipt_name(&fixture.store.state_path))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn managed_worktree_relocation_preview_blocks_unsettled_or_unrecognized_git_formats() {
    let fixture = Fixture::new();
    let original = std::fs::read(&fixture.store.state_path).unwrap();
    let mut state = fixture.store.load().unwrap();
    let record = state.records.values_mut().next().unwrap();
    record.state = "restoring".into();
    record.snapshot_ref = Some(format!(
        "refs/kcoder/worktree-snapshots/{}",
        hex_sha256(record.path.as_bytes())
    ));
    record.snapshot_commit = record.base_commit.clone();
    record.git_common_dir = Some(utf8(&fixture.repository.join(".git")).unwrap().into());
    fixture.store.save(&state).unwrap();
    assert!(
        fixture
            .store
            .relocation_preview(&fixture.source, &fixture.target)
            .await
            .unwrap_err()
            .to_string()
            .contains("unsettled_lifecycle")
    );
    std::fs::write(&fixture.store.state_path, original).unwrap();
    let pointer = std::fs::read(fixture.path.join(".git")).unwrap();
    std::fs::write(fixture.path.join(".git"), b"gitdir: relative-admin\n").unwrap();
    assert!(
        fixture
            .store
            .relocation_preview(&fixture.source, &fixture.target)
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(fixture.path.join(".git")).unwrap(),
        b"gitdir: relative-admin\n"
    );
    std::fs::write(fixture.path.join(".git"), pointer).unwrap();
}

#[tokio::test]
async fn managed_worktree_relocation_rejects_registration_and_target_content_races_before_mutation()
{
    let fixture = Fixture::new();
    fixture.dirty();
    let expected = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    copy_tree(&fixture.source, &fixture.target);
    let admin = &expected.entries[0].git.as_ref().unwrap().admin;
    let before = read_path(&admin.join("gitdir")).unwrap();
    let target_path = mapped(&fixture.path, &fixture.source, &fixture.target);
    std::fs::write(target_path.join("未跟踪.bin"), b"changed target").unwrap();
    assert!(
        fixture
            .store
            .relocate_core(
                &fixture.target_store(),
                "content-race",
                &fixture.control,
                &expected
            )
            .await
            .is_err()
    );
    assert_eq!(read_path(&admin.join("gitdir")).unwrap(), before);
    assert!(
        read_optional(&fixture.control, &receipt_name(&fixture.store.state_path))
            .unwrap()
            .is_none()
    );
    std::fs::copy(
        fixture.path.join("未跟踪.bin"),
        target_path.join("未跟踪.bin"),
    )
    .unwrap();
    std::fs::write(
        admin.join("gitdir"),
        fixture
            .root
            .join("another-owner/.git")
            .to_string_lossy()
            .as_bytes(),
    )
    .unwrap();
    let changed = read_path(&admin.join("gitdir")).unwrap();
    assert!(
        fixture
            .store
            .relocate_core(
                &fixture.target_store(),
                "registration-race",
                &fixture.control,
                &expected
            )
            .await
            .is_err()
    );
    assert_eq!(read_path(&admin.join("gitdir")).unwrap(), changed);
}

#[tokio::test]
async fn managed_worktree_relocation_unknown_publication_is_not_replayed() {
    let fixture = Fixture::new();
    let expected = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    copy_tree(&fixture.source, &fixture.target);
    let target = fixture.target_store();
    let transformed = fixture.store.target_bytes(&target, &expected).unwrap();
    let mut receipt = prepare_receipt(
        &target,
        "unknown-operation",
        &fixture.control,
        &expected,
        &transformed,
    )
    .await
    .unwrap();
    let bytes = gitdir_replacement(&expected.entries[0].target).unwrap();
    let unknown_file = fixture.root.join("unknown-candidate");
    std::fs::write(&unknown_file, &bytes).unwrap();
    receipt.replacements[0].candidate = Some(read_path(&unknown_file).unwrap().1);
    write_receipt(&fixture.control, &receipt).unwrap();
    let before = read_path(&receipt.replacements[0].parent.join("gitdir")).unwrap();
    let error = fixture
        .store
        .relocate_core(&target, "unknown-operation", &fixture.control, &expected)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("unsettled"), "{error:#}");
    assert_eq!(
        read_path(&receipt.replacements[0].parent.join("gitdir")).unwrap(),
        before
    );
    assert!(
        !receipt.replacements[0]
            .parent
            .join(candidate_name("unknown-operation", 0))
            .exists()
    );
    assert_eq!(
        std::fs::read(&target.state_path).unwrap(),
        std::fs::read(&fixture.store.state_path).unwrap()
    );
}

#[tokio::test]
async fn managed_worktree_relocation_ref_requires_original_intent_and_reconciles_lost_receipt() {
    let fixture = Fixture::new();
    let mut state = fixture.store.load().unwrap();
    let record = state.records.values_mut().next().unwrap();
    let commit = record.base_commit.clone().unwrap();
    let reference = format!(
        "refs/kcoder/worktree-snapshots/{}",
        hex_sha256(record.path.as_bytes())
    );
    command(&fixture.repository, &["update-ref", &reference, &commit]);
    command(
        &fixture.repository,
        &["worktree", "remove", utf8(&fixture.path).unwrap()],
    );
    record.state = "restorable".into();
    record.snapshot_ref = Some(reference.clone());
    record.snapshot_commit = Some(commit.clone());
    record.git_common_dir = Some(utf8(&fixture.repository.join(".git")).unwrap().into());
    fixture.store.save(&state).unwrap();
    let expected = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    let retained = expected.entries[0].snapshot.as_ref().unwrap();
    copy_tree(&fixture.source, &fixture.target);
    let target = fixture.target_store();

    // Equal commit bytes without this operation's prior intent are a conflict.
    command(&fixture.repository, &["update-ref", &retained.new, &commit]);
    assert!(
        fixture
            .store
            .relocate_core(&target, "ref-operation", &fixture.control, &expected)
            .await
            .unwrap_err()
            .to_string()
            .contains("target_ref_exists")
    );
    assert!(
        read_optional(&fixture.control, &receipt_name(&fixture.store.state_path))
            .unwrap()
            .is_none()
    );
    command(&fixture.repository, &["update-ref", "-d", &retained.new]);

    let transformed = fixture.store.target_bytes(&target, &expected).unwrap();
    let mut receipt = prepare_receipt(
        &target,
        "ref-operation",
        &fixture.control,
        &expected,
        &transformed,
    )
    .await
    .unwrap();
    receipt.refs[0] = RefState::Intent;
    write_receipt(&fixture.control, &receipt).unwrap();
    assert!(
        fixture
            .store
            .relocate_core(&target, "ref-operation", &fixture.control, &expected)
            .await
            .unwrap_err()
            .to_string()
            .contains("do_not_replay")
    );
    assert!(
        read_ref(&retained.common, &retained.new)
            .await
            .unwrap()
            .is_none()
    );
    // The original effect becomes authoritatively visible after its lost reply.
    command(
        &fixture.repository,
        &[
            "update-ref",
            &retained.new,
            &commit,
            &"0".repeat(commit.len()),
        ],
    );
    let ref_file = retained.common.join(&retained.new);
    let before = read_path(&ref_file).unwrap();
    fixture
        .store
        .relocate_core(&target, "ref-operation", &fixture.control, &expected)
        .await
        .unwrap();
    assert_eq!(read_path(&ref_file).unwrap(), before);
    assert_eq!(
        read_ref(&retained.common, &retained.old)
            .await
            .unwrap()
            .as_deref(),
        Some(commit.as_str())
    );
    fixture
        .store
        .verify_relocation_core(&target, "ref-operation", &fixture.control, &expected)
        .await
        .unwrap();
}

#[tokio::test]
async fn managed_worktree_relocation_multiple_projects_share_the_original_operation_directory() {
    let fixture = Fixture::new();
    let second = ClientWorktreeStore::from_client_storage_root(
        fixture.source.join("projects/second/sessions"),
        true,
    );
    let second_path = second.default_root.join("task-a/repository");
    std::fs::create_dir_all(second_path.parent().unwrap()).unwrap();
    command(
        &fixture.repository,
        &[
            "worktree",
            "add",
            "--detach",
            utf8(&second_path).unwrap(),
            "HEAD",
        ],
    );
    let mut state = fixture.store.load().unwrap();
    state.settings.resolved_worktree_root = utf8(&second.default_root).unwrap().into();
    let mut record = state.records.pop_first().unwrap().1;
    record.path = utf8(&second_path).unwrap().into();
    record.lease_key = hex_sha256(record.path.as_bytes());
    record.archived_conversations[0].workspace_path = record.path.clone();
    state.records.insert(record.path.clone(), record);
    second.save(&state).unwrap();
    let first_snapshot = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    let second_snapshot = second
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    copy_tree(&fixture.source, &fixture.target);
    let first_target = fixture.target_store();
    let second_target = ClientWorktreeStore::from_client_storage_root(
        fixture.target.join("projects/second/sessions"),
        true,
    );
    fixture
        .store
        .relocate_core(
            &first_target,
            "same-operation",
            &fixture.control,
            &first_snapshot,
        )
        .await
        .unwrap();
    second
        .relocate_core(
            &second_target,
            "same-operation",
            &fixture.control,
            &second_snapshot,
        )
        .await
        .unwrap();
    fixture
        .store
        .verify_relocation_core(
            &first_target,
            "same-operation",
            &fixture.control,
            &first_snapshot,
        )
        .await
        .unwrap();
    second
        .verify_relocation_core(
            &second_target,
            "same-operation",
            &fixture.control,
            &second_snapshot,
        )
        .await
        .unwrap();
    assert_ne!(
        receipt_name(&fixture.store.state_path),
        receipt_name(&second.state_path)
    );
    assert!(
        read_optional(&fixture.control, &receipt_name(&fixture.store.state_path))
            .unwrap()
            .is_some()
    );
    assert!(
        read_optional(&fixture.control, &receipt_name(&second.state_path))
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn managed_worktree_relocation_journal_name_does_not_adopt_an_unknown_receipt() {
    let fixture = Fixture::new();
    let expected = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    copy_tree(&fixture.source, &fixture.target);
    let receipt = receipt_name(&fixture.store.state_path);
    fixture
        .control
        .atomic_replace(OsStr::new(&receipt), b"unknown preserved journal")
        .unwrap();
    let binding = expected.entries[0].git.as_ref().unwrap();
    let before = read_path(&binding.admin.join("gitdir")).unwrap();
    assert!(
        fixture
            .store
            .relocate_core(
                &fixture.target_store(),
                "operation-one",
                &fixture.control,
                &expected
            )
            .await
            .is_err()
    );
    assert_eq!(
        read_optional(&fixture.control, &receipt).unwrap().unwrap(),
        b"unknown preserved journal"
    );
    assert_eq!(read_path(&binding.admin.join("gitdir")).unwrap(), before);
}

#[tokio::test]
async fn managed_worktree_relocation_preserves_a_source_repository_subdirectory() {
    let fixture = Fixture::new();
    let source = fixture.repository.join("source-subdirectory");
    std::fs::create_dir(&source).unwrap();
    let mut state = fixture.store.load().unwrap();
    state.records.values_mut().next().unwrap().source_path = Some(utf8(&source).unwrap().into());
    fixture.store.save(&state).unwrap();
    let expected = fixture
        .store
        .relocation_snapshot(&fixture.source, &fixture.target)
        .await
        .unwrap()
        .unwrap();
    copy_tree(&fixture.source, &fixture.target);
    let target = fixture.target_store();
    fixture
        .store
        .relocate_core(&target, "subdirectory-source", &fixture.control, &expected)
        .await
        .unwrap();
    assert_eq!(
        target
            .load()
            .unwrap()
            .records
            .values()
            .next()
            .unwrap()
            .source_path
            .as_deref(),
        source.to_str()
    );
    assert!(source.is_dir());
}

#[tokio::test]
async fn managed_worktree_profile_relocation_collects_registered_owners_without_state_sessions() {
    let fixture = Fixture::new();
    let unrelated = fixture.source.join("unrelated/managed-worktrees.json");
    std::fs::create_dir_all(unrelated.parent().unwrap()).unwrap();
    std::fs::write(&unrelated, b"unregistered same-name file; preserve").unwrap();
    let empty_project = fixture.source.join("projects/no-managed-registry");
    std::fs::create_dir(&empty_project).unwrap();
    let original = read_path(&fixture.store.state_path).unwrap();
    let owners = profile_relocation_snapshots(&fixture.source, &fixture.target)
        .await
        .unwrap();
    assert_eq!(owners.len(), 1);
    assert_eq!(owners[0].source_store.state_path, fixture.store.state_path);
    assert_eq!(
        owners[0].target_store.state_path,
        fixture.target_store().state_path
    );
    assert_eq!(owners[0].snapshot.entries[0].worktree_id, "task-a");
    assert_eq!(read_path(&fixture.store.state_path).unwrap(), original);
    assert!(
        !fixture
            .store
            .state_path
            .parent()
            .unwrap()
            .join("client-sessions")
            .exists()
    );
    assert!(!empty_project.join("client-sessions").exists());
    assert!(!empty_project.join("managed-worktrees.json").exists());
    assert_eq!(
        std::fs::read(unrelated).unwrap(),
        b"unregistered same-name file; preserve"
    );
    assert!(!fixture.target.exists());
}

#[tokio::test]
async fn managed_worktree_profile_relocation_missing_namespaces_are_not_initialized_and_corruption_blocks()
 {
    let owned = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(owned.path()).unwrap();
    let source = root.join("source");
    let target = root.join("target");
    assert!(
        profile_relocation_snapshots(&source, &target)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!source.exists());
    std::fs::create_dir(&source).unwrap();
    assert!(
        profile_relocation_snapshots(&source, &target)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(std::fs::read_dir(&source).unwrap().count(), 0);
    let project = source.join("projects/corrupt-owner");
    std::fs::create_dir_all(&project).unwrap();
    let registry = project.join("managed-worktrees.json");
    std::fs::write(&registry, b"unknown registry schema").unwrap();
    let error = profile_relocation_snapshots(&source, &target)
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("registry_invalid"));
    assert_eq!(std::fs::read(registry).unwrap(), b"unknown registry schema");
    assert!(!project.join("client-sessions").exists());
    assert!(!project.join("managed-worktrees.lock").exists());
    assert!(!target.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn managed_worktree_profile_relocation_rejects_registry_aliases_without_following_them() {
    let owned = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(owned.path()).unwrap();
    let source = root.join("source");
    let project = source.join("projects/alias-owner");
    std::fs::create_dir_all(&project).unwrap();
    let external = root.join("external-registry.json");
    std::fs::write(&external, b"external unknown owner").unwrap();
    let registry = project.join("managed-worktrees.json");
    std::os::unix::fs::symlink(&external, &registry).unwrap();
    assert!(
        profile_relocation_snapshots(&source, &root.join("target"))
            .await
            .is_err()
    );
    assert!(
        std::fs::symlink_metadata(&registry)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read(external).unwrap(), b"external unknown owner");
    assert!(!project.join("managed-worktrees.lock").exists());
}

#[path = "profile_tests.rs"]
mod profile_tests;
