//! Cross-owner acceptance uses actual Git registration and coordinator publication.
//! No fake relocation proof, process environment override or normal Engine starts.
use super::super::*;
use kcoder_config::profile_identity::ProfileIdentity;
use kcoder_config::storage::{
    StorageCoordinator, StoragePublishedComponent, StorageResolveInput, resolve_storage_paths,
};
use kcoder_config::{PrivateDirectory, Settings};
use kcoder_state::history_storage_relocation::HistoryStorageRelocation;
use kcoder_state::{AppState, DeletedHistoryProof, HistorySourceObservation};
use kcoder_types::{
    Message, STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase, StorageMigrationPlan, StorageTargetBinding,
};
use kcoder_workspace_resources::managed_worktrees::{
    ClientWorkspaceStore, ClientWorktreeStore, worktree_request,
};
use serde_json::json;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
};

const OPERATION: &str = "managed-history-consumers";
const WORKTREE: &str = "owned-worktree";

fn git(cwd: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command.current_dir(cwd).env_clear();
    for name in ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_SYSTEM",
            kcoder_workspace_resources::git::NULL_DEVICE_PATH,
        )
        .env(
            "GIT_CONFIG_GLOBAL",
            kcoder_workspace_resources::git::NULL_DEVICE_PATH,
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args([
            "-c",
            "init.templateDir=",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(args);
    let result = command.output().expect("owned Git fixture requires Git");
    assert!(
        result.status.success(),
        "Git {args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

struct Session {
    id: String,
    path: PathBuf,
    state_path: PathBuf,
    state_bytes: Vec<u8>,
    transcript_bytes: Vec<u8>,
    metadata_path: PathBuf,
    metadata_bytes: Vec<u8>,
}

impl Session {
    async fn create(profile: &Path, workspace: &Path, registry: &Path, prompt: &str) -> Self {
        let state = AppState::new(workspace);
        state.set_short_id_registry(registry);
        state.start_new_session().unwrap();
        let id = state.session_id();
        let project = Settings::project_data_dir_at(profile, workspace).unwrap();
        PrivateDirectory::open_or_create(&project).unwrap();
        let path = project.join(format!("{id}.jsonl"));
        state.with_history_path(&path);
        state.add_message(Message::user_text(prompt));
        state.save_history().unwrap();
        state.flush_history().await.unwrap();
        state.commit_session_state();
        let state_path = state.session_state_path().unwrap();
        let state_bytes = std::fs::read(&state_path).unwrap();
        let transcript_bytes = std::fs::read(&path).unwrap();
        drop(state);
        let client = project.join("client-sessions");
        let storage = crate::ensure_thread_metadata_directory(&client, &id).unwrap();
        let _lifecycle =
            crate::try_acquire_thread_lifecycle_locks_at_root(&client, &[&id]).unwrap();
        let mut fence = kcoder_state::history_index::journal::JournalFence::try_acquire(
            &client,
            kcoder_state::history_index::journal::JournalDomain::ClientMetadata,
        )
        .unwrap();
        crate::write_thread_metadata(
            &storage,
            &crate::ThreadClientMetadata {
                version: 1,
                revision: 3,
                thread_id: id.clone(),
                workspace: workspace.to_str().unwrap().into(),
                fields: std::collections::BTreeMap::from([(
                    "title".into(),
                    Some("original owned title".into()),
                )]),
                updated_at: "1234".into(),
            },
            &mut fence,
        )
        .unwrap();
        let metadata_path = storage.join(crate::THREAD_METADATA_FILE);
        let metadata_bytes = std::fs::read(&metadata_path).unwrap();
        Self {
            id,
            path,
            state_path,
            state_bytes,
            transcript_bytes,
            metadata_path,
            metadata_bytes,
        }
    }

    fn target_path(&self, source: &Path, target: &Path) -> PathBuf {
        target.join(self.path.strip_prefix(source).unwrap())
    }

    fn target_state_path(&self, source: &Path, target: &Path) -> PathBuf {
        target.join(self.state_path.strip_prefix(source).unwrap())
    }

    fn target_metadata_path(&self, source: &Path, target: &Path) -> PathBuf {
        target.join(self.metadata_path.strip_prefix(source).unwrap())
    }
}

struct Fixture {
    source: PathBuf,
    target: PathBuf,
    workspace_a: PathBuf,
    workspace_b: PathBuf,
    source_store: ClientWorktreeStore,
    target_store: ClientWorktreeStore,
    live: Session,
    deleted: Session,
    deleted_proof: DeletedHistoryProof,
    deleted_record: Vec<u8>,
    project_key: std::ffi::OsString,
    source_workspace: PrivateDirectory,
    root: PathBuf,
    // All held descriptors above close before their owned fixture is removed.
    _owned: tempfile::TempDir,
}

struct Migrated {
    _coordinator: StorageCoordinator,
    _published: StoragePublishedComponent,
    fixture: Fixture,
}

impl Fixture {
    async fn new() -> Self {
        let owned = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(owned.path()).unwrap();
        let source = root.join("profile-A");
        let target = root.join("profile-B");
        PrivateDirectory::open_or_create(&source).unwrap();
        let repository = root.join("external-source-repository");
        std::fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "--initial-branch=main"]);
        // Production Git children inherit only this owned repository's local
        // configuration; no user hook, signing helper or fsmonitor can run.
        for (key, value) in [
            ("core.hooksPath", "/dev/null"),
            ("core.fsmonitor", "false"),
            ("core.attributesFile", "/dev/null"),
            ("commit.gpgSign", "false"),
        ] {
            git(&repository, &["config", key, value]);
        }
        std::fs::write(
            repository.join("tracked.txt"),
            b"original owned Git bytes\n",
        )
        .unwrap();
        git(&repository, &["add", "tracked.txt"]);
        git(
            &repository,
            &[
                "-c",
                "user.name=Owned Cross Owner Fixture",
                "-c",
                "user.email=fixture@kcoder.local",
                "commit",
                "-m",
                "baseline",
            ],
        );
        let owner_project = Settings::project_data_dir_at(&source, &repository).unwrap();
        let client = owner_project.join("client-sessions");
        let source_store = ClientWorktreeStore::from_client_storage_root(client.clone(), true);
        let workspaces = ClientWorkspaceStore::from_client_storage_root(client);
        let prepared = worktree_request(
            &source_store,
            &workspaces,
            &repository,
            "runtime.worktrees.prepare",
            &json!({"worktreeId":WORKTREE,"sourcePath":repository,"ref":"HEAD"}),
        )
        .await
        .unwrap();
        let workspace_a = PathBuf::from(prepared["path"].as_str().unwrap());
        let workspace_b = target.join(workspace_a.strip_prefix(&source).unwrap());
        let source_workspace = PrivateDirectory::open_existing(&workspace_a).unwrap();
        std::fs::write(
            workspace_a.join("untracked.txt"),
            b"untracked bytes stay owned\n",
        )
        .unwrap();
        let project = Settings::project_data_dir_at(&source, &workspace_a).unwrap();
        let project_key = project.file_name().unwrap().to_owned();
        let registry = root.join("owned-session-ids.json");
        let prompt = format!(
            "Keep historical user text unchanged: cwd={} ; ssh user@host:/external/source ; unknown receipt=original-request",
            workspace_a.display()
        );
        let live = Session::create(&source, &workspace_a, &registry, &prompt).await;
        let deleted = Session::create(
            &source,
            &workspace_a,
            &registry,
            "Deleted original history with stable identity",
        )
        .await;
        let deleted_proof =
            kcoder_state::mark_session_history_deleted(&deleted.path, &workspace_a).unwrap();
        let deleted_record =
            std::fs::read(deleted.path.with_extension("hctl").join("source.json")).unwrap();
        let target_client = target
            .join(owner_project.strip_prefix(&source).unwrap())
            .join("client-sessions");
        let target_store = ClientWorktreeStore::from_client_storage_root(target_client, true);
        Self {
            source,
            target,
            workspace_a,
            workspace_b,
            source_store,
            target_store,
            live,
            deleted,
            deleted_proof,
            deleted_record,
            project_key,
            source_workspace,
            root,
            _owned: owned,
        }
    }

    async fn migrate(self) -> Migrated {
        let expected = self
            .source_store
            .relocation_snapshot(&self.source, &self.target)
            .await
            .unwrap()
            .unwrap();
        let history = HistoryStorageRelocation::snapshot(&self.source).unwrap();
        let home = self.root.join("coordinator-home");
        PrivateDirectory::open_or_create(&home).unwrap();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(home.clone()),
            ..Default::default()
        })
        .unwrap();
        let plan = StorageMigrationPlan {
            version: 1,
            operation_id: OPERATION.into(),
            original: None,
            from,
            target: StorageLocationRecord {
                version: 1,
                revision: 1,
                data_root: self.target.clone(),
                cache_root: self.root.join("new-cache"),
                operation_id: Some(OPERATION.into()),
            },
            components: vec![StorageMigrationComponent {
                domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
                source: self.source.clone(),
                destination: self.target.clone(),
                source_identity: PrivateDirectory::open_existing(&self.source)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 0,
            }],
            target_bindings: vec![StorageTargetBinding {
                path: self.target.clone(),
                existing_ancestor: self.root.clone(),
                ancestor_identity: PrivateDirectory::open_existing(&self.root)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
            }],
            launch_intent: StorageLaunchIntent::VerifyOnly,
        };
        let mut coordinator = StorageCoordinator::acquire(&home).unwrap();
        coordinator.begin(plan).unwrap();
        coordinator
            .advance(
                OPERATION,
                StorageMigrationPhase::Planned,
                StorageMigrationPhase::Stopping,
            )
            .unwrap();
        coordinator
            .advance(
                OPERATION,
                StorageMigrationPhase::Stopping,
                StorageMigrationPhase::Stopped,
            )
            .unwrap();
        coordinator
            .advance(
                OPERATION,
                StorageMigrationPhase::Stopped,
                StorageMigrationPhase::Copying,
            )
            .unwrap();
        coordinator
            .publish_component(
                OPERATION,
                STORAGE_PERSISTENT_ROOT_DOMAIN,
                &Default::default(),
            )
            .unwrap();
        let published = coordinator
            .open_published_component(OPERATION, STORAGE_PERSISTENT_ROOT_DOMAIN)
            .unwrap();
        let source_profile = PrivateDirectory::open_existing(&self.source).unwrap();
        let target_profile = published.directory();
        ProfileIdentity::observe(&source_profile)
            .unwrap()
            .relocate(&source_profile, target_profile, OPERATION)
            .unwrap();
        let control = coordinator.offline_operation_directory(OPERATION).unwrap();
        let relocated = self
            .source_store
            .relocate(
                &self.target_store,
                OPERATION,
                &control,
                &expected,
                &published,
            )
            .await
            .unwrap();
        assert_eq!(relocated.workspace_facts().len(), 1);
        let fact = &relocated.workspace_facts()[0];
        assert_eq!(fact.worktree_id(), WORKTREE);
        let identity = fact
            .relocate_workspace_identity(&source_profile, target_profile)
            .unwrap();
        assert_eq!(
            identity.logical_seed(),
            self.source_workspace.directory_identity().unwrap()
        );
        fact.verify_workspace_identity_relocation(&source_profile, target_profile)
            .unwrap();
        HistoryStorageRelocation::relocate(
            &self.source,
            &self.target,
            OPERATION,
            &history,
            &published,
        )
        .unwrap();
        HistoryStorageRelocation::verify_relocation(
            &self.source,
            &self.target,
            OPERATION,
            &history,
            &published,
        )
        .unwrap();
        drop(relocated);
        Migrated {
            _coordinator: coordinator,
            _published: published,
            fixture: self,
        }
    }

    fn target_deleted(&self) -> PathBuf {
        self.deleted.target_path(&self.source, &self.target)
    }

    fn assert_deleted_record_unchanged(&self) {
        let source = self.deleted.path.with_extension("hctl").join("source.json");
        let target = self
            .target_deleted()
            .with_extension("hctl")
            .join("source.json");
        assert_eq!(std::fs::read(source).unwrap(), self.deleted_record);
        assert_eq!(std::fs::read(target).unwrap(), self.deleted_record);
    }
}

