use crate::{AppState, HistoryEntry, Message, Task, load_history, prepare_session_resume};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory,
    profile_identity::ProfileIdentity,
    storage::{
        StorageComponentDirectory, StorageCoordinator, StoragePublishedComponent,
        StorageResolveInput, resolve_storage_paths,
    },
    workspace_identity::{
        ManagedWorkspaceRelocationProof, WorkspaceAddressLookup, WorkspaceIdentity,
    },
};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
    StorageTargetBinding, TaskStatus,
};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

fn private_directory(path: &Path) -> Result<PrivateDirectory> {
    PrivateDirectory::open_existing(path)
}

struct PublishedMove {
    _coordinator: StorageCoordinator,
    component: StoragePublishedComponent,
}

fn publish_component(
    outer: &Path,
    source: &Path,
    target: &Path,
    operation: &str,
) -> Result<PublishedMove> {
    let control_name = format!("control-{operation}");
    private_directory(outer)?.create_private_child(OsStr::new(&control_name))?;
    let home = outer.join(control_name);
    let from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.clone()),
        ..Default::default()
    })?;
    let target_location = StorageLocationRecord {
        version: 1,
        revision: 1,
        data_root: target.into(),
        cache_root: outer.join(format!("cache-{operation}")),
        operation_id: Some(operation.into()),
    };
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: operation.into(),
        original: None,
        from,
        target: target_location,
        components: vec![StorageMigrationComponent {
            domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: source.into(),
            destination: target.into(),
            source_identity: private_directory(source)?.directory_identity()?,
            estimated_bytes: 0,
        }],
        target_bindings: vec![StorageTargetBinding {
            path: target.into(),
            existing_ancestor: outer.into(),
            ancestor_identity: private_directory(outer)?.directory_identity()?,
        }],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    };
    let mut coordinator = StorageCoordinator::acquire(&home)?;
    coordinator.begin(plan)?;
    coordinator.advance(operation, Phase::Planned, Phase::Stopping)?;
    coordinator.advance(operation, Phase::Stopping, Phase::Stopped)?;
    coordinator.advance(operation, Phase::Stopped, Phase::Copying)?;
    assert!(matches!(
        coordinator.publish_component(
            operation,
            STORAGE_PERSISTENT_ROOT_DOMAIN,
            &BTreeSet::new()
        )?,
        StorageComponentDirectory::Published(_)
    ));
    let component =
        coordinator.open_published_component(operation, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
    Ok(PublishedMove {
        _coordinator: coordinator,
        component,
    })
}

/// Test oracle for the existing owner's proof contract; this does not claim Git
/// registration acceptance, which remains covered by managed-worktree tests.
struct WorkspaceOwner<'a> {
    published: &'a StoragePublishedComponent,
    source: PrivateDirectory,
    target: PrivateDirectory,
    source_path: PathBuf,
    target_path: PathBuf,
    relative_path: PathBuf,
    registration: File,
    registration_identity: PortableLeaseIdentity,
    registration_bytes: Vec<u8>,
}

impl<'a> WorkspaceOwner<'a> {
    fn new(movement: &'a PublishedMove) -> Result<Self> {
        let published = &movement.component;
        let relative_path = PathBuf::from("managed/tree/repository");
        let source_path = published.source_path().join(&relative_path);
        let target_path = published.destination_path().join(&relative_path);
        let registration = private_directory(published.source_path())?
            .open_single_link_regular_file(OsStr::new("owned-registration.json"))?;
        let registration_identity =
            PortableLeaseIdentity::from_private_regular_handle(&registration)?;
        let mut registration_bytes = Vec::new();
        (&registration).read_to_end(&mut registration_bytes)?;
        Ok(Self {
            published,
            source: private_directory(&source_path)?,
            target: private_directory(&target_path)?,
            source_path,
            target_path,
            relative_path,
            registration,
            registration_identity,
            registration_bytes,
        })
    }
}

