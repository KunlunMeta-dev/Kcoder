#![cfg(unix)]

use kcoder_config::{
    PrivateDirectory,
    storage::{
        StorageCoordinator, StorageInstance, StorageResolveInput, inspect_storage_target,
        read_storage_migration, storage_location_file,
    },
};
use kcoder_test_harness::OwnedProcess;
use kcoder_types::{
    StorageLaunchIntent, StorageLocationRecord, StorageMigrationComponent,
    StorageMigrationDisposition, StorageMigrationPlan, StorageTargetBinding,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Fixture {
    _owned: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    cache: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("owned-home");
        fs::create_dir(&home).unwrap();
        Self {
            data: home.join(".config/kcoder"),
            cache: home.join(if cfg!(windows) {
                "AppData/Local/kcoder"
            } else if cfg!(target_os = "macos") {
                "Library/Caches/kcoder"
            } else {
                ".cache/kcoder"
            }),
            home,
            _owned: owned,
        }
    }

    fn seed_native(&self) -> Vec<u8> {
        fs::create_dir_all(self.data.join("tmp/old-owned-resource")).unwrap();
        let settings = br#"{"providers":[]}"#.to_vec();
        fs::write(self.data.join("settings.json"), &settings).unwrap();
        fs::write(
            self.data.join("tmp/old-owned-resource/keep"),
            b"keep old tmp",
        )
        .unwrap();
        settings
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder"));
        command
            .env_clear()
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("APPDATA", self.home.join("AppData/Roaming"))
            .env("LOCALAPPDATA", self.home.join("AppData/Local"))
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("XDG_CACHE_HOME", self.home.join(".cache"))
            .current_dir(&self.home)
            .stdin(Stdio::null())
            .args(args);
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        bounded(self.command(args))
    }

    fn plan_output(&self, id: &str) -> Output {
        let input = self.home.join("plan-input.json");
        fs::write(
            &input,
            serde_json::to_vec(&json!({
                "operationId": id,
                "dataRoot": self.data,
                "cacheRoot": self.cache,
                "launchIntent": "cli"
            }))
            .unwrap(),
        )
        .unwrap();
        let mut command = self.command(&["--internal-storage-operation-v1", "plan"]);
        command.stdin(Stdio::from(fs::File::open(input).unwrap()));
        bounded(command)
    }

    fn plan(&self, id: &str) -> StorageMigrationPlan {
        serde_json::from_value(successful_json(self.plan_output(id))).unwrap()
    }
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
    let deadline = Instant::now() + Duration::from_secs(45);
    let status = loop {
        if let Some(status) = process.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            process.terminate(Duration::from_secs(2)).unwrap();
            panic!("owned legacy startup exceeded its deadline");
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
    successful(&output);
    serde_json::from_slice(&output.stdout).unwrap()
}

fn successful(output: &Output) {
    assert!(
        output.status.success(),
        "status={}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn control_file(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, []).unwrap();
}

fn gateway_owner_runtime() -> String {
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Node is required to exercise the Gateway storage owner");
    assert!(
        output.status.success(),
        "Node runtime lookup failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let program = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    let application_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/kcoder-studio")
        .canonicalize()
        .unwrap();
    json!({
        "program": program,
        "applicationRoot": application_root,
        "runAsNode": true
    })
    .to_string()
}

#[test]
fn legacy_queries_are_pure_and_only_business_startup_initializes_native_root() {
    let fixture = Fixture::new();
    for args in [
        vec!["config", "storage-paths"],
        vec!["--version"],
        vec!["--help"],
    ] {
        let output = fixture.run(&args);
        successful(&output);
        assert!(
            !fixture.home.join(".config").exists(),
            "query wrote control state: {args:?}"
        );
        assert!(!fixture.data.exists() && !fixture.cache.exists());
    }
    let preview = fixture.plan_output("read-only-missing-native");
    assert!(!preview.status.success());
    assert!(!fixture.home.join(".config").exists());
    assert!(!fixture.data.exists() && !fixture.cache.exists());
    let output = fixture.run(&["config", "path"]);
    successful(&output);
    let receipt = read_storage_migration(&fixture.home).unwrap().unwrap();
    assert_eq!(receipt.disposition, StorageMigrationDisposition::Complete);
    assert_eq!(
        receipt.plan.from.layout,
        kcoder_types::StorageLayout::Legacy
    );
    assert_eq!(receipt.plan.target.data_root, fixture.data);
    assert!(fixture.cache.is_dir());
    assert!(storage_location_file(&fixture.home).is_file());
}

#[test]
fn doctor_preserves_plugin_diagnostics_without_starting_storage_migration() {
    let fixture = Fixture::new();
    successful(&fixture.run(&["doctor"]));
    // Explicit doctor probes retain upstream plugin-store initialization and
    // the configuration read guard. Neither commits a storage selection.
    let mut entries = fs::read_dir(&fixture.data)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    entries.sort();
    assert_eq!(
        entries,
        [
            ".provider-transaction.json.lock",
            "kcoder-storage-writers.lock",
            "plugin_store"
        ]
        .map(std::ffi::OsString::from)
    );
    let store = fixture.data.join("plugin_store");
    let mut directories = fs::read_dir(&store)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    directories.sort();
    assert_eq!(
        directories,
        [
            "backups",
            "cache",
            "data",
            "locks",
            "staging",
            "transactions"
        ]
        .map(std::ffi::OsString::from)
    );
    for name in ["backups", "cache", "data", "staging", "transactions"] {
        assert_eq!(fs::read_dir(store.join(name)).unwrap().count(), 0);
    }
    let locks = fs::read_dir(store.join("locks"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(locks, [std::ffi::OsString::from("state.lock")]);
    assert_eq!(
        fs::metadata(store.join("locks/state.lock")).unwrap().len(),
        0
    );
    assert_eq!(
        fs::metadata(fixture.data.join(".provider-transaction.json.lock"))
            .unwrap()
            .len(),
        0
    );
    assert!(!storage_location_file(&fixture.home).exists());
    assert!(read_storage_migration(&fixture.home).unwrap().is_none());
    assert!(!fixture.cache.exists());
    assert_eq!(
        successful_json(fixture.run(&["config", "storage-paths"]))["layout"],
        "legacy"
    );
}

#[test]
fn doctor_respects_explicit_configuration_roots_and_their_ancestor_writer_fences() {
    for nested in [false, true] {
        let source = Fixture::new();
        let peer = Fixture::new();
        fs::create_dir_all(&source.data).unwrap();
        let settings = b"{}";
        fs::write(source.data.join("settings.json"), settings).unwrap();
        let directory = PrivateDirectory::open_existing(&source.data).unwrap();
        let held = directory
            .try_exclusive_lock(std::ffi::OsStr::new("kcoder-storage-writers.lock"))
            .unwrap()
            .unwrap();
        let config = if nested {
            source.data.join("nested")
        } else {
            source.data.clone()
        };
        let command = || {
            let mut command = peer.command(&["doctor"]);
            command
                .env("KCODER_CONFIG_DIR", &config)
                .env("KCODER_CACHE_DIR", &peer.cache);
            command
        };
        let rejected = bounded(command());
        assert!(!rejected.status.success());
        assert!(String::from_utf8_lossy(&rejected.stderr).contains("STORAGE_MIGRATION_BUSY"));
        assert!(!config.join("plugin_store").exists());
        if nested {
            assert!(!config.exists());
        }
        assert_eq!(
            fs::read(source.data.join("settings.json")).unwrap(),
            settings
        );
        assert!(!storage_location_file(&source.home).exists());
        assert!(!storage_location_file(&peer.home).exists());
        drop(held);
        successful(&bounded(command()));
        assert!(config.join("plugin_store/locks/state.lock").is_file());
        assert!(!peer.data.exists());
        assert!(!peer.cache.exists());
        assert!(!storage_location_file(&peer.home).exists());
        assert_eq!(
            fs::read(source.data.join("settings.json")).unwrap(),
            settings
        );
    }
}

#[test]
fn doctor_keeps_its_admitted_configuration_when_user_dotenv_changes_path_variables() {
    let source = Fixture::new();
    let peer = Fixture::new();
    fs::create_dir_all(&source.data).unwrap();
    fs::create_dir_all(&peer.data).unwrap();
    fs::write(peer.data.join("settings.json"), b"{}").unwrap();
    fs::write(
        source.data.join(".env"),
        format!("KCODER_CONFIG_DIR={}\n", peer.data.display()),
    )
    .unwrap();
    let peer_root = PrivateDirectory::open_existing(&peer.data).unwrap();
    let _held = peer_root
        .try_exclusive_lock(std::ffi::OsStr::new("kcoder-storage-writers.lock"))
        .unwrap()
        .unwrap();
    successful(&source.run(&["doctor"]));
    assert!(source.data.join("plugin_store/locks/state.lock").is_file());
    assert!(!peer.data.join("plugin_store").exists());
    assert_eq!(fs::read(peer.data.join("settings.json")).unwrap(), b"{}");
    assert!(!source.cache.exists());
    assert!(!peer.cache.exists());
    assert!(!storage_location_file(&source.home).exists());
    assert!(!storage_location_file(&peer.home).exists());
}

#[test]
fn legacy_native_startup_keeps_original_bytes_identity_and_tmp_and_runs_once() {
    let fixture = Fixture::new();
    let settings = fixture.seed_native();
    let profile = PrivateDirectory::open_existing(&fixture.data).unwrap();
    profile
        .atomic_replace(
            std::ffi::OsStr::new(".profile-identity.json"),
            br#"{"version":2,"logicalSeed":"legacy-original-seed"}"#,
        )
        .unwrap();
    let identity_bytes = fs::read(fixture.data.join(".profile-identity.json")).unwrap();
    let native_identity = profile.directory_identity().unwrap();
    let legacy_client = fixture.home.join(".config/kcoder-studio");
    control_file(&legacy_client.join("kcoder-storage-writers.lock"));
    control_file(&legacy_client.join("kcoder-storage-instances.lock"));
    let completed = successful_json(fixture.run(&["--internal-storage-operation-v1", "startup"]));
    assert_eq!(completed["phase"], "verified");
    assert_eq!(completed["disposition"], "complete");
    assert_eq!(completed["plan"]["target"]["dataRoot"], json!(fixture.data));
    assert_eq!(
        completed["plan"]["components"][0]["source"],
        completed["plan"]["components"][0]["destination"]
    );
    assert!(
        !fixture.cache.exists(),
        "one-shot verification must not initialize a cache"
    );
    assert!(!fixture.data.join("kcoder-storage-pending.json").exists());
    let record = fs::read(storage_location_file(&fixture.home)).unwrap();
    let receipt = read_storage_migration(&fixture.home).unwrap().unwrap();

    // A retained legacy copy is irrelevant after the valid unified selection.
    fs::write(
        legacy_client.join("retained-unknown"),
        b"old copy must be ignored",
    )
    .unwrap();
    successful(&fixture.run(&["config", "path"]));
    assert_eq!(
        read_storage_migration(&fixture.home).unwrap().unwrap(),
        receipt
    );
    assert_eq!(
        fs::read(storage_location_file(&fixture.home)).unwrap(),
        record
    );
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        fs::read(fixture.data.join(".profile-identity.json")).unwrap(),
        identity_bytes
    );
    assert_eq!(
        inspect_storage_target(&fixture.data)
            .unwrap()
            .ancestor_identity,
        native_identity
    );
    assert_eq!(
        fs::read(fixture.data.join("tmp/old-owned-resource/keep")).unwrap(),
        b"keep old tmp"
    );
}

#[test]
fn legacy_cli_plan_moves_unregistered_gateway_directly_to_custom_roots_once() {
    let fixture = Fixture::new();
    let settings = fixture.seed_native();
    let gateway = fixture.home.join(".config/kcoder-studio");
    fs::create_dir_all(&gateway).unwrap();
    let gateway_settings = b"{\"gateway\":true}\n";
    fs::write(gateway.join("settings.json"), gateway_settings).unwrap();
    fs::write(gateway.join("servers.json"), b"[]\n").unwrap();
    let platform_config = fixture.home.join("owned-platform-config");
    let data = fixture.home.join("chosen-data");
    let cache = fixture.home.join("chosen-cache");
    let id = "legacy-custom-roots-direct";
    let owner_runtime = gateway_owner_runtime();
    let command = |args: &[&str]| {
        let mut command = fixture.command(args);
        command
            .env("XDG_CONFIG_HOME", &platform_config)
            .env("KCODER_STORAGE_OWNER_RUNTIME_V1", &owner_runtime);
        command
    };
    let input = fixture.home.join("custom-plan-input.json");
    fs::write(
        &input,
        serde_json::to_vec(&json!({
            "operationId": id,
            "dataRoot": data,
            "cacheRoot": cache,
            "launchIntent": "cli"
        }))
        .unwrap(),
    )
    .unwrap();
    let mut preview = command(&["--internal-storage-operation-v1", "plan"]);
    preview.stdin(Stdio::from(fs::File::open(&input).unwrap()));
    let plan = successful_json(bounded(preview));
    assert_eq!(plan["operationId"], id);
    assert_eq!(plan["from"]["layout"], "legacy");
    assert_eq!(plan["from"]["dataRoot"], json!(fixture.data));
    assert_eq!(plan["from"]["gatewayRoot"], json!(gateway));
    assert_eq!(plan["target"]["dataRoot"], json!(data));
    assert_eq!(plan["target"]["cacheRoot"], json!(cache));
    assert_eq!(
        plan["components"]
            .as_array()
            .unwrap()
            .iter()
            .map(|component| component["domain"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["persistent-root", "gateway"]
    );
    assert_eq!(plan["components"][0]["destination"], json!(data));
    assert_eq!(
        plan["components"][1]["destination"],
        json!(data.join("studio/gateway"))
    );
    assert!(read_storage_migration(&fixture.home).unwrap().is_none());
    assert!(!storage_location_file(&fixture.home).exists());
    assert!(!data.exists() && !cache.exists());
    assert!(!fixture.data.join("studio").exists() && !fixture.cache.exists());

    fs::write(&input, serde_json::to_vec(&plan).unwrap()).unwrap();
    let mut execute = command(&["--internal-storage-operation-v1", "execute"]);
    execute.stdin(Stdio::from(fs::File::open(&input).unwrap()));
    // Execute completes only after its real, separate target verifier exits.
    let completed = successful_json(bounded(execute));
    assert_eq!(completed["plan"], plan);
    assert_eq!(completed["phase"], "verified");
    assert_eq!(completed["disposition"], "complete");
    let paths = successful_json(bounded(command(&["config", "storage-paths"])));
    assert_eq!(paths["layout"], "unified");
    assert_eq!(paths["dataRoot"], json!(data));
    assert_eq!(paths["cacheRoot"], json!(cache));
    assert_eq!(paths["gatewayRoot"], json!(data.join("studio/gateway")));
    assert_eq!(paths["operationId"], id);
    assert_eq!(
        successful_json(bounded(command(&[
            "--internal-storage-operation-v1",
            "status",
            id
        ]))),
        completed
    );
    let operations = fs::read_dir(fixture.home.join(".config/kcoder-storage-migrations"))
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(operations, [id]);
    assert!(!fixture.data.join("studio").exists() && !fixture.cache.exists());
    assert!(!platform_config.join("kcoder-studio").exists());
    for root in [&fixture.data, &data] {
        assert_eq!(fs::read(root.join("settings.json")).unwrap(), settings);
        assert_eq!(
            fs::read(root.join("tmp/old-owned-resource/keep")).unwrap(),
            b"keep old tmp"
        );
    }
    for root in [&gateway, &data.join("studio/gateway")] {
        assert_eq!(
            fs::read(root.join("settings.json")).unwrap(),
            gateway_settings
        );
        assert_eq!(fs::read(root.join("servers.json")).unwrap(), b"[]\n");
    }
}

#[test]
fn concurrent_legacy_business_startups_keep_one_original_migration() {
    let fixture = Fixture::new();
    let settings = fixture.seed_native();
    let barrier = std::sync::Barrier::new(3);
    let outputs = thread::scope(|scope| {
        let first = scope.spawn(|| {
            barrier.wait();
            fixture.run(&["config", "path"])
        });
        let second = scope.spawn(|| {
            barrier.wait();
            fixture.run(&["config", "path"])
        });
        barrier.wait();
        [first.join().unwrap(), second.join().unwrap()]
    });
    assert!(outputs.iter().any(|output| output.status.success()));
    for output in &outputs {
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            assert!(
                [
                    "STORAGE_MIGRATION_BUSY",
                    "STORAGE_MIGRATION_PENDING",
                    "STORAGE_SELECTION_CHANGED"
                ]
                .iter()
                .any(|code| error.contains(code)),
                "unexpected concurrent-start failure: {error}"
            );
        }
    }
    let original = read_storage_migration(&fixture.home).unwrap().unwrap();
    assert_eq!(original.disposition, StorageMigrationDisposition::Complete);
    successful(&fixture.run(&["config", "path"]));
    assert_eq!(
        read_storage_migration(&fixture.home).unwrap().unwrap(),
        original
    );
    let mut operations = fs::read_dir(fixture.home.join(".config/kcoder-storage-migrations"))
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    operations.sort();
    assert_eq!(operations, [original.plan.operation_id]);
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        fs::read(fixture.data.join("tmp/old-owned-resource/keep")).unwrap(),
        b"keep old tmp"
    );
}

#[test]
fn legacy_occupied_destinations_and_nonempty_control_data_block_selection() {
    for (relative, expected_code) in [
        (
            ".config/kcoder/studio/gateway/servers.json",
            "STORAGE_LEGACY_CLIENT_DATA_UNSUPPORTED",
        ),
        (
            ".config/kcoder/studio/desktop/Preferences",
            "STORAGE_LEGACY_CLIENT_DATA_UNSUPPORTED",
        ),
        (
            ".config/kcoder-studio/kcoder-storage-writers.lock",
            "STORAGE_LEGACY_CLIENT_DATA_UNSUPPORTED",
        ),
    ] {
        let fixture = Fixture::new();
        let settings = fixture.seed_native();
        let payload = fixture.home.join(relative);
        fs::create_dir_all(payload.parent().unwrap()).unwrap();
        fs::write(&payload, b"unknown or business payload").unwrap();
        let output = fixture.run(&["config", "path"]);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected_code),
            "{relative}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!storage_location_file(&fixture.home).exists());
        assert!(read_storage_migration(&fixture.home).unwrap().is_none());
        assert_eq!(fs::read(&payload).unwrap(), b"unknown or business payload");
        assert_eq!(
            fs::read(fixture.data.join("settings.json")).unwrap(),
            settings
        );
    }
}

#[test]
fn legacy_active_startup_resumes_original_id_and_deferred_is_not_retried() {
    for deferred in [false, true] {
        let fixture = Fixture::new();
        fixture.seed_native();
        // A usable default configuration reaches plugin diagnostics. An empty
        // provider catalog can fail earlier and mask missing writer admission.
        fs::write(fixture.data.join("settings.json"), b"{}").unwrap();
        let id = if deferred {
            "legacy-explicitly-deferred"
        } else {
            "legacy-original-interrupted"
        };
        let plan = fixture.plan(id);
        assert!(!storage_location_file(&fixture.home).exists());
        assert!(read_storage_migration(&fixture.home).unwrap().is_none());
        assert!(!fixture.cache.exists());
        let coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
        coordinator.begin(plan).unwrap();
        if deferred {
            coordinator
                .defer_after_cleanup(id, "STORAGE_TEST_DEFERRED")
                .unwrap();
        } else {
            let busy = fixture.run(&["--internal-storage-operation-v1", "startup"]);
            assert!(!busy.status.success());
            assert!(String::from_utf8_lossy(&busy.stderr).contains("STORAGE_MIGRATION_BUSY"));
            assert_eq!(
                coordinator.current().unwrap().unwrap().plan.operation_id,
                id
            );
            let doctor = fixture.run(&["doctor"]);
            assert!(
                !doctor.status.success(),
                "diagnostic plugin writes must not bypass a held migration coordinator"
            );
            assert!(
                String::from_utf8_lossy(&doctor.stderr).contains("STORAGE_MIGRATION_BUSY"),
                "doctor status: {:?}; stderr: {}; plugin_store_exists: {}",
                doctor.status,
                String::from_utf8_lossy(&doctor.stderr),
                fixture.data.join("plugin_store").exists()
            );
            assert!(
                !fixture.data.join("plugin_store").exists(),
                "rejected diagnostics must not initialize plugin data"
            );
        }
        drop(coordinator);
        let before = read_storage_migration(&fixture.home).unwrap().unwrap();
        if !deferred {
            let doctor = fixture.run(&["doctor"]);
            assert!(!doctor.status.success());
            assert!(String::from_utf8_lossy(&doctor.stderr).contains("STORAGE_MIGRATION_PENDING"));
            assert!(!fixture.data.join("plugin_store").exists());
            assert_eq!(
                read_storage_migration(&fixture.home).unwrap().unwrap(),
                before
            );
        }
        let output = successful_json(fixture.run(&["--internal-storage-operation-v1", "startup"]));
        let after = read_storage_migration(&fixture.home).unwrap().unwrap();
        assert_eq!(after.plan.operation_id, id);
        if deferred {
            // The host needs the original Deferred receipt to reopen these
            // exact source roots, without retrying or selecting new defaults.
            assert_eq!(output, serde_json::to_value(&before).unwrap());
            assert_eq!(after, before);
            assert!(!storage_location_file(&fixture.home).exists());
        } else {
            assert_eq!(after.disposition, StorageMigrationDisposition::Complete);
            assert_eq!(output["plan"]["operationId"], id);
        }
    }
}

#[test]
fn legacy_startup_reuses_the_initial_receipt_before_current_pointer_publication() {
    let fixture = Fixture::new();
    fixture.seed_native();
    let id = "legacy-locations-v1";
    let plan = fixture.plan(id);
    let coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
    coordinator.begin(plan.clone()).unwrap();
    drop(coordinator);
    // Model the original begin boundary after its receipt write and before
    // publishing the fixed current pointer. No business effect has run yet.
    fs::remove_file(
        fixture
            .home
            .join(".config/kcoder-storage-migrations/current.json"),
    )
    .unwrap();
    assert!(read_storage_migration(&fixture.home).unwrap().is_none());
    let completed = successful_json(fixture.run(&["--internal-storage-operation-v1", "startup"]));
    assert_eq!(completed["plan"], serde_json::to_value(plan).unwrap());
    assert_eq!(completed["plan"]["operationId"], id);
    assert_eq!(completed["disposition"], "complete");
    let entries = fs::read_dir(fixture.home.join(".config/kcoder-storage-migrations"))
        .unwrap()
        .count();
    assert_eq!(
        entries, 2,
        "retain only the original operation and current pointer"
    );
}

#[test]
fn legacy_host_startup_uses_actual_context_paths_then_requires_a_fresh_business_context() {
    let fixture = Fixture::new();
    fixture.seed_native();
    let platform_config = fixture.home.join("owned-platform-config");
    let desktop = platform_config.join("kcoder-studio");
    fs::create_dir_all(&desktop).unwrap();
    let context = serde_json::to_string(&json!({
        "version": 1,
        "home": fixture.home,
        "platformConfig": platform_config,
        "overrides": {},
        "record": null,
        "consumer": "desktop",
        "development": false
    }))
    .unwrap();
    let mut business = fixture.command(&["config", "path"]);
    business.env(kcoder_types::STORAGE_STARTUP_ENV, &context);
    let output = bounded(business);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("STORAGE_LEGACY_HOST_STARTUP_REQUIRED")
    );
    assert!(!storage_location_file(&fixture.home).exists());
    let unknown = desktop.join("unregistered-owned-payload");
    fs::write(&unknown, b"owned desktop data").unwrap();
    let mut startup = fixture.command(&["--internal-storage-operation-v1", "startup"]);
    startup.env(kcoder_types::STORAGE_STARTUP_ENV, &context);
    let receipt = successful_json(bounded(startup));
    assert_eq!(receipt["disposition"], "complete");
    assert_eq!(
        fs::read(
            fixture
                .data
                .join("studio/desktop/unregistered-owned-payload")
        )
        .unwrap(),
        b"owned desktop data"
    );
    assert_eq!(fs::read(&unknown).unwrap(), b"owned desktop data");
    assert_eq!(receipt["plan"]["from"]["desktopRoot"], json!(desktop));
    assert_eq!(receipt["plan"]["from"]["gatewayRoot"], json!(desktop));
}

#[test]
fn unregistered_cli_and_desktop_startup_split_roaming_gateway_and_electron_data() {
    let owner_runtime = gateway_owner_runtime();
    for consumer in ["cli", "desktop"] {
        let fixture = Fixture::new();
        fixture.seed_native();
        let platform_config = fixture.home.join("owned-platform-config");
        let source = platform_config.join("kcoder-studio");
        let payloads = [
            ("servers.json", b"[]\n".as_slice()),
            ("settings.json", b"{\"gateway\":true}\n".as_slice()),
            ("gateway-port", b"40123".as_slice()),
            (
                "Network/network-state",
                b"original Electron network state".as_slice(),
            ),
            (
                "SharedStorage",
                b"original Electron shared storage".as_slice(),
            ),
            (
                "shell-icons/cache",
                b"original Electron shell icon state".as_slice(),
            ),
            ("Cookies", b"original Electron cookie database".as_slice()),
            ("settings.json.bak", b"opaque settings backup".as_slice()),
            (
                "servers.json.20260928.bak",
                b"older catalog backup".as_slice(),
            ),
            (
                "preferences.20261111.backup",
                b"older preferences backup".as_slice(),
            ),
            (
                "unknown-folder/payload",
                b"unlisted durable bytes".as_slice(),
            ),
            (
                "Partitions/another-client/Preferences",
                b"other partition".as_slice(),
            ),
        ];
        for (relative, bytes) in payloads {
            let path = source.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let context = serde_json::to_string(&json!({
            "version": 1,
            "home": fixture.home,
            "platformConfig": platform_config,
            "overrides": {},
            "record": null,
            "consumer": consumer,
            "development": false
        }))
        .unwrap();
        assert!(!fixture.home.join(".config/kcoder-studio").exists());

        let mut startup = fixture.command(&["--internal-storage-operation-v1", "startup"]);
        startup
            .env(kcoder_types::STORAGE_STARTUP_ENV, &context)
            .env("KCODER_STORAGE_OWNER_RUNTIME_V1", &owner_runtime);
        let completed = successful_json(bounded(startup));
        assert_eq!(completed["phase"], "verified", "consumer={consumer}");
        assert_eq!(completed["disposition"], "complete", "consumer={consumer}");
        let receipt = read_storage_migration(&fixture.home).unwrap().unwrap();
        assert_eq!(
            receipt.plan.from.gateway_root, source,
            "consumer={consumer}"
        );
        assert_eq!(
            receipt.plan.from.desktop_root, source,
            "consumer={consumer}"
        );
        assert_eq!(
            receipt
                .plan
                .components
                .iter()
                .map(|component| component.domain.as_str())
                .collect::<Vec<_>>(),
            ["persistent-root", "gateway", "desktop"],
            "consumer={consumer}"
        );

        let gateway = fixture.data.join("studio/gateway");
        let desktop = fixture.data.join("studio/desktop");
        for (relative, bytes) in payloads {
            assert_eq!(
                fs::read(source.join(relative)).unwrap(),
                bytes,
                "{relative}"
            );
        }
        for relative in ["servers.json", "settings.json"] {
            assert_eq!(
                fs::read(gateway.join(relative)).unwrap(),
                fs::read(source.join(relative)).unwrap(),
                "Gateway source was not selected for {relative}"
            );
            assert!(!desktop.join(relative).exists(), "{relative}");
        }
        for relative in [
            "gateway-port",
            "Network/network-state",
            "SharedStorage",
            "shell-icons/cache",
            "Cookies",
            "settings.json.bak",
            "servers.json.20260928.bak",
            "preferences.20261111.backup",
            "unknown-folder/payload",
            "Partitions/another-client/Preferences",
        ] {
            assert_eq!(
                fs::read(desktop.join(relative)).unwrap(),
                fs::read(source.join(relative)).unwrap(),
                "Desktop source was not selected for {relative}"
            );
            assert!(!gateway.join(relative).exists(), "{relative}");
        }
    }
}

#[test]
fn legacy_explicit_home_and_domain_overrides_do_not_write_personal_selection() {
    for variable in [
        "KCODER_HOME",
        "KCODER_CONFIG_DIR",
        "KCODER_STUDIO_DATA_DIR",
        "KCODER_CACHE_DIR",
    ] {
        let fixture = Fixture::new();
        let override_root = fixture.home.join("explicit-instance");
        let mut startup = fixture.command(&["--internal-storage-operation-v1", "startup"]);
        startup.env(variable, &override_root);
        assert!(successful_json(bounded(startup)).is_null());
        assert!(!fixture.home.join(".config").exists());
        assert!(!override_root.exists());
    }
}

#[test]
fn settled_startup_does_not_require_an_exclusive_lock_while_business_is_running() {
    for deferred in [false, true] {
        let fixture = Fixture::new();
        fixture.seed_native();
        fs::write(fixture.data.join("settings.json"), b"{}").unwrap();
        if deferred {
            let id = "legacy-deferred-live-instance";
            let plan = fixture.plan(id);
            let coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
            coordinator.begin(plan).unwrap();
            coordinator
                .defer_after_cleanup(id, "STORAGE_TEST_DEFERRED")
                .unwrap();
        } else {
            successful_json(fixture.run(&["--internal-storage-operation-v1", "startup"]));
        }
        let _instance = StorageInstance::open(StorageResolveInput {
            home: Some(fixture.home.clone()),
            ..Default::default()
        })
        .unwrap();
        // Also hold the admission lock shared, as another startup does while
        // registering its lifetime lease. A settled startup needs no exclusion.
        let admission = fs::File::open(fixture.home.join(".config/kcoder-storage.lock")).unwrap();
        fs2::FileExt::lock_shared(&admission).unwrap();
        let record = fs::read(storage_location_file(&fixture.home)).ok();
        let receipt = read_storage_migration(&fixture.home).unwrap();
        let output = successful_json(fixture.run(&["--internal-storage-operation-v1", "startup"]));
        if deferred {
            assert_eq!(
                output,
                serde_json::to_value(receipt.as_ref().unwrap()).unwrap()
            );
        } else {
            assert!(output.is_null());
        }
        successful_json(fixture.run(&["config", "storage-paths"]));
        successful(&fixture.run(&["config", "path"]));
        successful(&fixture.run(&["doctor"]));
        assert_eq!(fs::read(storage_location_file(&fixture.home)).ok(), record);
        assert_eq!(read_storage_migration(&fixture.home).unwrap(), receipt);
    }
}

#[test]
fn legacy_desktop_only_startup_publishes_the_original_profile_and_reopens_without_old_source() {
    let fixture = Fixture::new();
    let settings = fixture.seed_native();
    let native_identity = inspect_storage_target(&fixture.data)
        .unwrap()
        .ancestor_identity;
    let native = PrivateDirectory::open_existing(&fixture.data).unwrap();
    native
        .atomic_replace(
            std::ffi::OsStr::new(".profile-identity.json"),
            br#"{"version":2,"logicalSeed":"native-in-place-with-desktop"}"#,
        )
        .unwrap();
    let identity_bytes = fs::read(fixture.data.join(".profile-identity.json")).unwrap();
    let platform_config = fixture.home.join("owned-desktop-config");
    let source = platform_config.join("kcoder-studio");
    let payloads = [
        ("gateway-port", b"40123".as_slice()),
        (
            "Local State",
            br#"{"browser":{"last_known_google_url":"https://owned.invalid"}}"#.as_slice(),
        ),
        ("Dictionaries/en-US.bdic", b"owned dictionary".as_slice()),
        (
            "Partitions/kcoder-studio-desktop/Local Storage/leveldb/000001.log",
            b"original unsent desktop draft".as_slice(),
        ),
    ];
    for (relative, bytes) in payloads {
        let path = source.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    let context = serde_json::to_string(&json!({
        "version": 1,
        "home": fixture.home,
        "platformConfig": platform_config,
        "overrides": {},
        "record": null,
        "consumer": "cli",
        "development": false
    }))
    .unwrap();
    assert!(!fixture.home.join(".config/kcoder-studio").exists());
    let mut startup = fixture.command(&["--internal-storage-operation-v1", "startup"]);
    startup.env(kcoder_types::STORAGE_STARTUP_ENV, context);
    let completed = successful_json(bounded(startup));
    assert_eq!(completed["phase"], "verified");
    assert_eq!(completed["disposition"], "complete");
    let receipt = read_storage_migration(&fixture.home).unwrap().unwrap();
    assert_eq!(
        receipt
            .plan
            .components
            .iter()
            .map(|component| component.domain.as_str())
            .collect::<Vec<_>>(),
        ["persistent-root", "desktop"]
    );
    assert_eq!(receipt.plan.from.desktop_root, source);
    assert_eq!(receipt.plan.target.data_root, fixture.data);
    assert_eq!(receipt.plan.target.cache_root, fixture.cache);
    let target = fixture.data.join("studio/desktop");
    for (relative, bytes) in payloads {
        assert_eq!(fs::read(source.join(relative)).unwrap(), bytes);
        assert_eq!(fs::read(target.join(relative)).unwrap(), bytes);
    }
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        fs::read(fixture.data.join(".profile-identity.json")).unwrap(),
        identity_bytes
    );
    assert_eq!(
        inspect_storage_target(&fixture.data)
            .unwrap()
            .ancestor_identity,
        native_identity
    );
    let record = fs::read(storage_location_file(&fixture.home)).unwrap();

    // Completion removes the runtime dependency on the preserved legacy tree.
    // Normal business admission and original-ID reconciliation use the selected
    // final roots even when that old source is unavailable at its prior name.
    let retained = platform_config.join("retained-original-desktop");
    fs::rename(&source, &retained).unwrap();
    let old_default_gateway = fixture.home.join(".config/kcoder-studio");
    std::os::unix::fs::symlink(&fixture.data, &old_default_gateway).unwrap();
    assert!(
        successful_json(fixture.run(&["--internal-storage-operation-v1", "startup"])).is_null()
    );
    assert!(
        fs::symlink_metadata(&old_default_gateway)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    fs::remove_file(&old_default_gateway).unwrap();
    successful(&fixture.run(&["config", "path"]));
    let id = receipt.plan.operation_id.as_str();
    let status = successful_json(fixture.run(&["--internal-storage-operation-v1", "status", id]));
    assert_eq!(status, completed);
    let resumed = successful_json(fixture.run(&["--internal-storage-operation-v1", "resume", id]));
    assert_eq!(resumed, completed);
    let paths = successful_json(fixture.run(&["config", "storage-paths"]));
    assert_eq!(paths["layout"], "unified");
    assert_eq!(paths["desktopRoot"], json!(target));
    assert_eq!(paths["cacheRoot"], json!(fixture.cache));
    assert!(fixture.cache.is_dir());
    assert!(!source.exists());
    assert_eq!(
        fs::read(storage_location_file(&fixture.home)).unwrap(),
        record
    );
    assert_eq!(
        read_storage_migration(&fixture.home).unwrap().unwrap(),
        receipt
    );
    assert_eq!(
        fs::read(fixture.data.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        inspect_storage_target(&fixture.data)
            .unwrap()
            .ancestor_identity,
        native_identity
    );
    for (relative, bytes) in payloads {
        assert_eq!(fs::read(retained.join(relative)).unwrap(), bytes);
        assert_eq!(fs::read(target.join(relative)).unwrap(), bytes);
    }
}

#[test]
fn deferred_registered_sources_never_open_new_default_business_roots_or_replace_the_original_id() {
    let fixture = Fixture::new();
    let native = fixture.home.join("registered-native");
    let gateway = fixture.home.join("registered-gateway");
    let desktop = fixture.home.join("registered-desktop");
    for root in [&native, &gateway, &desktop] {
        fs::create_dir(root).unwrap();
    }
    let settings = br#"{"providers":[]}"#;
    fs::write(native.join("settings.json"), settings).unwrap();
    let mut from = kcoder_config::storage::resolve_storage_paths(&StorageResolveInput {
        home: Some(fixture.home.clone()),
        platform_config: Some(fixture.home.join(".config")),
        ..Default::default()
    })
    .unwrap();
    from.data_root = native.clone();
    from.cache_root = native.join("tmp");
    from.temporary_root = from.cache_root.clone();
    from.gateway_root = gateway.clone();
    from.desktop_root = desktop.clone();
    let id = "registered-original-deferred";
    let mut bindings = Vec::new();
    for path in [&fixture.data, &fixture.cache] {
        let observed = inspect_storage_target(path).unwrap();
        bindings.push(StorageTargetBinding {
            path: path.to_owned(),
            existing_ancestor: observed.existing_ancestor,
            ancestor_identity: observed.ancestor_identity,
        });
    }
    let components = [
        ("persistent-root", &native, fixture.data.clone()),
        ("gateway", &gateway, fixture.data.join("studio/gateway")),
        ("desktop", &desktop, fixture.data.join("studio/desktop")),
    ]
    .into_iter()
    .map(|(domain, source, destination)| StorageMigrationComponent {
        domain: domain.into(),
        source: source.clone(),
        destination,
        source_identity: PrivateDirectory::open_existing(source)
            .unwrap()
            .directory_identity()
            .unwrap(),
        estimated_bytes: 0,
    })
    .collect();
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original: None,
        from,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: fixture.data.clone(),
            cache_root: fixture.cache.clone(),
            operation_id: Some(id.into()),
        },
        components,
        target_bindings: bindings,
        launch_intent: StorageLaunchIntent::Cli,
    };
    let coordinator = StorageCoordinator::acquire(&fixture.home).unwrap();
    coordinator.begin(plan).unwrap();
    coordinator
        .defer_after_cleanup(id, "STORAGE_TEST_DEFERRED")
        .unwrap();
    drop(coordinator);
    let operation = fixture.home.join(".config/kcoder-storage-migrations");
    let current = fs::read(operation.join("current.json")).unwrap();
    let receipt = fs::read(operation.join(id).join("receipt.json")).unwrap();
    for args in [
        &["--internal-storage-operation-v1", "startup"][..],
        &["config", "path"][..],
    ] {
        let output = fixture.run(args);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("STORAGE_SELECTION_CHANGED"));
        assert!(!fixture.data.exists() && !fixture.home.join(".config/kcoder-studio").exists());
        assert!(!storage_location_file(&fixture.home).exists());
        assert_eq!(fs::read(native.join("settings.json")).unwrap(), settings);
        assert_eq!(fs::read(operation.join("current.json")).unwrap(), current);
        assert_eq!(
            fs::read(operation.join(id).join("receipt.json")).unwrap(),
            receipt
        );
    }
}

fn manual_provider_plan_args(peer: &Fixture, target: &Path) -> Vec<String> {
    let source = peer.home.join("manual-provider-source");
    PrivateDirectory::open_or_create(&source).unwrap();
    let config = source.join("settings.json");
    fs::write(
        &config,
        br#"{"model":"source-model","env":{"ANTHROPIC_BASE_URL":"https://example.invalid","ANTHROPIC_API_KEY":"SYNTHETIC_STORAGE_GUARD_TEST"}}"#,
    )
    .unwrap();
    let inventory = successful_json(peer.run(&[
        "migrate",
        "scan",
        "--source",
        "claude-code",
        "--config",
        config.to_str().unwrap(),
    ]));
    vec![
        "migrate".into(),
        "plan-provider".into(),
        "--source".into(),
        "claude-code".into(),
        "--config".into(),
        config.to_str().unwrap().into(),
        "--item-id".into(),
        inventory["items"][0]["preview"]["id"]
            .as_str()
            .unwrap()
            .into(),
        "--target-profile".into(),
        target.to_str().unwrap().into(),
        "--target-name".into(),
        "ImportedStorageGuard".into(),
        "--context-window-tokens".into(),
        "128000".into(),
        "--output-headroom-tokens".into(),
        "8192".into(),
        "--max-output-tokens".into(),
        "8192".into(),
    ]
}

#[test]
fn manual_migration_respects_another_homes_explicit_profile_writer_fence_without_bootstrap() {
    let source = Fixture::new();
    let peer = Fixture::new();
    PrivateDirectory::open_or_create(&source.data).unwrap();
    source.seed_native();
    let settings = b"{}".to_vec();
    fs::write(source.data.join("settings.json"), &settings).unwrap();
    let args = manual_provider_plan_args(&peer, &source.data);
    let run = || {
        let mut command = peer.command(&[]);
        command.args(&args);
        bounded(command)
    };
    let directory = PrivateDirectory::open_existing(&source.data).unwrap();
    let exclusive = directory
        .try_exclusive_lock(std::ffi::OsStr::new("kcoder-storage-writers.lock"))
        .unwrap()
        .unwrap();
    let rejected = run();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("STORAGE_MIGRATION_BUSY"));
    assert!(!source.data.join("migrations").exists());
    assert!(!source.data.join(".provider-transaction.json.lock").exists());
    assert_eq!(
        fs::read(source.data.join("settings.json")).unwrap(),
        settings
    );
    assert!(!peer.data.exists() && !peer.cache.exists());
    assert!(!storage_location_file(&peer.home).exists());
    drop(exclusive);
    let planned = successful_json(run());
    assert_eq!(planned["providerPlans"].as_array().unwrap().len(), 1);
    assert!(planned["jobId"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(source.data.join("migrations").is_dir());
    assert_eq!(
        fs::read(source.data.join("settings.json")).unwrap(),
        settings
    );
    assert!(!peer.data.exists() && !peer.cache.exists());
    assert!(!storage_location_file(&source.home).exists());
    assert!(!storage_location_file(&peer.home).exists());
}

#[test]
fn manual_migration_rejects_pending_target_and_retired_source_from_another_home() {
    use kcoder_types::StorageMigrationPhase as Phase;

    let source = Fixture::new();
    let peer = Fixture::new();
    PrivateDirectory::open_or_create(&source.data).unwrap();
    let settings = source.seed_native();
    let id = "manual-profile-admission";
    let target = StorageLocationRecord {
        version: 1,
        revision: 1,
        data_root: source.home.join("published-target"),
        cache_root: source.home.join("published-cache"),
        operation_id: Some(id.into()),
    };
    let from = kcoder_config::storage::resolve_storage_paths(&StorageResolveInput {
        home: Some(source.home.clone()),
        ..Default::default()
    })
    .unwrap();
    let bindings = [&target.data_root, &target.cache_root]
        .map(|path| {
            let observed = inspect_storage_target(path).unwrap();
            StorageTargetBinding {
                path: path.clone(),
                existing_ancestor: observed.existing_ancestor,
                ancestor_identity: observed.ancestor_identity,
            }
        })
        .to_vec();
    let mut coordinator = StorageCoordinator::acquire(&source.home).unwrap();
    coordinator
        .begin(StorageMigrationPlan {
            version: 1,
            operation_id: id.into(),
            original: None,
            from,
            target: target.clone(),
            components: vec![StorageMigrationComponent {
                domain: "persistent-root".into(),
                source: source.data.clone(),
                destination: target.data_root.clone(),
                source_identity: PrivateDirectory::open_existing(&source.data)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 0,
            }],
            target_bindings: bindings,
            launch_intent: StorageLaunchIntent::VerifyOnly,
        })
        .unwrap();
    coordinator
        .advance(id, Phase::Planned, Phase::Stopping)
        .unwrap();
    coordinator
        .advance(id, Phase::Stopping, Phase::Stopped)
        .unwrap();
    coordinator.prepare_source_retirements(id).unwrap();
    coordinator
        .advance(id, Phase::Stopped, Phase::Copying)
        .unwrap();
    coordinator
        .publish_component(id, "persistent-root", &Default::default())
        .unwrap();
    let pending = coordinator.current().unwrap().unwrap();
    drop(coordinator);

    let args = manual_provider_plan_args(&peer, &target.data_root);
    let mut command = peer.command(&[]);
    command.args(&args);
    let rejected = bounded(command);
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("STORAGE_MIGRATION_PENDING"));
    assert!(!target.data_root.join("migrations").exists());
    assert!(
        !target
            .data_root
            .join(".provider-transaction.json.lock")
            .exists()
    );
    assert_eq!(
        fs::read(target.data_root.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        read_storage_migration(&source.home).unwrap().unwrap(),
        pending
    );
    assert!(!storage_location_file(&source.home).exists());

    let mut coordinator = StorageCoordinator::acquire(&source.home).unwrap();
    coordinator
        .advance(id, Phase::Copying, Phase::Verifying)
        .unwrap();
    coordinator
        .advance(id, Phase::Verifying, Phase::Prepared)
        .unwrap();
    coordinator.commit(id).unwrap();
    let completed = coordinator.complete(id).unwrap();
    drop(coordinator);
    let selection = fs::read(storage_location_file(&source.home)).unwrap();
    let args = manual_provider_plan_args(&peer, &source.data);
    let mut command = peer.command(&[]);
    command.args(&args);
    let rejected = bounded(command);
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("STORAGE_SOURCE_RETIRED"));
    assert!(!source.data.join("migrations").exists());
    assert!(!source.data.join(".provider-transaction.json.lock").exists());
    for root in [&source.data, &target.data_root] {
        assert_eq!(fs::read(root.join("settings.json")).unwrap(), settings);
    }
    assert_eq!(
        read_storage_migration(&source.home).unwrap().unwrap(),
        completed
    );
    assert_eq!(
        fs::read(storage_location_file(&source.home)).unwrap(),
        selection
    );
    assert!(!peer.data.exists() && !peer.cache.exists());
    assert!(!storage_location_file(&peer.home).exists());
}