#[tokio::test]
async fn managed_worktree_deleted_proof_follows_real_publication_and_rejects_reoccupied_old_cwd() {
    let migrated = Fixture::new().await.migrate().await;
    let fixture = &migrated.fixture;
    let target_history = fixture.target_deleted();
    let proof = kcoder_state::read_session_history_deletion(&target_history, &fixture.workspace_b)
        .unwrap()
        .unwrap();
    assert_eq!(proof.thread_id(), fixture.deleted.id);
    assert_eq!(proof.sha256(), fixture.deleted_proof.sha256());
    proof.verify(&target_history, &fixture.workspace_b).unwrap();
    let observed = kcoder_state::observe_session_history_source_presence(
        &target_history,
        &fixture.workspace_b,
    )
    .unwrap();
    let HistorySourceObservation::BoundDeletedSourceAbsent(reference) = observed else {
        panic!("expected original bound deletion");
    };
    assert_eq!(reference.thread_id(), fixture.deleted.id);
    let original_record: serde_json::Value =
        serde_json::from_slice(&fixture.deleted_record).unwrap();
    assert_eq!(
        reference.source_incarnation().to_string(),
        original_record["incarnation"].as_str().unwrap()
    );
    assert_eq!(
        reference.control_record_sha256(),
        fixture.deleted_proof.sha256()
    );
    fixture.assert_deleted_record_unchanged();

    // Only this owned test directory is removed. The issued mapping and the
    // actual new workspace must work without opening the retained old cwd.
    std::fs::remove_dir_all(&fixture.workspace_a).unwrap();
    let replacement = PrivateDirectory::open_or_create(&fixture.workspace_a).unwrap();
    replacement
        .atomic_replace(
            OsStr::new("foreign-owner.txt"),
            b"foreign D, same path text",
        )
        .unwrap();
    assert_ne!(
        replacement.directory_identity().unwrap(),
        fixture.source_workspace.directory_identity().unwrap()
    );
    assert!(
        kcoder_state::read_session_history_deletion(&target_history, &fixture.workspace_a).is_err()
    );
    assert!(
        kcoder_state::observe_session_history_source_presence(
            &target_history,
            &fixture.workspace_a
        )
        .is_err()
    );
    let client = fixture
        .live
        .target_path(&fixture.source, &fixture.target)
        .parent()
        .unwrap()
        .join("client-sessions");
    assert!(
        crate::read_thread_metadata_at_profile(
            &fixture.target,
            &client,
            &fixture.workspace_a,
            &fixture.live.id,
        )
        .is_err()
    );
    assert_eq!(
        crate::read_thread_metadata_at_profile(
            &fixture.target,
            &client,
            &fixture.workspace_b,
            &fixture.live.id,
        )
        .unwrap()
        .unwrap()
        .thread_id,
        fixture.live.id
    );
    let current =
        kcoder_state::read_session_history_deletion(&target_history, &fixture.workspace_b)
            .unwrap()
            .unwrap();
    assert_eq!(current.sha256(), fixture.deleted_proof.sha256());
    assert_eq!(current.thread_id(), fixture.deleted.id);
    fixture.assert_deleted_record_unchanged();
    assert_eq!(
        std::fs::read(fixture.workspace_a.join("foreign-owner.txt")).unwrap(),
        b"foreign D, same path text"
    );
}

