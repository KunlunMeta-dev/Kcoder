// Windows Known Folders ignore HOME/USERPROFILE overrides. These subprocess
// fixtures must not run in a developer's real profile; Windows uses an owned
// OS account for installed acceptance and explicit roots for library tests.
#![cfg(unix)]

use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_config::storage::browser_cache::{BROWSER_CACHE_OWNER, prepare_browser_cache};
use kcoder_config::storage::{
    StorageCoordinator, StorageInstance, StorageLocationRecord, StorageResolveInput,
    inspect_storage_target, prepare_storage_plan, read_storage_migration, storage_location_file,
};
use kcoder_config::{
    OsCredentialBackend, PortableLeaseIdentity, PrivateDirectory,
    imported_credentials::ImportedCredentialStore, profile_identity::ProfileIdentity,
    settings_templates::SettingsTemplateStore,
};
use kcoder_state::AppState;
use kcoder_test_harness::OwnedProcess;
use kcoder_types::{
    ContentBlock, ImageSource, Message, StorageMigrationPhase as Phase, StorageMigrationPlan,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{ChildStderr, Command, ExitStatus, Output, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    thread::JoinHandle,
    time::{Duration, Instant},
};

struct Roots {
    home: PathBuf,
    data: PathBuf,
    old_cache: PathBuf,
    cache: PathBuf,
    settings: Vec<u8>,
}

#[test]
fn cancelling_a_stop_reconciles_the_original_id_without_stopping_an_independent_writer() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let writer = StorageInstance::open(StorageResolveInput {
        home: Some(roots.home.clone()),
        ..Default::default()
    })
    .unwrap();
    let id = "owned-cancel-before-copy";
    let plan = prepare_storage_plan(
        &roots.home,
        &roots.data,
        &roots.cache,
        id,
        kcoder_types::StorageLaunchIntent::VerifyOnly,
    )
    .unwrap()
    .unwrap();
    let original = fs::read(storage_location_file(&roots.home)).unwrap();
    let mut coordinator = StorageCoordinator::acquire(&roots.home).unwrap();
    coordinator.begin(plan).unwrap();
    coordinator
        .advance(id, Phase::Planned, Phase::Stopping)
        .unwrap();
    assert!(
        coordinator
            .advance(id, Phase::Stopping, Phase::Stopped)
            .is_err()
    );
    drop(coordinator);
    let cancelled = successful_json(run(
        &roots.home,
        &["--internal-storage-operation-v1", "cancel", id],
    ));
    assert_eq!(cancelled["disposition"], "deferred");
    assert_eq!(cancelled["plan"]["operationId"], id);
    assert_eq!(
        successful_json(run(
            &roots.home,
            &["--internal-storage-operation-v1", "cancel", id]
        )),
        cancelled
    );
    assert_eq!(
        fs::read(storage_location_file(&roots.home)).unwrap(),
        original
    );
    assert_eq!(
        fs::read(roots.data.join("settings.json")).unwrap(),
        roots.settings
    );
    assert_eq!(writer.paths().data_root, roots.data);
    assert!(
        !run(
            &roots.home,
            &["--internal-storage-operation-v1", "cancel", "another-id"]
        )
        .status
        .success()
    );
}

#[test]
fn first_install_selects_custom_roots_without_creating_a_default_profile_or_migration() {
    let owned = tempfile::tempdir().unwrap();
    let home = owned.path();
    let data = home.join("chosen-data");
    let cache = home.join("chosen-cache");
    let input = serde_json::to_vec(&json!({ "dataRoot": data, "cacheRoot": cache })).unwrap();
    let selected = successful_json(run_with_input(
        home,
        &["--internal-storage-operation-v1", "initialize"],
        &input,
    ));
    assert_eq!(selected["revision"], 1);
    assert!(selected["operationId"].is_null());
    assert_eq!(selected["dataRoot"], json!(data));
    assert_eq!(selected["cacheRoot"], json!(cache));
    assert!(!home.join(".config/kcoder").exists());
    assert!(read_storage_migration(home).unwrap().is_none());
    assert!(!data.join("settings.json").exists());
    assert!(!data.join("native").exists());
    let again = successful_json(run_with_input(
        home,
        &["--internal-storage-operation-v1", "initialize"],
        &input,
    ));
    assert_eq!(
        again, selected,
        "a lost initial-selection reply must not create a migration"
    );
}

#[test]
fn first_install_cannot_hide_existing_legacy_settings_in_an_empty_home() {
    let owned = tempfile::tempdir().unwrap();
    let home = owned.path();
    let original = home.join(".config/kcoder");
    fs::create_dir_all(&original).unwrap();
    fs::write(
        original.join("settings.json"),
        b"existing account configuration",
    )
    .unwrap();
    let data = home.join("new-data");
    let input =
        serde_json::to_vec(&json!({ "dataRoot": data, "cacheRoot": home.join("new-cache") }))
            .unwrap();
    let output = run_with_input(
        home,
        &["--internal-storage-operation-v1", "initialize"],
        &input,
    );
    assert!(!output.status.success());
    assert!(!storage_location_file(home).exists());
    assert!(!data.exists());
    assert_eq!(
        fs::read(original.join("settings.json")).unwrap(),
        b"existing account configuration"
    );
    assert!(read_storage_migration(home).unwrap().is_none());
}

#[test]
fn cleanup_cli_requires_original_preview_and_preserves_new_or_changed_source_data() {
    use kcoder_config::storage::{
        StorageSourceCleanupPreview, StorageSourceCleanupResult, read_storage_location_record,
        resolve_storage_paths,
    };
    use kcoder_types::{StorageLaunchIntent, StorageMigrationComponent, StorageTargetBinding};
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let id = "owned-source-cleanup-cli";
    let original = read_storage_location_record(&storage_location_file(&roots.home))
        .unwrap()
        .unwrap();
    let target = owned.path().join("copied-root");
    fs::create_dir(&target).unwrap();
    let target_identity = PrivateDirectory::open_existing(&target)
        .unwrap()
        .directory_identity()
        .unwrap();
    let selected = StorageLocationRecord {
        version: 1,
        revision: original.revision + 1,
        data_root: target.clone(),
        cache_root: roots.cache.clone(),
        operation_id: Some(id.into()),
    };
    let mut coordinator = StorageCoordinator::acquire(&roots.home).unwrap();
    coordinator
        .begin(StorageMigrationPlan {
            version: 1,
            operation_id: id.into(),
            original: Some(original.clone()),
            from: resolve_storage_paths(&StorageResolveInput {
                home: Some(roots.home.clone()),
                record: Some(original),
                ..Default::default()
            })
            .unwrap(),
            target: selected.clone(),
            components: vec![StorageMigrationComponent {
                domain: "persistent-root".into(),
                source: roots.data.clone(),
                destination: target.clone(),
                estimated_bytes: 0,
                source_identity: PrivateDirectory::open_existing(&roots.data)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
            }],
            target_bindings: vec![StorageTargetBinding {
                path: target.clone(),
                existing_ancestor: target.clone(),
                ancestor_identity: target_identity,
            }],
            launch_intent: StorageLaunchIntent::VerifyOnly,
        })
        .unwrap();
    advance_to_copying(&mut coordinator, id);
    coordinator.prepare_source_retirements(id).unwrap();
    coordinator
        .publish_component(id, "persistent-root", &Default::default())
        .unwrap();
    coordinator
        .advance(id, Phase::Copying, Phase::Verifying)
        .unwrap();
    coordinator
        .advance(id, Phase::Verifying, Phase::Prepared)
        .unwrap();
    coordinator.commit(id).unwrap();
    coordinator.complete(id).unwrap();
    drop(coordinator);
    fs::write(roots.data.join("new-data"), b"retain new data").unwrap();
    fs::write(roots.data.join("settings.json"), b"retain changed data").unwrap();
    let before = read_storage_migration(&roots.home).unwrap().unwrap();
    let preview: StorageSourceCleanupPreview = serde_json::from_value(successful_json(run(
        &roots.home,
        &["--internal-storage-operation-v1", "cleanup-preview", id],
    )))
    .unwrap();
    assert_eq!(
        read_storage_migration(&roots.home).unwrap().unwrap(),
        before
    );
    assert_eq!(
        fs::read(roots.data.join(".data-id")).unwrap(),
        b"native-data-id-001"
    );
    let input = serde_json::to_vec(&json!({"confirmation": preview.confirmation})).unwrap();
    let result: StorageSourceCleanupResult =
        serde_json::from_value(successful_json(run_with_input(
            &roots.home,
            &["--internal-storage-operation-v1", "cleanup-confirm", id],
            &input,
        )))
        .unwrap();
    assert_eq!(result.operation_id, id);
    assert!(!roots.data.join(".data-id").exists());
    assert_eq!(
        fs::read(roots.data.join("new-data")).unwrap(),
        b"retain new data"
    );
    assert_eq!(
        fs::read(roots.data.join("settings.json")).unwrap(),
        b"retain changed data"
    );
    assert_eq!(
        fs::read(target.join("settings.json")).unwrap(),
        roots.settings
    );
    assert_eq!(
        read_storage_location_record(&storage_location_file(&roots.home)).unwrap(),
        Some(selected)
    );
    let receipt = successful_json(run(
        &roots.home,
        &["--internal-storage-operation-v1", "status", id],
    ));
    assert_eq!(receipt["plan"]["operationId"], id);
    assert_eq!(receipt["disposition"], "complete");
    assert_eq!(
        receipt["ownerReceipts"]["source-cleanup"]["resultStatuses"],
        serde_json::to_value(
            result
                .entries
                .iter()
                .map(|entry| entry.status)
                .collect::<Vec<_>>()
        )
        .unwrap()
    );
    fs::rename(&roots.data, owned.path().join("retained-original-source")).unwrap();
    assert_eq!(
        successful_json(run_with_input(
            &roots.home,
            &["--internal-storage-operation-v1", "cleanup-confirm", id],
            &input
        )),
        serde_json::to_value(result).unwrap()
    );
}

