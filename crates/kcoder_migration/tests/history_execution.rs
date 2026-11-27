use kcoder_migration::{
    history_discovery::HistoryCatalog,
    history_jobs::{HistoryExecutionState as State, HistoryImportEvent, HistoryJobStore},
};
use kcoder_types::{external_history::HistoryImportStage, migration::MigrationSourceKind};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[path = "../examples/history_reinterpretation_fixture/owned.rs"]
mod owned_legacy;
#[path = "fixtures/reinterpretation.rs"]
mod persisted_legacy;

struct Fixture {
    root: tempfile::TempDir,
    profile: PathBuf,
    id: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        fs::create_dir(&profile).unwrap();
        let source = root.path().join("source");
        let directory = source.join("projects/project");
        fs::create_dir_all(&directory).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        fs::write(directory.join(format!("{id}.jsonl")), format!("{{\"type\":\"user\",\"uuid\":\"synthetic-request\",\"sessionId\":\"{id}\",\"message\":{{\"role\":\"user\",\"content\":\"Owned history execution\"}}}}\n")).unwrap();
        let catalog =
            HistoryCatalog::discover(&source, MigrationSourceKind::ClaudeCode, |_| true).unwrap();
        let page = catalog.page(None, |_| true).unwrap();
        let selection = catalog
            .selection(&page.items[0].source_handle)
            .unwrap()
            .pin()
            .unwrap();
        HistoryJobStore::open(&profile)
            .unwrap()
            .create_selected(&id, selection)
            .unwrap();
        Self { root, profile, id }
    }
    fn store(&self) -> HistoryJobStore {
        HistoryJobStore::open_existing(&self.profile)
            .unwrap()
            .unwrap()
    }
    fn leaf(&self, suffix: &str) -> PathBuf {
        self.profile
            .join("migrations/history")
            .join(format!("{}.{}", self.id, suffix))
    }
    fn legacy(&self) {
        let path = self.leaf("json");
        let mut job: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        job.as_object_mut().unwrap().remove("executionIdentity");
        job.as_object_mut().unwrap().remove("executionBirthSha256");
        fs::write(path, serde_json::to_vec(&job).unwrap()).unwrap();
        fs::remove_file(self.leaf("execution.lock")).unwrap();
        fs::remove_file(self.leaf("execution.birth")).unwrap();
    }
}

#[test]
fn execution_owner_is_global_and_held_across_native_steps_and_cancelled_checkpoints() {
    let f = Fixture::new();
    let store = f.store();
    let peer = f.store();
    assert_eq!(peer.execution_state(&f.id).unwrap(), State::Stopped);
    let owner = store.claim_execution(&f.id, 0).unwrap();
    assert_eq!(peer.execution_state(&f.id).unwrap(), State::Running);
    assert!(peer.claim_execution(&f.id, 0).is_err());
    let mut observed = false;
    let cancelled = store
        .step_owned(&owner, 0, 10, |event| {
            if matches!(event, HistoryImportEvent::Capture { .. }) && !observed {
                assert_eq!(peer.execution_state(&f.id).unwrap(), State::Running);
                assert!(peer.request_cancel(&f.id).unwrap().cancel_requested);
                assert_eq!(peer.execution_state(&f.id).unwrap(), State::Running);
                observed = true;
            }
            true
        })
        .unwrap();
    assert!(observed);
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    assert_eq!(peer.execution_state(&f.id).unwrap(), State::Running);
    drop(owner);
    assert_eq!(peer.execution_state(&f.id).unwrap(), State::Stopped);
}

#[test]
fn a_reference_run_fence_is_not_misreported_as_an_execution_owner() {
    use fs2::FileExt;
    let f = Fixture::new();
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.leaf("run.lock"))
        .unwrap();
    file.try_lock_exclusive().unwrap();
    assert_eq!(f.store().execution_state(&f.id).unwrap(), State::Stopped);
}

#[test]
fn recorded_missing_or_replaced_lock_identities_remain_unknown_and_are_never_recreated() {
    for suffix in ["execution.lock", "execution.birth", "run.lock"] {
        let f = Fixture::new();
        let path = f.leaf(suffix);
        fs::remove_file(&path).unwrap();
        let store = f.store();
        assert_eq!(store.execution_state(&f.id).unwrap(), State::Unknown);
        assert!(store.claim_execution(&f.id, 0).is_err());
        assert!(store.resume(&f.id, 0).is_err());
        assert!(!path.exists());
    }
    let f = Fixture::new();
    let path = f.leaf("execution.lock");
    fs::rename(&path, f.leaf("original-execution.lock")).unwrap();
    fs::write(&path, b"").unwrap();
    let store = f.store();
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Unknown);
    assert!(store.claim_execution(&f.id, 0).is_err());
    assert!(f.leaf("original-execution.lock").exists());
}