#[tokio::test]
async fn managed_worktree_actual_workspace_lookup_settings_and_state_restore_use_new_cwd_and_original_key()
 {
    let migrated = Fixture::new().await.migrate().await;
    let fixture = &migrated.fixture;
    let expected_project = fixture.target.join("projects").join(&fixture.project_key);
    assert_eq!(
        Settings::project_data_dir_at(&fixture.target, &fixture.workspace_b).unwrap(),
        expected_project
    );
    assert!(
        Settings::project_data_dirs_for_read_at(&fixture.target, &fixture.workspace_b)
            .unwrap()
            .contains(&expected_project)
    );
    let new_history = fixture.live.target_path(&fixture.source, &fixture.target);
    assert_eq!(new_history.parent(), Some(expected_project.as_path()));
    let state_path = fixture
        .live
        .target_state_path(&fixture.source, &fixture.target);
    assert_eq!(
        std::fs::read(&new_history).unwrap(),
        fixture.live.transcript_bytes
    );
    assert_eq!(
        std::fs::read(&state_path).unwrap(),
        fixture.live.state_bytes
    );
    let metadata_path = fixture
        .live
        .target_metadata_path(&fixture.source, &fixture.target);
    assert_eq!(
        std::fs::read(&metadata_path).unwrap(),
        fixture.live.metadata_bytes
    );
    let metadata = crate::read_thread_metadata_at_profile(
        &fixture.target,
        &expected_project.join("client-sessions"),
        &fixture.workspace_b,
        &fixture.live.id,
    )
    .unwrap()
    .unwrap();
    assert_eq!(metadata.thread_id, fixture.live.id);
    assert_eq!(metadata.workspace, fixture.workspace_b.to_str().unwrap());
    assert_eq!(metadata.revision, 3);
    assert_eq!(
        metadata.fields["title"].as_deref(),
        Some("original owned title")
    );
    assert_eq!(
        std::fs::read(metadata_path).unwrap(),
        fixture.live.metadata_bytes
    );
    let sidecar: serde_json::Value = serde_json::from_slice(&fixture.live.state_bytes).unwrap();
    assert_eq!(sidecar["base_cwd"], json!(fixture.workspace_a));
    assert_eq!(sidecar["cwd"], json!(fixture.workspace_a));
    let mut lookup = ProfileWorkspaceLookup::capture(&fixture.target).unwrap();
    let result = lookup
        .lookup(
            ThreadWorkspaceLookupParams {
                thread_id: fixture.live.id.clone(),
                cursor: None,
                limit: Some(64),
            },
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(
        result.completeness,
        ThreadWorkspaceLookupCompleteness::Complete
    );
    assert_eq!(result.issue_count, 0);
    assert_eq!(
        result.candidates,
        vec![ThreadWorkspaceHintV1 {
            workspace_path: fixture.workspace_b.to_str().unwrap().into()
        }]
    );
    assert_eq!(
        std::fs::read(&new_history).unwrap(),
        fixture.live.transcript_bytes
    );
    assert_eq!(
        std::fs::read(&state_path).unwrap(),
        fixture.live.state_bytes
    );

    let restored = AppState::new(&fixture.workspace_b);
    restored
        .resume_from_history_at_profile(&fixture.target, &new_history)
        .unwrap();
    assert_eq!(restored.session_id(), fixture.live.id);
    assert_eq!(restored.cwd(), fixture.workspace_b);
    assert_eq!(restored.base_cwd(), fixture.workspace_b);
    drop(restored);
    assert_eq!(
        std::fs::read(&new_history).unwrap(),
        fixture.live.transcript_bytes
    );
}