fn roots(base: &Path) -> Roots {
    let home = base.join("user-home");
    let data = base.join("data-root");
    let old_cache = base.join("old-cache");
    let cache = base.join("new-cache");
    fs::create_dir_all(home.join(".config")).unwrap();
    for directory in [&data, &old_cache, &cache] {
        fs::create_dir(directory).unwrap();
    }
    let settings = br#"{"dataId":"native-data-id-001","theme":"dark","revision":3}"#.to_vec();
    fs::write(data.join("settings.json"), &settings).unwrap();
    fs::write(data.join(".data-id"), b"native-data-id-001").unwrap();
    fs::write(old_cache.join("obsolete-cache.bin"), b"rebuildable only").unwrap();
    let selection = StorageLocationRecord {
        version: 1,
        revision: 11,
        data_root: data.clone(),
        cache_root: old_cache.clone(),
        operation_id: None,
    };
    fs::write(
        storage_location_file(&home),
        serde_json::to_vec_pretty(&selection).unwrap(),
    )
    .unwrap();
    Roots {
        home,
        data,
        old_cache,
        cache,
        settings,
    }
}

fn command(home: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder"));
    command
        .env_clear()
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("APPDATA", home.join("AppData/Roaming"))
        .env("LOCALAPPDATA", home.join("AppData/Local"))
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .stdin(Stdio::null())
        .current_dir(home)
        .args(args);
    command
}

fn run(home: &Path, args: &[&str]) -> Output {
    bounded(command(home, args))
}

fn run_with_input(home: &Path, args: &[&str], input: &[u8]) -> Output {
    run_command_with_input(command(home, args), home, input)
}

fn run_command_with_input(mut command: Command, home: &Path, input: &[u8]) -> Output {
    let input_path = home.join("storage-operation-input.json");
    fs::write(&input_path, input).unwrap();
    let input_file = fs::File::open(input_path).unwrap();
    command.stdin(Stdio::from(input_file));
    bounded(command)
}

fn start_handoff(
    home: &Path,
    input: &[u8],
    relaunch: Option<&Value>,
) -> (
    OwnedProcess,
    Receiver<String>,
    JoinHandle<Vec<u8>>,
    JoinHandle<()>,
) {
    let input_path = home.join("storage-operation-handoff.json");
    fs::write(&input_path, input).unwrap();
    let mut command = command(home, &["--internal-storage-operation-v1", "handoff"]);
    if let Some(relaunch) = relaunch {
        command.env(
            "KCODER_STORAGE_DESKTOP_RELAUNCH_V1",
            serde_json::to_string(relaunch).unwrap(),
        );
        command.env("ELECTRON_RUN_AS_NODE", "1");
    }
    command
        .stdin(Stdio::from(fs::File::open(input_path).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = OwnedProcess::spawn_exact_environment(&mut command).unwrap();
    let stdout = process.take_stdout().unwrap();
    let stderr: ChildStderr = process.take_stderr().unwrap();
    let (sender, lines) = mpsc::channel();
    let stdout_reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            let count = reader.read_line(&mut line).unwrap();
            if count == 0 || sender.send(line).is_err() {
                break;
            }
        }
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut stderr = stderr;
        stderr.read_to_end(&mut bytes).unwrap();
        bytes
    });
    (process, lines, stderr_reader, stdout_reader)
}