impl ManagedWorkspaceRelocationProof for WorkspaceOwner<'_> {
    fn verify(&self) -> Result<()> {
        self.published.verify()?;
        let root = private_directory(self.published.source_path())?;
        let current = root.open_single_link_regular_file(OsStr::new("owned-registration.json"))?;
        ensure!(
            PortableLeaseIdentity::from_private_regular_handle(&current)?
                == self.registration_identity
                && PortableLeaseIdentity::from_private_regular_handle(&self.registration)?
                    == self.registration_identity
                && fs::read(self.published.source_path().join("owned-registration.json"))?
                    == self.registration_bytes,
            "workspace relocation test owner changed"
        );
        Ok(())
    }

    fn operation_id(&self) -> &str {
        self.published.operation_id()
    }

    fn worktree_id(&self) -> &str {
        "tree"
    }

    fn source_path(&self) -> &Path {
        &self.source_path
    }

    fn destination_path(&self) -> &Path {
        &self.target_path
    }

    fn relative_path(&self) -> &Path {
        &self.relative_path
    }

    fn source_directory(&self) -> &PrivateDirectory {
        &self.source
    }

    fn target_directory(&self) -> &PrivateDirectory {
        &self.target
    }

    fn published_component(&self) -> &StoragePublishedComponent {
        self.published
    }
}

fn create_source_root(outer: &Path) -> Result<PathBuf> {
    let source = private_directory(outer)?.create_private_child(OsStr::new("source"))?;
    source.create_private_child(OsStr::new("profile"))?;
    source
        .create_private_child(OsStr::new("managed"))?
        .create_private_child(OsStr::new("tree"))?
        .create_private_child(OsStr::new("repository"))?;
    source.atomic_replace(
        OsStr::new("owned-registration.json"),
        br#"{"worktreeId":"tree","revision":7}"#,
    )?;
    Ok(outer.join("source"))
}

fn relocate_profiles(movement: &PublishedMove, operation: &str) -> Result<(PathBuf, PathBuf)> {
    let source_path = movement.component.source_path().join("profile");
    let target_path = movement.component.destination_path().join("profile");
    let source = private_directory(&source_path)?;
    let target = private_directory(&target_path)?;
    ProfileIdentity::observe(&source)?.relocate(&source, &target, operation)?;
    Ok((source_path, target_path))
}

fn issue_workspace_map(movement: &PublishedMove) -> Result<String> {
    let owner = WorkspaceOwner::new(movement)?;
    let (source_profile_path, target_profile_path) =
        relocate_profiles(movement, owner.operation_id())?;
    let source_profile = private_directory(&source_profile_path)?;
    let target_profile = private_directory(&target_profile_path)?;
    let identity = WorkspaceIdentity::relocate(&source_profile, &target_profile, &owner)?;
    Ok(identity.logical_seed().to_owned())
}

struct SessionFixture {
    history: PathBuf,
    sidecar: PathBuf,
    history_bytes: Vec<u8>,
    sidecar_bytes: Vec<u8>,
    message_id: String,
    task_id: Option<String>,
}

fn create_session(
    project: &Path,
    cwd: &Path,
    session_id: &str,
    task_id: Option<&str>,
) -> Result<SessionFixture> {
    let history = project.join(format!("{session_id}.jsonl"));
    let state = AppState::new(project);
    state.with_history_path(&history);
    state.add_message(Message::user_text(format!(
        "retained message for {session_id}"
    )));
    state.save_history()?;
    state.set_cwd(cwd.to_owned());
    if let Some(task_id) = task_id {
        let mut task = Task::new(task_id, "retained business task");
        task.managed = true;
        task.status = TaskStatus::Completed;
        task.output = Some("retained business result".into());
        state.upsert_task(task);
    }
    let message_id = load_history(&history)?
        .first()
        .and_then(|entry| entry.uuid.clone())
        .context("fixture history message id missing")?;
    let sidecar = state
        .session_state_path()
        .context("fixture session sidecar missing")?;
    let result = SessionFixture {
        history_bytes: fs::read(&history)?,
        sidecar_bytes: fs::read(&sidecar)?,
        history,
        sidecar,
        message_id,
        task_id: task_id.map(str::to_owned),
    };
    drop(state);
    Ok(result)
}

fn make_workspace_subdirectory(workspace: &Path, relative: &str) -> Result<PathBuf> {
    let mut current = private_directory(workspace)?;
    let mut path = workspace.to_owned();
    for component in Path::new(relative).components() {
        let std::path::Component::Normal(name) = component else {
            anyhow::bail!("invalid fixture subdirectory")
        };
        current = current.create_private_child(name)?;
        path.push(name);
    }
    Ok(path)
}