#[test]
fn legacy_nonterminal_observation_is_read_only_and_takeover_requires_cancel_then_explicit_resume() {
    let f = Fixture::new();
    f.legacy();
    let before = fs::read(f.leaf("json")).unwrap();
    let store = f.store();
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Unknown);
    assert!(store.claim_execution(&f.id, 0).is_err());
    assert!(store.resume(&f.id, 0).is_err());
    assert_eq!(fs::read(f.leaf("json")).unwrap(), before);
    assert!(!f.leaf("execution.lock").exists());
    store.request_cancel(&f.id).unwrap();
    let resumed = store.resume(&f.id, 0).unwrap();
    assert_eq!(resumed.stage, HistoryImportStage::Capturing);
    assert_eq!(resumed.sequence, 2);
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Stopped);
    let old: serde_json::Value = serde_json::from_slice(&before).unwrap();
    let new: serde_json::Value =
        serde_json::from_slice(&fs::read(f.leaf("json")).unwrap()).unwrap();
    assert!(!old.as_object().unwrap().contains_key("executionIdentity"));
    assert!(new.as_object().unwrap().contains_key("executionIdentity"));
    assert!(store.resume(&f.id, 0).is_err());
}

#[test]
fn explicit_legacy_resume_never_preempts_an_active_old_step() {
    use fs2::FileExt;
    let f = Fixture::new();
    f.legacy();
    let store = f.store();
    store.request_cancel(&f.id).unwrap();
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.leaf("run.lock"))
        .unwrap();
    file.try_lock_exclusive().unwrap();
    assert!(store.resume(&f.id, 0).is_err());
    assert!(!f.leaf("execution.lock").exists());
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Unknown);
    drop(file);
    assert!(store.resume(&f.id, 0).is_ok());
}

#[test]
fn a_completed_legacy_job_is_upgraded_only_by_an_explicit_bound_claim() {
    let f = Fixture::new();
    let store = f.store();
    let mut job = store.read(&f.id).unwrap();
    while job.stage != HistoryImportStage::Normalized {
        job = store.step(&f.id, job.sequence, 10, |_| true).unwrap();
    }
    f.legacy();
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Unknown);
    assert!(!f.leaf("execution.lock").exists());
    let execution = store.claim_execution(&f.id, job.sequence).unwrap();
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Running);
    drop(execution);
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Stopped);
}

#[test]
fn a_valid_pending_legacy_upgrade_reconciles_the_original_birth_without_replaying_it() {
    let f = Fixture::new();
    f.legacy();
    let store = f.store();
    store.request_cancel(&f.id).unwrap();
    let old_header = fs::read(f.leaf("json")).unwrap();
    store.resume(&f.id, 0).unwrap();
    let marker = fs::read(f.leaf("execution.birth")).unwrap();
    // Reconstruct a crash after the durable birth, before its header publication.
    fs::write(f.leaf("json"), &old_header).unwrap();
    store.request_cancel(&f.id).unwrap();
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Unknown);
    assert_eq!(
        store.execution_unknown_code(&f.id).unwrap(),
        "history_job_execution_untracked"
    );
    let resumed = store.resume(&f.id, 0).unwrap();
    assert_eq!(resumed.sequence, 2);
    assert_eq!(fs::read(f.leaf("execution.birth")).unwrap(), marker);
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Stopped);
}

#[test]
fn metadata_only_normalized_legacy_resume_preserves_its_old_parser_and_every_archive_byte() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    fs::create_dir(&profile).unwrap();
    let (done, _, original) = persisted_legacy::legacy(
        &profile,
        &root.path().join("source"),
        MigrationSourceKind::ClaudeCode,
        false,
    );
    let directory = profile.join("migrations/history");
    let path = directory.join(format!("{}.json", done.job_id));
    let mut header: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    header.as_object_mut().unwrap().remove("executionIdentity");
    header
        .as_object_mut()
        .unwrap()
        .remove("executionBirthSha256");
    fs::write(&path, serde_json::to_vec(&header).unwrap()).unwrap();
    for suffix in ["execution.lock", "execution.birth"] {
        fs::remove_file(directory.join(format!("{}.{suffix}", done.job_id))).unwrap();
    }
    let before_archive = persisted_legacy::snapshot(&profile.join("external-history"));
    let before_source = fs::read(&original).unwrap();
    let store = HistoryJobStore::open_existing(&profile).unwrap().unwrap();
    assert_eq!(store.execution_state(&done.job_id).unwrap(), State::Unknown);
    assert_eq!(store.resume(&done.job_id, done.sequence).unwrap(), done);
    assert_eq!(store.execution_state(&done.job_id).unwrap(), State::Stopped);
    let mut after: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    after.as_object_mut().unwrap().remove("executionIdentity");
    after
        .as_object_mut()
        .unwrap()
        .remove("executionBirthSha256");
    assert_eq!(after, header);
    assert!(
        after["normalizationRevision"]
            .as_str()
            .unwrap()
            .starts_with("foreign-records/3")
    );
    assert_eq!(
        persisted_legacy::snapshot(&profile.join("external-history")),
        before_archive
    );
    assert_eq!(fs::read(&original).unwrap(), before_source);
}