fn bounded(mut command: Command) -> Output {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut process = OwnedProcess::spawn_exact_environment(&mut command).unwrap();
    let mut stdout = process.take_stdout().unwrap();
    let mut stderr = process.take_stderr().unwrap();
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let status: ExitStatus = loop {
        if let Some(status) = process.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            process.terminate(Duration::from_secs(2)).unwrap();
            let stdout = stdout_reader.join().unwrap();
            let stderr = stderr_reader.join().unwrap();
            panic!(
                "owned storage operation process exceeded its deadline\nstdout={}\nstderr={}",
                String::from_utf8_lossy(&stdout),
                String::from_utf8_lossy(&stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    Output {
        status,
        stdout: stdout_reader.join().unwrap(),
        stderr: stderr_reader.join().unwrap(),
    }
}

fn successful_json(output: Output) -> Value {
    assert!(
        output.status.success(),
        "status={}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn advance_to_prepared(coordinator: &mut StorageCoordinator, id: &str) {
    for (from, to) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
        (Phase::Copying, Phase::Verifying),
        (Phase::Verifying, Phase::Prepared),
    ] {
        coordinator.advance(id, from, to).unwrap();
    }
}

fn advance_to_copying(coordinator: &mut StorageCoordinator, id: &str) {
    for (from, to) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
    ] {
        coordinator.advance(id, from, to).unwrap();
    }
}

fn electron_partition(roots: &Roots) -> PathBuf {
    roots
        .data
        .join("studio/desktop/Partitions/kcoder-studio-desktop")
}

fn cli_root_move_plan(roots: &Roots, operation_id: &str, data_root: &Path) -> StorageMigrationPlan {
    let request = serde_json::to_vec(&json!({
        "operationId": operation_id,
        "dataRoot": data_root,
        "cacheRoot": roots.cache,
        "launchIntent": "desktop"
    }))
    .unwrap();
    let output = run_with_input(
        &roots.home,
        &["--internal-storage-operation-v1", "plan"],
        &request,
    );
    serde_json::from_value(successful_json(output)).unwrap()
}

fn publish_root_for_source_resume(
    roots: &Roots,
    operation_id: &str,
    destination: &Path,
    phase: Phase,
) -> StorageMigrationPlan {
    use kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN;
    assert!(matches!(phase, Phase::Copying | Phase::Prepared));
    let plan = cli_root_move_plan(roots, operation_id, destination);
    let mut coordinator = StorageCoordinator::acquire(&roots.home).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    advance_to_copying(&mut coordinator, operation_id);
    coordinator
        .prepare_source_retirements(operation_id)
        .unwrap();

    // Prepare the same empty-profile owners before freezing the raw inventory.
    // Their actual lock files must be copied too; no receipt is manufactured.
    let templates = SettingsTemplateStore::open(&roots.data).unwrap();
    let credentials = ImportedCredentialStore::open(&roots.data).unwrap();
    let backend = OsCredentialBackend::new();
    templates.preview_relocation().unwrap();
    credentials.preview_relocation(&backend).unwrap();
    let prepared_templates = templates.prepare_relocation(operation_id).unwrap();
    let prepared_credentials = credentials
        .prepare_relocation(operation_id, &backend)
        .unwrap();
    assert!(matches!(
        coordinator
            .publish_component(
                operation_id,
                STORAGE_PERSISTENT_ROOT_DOMAIN,
                &std::collections::BTreeSet::new(),
            )
            .unwrap(),
        kcoder_config::storage::StorageComponentDirectory::Published(_)
    ));
    let published = coordinator
        .open_published_component(operation_id, STORAGE_PERSISTENT_ROOT_DOMAIN)
        .unwrap();
    let source = PrivateDirectory::open_existing(&roots.data).unwrap();
    let profile = ProfileIdentity::observe(&source).unwrap();
    profile
        .relocate(&source, published.directory(), operation_id)
        .unwrap();
    prepared_templates.relocate(destination).unwrap();
    prepared_credentials
        .verify_target(published.directory(), &backend)
        .unwrap();
    prepared_templates.verify_target(destination).unwrap();
    profile
        .verify_relocation(&source, published.directory(), operation_id)
        .unwrap();
    published.verify().unwrap();
    coordinator
        .assert_source_retirements_ready(operation_id)
        .unwrap();
    if phase == Phase::Prepared {
        coordinator
            .advance(operation_id, Phase::Copying, Phase::Verifying)
            .unwrap();
        coordinator
            .advance(operation_id, Phase::Verifying, Phase::Prepared)
            .unwrap();
    }
    let receipt = coordinator.current().unwrap().unwrap();
    assert_eq!(receipt.phase, phase);
    assert_eq!(
        receipt.disposition,
        kcoder_types::StorageMigrationDisposition::Active
    );
    assert_eq!(
        fs::read(destination.join("settings.json")).unwrap(),
        roots.settings
    );
    // End the original exclusive period, including all original domain leases.
    drop(prepared_credentials);
    drop(prepared_templates);
    drop(published);
    drop(coordinator);
    plan
}

fn overwrite_owned_source_file_without_replacing_its_identity(path: &Path, bytes: &[u8]) {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    let identity = PortableLeaseIdentity::from_regular_handle(&file).unwrap();
    file.set_len(0).unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    assert_eq!(
        PortableLeaseIdentity::from_regular_handle(&file).unwrap(),
        identity
    );
    assert_eq!(
        PortableLeaseIdentity::from_regular_handle(&fs::File::open(path).unwrap()).unwrap(),
        identity
    );
}

fn assert_changed_source_resume_is_refused(
    roots: &Roots,
    plan: &StorageMigrationPlan,
    phase: Phase,
    relative: &str,
    copied_bytes: &[u8],
) {
    use kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN;
    let operation_id = &plan.operation_id;
    let destination = &plan.target.data_root;
    let original_selection = fs::read(storage_location_file(&roots.home)).unwrap();
    let original = read_storage_migration(&roots.home).unwrap().unwrap();
    let copy_key = format!("copy-{STORAGE_PERSISTENT_ROOT_DOMAIN}");
    let publish_key = format!("publish-{STORAGE_PERSISTENT_ROOT_DOMAIN}");
    let target = PrivateDirectory::open_existing(destination).unwrap();
    let target_identity = target.directory_identity().unwrap();
    let target_file_identity = PortableLeaseIdentity::from_regular_handle(
        &fs::File::open(destination.join(relative)).unwrap(),
    )
    .unwrap();
    let identity_record = fs::read(destination.join(".profile-identity.json")).unwrap();
    let manifest = storage_location_file(&roots.home)
        .parent()
        .unwrap()
        .join("kcoder-storage-migrations")
        .join(operation_id)
        .join(format!("tree-copy-{STORAGE_PERSISTENT_ROOT_DOMAIN}.json"));
    let manifest_bytes = fs::read(&manifest).unwrap();
    assert_eq!(original.phase, phase);
    assert_eq!(original.plan, *plan);
    assert_eq!(
        PrivateDirectory::open_existing(&roots.data)
            .unwrap()
            .directory_identity()
            .unwrap(),
        plan.components[0].source_identity
    );
    // Physical publication remains valid; it is not permission to reuse stale
    // source payload facts after the previous exclusive period has ended.
    kcoder_config::storage::observe_published_storage_component(
        &roots.home,
        operation_id,
        STORAGE_PERSISTENT_ROOT_DOMAIN,
    )
    .unwrap()
    .verify()
    .unwrap();

    let output = run(
        &roots.home,
        &["--internal-storage-operation-v1", "resume", operation_id],
    );
    let pending = read_storage_migration(&roots.home).unwrap().unwrap();
    assert_eq!(pending.plan, *plan);
    assert_eq!(
        PrivateDirectory::open_existing(&roots.data)
            .unwrap()
            .directory_identity()
            .unwrap(),
        plan.components[0].source_identity
    );
    assert_eq!(target.directory_identity().unwrap(), target_identity);
    assert_eq!(
        PrivateDirectory::open_existing(destination)
            .unwrap()
            .directory_identity()
            .unwrap(),
        target_identity
    );
    assert_eq!(
        PortableLeaseIdentity::from_regular_handle(
            &fs::File::open(destination.join(relative)).unwrap()
        )
        .unwrap(),
        target_file_identity
    );
    assert_eq!(fs::read(destination.join(relative)).unwrap(), copied_bytes);
    assert_eq!(
        fs::read(destination.join(".profile-identity.json")).unwrap(),
        identity_record
    );
    assert_eq!(fs::read(&manifest).unwrap(), manifest_bytes);
    assert_eq!(
        pending.owner_receipts[&copy_key],
        original.owner_receipts[&copy_key]
    );
    assert_eq!(
        pending.owner_receipts[&publish_key],
        original.owner_receipts[&publish_key]
    );
    assert!(
        !output.status.success(),
        "same-ID resume accepted changed source payloads after reacquiring exclusive leases\nstdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("STORAGE_SOURCE_CHANGED") || stderr.contains("STORAGE_TREE_SOURCE_CHANGED"),
        "resume must reject changed source facts, not an unrelated incomplete fixture: {stderr}"
    );
    assert_eq!(pending.phase, phase);
    assert_eq!(
        pending.disposition,
        kcoder_types::StorageMigrationDisposition::Active
    );
    assert_eq!(
        fs::read(storage_location_file(&roots.home)).unwrap(),
        original_selection
    );
}

#[test]
fn cli_prepared_resume_rejects_changed_source_settings_under_the_original_native_id() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let destination = owned.path().join("prepared-target");
    let plan = publish_root_for_source_resume(
        &roots,
        "prepared-resume-source-settings",
        &destination,
        Phase::Prepared,
    );
    let changed = br#"{"dataId":"native-data-id-001","theme":"light","revision":4}"#;
    overwrite_owned_source_file_without_replacing_its_identity(
        &roots.data.join("settings.json"),
        changed,
    );

    assert_changed_source_resume_is_refused(
        &roots,
        &plan,
        Phase::Prepared,
        "settings.json",
        &roots.settings,
    );

    assert_eq!(fs::read(roots.data.join("settings.json")).unwrap(), changed);
}

#[test]
fn cli_copying_published_resume_rejects_changed_unowned_source_file_under_the_original_native_id() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let relative = "unknown-persistent.bin";
    let copied = b"unowned persistent bytes before publication";
    let changed = b"unowned persistent bytes written after executor exit";
    fs::write(roots.data.join(relative), copied).unwrap();
    let destination = owned.path().join("copying-published-target");
    let plan = publish_root_for_source_resume(
        &roots,
        "copying-resume-source-unowned",
        &destination,
        Phase::Copying,
    );
    overwrite_owned_source_file_without_replacing_its_identity(&roots.data.join(relative), changed);

    assert_changed_source_resume_is_refused(&roots, &plan, Phase::Copying, relative, copied);

    assert_eq!(fs::read(roots.data.join(relative)).unwrap(), changed);
}

fn history_path(data_root: &Path, session_id: &str) -> PathBuf {
    data_root.join("history").join(format!(
        "{}.jsonl",
        kcoder_state::artifact_id_path_component(session_id)
    ))
}

fn cold_read_history(profile: &Path, history: &Path, image_bytes: &[u8]) {
    let restored = AppState::new(profile);
    assert_eq!(restored.resume_from_history(history).unwrap(), 1);
    let messages = restored.messages();
    let [Message::User { content, .. }] = messages.as_slice() else {
        panic!("cold read did not restore the saved user message: {messages:?}");
    };
    let [ContentBlock::Text { text }, ContentBlock::Image { source }] = content.as_slice() else {
        panic!("cold read did not restore the saved image attachment: {content:?}");
    };
    assert_eq!(text, "offline history with an image attachment");
    assert_eq!(source.source_type, "base64");
    assert_eq!(source.media_type, "image/png");
    assert_eq!(STANDARD.decode(&source.data).unwrap(), image_bytes);
}