fn assert_session_copy(fixture: &SessionFixture, project: &Path) -> Result<()> {
    assert_eq!(
        fs::read(project.join(fixture.history.file_name().unwrap()))?,
        fixture.history_bytes
    );
    assert_eq!(
        fs::read(session_state_path(
            project,
            fixture.history.file_stem().unwrap().to_str().unwrap()
        ))?,
        fixture.sidecar_bytes
    );
    Ok(())
}

fn task_id(fixture: &SessionFixture) -> Option<&str> {
    fixture.task_id.as_deref()
}

#[test]
fn prepared_resume_reanchors_owned_worktree_after_two_published_moves() -> Result<()> {
    let outer = tempfile::tempdir()?;
    let source_root = create_source_root(outer.path())?;
    let original_workspace = source_root.join("managed/tree/repository");
    let original_subdirectory = make_workspace_subdirectory(&original_workspace, "packages/demo")?;
    let external_workspace =
        private_directory(outer.path())?.create_private_child(OsStr::new("external-workspace"))?;
    external_workspace.create_private_child(OsStr::new("current"))?;
    let external_cwd = outer.path().join("external-workspace/current");
    let owned = create_session(
        &original_workspace,
        &original_subdirectory,
        "owned-session",
        Some("business-task-kept"),
    )?;
    let external = create_session(&original_workspace, &external_cwd, "external-session", None)?;
    let original_directory_identity =
        private_directory(&original_workspace)?.directory_identity()?;

    let first = publish_component(
        outer.path(),
        &source_root,
        &outer.path().join("first"),
        "workspace-move-one",
    )?;
    let logical_seed = issue_workspace_map(&first)?;
    let first_destination = first.component.destination_path().to_path_buf();
    let first_workspace = first_destination.join("managed/tree/repository");
    assert_session_copy(&owned, &first_workspace)?;
    assert_session_copy(&external, &first_workspace)?;
    assert_eq!(fs::read(&owned.history)?, owned.history_bytes);
    fs::remove_dir_all(&original_workspace)?;
    assert!(!original_workspace.exists());
    // The first coordinator owns the active writer fence; release it before
    // acquiring the next coordinator for the second published move.
    drop(first);

    let second = publish_component(
        outer.path(),
        &first_destination,
        &outer.path().join("second"),
        "workspace-move-two",
    )?;
    let second_seed = issue_workspace_map(&second)?;
    assert_eq!(second_seed, logical_seed);
    let final_workspace = second
        .component
        .destination_path()
        .join("managed/tree/repository");
    let final_profile_path = second.component.destination_path().join("profile");
    let final_history = final_workspace.join("owned-session.jsonl");
    let final_sidecar = session_state_path(&final_workspace, "owned-session");
    let final_external_sidecar = session_state_path(&final_workspace, "external-session");
    assert_session_copy(&owned, &final_workspace)?;
    assert_session_copy(&external, &final_workspace)?;
    assert_eq!(fs::read(&final_history)?, owned.history_bytes);
    let first_workspace_identity = private_directory(&first_workspace)?.directory_identity()?;
    fs::remove_dir_all(&first_workspace)?;
    assert!(!first_workspace.exists());

    let profile = private_directory(&final_profile_path)?;
    let Some(WorkspaceAddressLookup::Moved(original_address)) =
        WorkspaceIdentity::lookup(&profile, &original_workspace)?
    else {
        anyhow::bail!("expected the original workspace address to resolve as moved")
    };
    assert_eq!(original_address.workspace_path(), final_workspace);
    assert_eq!(
        original_address.recorded_directory_identity(),
        original_directory_identity
    );
    let Some(WorkspaceAddressLookup::Moved(first_address)) =
        WorkspaceIdentity::lookup(&profile, &first_workspace)?
    else {
        anyhow::bail!("expected the first published workspace address to resolve as moved")
    };
    assert_eq!(first_address.workspace_path(), final_workspace);
    assert_eq!(
        first_address.recorded_directory_identity(),
        first_workspace_identity
    );

    let final_subdirectory = final_workspace.join("packages/demo");
    let mut prepared = prepare_session_resume(&final_history)?;
    let sidecar_before = fs::read(&final_sidecar)?;
    assert_eq!(
        prepared.persisted_base_cwd(),
        Some(original_workspace.as_path())
    );
    prepared.resolve_workspace_addresses(&final_profile_path)?;
    assert_eq!(
        prepared.persisted_base_cwd(),
        Some(final_workspace.as_path())
    );
    assert_eq!(
        prepared.persisted_state.cwd.as_deref(),
        Some(final_subdirectory.as_path())
    );
    assert_eq!(fs::read(&final_sidecar)?, sidecar_before);
    assert_eq!(fs::read(&final_history)?, owned.history_bytes);

    let restored = AppState::new(outer.path());
    assert_eq!(restored.apply_prepared_session_resume(prepared)?, 1);
    assert_eq!(restored.base_cwd(), final_workspace);
    assert_eq!(restored.cwd(), final_subdirectory);
    assert_eq!(restored.snapshot().session_id, "owned-session");
    let restored_task = restored.task(task_id(&owned).unwrap()).unwrap();
    assert_eq!(restored_task.id, "business-task-kept");
    assert_eq!(restored_task.status, TaskStatus::Completed);
    assert_eq!(
        restored_task.output.as_deref(),
        Some("retained business result")
    );
    assert_eq!(
        load_history(&restored.history_path().unwrap())?[0]
            .uuid
            .as_deref(),
        Some(owned.message_id.as_str())
    );
    assert_eq!(fs::read(&final_history)?, owned.history_bytes);
    let committed_sidecar: serde_json::Value =
        serde_json::from_slice(&fs::read(restored.session_state_path().unwrap())?)?;
    assert_eq!(
        committed_sidecar["base_cwd"],
        serde_json::json!(final_workspace)
    );
    assert_eq!(
        committed_sidecar["cwd"],
        serde_json::json!(final_subdirectory)
    );
    assert!(
        committed_sidecar["tasks"]
            .get("business-task-kept")
            .is_some()
    );

    let external_sidecar_before = fs::read(&final_external_sidecar)?;
    assert_eq!(fs::read(&final_external_sidecar)?, external_sidecar_before);
    let external_restored = AppState::new(outer.path());
    external_restored.resume_from_history_at_profile(
        &final_profile_path,
        &final_workspace.join("external-session.jsonl"),
    )?;
    assert_eq!(external_restored.cwd(), external_cwd);
    assert_eq!(external_restored.base_cwd(), final_workspace);
    assert_eq!(
        fs::read(final_workspace.join("external-session.jsonl"))?,
        external.history_bytes
    );
    let external_sidecar: serde_json::Value =
        serde_json::from_slice(&fs::read(&final_external_sidecar)?)?;
    assert_eq!(
        external_sidecar["base_cwd"],
        serde_json::json!(final_workspace)
    );
    assert_eq!(external_sidecar["cwd"], serde_json::json!(external_cwd));
    Ok(())
}