#[test]
fn a_guard_cannot_be_reused_by_another_profile_or_after_its_birth_marker_is_modified() {
    let f = Fixture::new();
    let other = Fixture::new();
    let store = f.store();
    let owner = store.claim_execution(&f.id, 0).unwrap();
    assert!(other.store().step_owned(&owner, 0, 10, |_| true).is_err());
    let path = f.leaf("execution.birth");
    let mut birth: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    birth["initialSha256"] = serde_json::json!("a".repeat(64));
    fs::write(&path, serde_json::to_vec(&birth).unwrap()).unwrap();
    assert_eq!(store.execution_state(&f.id).unwrap(), State::Unknown);
    assert_eq!(
        store.execution_unknown_code(&f.id).unwrap(),
        "history_job_execution_unknown"
    );
    assert!(store.step_owned(&owner, 0, 10, |_| true).is_err());
}

#[test]
fn an_owned_subprocess_lease_is_visible_and_process_interruption_releases_only_that_owner() {
    let f = Fixture::new();
    let ready = f.root.path().join("helper-ready");
    let mut child = OwnedProcess(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "owned_history_execution_helper",
                "--ignored",
                "--nocapture",
            ])
            .env("KCODER_OWNED_HISTORY_EXECUTION_PROFILE", &f.profile)
            .env("KCODER_OWNED_HISTORY_EXECUTION_JOB", &f.id)
            .env("KCODER_OWNED_HISTORY_EXECUTION_READY", &ready)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "owned helper exited before claim"
        );
        assert!(Instant::now() < deadline, "owned helper claim deadline");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(f.store().execution_state(&f.id).unwrap(), State::Running);
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(f.store().execution_state(&f.id).unwrap(), State::Stopped);
    assert_eq!(
        f.store().read(&f.id).unwrap().stage,
        HistoryImportStage::Capturing
    );
}

#[test]
fn version_one_failed_old_parser_owner_check_preserves_failure_and_all_archive_bytes() {
    let f = Fixture::new();
    let store = f.store();
    let mut current = store.read(&f.id).unwrap();
    while current.stage != HistoryImportStage::Normalized {
        current = store.step(&f.id, current.sequence, 10, |_| true).unwrap();
    }
    let old = owned_legacy::from_job(&f.profile, &f.id).unwrap();
    let path = f
        .profile
        .join("migrations/history")
        .join(format!("{}.json", old.job_id));
    let before: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(before["version"], 1);
    assert_eq!(old.stage, HistoryImportStage::Failed);
    let archives = persisted_legacy::snapshot(&f.profile.join("external-history"));
    assert_eq!(
        store.execution_unknown_code(&old.job_id).unwrap(),
        "history_job_execution_untracked"
    );
    assert_eq!(store.resume(&old.job_id, old.sequence).unwrap(), old);
    assert_eq!(store.execution_state(&old.job_id).unwrap(), State::Stopped);
    let mut after: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    after.as_object_mut().unwrap().remove("executionIdentity");
    after
        .as_object_mut()
        .unwrap()
        .remove("executionBirthSha256");
    assert_eq!(after, before);
    assert_eq!(
        persisted_legacy::snapshot(&f.profile.join("external-history")),
        archives
    );
    assert!(
        store
            .reinterpretation_preview(&old.job_id)
            .unwrap()
            .can_create
    );
}

struct OwnedProcess(std::process::Child);
impl std::ops::Deref for OwnedProcess {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for OwnedProcess {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[test]
#[ignore = "owned subprocess helper, executed only by its parent regression"]
fn owned_history_execution_helper() {
    let profile =
        std::env::var_os("KCODER_OWNED_HISTORY_EXECUTION_PROFILE").expect("owned fixture profile");
    let id = std::env::var("KCODER_OWNED_HISTORY_EXECUTION_JOB").unwrap();
    let ready = std::env::var_os("KCODER_OWNED_HISTORY_EXECUTION_READY").unwrap();
    let store = HistoryJobStore::open_existing(Path::new(&profile))
        .unwrap()
        .unwrap();
    let _guard = store.claim_execution(&id, 0).unwrap();
    fs::write(ready, b"owned").unwrap();
    std::thread::sleep(Duration::from_secs(15));
}