fn profile_identity_record(profile: &Path) -> Value {
    serde_json::from_slice(&fs::read(profile.join(".profile-identity.json")).unwrap()).unwrap()
}

struct NativeServicesFixture {
    scope: kcoder_types::integrations::core::IntegrationScope,
    namespace: String,
    identity_namespace: String,
    snapshot: kcoder_native_scope::NativeIdentitySnapshot,
    record: Vec<u8>,
    head: Vec<u8>,
}

fn seed_native_services(profile: &Path, workspace: &Path) -> NativeServicesFixture {
    use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
    use kcoder_state::integrations::core::service_leases::IntegrationServiceLeaseStore;
    use std::ffi::OsStr;
    fs::create_dir(workspace).unwrap();
    let native =
        NativeIntegrationContext::capture(profile, workspace, "owned", "storage-fixture").unwrap();
    let scope = native.scope().clone();
    let (domain, store) = NativeDomainGuard::initialize(
        native.profile().unwrap(),
        &scope,
        NativeDomain::Services,
        "owned-services",
        |directory| {
            IntegrationServiceLeaseStore::create_in(directory, OsStr::new("leases"), &scope)
        },
    )
    .unwrap();
    // Prepare the real current scope slot, then release it before handoff.
    drop(store.try_claim_gateway_app_server().unwrap().unwrap());
    let (global, _, snapshot) = NativeIntegrationContext::observe_global_profile(
        native.profile().unwrap(),
        "storage-fixture",
    )
    .unwrap()
    .unwrap();
    let identity_namespace =
        NativeDomainGuard::expected_namespace_id(&global, NativeDomain::Identity).unwrap();
    NativeServicesFixture {
        scope,
        namespace: domain.namespace_id().into(),
        record: fs::read(
            profile
                .join(&identity_namespace)
                .join("native-identity.jsonl"),
        )
        .unwrap(),
        head: fs::read(
            profile
                .join(&identity_namespace)
                .join("native-identity-head.jsonl"),
        )
        .unwrap(),
        identity_namespace,
        snapshot,
    }
}

fn assert_cold_native_services(profile: &Path, original: &NativeServicesFixture) -> Value {
    use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
    use kcoder_state::integrations::core::service_leases::IntegrationServiceLeaseStore;
    use std::ffi::OsStr;
    let root = PrivateDirectory::open_existing(profile).unwrap();
    let (_, _, snapshot) =
        NativeIntegrationContext::observe_global_profile(&root, "storage-fixture")
            .unwrap()
            .unwrap();
    assert_eq!(snapshot, original.snapshot);
    let domain = NativeDomainGuard::observe(&root, &original.scope, NativeDomain::Services)
        .unwrap()
        .unwrap();
    assert_eq!(domain.namespace_id(), original.namespace);
    let store = IntegrationServiceLeaseStore::open_in(
        &domain.directory(&root).unwrap(),
        OsStr::new("leases"),
        &original.scope,
    )
    .unwrap();
    let _host = store.try_claim_gateway_app_server().unwrap().unwrap();
    assert!(store.try_claim_gateway_app_server().unwrap().is_none());
    let identity = profile.join(&original.identity_namespace);
    assert_eq!(
        fs::read(identity.join("native-identity.jsonl")).unwrap(),
        original.record
    );
    assert_eq!(
        fs::read(identity.join("native-identity-head.jsonl")).unwrap(),
        original.head
    );
    let placement = fs::read(identity.join("native-identity-lock-placement.json")).unwrap();
    assert!(placement.len() <= 1024);
    let placement: Value = serde_json::from_slice(&placement).unwrap();
    assert_eq!(placement.as_object().unwrap().len(), 3);
    assert!(placement.get("version").is_some());
    assert!(placement.get("headerDigest").is_some());
    assert!(placement.get("lockIdentity").is_some());
    placement
}

fn assert_no_plain_history_identity_mapping(history: &Path) {
    assert!(
        !history
            .with_extension("hctl")
            .join(".history-storage-relocation.json")
            .exists()
    );
    assert!(
        !history
            .parent()
            .unwrap()
            .join(".history-storage-relocation.json")
            .exists()
    );
}

fn run_owned_profile_handoff(
    roots: &Roots,
    plan: &StorageMigrationPlan,
    history_relative: &Path,
    proof: &Path,
) -> Value {
    let operation_id = plan.operation_id.as_str();
    let original_location = fs::read(storage_location_file(&roots.home)).unwrap();
    let source_settings = fs::read(plan.from.data_root.join("settings.json")).unwrap();
    let source_history = fs::read(plan.from.data_root.join(history_relative)).unwrap();
    let writer = StorageInstance::open(StorageResolveInput {
        home: Some(roots.home.clone()),
        record: plan.original.clone(),
        ..Default::default()
    })
    .unwrap();
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/storage-relaunch-probe.mjs");
    let node = dunce::canonicalize(
        which::which("node").expect("Node is required by the desktop restart fixture"),
    )
    .unwrap();
    let relaunch = json!({
        "program": node,
        "args": [
            fixture,
            PathBuf::from(env!("CARGO_BIN_EXE_kcoder")),
            roots.home,
            PathBuf::from(operation_id),
            proof,
            plan.target.cache_root
        ],
        "cwd": roots.home
    });
    let (mut process, lines, stderr_reader, stdout_reader) = start_handoff(
        &roots.home,
        &serde_json::to_vec(plan).unwrap(),
        Some(&relaunch),
    );
    let ready_line = lines
        .recv_timeout(Duration::from_secs(10))
        .expect("owned handoff child did not publish readiness before its deadline");
    let ready: Value = serde_json::from_str(&ready_line).unwrap();
    assert_eq!(
        ready,
        json!({"operationId": operation_id, "state": "ready"})
    );
    assert!(process.try_wait().unwrap().is_none());

    let waiting = read_storage_migration(&roots.home).unwrap().unwrap();
    assert_eq!(waiting.plan.operation_id, operation_id);
    assert_eq!(waiting.phase, Phase::Stopping);
    assert_eq!(
        waiting.disposition,
        kcoder_types::StorageMigrationDisposition::Active
    );
    assert_eq!(
        fs::read(storage_location_file(&roots.home)).unwrap(),
        original_location
    );
    assert!(
        !plan.target.data_root.exists(),
        "ready must precede all target writes"
    );
    assert_eq!(
        fs::read(plan.from.data_root.join("settings.json")).unwrap(),
        source_settings
    );
    assert_eq!(
        fs::read(plan.from.data_root.join(history_relative)).unwrap(),
        source_history
    );
    assert!(
        !proof.exists(),
        "readiness must not launch the new application"
    );

    drop(writer);
    let completed_line = lines
        .recv_timeout(Duration::from_secs(60))
        .expect("handoff did not finish after the owned writer was dropped");
    let completed: Value = serde_json::from_str(&completed_line).unwrap();
    assert_eq!(completed["plan"]["operationId"], operation_id);
    assert_eq!(completed["phase"], "verified");
    assert_eq!(completed["disposition"], "complete");
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = process.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            process.terminate(Duration::from_secs(2)).unwrap();
            let stderr = stderr_reader.join().unwrap();
            stdout_reader.join().unwrap();
            panic!(
                "owned handoff CLI process exceeded its deadline\nready={}\ncompleted={}\nstderr={}",
                ready_line.trim_end(),
                completed_line.trim_end(),
                String::from_utf8_lossy(&stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success());
    let _stderr = stderr_reader.join().unwrap();
    stdout_reader.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !proof.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        proof.exists(),
        "relaunched process did not write its owned proof"
    );
    completed
}