#[test]
fn replacement_at_the_same_workspace_path_rejects_resume_without_replacing_live_state() -> Result<()>
{
    let outer = tempfile::tempdir()?;
    let source_root = create_source_root(outer.path())?;
    let original_workspace = source_root.join("managed/tree/repository");
    let original_subdirectory = make_workspace_subdirectory(&original_workspace, "packages/demo")?;
    let session = create_session(
        &original_workspace,
        &original_subdirectory,
        "replace-session",
        Some("business-task-original"),
    )?;
    let movement = publish_component(
        outer.path(),
        &source_root,
        &outer.path().join("published"),
        "workspace-replacement",
    )?;
    issue_workspace_map(&movement)?;
    let workspace = movement
        .component
        .destination_path()
        .join("managed/tree/repository");
    let profile_path = movement.component.destination_path().join("profile");
    let mut prepared = prepare_session_resume(&workspace.join("replace-session.jsonl"))?;
    assert_eq!(
        prepared.persisted_base_cwd(),
        Some(original_workspace.as_path())
    );
    assert_eq!(
        prepared.persisted_state.cwd.as_deref(),
        Some(original_subdirectory.as_path())
    );
    assert_eq!(fs::read(&session.sidecar)?, session.sidecar_bytes);

    let mapped_identity = {
        let profile = private_directory(&profile_path)?;
        let Some(WorkspaceAddressLookup::Moved(location)) =
            WorkspaceIdentity::lookup(&profile, &original_workspace)?
        else {
            anyhow::bail!("expected the original workspace address to resolve as moved")
        };
        assert_eq!(location.workspace_path(), workspace);
        let identity = location.directory_identity().to_owned();
        assert_eq!(
            identity,
            private_directory(&workspace)?.directory_identity()?
        );
        identity
    };
    drop(movement);
    let retained_workspace = workspace.with_file_name("repository-retained");
    fs::rename(&workspace, &retained_workspace)?;
    let tree = private_directory(workspace.parent().unwrap())?;
    let replacement = tree.create_private_child(OsStr::new("repository"))?;
    replacement
        .create_private_child(OsStr::new("packages"))?
        .create_private_child(OsStr::new("demo"))?;
    drop(replacement);
    assert!(
        workspace.exists(),
        "replacement keeps the same recorded path"
    );
    let replacement_identity = private_directory(&workspace)?.directory_identity()?;
    assert_ne!(replacement_identity, mapped_identity);

    let live = AppState::new(outer.path());
    live.add_message(Message::user_text("keep the current session"));
    live.set_cwd(outer.path().join("current-session"));
    live.upsert_task(Task::new("live-task", "live state"));
    let before_messages = live.messages();
    let before_cwd = live.cwd();
    let before_tasks = serde_json::to_value(live.tasks())?;
    let error = prepared
        .resolve_workspace_addresses(&profile_path)
        .expect_err("a replaced same-name workspace must not be selected");
    assert!(format!("{error:#}").contains("WORKSPACE_IDENTITY_DIRECTORY_CHANGED"));
    assert_eq!(live.messages(), before_messages);
    assert_eq!(live.cwd(), before_cwd);
    assert_eq!(serde_json::to_value(live.tasks())?, before_tasks);
    assert!(live.history_path().is_none());
    assert_eq!(fs::read(&session.sidecar)?, session.sidecar_bytes);
    Ok(())
}

