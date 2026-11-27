//! Linux crash boundaries use only an owned Native child, never cooperative cancel.
#![cfg(target_os = "linux")]
use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    batch::BatchSource,
    discovery::ConfigurationBinding,
    store::{
        BatchCaptureInput, BatchCreateIntent, BatchCreationStage as Stage,
        BatchCreationWorkerState as Worker, MigrationStore,
    },
};
use kcoder_types::migration::MigrationSourceKind as Kind;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
const REQUEST: &str = "292abcf1-154c-4366-949e-fb81ed21f5f0";
fn intent() -> BatchCreateIntent {
    BatchCreateIntent::new(REQUEST,&serde_json::json!({"sourceIds":["expired-after-owned-crash"],"destination":"user","limits":null})).unwrap()
}
fn resolve(source: &Path) -> BatchCaptureInput {
    BatchCaptureInput {
        sources: vec![BatchSource::Configuration(
            ConfigurationBinding::capture_selected(source, Kind::ClaudeCode).unwrap(),
        )],
        resource_limits: Default::default(),
        project: None,
    }
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn crash_at(phase: &str) {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    PrivateDirectory::open_or_create(&profile).unwrap();
    fs::write(profile.join("settings.json"), "{}").unwrap();
    drop(MigrationStore::open_or_create(&profile).unwrap());
    let source = root.path().join("settings.json");
    let original = r#"{"mcpServers":{"docs":{"command":"NEVER_RUN_CRASH_BOUNDARY_SOURCE"}}}"#;
    fs::write(&source, original).unwrap();
    let ready = root.path().join("ready");
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "batch_creation_owned_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("KCODER_BATCH_CREATION_CRASH_ROOT", root.path())
            .env("KCODER_BATCH_CREATION_CRASH_PHASE", phase)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if ready.is_file() {
            break;
        }
        if let Some(status) = child.0.try_wait().unwrap() {
            use std::io::Read;
            let mut diagnostic = String::new();
            if let Some(stderr) = child.0.stderr.take() {
                let _ = stderr.take(8192).read_to_string(&mut diagnostic);
            }
            panic!("owned crash child exited before {phase}: {status}; {diagnostic}");
        }
        assert!(
            Instant::now() < deadline,
            "owned child did not reach {phase}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    let parent = MigrationStore::open_existing(&profile).unwrap();
    let acknowledged = parent.read_batch_creation(REQUEST).unwrap();
    assert_eq!(acknowledged.worker_state, Worker::Running);
    assert_eq!(acknowledged.control_revision, Some(1));
    assert_eq!(acknowledged.cancel_requested, Some(false));
    let before = fs::read_to_string(&source).unwrap();
    assert_eq!(before, original);
    // std::process::Child::kill is SIGKILL on this Linux-only owned child.
    child.0.kill().unwrap();
    let status = child.0.wait().unwrap();
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(status.signal(), Some(9));
    let stopped = parent.read_batch_creation(REQUEST).unwrap();
    assert_eq!(stopped.job_id, acknowledged.job_id);
    assert_eq!(
        (
            stopped.worker_state,
            stopped.control_revision,
            stopped.cancel_requested
        ),
        (Worker::Stopped, Some(1), Some(false))
    );
    assert_eq!(
        stopped.stage, acknowledged.stage,
        "SIGKILL is not a cooperative Cancelled state"
    );
    fs::rename(&source, source.with_extension("withheld")).unwrap();
    drop(parent);
    let reopened = MigrationStore::open_existing(&profile).unwrap();
    let replay = reopened
        .create_batch_scan_idempotent(
            &intent(),
            |_| panic!("lost reply must not resolve a source"),
            &mut |_, _| panic!("read reconciliation does not launch work"),
        )
        .unwrap();
    assert_eq!(replay.job_id, acknowledged.job_id);
    if phase == "prepared" {
        assert_eq!(replay.stage, Stage::Prepared);
        assert!(replay.job.is_none());
        assert!(
            reopened
                .continue_batch_creation(
                    &intent(),
                    1,
                    |_| panic!("explicit resume absent"),
                    &mut |_, _| true
                )
                .is_err()
        );
        let resumed = reopened
            .resume_batch_creation(&intent(), &uuid::Uuid::new_v4().to_string(), 1)
            .unwrap();
        let finished = reopened
            .continue_batch_creation(
                &intent(),
                resumed.control_revision.unwrap(),
                |_| panic!("prepared capture is source-independent"),
                &mut |_, _| true,
            )
            .unwrap();
        assert_eq!(finished.stage, Stage::Published);
        assert_eq!(finished.job_id, acknowledged.job_id);
        assert_eq!(finished.job.unwrap().sequence, 1);
    } else {
        assert_eq!(replay.stage, Stage::Published);
        assert_eq!(replay.job.unwrap(), acknowledged.job.unwrap());
    }
    assert_eq!(
        fs::read_to_string(source.with_extension("withheld")).unwrap(),
        original
    );
    assert_eq!(
        fs::read_to_string(profile.join("settings.json")).unwrap(),
        "{}"
    );
    assert!(!root.path().join("executed").exists());
}
#[test]
fn sigkill_after_complete_capture_reopens_and_explicitly_finishes_the_original_job() {
    crash_at("prepared");
}
#[test]
fn sigkill_after_publication_before_reply_reconciles_the_original_current_journal() {
    crash_at("published");
}

#[test]
#[ignore = "Owned Linux subprocess helper, invoked by both non-ignored crash boundary parents"]
fn batch_creation_owned_crash_child() {
    let root = std::env::var_os("KCODER_BATCH_CREATION_CRASH_ROOT")
        .expect("owned crash helper requires its parent-provided isolated fixture");
    let root = PathBuf::from(root);
    let phase = std::env::var("KCODER_BATCH_CREATION_CRASH_PHASE").unwrap();
    assert!(matches!(phase.as_str(), "prepared" | "published"));
    let profile = root.join("profile");
    let source = root.join("settings.json");
    let store = MigrationStore::open_existing(&profile).unwrap();
    store
        .create_batch_scan_idempotent(&intent(), |_| Ok(resolve(&source)), &mut |stage, _| {
            let selected = if phase == "prepared" {
                Stage::Prepared
            } else {
                Stage::Published
            };
            if stage == selected {
                fs::write(root.join("ready"), phase.as_bytes()).unwrap();
                loop {
                    std::thread::park();
                }
            }
            true
        })
        .unwrap();
}