#[test]
fn cli_cache_only_operation_keeps_data_and_completes_through_its_real_verifier() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let operation_id = "cli-cache-only-20261123";
    let location = storage_location_file(&roots.home);
    let original_location = fs::read(&location).unwrap();

    let request = serde_json::to_vec(&json!({
        "operationId": operation_id,
        "dataRoot": roots.data,
        "cacheRoot": roots.cache,
        "launchIntent": "cli"
    }))
    .unwrap();
    let planned = run_with_input(
        &roots.home,
        &["--internal-storage-operation-v1", "plan"],
        &request,
    );
    let plan = successful_json(planned);
    assert_eq!(plan["operationId"], operation_id);
    assert_eq!(plan["original"]["revision"], 11);
    assert_eq!(plan["target"]["revision"], 12);
    assert_eq!(plan["target"]["dataRoot"], json!(roots.data));
    assert_eq!(plan["target"]["cacheRoot"], json!(roots.cache));
    assert_eq!(plan["components"].as_array().unwrap().len(), 1);
    assert_eq!(plan["components"][0]["domain"], "persistent-root");
    assert_eq!(plan["components"][0]["source"], json!(roots.data));
    assert_eq!(plan["components"][0]["destination"], json!(roots.data));
    assert_eq!(fs::read(&location).unwrap(), original_location);
    assert!(read_storage_migration(&roots.home).unwrap().is_none());
    assert_eq!(fs::read_dir(roots.home.join(".config")).unwrap().count(), 1);
    assert!(fs::read_dir(&roots.cache).unwrap().next().is_none());

    let executed = run_with_input(
        &roots.home,
        &["--internal-storage-operation-v1", "execute"],
        &serde_json::to_vec(&plan).unwrap(),
    );
    let completed = successful_json(executed);
    assert_eq!(completed["plan"]["operationId"], operation_id);
    assert_eq!(completed["phase"], "verified");
    assert_eq!(completed["disposition"], "complete");
    assert_eq!(
        completed["plan"]["components"][0]["sourceIdentity"],
        plan["components"][0]["sourceIdentity"]
    );

    let queried = successful_json(run(&roots.home, &["config", "storage-paths"]));
    assert_eq!(queried["layout"], "unified");
    assert_eq!(queried["dataRoot"], json!(roots.data));
    assert_eq!(queried["cacheRoot"], json!(roots.cache));
    assert_eq!(queried["operationId"], operation_id);
    assert_eq!(queried["selectionRevision"], 12);
    assert_eq!(
        fs::read(roots.data.join("settings.json")).unwrap(),
        roots.settings
    );
    assert_eq!(
        fs::read(roots.data.join(".data-id")).unwrap(),
        b"native-data-id-001"
    );
    assert_eq!(
        fs::read(roots.old_cache.join("obsolete-cache.bin")).unwrap(),
        b"rebuildable only"
    );
    assert!(!roots.cache.join("obsolete-cache.bin").exists());
    assert_eq!(
        read_storage_migration(&roots.home)
            .unwrap()
            .unwrap()
            .plan
            .operation_id,
        operation_id
    );

    let unknown = run(
        &roots.home,
        &[
            "--internal-storage-operation-v1",
            "resume",
            "unknown-operation",
        ],
    );
    assert!(!unknown.status.success());
    assert_eq!(
        read_storage_migration(&roots.home)
            .unwrap()
            .unwrap()
            .plan
            .operation_id,
        operation_id,
        "an unknown receipt must not replace the current operation"
    );
}

#[test]
fn cli_handoff_waits_for_writers_then_verifies_and_relaunches_after_releasing_migration() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let operation_id = "cli-handoff-writer-exit";
    let location = storage_location_file(&roots.home);
    let original_location = fs::read(&location).unwrap();
    let plan_input = serde_json::to_vec(&json!({
        "operationId": operation_id,
        "dataRoot": roots.data,
        "cacheRoot": roots.cache,
        "launchIntent": "desktop"
    }))
    .unwrap();
    let plan = successful_json(run_with_input(
        &roots.home,
        &["--internal-storage-operation-v1", "plan"],
        &plan_input,
    ));
    let plan: StorageMigrationPlan = serde_json::from_value(plan).unwrap();
    let missing_launch = run_with_input(
        &roots.home,
        &["--internal-storage-operation-v1", "handoff"],
        &serde_json::to_vec(&plan).unwrap(),
    );
    assert!(!missing_launch.status.success());
    assert!(
        String::from_utf8_lossy(&missing_launch.stderr)
            .contains("STORAGE_DESKTOP_RELAUNCH_REQUIRED")
    );
    assert!(read_storage_migration(&roots.home).unwrap().is_none());
    assert_eq!(fs::read(&location).unwrap(), original_location);
    let writer = StorageInstance::open(StorageResolveInput {
        home: Some(roots.home.clone()),
        record: plan.original.clone(),
        ..Default::default()
    })
    .unwrap();

    let proof = roots.home.join("owned-desktop-relaunch.json");
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/storage-relaunch-probe.mjs");
    let node = dunce::canonicalize(
        which::which("node").expect("Node is required by the desktop restart fixture"),
    )
    .unwrap();
    let relaunch = json!({"program": node,
        "args": [fixture, PathBuf::from(env!("CARGO_BIN_EXE_kcoder")), roots.home,
            PathBuf::from(operation_id), proof, roots.cache], "cwd": roots.home});
    let (mut process, lines, stderr_reader, stdout_reader) = start_handoff(
        &roots.home,
        &serde_json::to_vec(&plan).unwrap(),
        Some(&relaunch),
    );
    let ready_line = lines
        .recv_timeout(Duration::from_secs(10))
        .expect("owned handoff child did not publish readiness before its deadline");
    let ready: Value = serde_json::from_str(&ready_line).unwrap();
    assert_eq!(ready.as_object().unwrap().len(), 2);
    assert_eq!(ready["operationId"], operation_id);
    assert_eq!(ready["state"], "ready");
    assert!(process.try_wait().unwrap().is_none());

    let waiting = read_storage_migration(&roots.home).unwrap().unwrap();
    assert_eq!(waiting.plan.operation_id, operation_id);
    assert_eq!(waiting.phase, Phase::Stopping);
    assert_eq!(
        waiting.disposition,
        kcoder_types::StorageMigrationDisposition::Active
    );
    assert_eq!(fs::read(&location).unwrap(), original_location);
    assert!(fs::read_dir(&roots.cache).unwrap().next().is_none());
    assert!(!roots.cache.join("obsolete-cache.bin").exists());
    assert!(
        !proof.exists(),
        "readiness must not launch the application before writer exit"
    );

    drop(writer);
    let completed_line = lines
        .recv_timeout(Duration::from_secs(30))
        .expect("handoff did not report the committed operation after writer shutdown");
    let completed: Value = serde_json::from_str(&completed_line).unwrap();
    assert_eq!(completed["plan"]["operationId"], operation_id);
    assert_eq!(completed["phase"], "verified");
    assert_eq!(completed["disposition"], "complete");
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = process.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            process.terminate(Duration::from_secs(2)).unwrap();
            let stderr = stderr_reader.join().unwrap();
            stdout_reader.join().unwrap();
            panic!(
                "owned handoff CLI process exceeded its deadline\nready={}\ncompleted={}\nstderr={}",
                ready_line.trim_end(),
                completed_line.trim_end(),
                String::from_utf8_lossy(&stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success());
    let _stderr = stderr_reader.join().unwrap();
    stdout_reader.join().unwrap();

    let completed_receipt = read_storage_migration(&roots.home).unwrap().unwrap();
    assert_eq!(completed_receipt.plan.operation_id, operation_id);
    assert_eq!(completed_receipt.phase, Phase::Verified);
    assert_eq!(
        completed_receipt.disposition,
        kcoder_types::StorageMigrationDisposition::Complete
    );
    assert_eq!(
        fs::read(&location).unwrap(),
        serde_json::to_vec_pretty(&plan.target).unwrap()
    );
    assert_eq!(
        fs::read(roots.data.join("settings.json")).unwrap(),
        roots.settings
    );
    assert_eq!(
        fs::read(roots.data.join(".data-id")).unwrap(),
        b"native-data-id-001"
    );
    assert_eq!(
        fs::read(roots.old_cache.join("obsolete-cache.bin")).unwrap(),
        b"rebuildable only"
    );
    assert!(!roots.cache.join("obsolete-cache.bin").exists());
    let deadline = Instant::now() + Duration::from_secs(15);
    while !proof.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let launched: Value = serde_json::from_slice(
        &fs::read(proof)
            .expect("relaunched process did not verify the completed original operation"),
    )
    .unwrap();
    assert_eq!(launched["operationId"], operation_id);
    assert_eq!(launched["phase"], "verified");
    assert_eq!(launched["cacheRoot"], json!(roots.cache));
}