#[test]
fn late_history_source_change_rejects_prepared_resume_and_keeps_live_state() -> Result<()> {
    let outer = tempfile::tempdir()?;
    let source_root = create_source_root(outer.path())?;
    let original_workspace = source_root.join("managed/tree/repository");
    let original_subdirectory = make_workspace_subdirectory(&original_workspace, "packages/demo")?;
    let session = create_session(
        &original_workspace,
        &original_subdirectory,
        "late-source-session",
        Some("business-task-original"),
    )?;
    let movement = publish_component(
        outer.path(),
        &source_root,
        &outer.path().join("published"),
        "workspace-late-source",
    )?;
    issue_workspace_map(&movement)?;
    let workspace = movement
        .component
        .destination_path()
        .join("managed/tree/repository");
    let profile_path = movement.component.destination_path().join("profile");
    let history = workspace.join("late-source-session.jsonl");
    let mut prepared = prepare_session_resume(&history)?;
    prepared.resolve_workspace_addresses(&profile_path)?;
    let sidecar = session_state_path(&workspace, "late-source-session");
    let sidecar_before = fs::read(&sidecar)?;
    let changed_entry = serde_json::to_value(HistoryEntry {
        web_sources: Vec::new(),
        history_attempt: None,
        session_id: "late-source-session".into(),
        timestamp_ms: 8,
        uuid: Some("late-message-id".into()),
        parent_uuid: None,
        message: Message::user_text("late append after preparation"),
    })?;
    let appended = format!("{changed_entry}\n");
    crate::history_store::HistorySource::bind(&history)?.append(appended.as_bytes())?;
    let changed_history = fs::read(&history)?;
    ensure!(
        changed_history != session.history_bytes,
        "fixture append did not change source"
    );

    let live = AppState::new(outer.path());
    live.add_message(Message::user_text("keep the current session"));
    live.set_cwd(outer.path().join("current-session"));
    live.upsert_task(Task::new("live-task", "live state"));
    let before_messages = live.messages();
    let before_cwd = live.cwd();
    let before_tasks = serde_json::to_value(live.tasks())?;
    let error = live
        .apply_prepared_session_resume(prepared)
        .expect_err("a source stamp that changed after preparation must fail closed");
    assert!(format!("{error:#}").contains("history source changed after resume preparation"));
    assert_eq!(live.messages(), before_messages);
    assert_eq!(live.cwd(), before_cwd);
    assert_eq!(serde_json::to_value(live.tasks())?, before_tasks);
    assert!(live.history_path().is_none());
    assert_eq!(fs::read(&sidecar)?, sidecar_before);
    assert_eq!(fs::read(&history)?, changed_history);
    Ok(())
}

fn session_state_path(project: &Path, session_id: &str) -> PathBuf {
    crate::session_state_path(project, session_id)
}