#[test]
fn cli_resume_publishes_the_registered_electron_cache_link_and_keeps_its_original_owner() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let operation_id = "electron-partition-cache-001";
    let partition = electron_partition(&roots);
    let partition_cache = partition.join("Cache");
    fs::create_dir_all(&partition_cache).unwrap();
    fs::create_dir_all(partition.join("Local Storage")).unwrap();
    let old_cache_bytes = b"original electron HTTP cache";
    let cookie_bytes = b"persistent session cookie";
    let draft_bytes = b"unsent durable draft";
    fs::write(partition_cache.join("entry.bin"), old_cache_bytes).unwrap();
    fs::write(partition.join("Cookies"), cookie_bytes).unwrap();
    fs::write(partition.join("Local Storage/draft"), draft_bytes).unwrap();
    let original_cache_identity = inspect_storage_target(&partition_cache)
        .unwrap()
        .ancestor_identity;
    let original_data_identity = inspect_storage_target(&roots.data)
        .unwrap()
        .ancestor_identity;
    let location = storage_location_file(&roots.home);

    let plan_input = serde_json::to_vec(&json!({
        "operationId": operation_id,
        "dataRoot": roots.data,
        "cacheRoot": roots.cache,
        "launchIntent": "desktop"
    }))
    .unwrap();
    let planned = successful_json(run_with_input(
        &roots.home,
        &["--internal-storage-operation-v1", "plan"],
        &plan_input,
    ));
    let plan: StorageMigrationPlan = serde_json::from_value(planned).unwrap();
    assert_eq!(plan.target.data_root, roots.data);
    assert_eq!(plan.target.cache_root, roots.cache);

    let mut coordinator = StorageCoordinator::acquire(&roots.home).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    advance_to_copying(&mut coordinator, operation_id);
    let owner = prepare_browser_cache(&mut coordinator, operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        owner.source.as_ref().unwrap().identity,
        original_cache_identity
    );
    coordinator
        .record_owner_receipt(
            operation_id,
            BROWSER_CACHE_OWNER,
            None,
            serde_json::to_value(&owner).unwrap(),
        )
        .unwrap();
    drop(coordinator);

    let pending = read_storage_migration(&roots.home).unwrap().unwrap();
    assert_eq!(pending.phase, Phase::Copying);
    let pending_owner = &pending.owner_receipts[BROWSER_CACHE_OWNER];
    assert_eq!(pending_owner["operationId"], operation_id);
    assert_eq!(pending_owner["source"]["identity"], original_cache_identity);
    assert_eq!(pending_owner["retainedEntryIdentity"], Value::Null);
    assert_eq!(pending_owner["publishedLinkIdentity"], Value::Null);
    assert!(
        !pending_owner["preparedLinkIdentity"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    let prepared = partition.join(format!("Cache.prepared-{operation_id}"));
    let new_http = roots
        .cache
        .join("browser-cache/desktop/kcoder-studio-desktop/http");
    assert_eq!(
        fs::canonicalize(&prepared).unwrap(),
        fs::canonicalize(&new_http).unwrap()
    );
    assert!(
        fs::symlink_metadata(&prepared)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        inspect_storage_target(&partition_cache)
            .unwrap()
            .ancestor_identity,
        original_cache_identity
    );
    assert_eq!(
        fs::read(partition_cache.join("entry.bin")).unwrap(),
        old_cache_bytes
    );

    let resumed = successful_json(run(
        &roots.home,
        &["--internal-storage-operation-v1", "resume", operation_id],
    ));
    assert_eq!(resumed["plan"]["operationId"], operation_id);
    assert_eq!(resumed["phase"], "verified");
    assert_eq!(resumed["disposition"], "complete");
    let owner_receipt = &resumed["ownerReceipts"][BROWSER_CACHE_OWNER];
    assert_eq!(owner_receipt["operationId"], operation_id);
    assert_eq!(owner_receipt["source"]["kind"], "directory");
    assert_eq!(owner_receipt["source"]["identity"], original_cache_identity);
    assert_eq!(
        owner_receipt["retainedEntryIdentity"],
        original_cache_identity
    );
    assert_eq!(
        owner_receipt["publishedLinkIdentity"],
        owner_receipt["preparedLinkIdentity"]
    );
    let retained = partition.join(format!("Cache.retained-{operation_id}"));
    let published_cache = partition.join("Cache");
    assert_eq!(
        inspect_storage_target(&retained).unwrap().ancestor_identity,
        original_cache_identity
    );
    assert_eq!(
        fs::read(retained.join("entry.bin")).unwrap(),
        old_cache_bytes
    );
    assert!(!prepared.exists());
    assert!(
        fs::symlink_metadata(&published_cache)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::canonicalize(&published_cache).unwrap(),
        fs::canonicalize(&new_http).unwrap()
    );
    assert!(fs::read_dir(&new_http).unwrap().next().is_none());
    assert!(!new_http.join("entry.bin").exists());
    assert_eq!(fs::read(partition.join("Cookies")).unwrap(), cookie_bytes);
    assert_eq!(
        fs::read(partition.join("Local Storage/draft")).unwrap(),
        draft_bytes
    );
    assert_eq!(
        inspect_storage_target(&roots.data)
            .unwrap()
            .ancestor_identity,
        original_data_identity
    );
    assert_eq!(
        fs::read(roots.data.join("settings.json")).unwrap(),
        roots.settings
    );
    assert_eq!(
        fs::read(roots.data.join(".data-id")).unwrap(),
        b"native-data-id-001"
    );
    assert_eq!(
        fs::read(roots.old_cache.join("obsolete-cache.bin")).unwrap(),
        b"rebuildable only"
    );
    assert!(!roots.cache.join("obsolete-cache.bin").exists());
    assert_eq!(
        serde_json::from_slice::<StorageLocationRecord>(&fs::read(location).unwrap()).unwrap(),
        plan.target
    );

    let published_owner = owner_receipt.clone();
    let resumed_again = successful_json(run(
        &roots.home,
        &["--internal-storage-operation-v1", "resume", operation_id],
    ));
    assert_eq!(resumed_again["plan"]["operationId"], operation_id);
    assert_eq!(resumed_again["phase"], "verified");
    assert_eq!(
        resumed_again["ownerReceipts"][BROWSER_CACHE_OWNER],
        published_owner
    );
    assert!(
        fs::symlink_metadata(&published_cache)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::canonicalize(&published_cache).unwrap(),
        fs::canonicalize(&new_http).unwrap()
    );
    assert_eq!(
        inspect_storage_target(&retained).unwrap().ancestor_identity,
        original_cache_identity
    );
    assert_eq!(
        fs::read(retained.join("entry.bin")).unwrap(),
        old_cache_bytes
    );
}

#[test]
fn cli_handoff_moves_a_unified_profile_twice_without_replaying_its_identity_or_history() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let settings =
        br#"{"dataId":"native-data-id-001","theme":"dark","revision":3,"futureOpaque":{"wireField":[1,true,"keep"]}}"#.to_vec();
    fs::write(roots.data.join("settings.json"), &settings).unwrap();
    let image_bytes = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60,
        0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0xa5, 0xf6, 0x45, 0x40, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    fs::create_dir(roots.data.join("history")).unwrap();
    let saved = AppState::new(&roots.data);
    let history = history_path(&roots.data, &saved.session_id());
    saved.with_history_path(&history);
    saved.add_message(Message::user_content(vec![
        ContentBlock::Text {
            text: "offline history with an image attachment".into(),
        },
        ContentBlock::Image {
            source: ImageSource::base64("image/png", STANDARD.encode(image_bytes)),
        },
    ]));
    saved.save_history().unwrap();
    let history_bytes = fs::read(&history).unwrap();
    let history_relative = history.strip_prefix(&roots.data).unwrap().to_owned();
    let native_services =
        seed_native_services(&roots.data, &owned.path().join("business-workspace"));
    let original_data_identity = inspect_storage_target(&roots.data)
        .unwrap()
        .ancestor_identity;
    let original_selection = fs::read(storage_location_file(&roots.home)).unwrap();
    let logical_seed =
        ProfileIdentity::observe(&PrivateDirectory::open_existing(&roots.data).unwrap())
            .unwrap()
            .logical_seed()
            .to_owned();
    assert!(!roots.data.join(".profile-identity.json").exists());

    let first_target = owned.path().join("relocated-B");
    let first_operation = "profile-root-move-A-B";
    assert!(!first_target.exists());
    assert!(read_storage_migration(&roots.home).unwrap().is_none());
    let first_plan = cli_root_move_plan(&roots, first_operation, &first_target);
    assert_eq!(first_plan.original.as_ref().unwrap().revision, 11);
    assert_eq!(first_plan.target.revision, 12);
    assert_eq!(first_plan.target.data_root, first_target);
    assert_eq!(first_plan.target.cache_root, roots.cache);
    assert_eq!(first_plan.components.len(), 1);
    assert_eq!(first_plan.components[0].domain, "persistent-root");
    assert_eq!(first_plan.components[0].source, roots.data);
    assert_eq!(first_plan.components[0].destination, first_target);
    assert_eq!(
        fs::read(storage_location_file(&roots.home)).unwrap(),
        original_selection
    );
    assert!(read_storage_migration(&roots.home).unwrap().is_none());
    assert!(
        !first_target.exists(),
        "plan must not create the target profile"
    );

    let first_proof = roots.home.join("profile-root-A-B-relaunch.json");
    let first_completed =
        run_owned_profile_handoff(&roots, &first_plan, &history_relative, &first_proof);
    assert_eq!(first_completed["phase"], "verified");
    assert_eq!(first_completed["disposition"], "complete");
    let first_location = successful_json(run(&roots.home, &["config", "storage-paths"]));
    assert_eq!(first_location["layout"], "unified");
    assert_eq!(first_location["dataRoot"], json!(first_target));
    assert_eq!(first_location["cacheRoot"], json!(roots.cache));
    assert_eq!(first_location["operationId"], first_operation);
    assert_eq!(first_location["selectionRevision"], 12);
    let first_history = first_target.join(&history_relative);
    let first_target_identity = inspect_storage_target(&first_target)
        .unwrap()
        .ancestor_identity;
    assert_eq!(
        fs::read(first_target.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        fs::read(first_target.join(".data-id")).unwrap(),
        b"native-data-id-001"
    );
    assert_eq!(fs::read(&first_history).unwrap(), history_bytes);
    assert_eq!(
        fs::read(roots.data.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(fs::read(&history).unwrap(), history_bytes);
    assert_eq!(
        inspect_storage_target(&roots.data)
            .unwrap()
            .ancestor_identity,
        original_data_identity
    );
    cold_read_history(&first_target, &first_history, &image_bytes);
    let first_identity = profile_identity_record(&first_target);
    assert_eq!(
        first_identity,
        json!({"version": 2, "logicalSeed": logical_seed})
    );
    assert_eq!(
        ProfileIdentity::observe(&PrivateDirectory::open_existing(&first_target).unwrap())
            .unwrap()
            .logical_seed(),
        logical_seed
    );
    assert_no_plain_history_identity_mapping(&first_history);
    let first_receipt =
        serde_json::to_value(read_storage_migration(&roots.home).unwrap().unwrap()).unwrap();
    let first_identity_bytes = fs::read(first_target.join(".profile-identity.json")).unwrap();
    let first_lock_placement = assert_cold_native_services(&first_target, &native_services);

    let same_id = successful_json(run(
        &roots.home,
        &["--internal-storage-operation-v1", "resume", first_operation],
    ));
    assert_eq!(same_id["plan"]["operationId"], first_operation);
    assert_eq!(same_id["phase"], "verified");
    assert_eq!(
        serde_json::to_value(read_storage_migration(&roots.home).unwrap().unwrap()).unwrap(),
        first_receipt
    );
    assert_eq!(
        fs::read(first_target.join(".profile-identity.json")).unwrap(),
        first_identity_bytes
    );
    assert_no_plain_history_identity_mapping(&first_history);
    let unknown = run(
        &roots.home,
        &[
            "--internal-storage-operation-v1",
            "resume",
            "unknown-profile-operation",
        ],
    );
    assert!(!unknown.status.success());
    assert_eq!(
        serde_json::to_value(read_storage_migration(&roots.home).unwrap().unwrap()).unwrap(),
        first_receipt,
        "an unknown operation receipt must not replace the current operation"
    );

    let second_target = owned.path().join("relocated-C");
    let second_operation = "profile-root-move-B-C";
    assert!(!second_target.exists());
    let before_second_plan =
        serde_json::to_value(read_storage_migration(&roots.home).unwrap().unwrap()).unwrap();
    let selection_before_second_plan = fs::read(storage_location_file(&roots.home)).unwrap();
    let second_plan = cli_root_move_plan(&roots, second_operation, &second_target);
    assert_eq!(second_plan.original.as_ref().unwrap().revision, 12);
    assert_eq!(second_plan.target.revision, 13);
    assert_eq!(second_plan.target.data_root, second_target);
    assert_eq!(second_plan.components[0].source, first_target);
    assert_eq!(second_plan.components[0].destination, second_target);
    assert!(
        !second_target.exists(),
        "second plan must not create another target"
    );
    assert_eq!(
        fs::read(storage_location_file(&roots.home)).unwrap(),
        selection_before_second_plan
    );
    assert_eq!(
        serde_json::to_value(read_storage_migration(&roots.home).unwrap().unwrap()).unwrap(),
        before_second_plan
    );

    let second_proof = roots.home.join("profile-root-B-C-relaunch.json");
    let second_completed =
        run_owned_profile_handoff(&roots, &second_plan, &history_relative, &second_proof);
    assert_eq!(second_completed["phase"], "verified");
    assert_eq!(second_completed["disposition"], "complete");
    let second_location = successful_json(run(&roots.home, &["config", "storage-paths"]));
    assert_eq!(second_location["layout"], "unified");
    assert_eq!(second_location["dataRoot"], json!(second_target));
    assert_eq!(second_location["cacheRoot"], json!(roots.cache));
    assert_eq!(second_location["operationId"], second_operation);
    assert_eq!(second_location["selectionRevision"], 13);
    let second_history = second_target.join(&history_relative);
    assert_no_plain_history_identity_mapping(&second_history);
    for profile in [&roots.data, &first_target, &second_target] {
        assert_eq!(fs::read(profile.join("settings.json")).unwrap(), settings);
        assert_eq!(
            fs::read(profile.join(".data-id")).unwrap(),
            b"native-data-id-001"
        );
        assert_eq!(
            fs::read(profile.join(&history_relative)).unwrap(),
            history_bytes
        );
    }
    assert_eq!(
        inspect_storage_target(&roots.data)
            .unwrap()
            .ancestor_identity,
        original_data_identity
    );
    assert_eq!(
        inspect_storage_target(&first_target)
            .unwrap()
            .ancestor_identity,
        first_target_identity
    );
    cold_read_history(&second_target, &second_history, &image_bytes);
    let second_lock_placement = assert_cold_native_services(&second_target, &native_services);
    assert_eq!(
        first_lock_placement["headerDigest"],
        second_lock_placement["headerDigest"]
    );
    assert_ne!(
        first_lock_placement["lockIdentity"],
        second_lock_placement["lockIdentity"]
    );
    let second_identity = profile_identity_record(&second_target);
    assert_eq!(second_identity, first_identity);
    assert_eq!(
        fs::read(second_target.join(".profile-identity.json")).unwrap(),
        first_identity_bytes
    );
    assert_eq!(
        ProfileIdentity::observe(&PrivateDirectory::open_existing(&roots.data).unwrap())
            .unwrap()
            .logical_seed(),
        logical_seed
    );
    assert_eq!(
        ProfileIdentity::observe(&PrivateDirectory::open_existing(&second_target).unwrap())
            .unwrap()
            .logical_seed(),
        logical_seed
    );
    let second_receipt =
        serde_json::to_value(read_storage_migration(&roots.home).unwrap().unwrap()).unwrap();
    let second_identity_bytes = fs::read(second_target.join(".profile-identity.json")).unwrap();
    let same_id = successful_json(run(
        &roots.home,
        &[
            "--internal-storage-operation-v1",
            "resume",
            second_operation,
        ],
    ));
    assert_eq!(same_id["plan"]["operationId"], second_operation);
    assert_eq!(same_id["phase"], "verified");
    assert_eq!(
        serde_json::to_value(read_storage_migration(&roots.home).unwrap().unwrap()).unwrap(),
        second_receipt
    );
    assert_eq!(
        fs::read(second_target.join(".profile-identity.json")).unwrap(),
        second_identity_bytes
    );
    assert_no_plain_history_identity_mapping(&second_history);
    let unknown = run(
        &roots.home,
        &[
            "--internal-storage-operation-v1",
            "resume",
            "unknown-profile-operation",
        ],
    );
    assert!(!unknown.status.success());
    assert_eq!(
        serde_json::to_value(read_storage_migration(&roots.home).unwrap().unwrap()).unwrap(),
        second_receipt
    );
    assert_eq!(
        fs::read(roots.old_cache.join("obsolete-cache.bin")).unwrap(),
        b"rebuildable only"
    );
    assert!(!roots.cache.join("obsolete-cache.bin").exists());
    for (proof, operation_id) in [
        (&first_proof, first_operation),
        (&second_proof, second_operation),
    ] {
        let launched: Value = serde_json::from_slice(&fs::read(proof).unwrap()).unwrap();
        assert_eq!(launched["operationId"], operation_id);
        assert_eq!(launched["phase"], "verified");
        assert_eq!(launched["cacheRoot"], json!(roots.cache));
    }

    drop(saved);
    let detached_a = owned.path().join("temporarily-unavailable-A");
    let detached_b = owned.path().join("temporarily-unavailable-B");
    fs::rename(&roots.data, &detached_a).unwrap();
    fs::rename(&first_target, &detached_b).unwrap();
    let reopened = StorageInstance::open(StorageResolveInput {
        home: Some(roots.home.clone()),
        ..Default::default()
    });
    assert_cold_native_services(&second_target, &native_services);
    fs::rename(&detached_b, &first_target).unwrap();
    fs::rename(&detached_a, &roots.data).unwrap();
    let reopened = reopened.unwrap();
    assert_eq!(reopened.paths().data_root, second_target);
}

#[test]
fn cli_plan_does_not_execute_owner_module_and_rejects_a_directory() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let application_root = owned.path().join("owned-application");
    let migrations = application_root.join("src/migrations");
    fs::create_dir_all(&migrations).unwrap();
    let entry = migrations.join("gateway-storage-domains.mjs");
    fs::write(
        &entry,
        "throw new Error('preview must not execute this module');\n",
    )
    .unwrap();

    let node = dunce::canonicalize(
        which::which("node").expect("Node is required by the local owner-runtime plan fixture"),
    )
    .unwrap();
    let owner_runtime = serde_json::to_string(&json!({
        "program": node,
        "applicationRoot": application_root,
        "runAsNode": true
    }))
    .unwrap();
    let target = owned.path().join("planned-profile-target");
    let operation_id = "owner-runtime-readable-entry-plan";
    let request = serde_json::to_vec(&json!({
        "operationId": operation_id,
        "dataRoot": target,
        "cacheRoot": roots.cache,
        "launchIntent": "cli"
    }))
    .unwrap();
    let original_location = fs::read(storage_location_file(&roots.home)).unwrap();
    let config = roots.home.join(".config");
    let config_entries = fs::read_dir(&config)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<std::collections::BTreeSet<_>>();
    let mut plan_command = command(&roots.home, &["--internal-storage-operation-v1", "plan"]);
    plan_command.env("KCODER_STORAGE_OWNER_RUNTIME_V1", &owner_runtime);
    let planned = successful_json(run_command_with_input(plan_command, &roots.home, &request));
    assert_eq!(planned["operationId"], operation_id);
    assert_eq!(planned["components"].as_array().unwrap().len(), 1);
    assert_eq!(planned["components"][0]["domain"], "persistent-root");
    assert_eq!(planned["components"][0]["source"], json!(roots.data));
    assert_eq!(planned["components"][0]["destination"], json!(target));
    assert!(!target.exists());
    assert_eq!(
        fs::read(storage_location_file(&roots.home)).unwrap(),
        original_location
    );
    assert!(read_storage_migration(&roots.home).unwrap().is_none());
    assert!(!config.join("kcoder-storage-migrations").exists());
    assert_eq!(
        fs::read_dir(&config)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>(),
        config_entries
    );

    fs::remove_file(&entry).unwrap();
    fs::create_dir(&entry).unwrap();
    let mut directory_command = command(&roots.home, &["--internal-storage-operation-v1", "plan"]);
    directory_command.env("KCODER_STORAGE_OWNER_RUNTIME_V1", &owner_runtime);
    let rejected = run_command_with_input(directory_command, &roots.home, &request);
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("STORAGE_OWNER_RUNTIME_INVALID"));
    assert!(!target.exists());
    assert_eq!(
        fs::read(storage_location_file(&roots.home)).unwrap(),
        original_location
    );
    assert!(read_storage_migration(&roots.home).unwrap().is_none());
    assert!(!config.join("kcoder-storage-migrations").exists());
}

#[test]
fn plan_refuses_an_explicit_external_profile_without_creating_it() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let explicit_profile = owned.path().join("external-profile");
    let location = storage_location_file(&roots.home);
    let original_location = fs::read(&location).unwrap();
    let input = serde_json::to_vec(&json!({
        "operationId": "external-profile-plan",
        "dataRoot": roots.data,
        "cacheRoot": roots.cache,
        "launchIntent": "cli"
    }))
    .unwrap();
    let mut external = command(&roots.home, &["--internal-storage-operation-v1", "plan"]);
    external.env("KCODER_CONFIG_DIR", &explicit_profile);
    let output = run_command_with_input(external, &roots.home, &input);

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("STORAGE_EXTERNAL_INSTANCE_READ_ONLY")
    );
    assert!(!explicit_profile.exists());
    assert_eq!(fs::read(&location).unwrap(), original_location);
    assert!(read_storage_migration(&roots.home).unwrap().is_none());
}

#[test]
fn committed_verifier_failure_can_resume_only_the_original_operation_id() {
    let owned = tempfile::tempdir().unwrap();
    let roots = roots(owned.path());
    let operation_id = "committed-resume-same-id";
    let plan = prepare_storage_plan(
        &roots.home,
        &roots.data,
        &roots.cache,
        operation_id,
        kcoder_types::StorageLaunchIntent::Cli,
    )
    .unwrap()
    .unwrap();
    let mut coordinator = StorageCoordinator::acquire(&roots.home).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    advance_to_prepared(&mut coordinator, operation_id);
    let committed = coordinator.commit(operation_id).unwrap();
    assert_eq!(committed.phase, Phase::Committed);
    drop(coordinator);
    let committed_location = fs::read(storage_location_file(&roots.home)).unwrap();

    let changed_selection = StorageLocationRecord {
        cache_root: owned.path().join("different-cache"),
        operation_id: None,
        ..plan.target.clone()
    };
    fs::write(
        storage_location_file(&roots.home),
        serde_json::to_vec_pretty(&changed_selection).unwrap(),
    )
    .unwrap();
    let failed_resume = run(
        &roots.home,
        &["--internal-storage-operation-v1", "resume", operation_id],
    );
    assert!(!failed_resume.status.success());
    let pending = read_storage_migration(&roots.home).unwrap().unwrap();
    assert_eq!(pending.plan.operation_id, operation_id);
    assert_eq!(pending.phase, Phase::Committed);
    assert_eq!(
        pending.disposition,
        kcoder_types::StorageMigrationDisposition::Active
    );

    fs::write(storage_location_file(&roots.home), &committed_location).unwrap();
    let verified = successful_json(run(
        &roots.home,
        &["--internal-storage-operation-v1", "verify", operation_id],
    ));
    assert_eq!(verified["dataRoot"], json!(roots.data));
    assert_eq!(verified["cacheRoot"], json!(roots.cache));
    let still_committed = read_storage_migration(&roots.home).unwrap().unwrap();
    assert_eq!(still_committed.phase, Phase::Committed);
    assert_eq!(
        still_committed.disposition,
        kcoder_types::StorageMigrationDisposition::Active
    );

    let resumed = successful_json(run(
        &roots.home,
        &["--internal-storage-operation-v1", "resume", operation_id],
    ));
    assert_eq!(resumed["plan"]["operationId"], operation_id);
    assert_eq!(resumed["phase"], "verified");
    assert_eq!(resumed["disposition"], "complete");
    assert_eq!(
        fs::read(roots.data.join("settings.json")).unwrap(),
        roots.settings
    );
    assert_eq!(
        fs::read(roots.old_cache.join("obsolete-cache.bin")).unwrap(),
        b"rebuildable only"
    );
    assert!(!roots.cache.join("obsolete-cache.bin").exists());
}
