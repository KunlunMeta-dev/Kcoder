use kcoder_migration::{
    assets::AssetTarget,
    batch::{
        BatchActionKind, BatchSource, default_resolution,
        execution::{BatchExecution, BatchRunEvent, BatchRunMode},
        history::HistoryBatchSource,
    },
    history_discovery::HistoryCatalog,
    history_jobs::HistoryJobStore,
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationJob, MigrationStore},
};
use kcoder_types::{
    external_history::HistoryImportStage,
    migration::{MigrationJobStatus, MigrationSourceKind},
};
use std::{fs, sync::mpsc, time::Duration};

struct Fixture {
    _source: tempfile::TempDir,
    profile: tempfile::TempDir,
    job: MigrationJob,
    child: String,
}
impl Fixture {
    fn new() -> Self {
        let source = tempfile::tempdir().unwrap();
        let directory = source.path().join("projects/fixture");
        fs::create_dir_all(&directory).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        fs::write(
            directory.join(format!("{id}.jsonl")),
            format!(
                "{}\n",
                serde_json::json!({
            "type":"user","uuid":"message","sessionId":id,
            "message":{"role":"user","content":"Owned control fixture"}})
            ),
        )
        .unwrap();
        let catalog =
            HistoryCatalog::discover(source.path(), MigrationSourceKind::ClaudeCode, |_| true)
                .unwrap();
        let page = catalog.page(None, |_| true).unwrap();
        let selection = catalog
            .selection(&page.items[0].source_handle)
            .unwrap()
            .pin()
            .unwrap();
        let profile = tempfile::tempdir().unwrap();
        let store = MigrationStore::open_or_create(profile.path()).unwrap();
        let provider = ProviderTarget::open(profile.path()).unwrap();
        let mcp = McpTarget::open(profile.path()).unwrap();
        let assets = AssetTarget::open(profile.path()).unwrap();
        let history = HistoryJobStore::open(profile.path()).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            history: Some(&history),
            credentials: None,
        };
        let scanned = store
            .create_batch_scan(vec![BatchSource::History(Box::new(
                HistoryBatchSource::new(selection).unwrap(),
            ))])
            .unwrap();
        let choice = default_resolution(&scanned, &scanned.inventory.items[0]).unwrap();
        let job = store
            .prepare_batch(&scanned.job_id, scanned.sequence, &[choice], &targets)
            .unwrap();
        let BatchActionKind::History { plan } = &job.batch.as_ref().unwrap().actions[0].action
        else {
            panic!("missing history action")
        };
        let child = plan.history_job_id.clone();
        Self {
            _source: source,
            profile,
            job,
            child,
        }
    }
    fn run(
        &self,
        mode: BatchRunMode,
        request: &str,
        sequence: u64,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> anyhow::Result<MigrationJob> {
        let store = MigrationStore::open_existing(self.profile.path())?;
        let provider = ProviderTarget::open(self.profile.path())?;
        let mcp = McpTarget::open(self.profile.path())?;
        let assets = AssetTarget::open(self.profile.path())?;
        let history = HistoryJobStore::open(self.profile.path())?;
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            history: Some(&history),
            credentials: None,
        };
        store.run_batch_controlled(
            BatchExecution {
                job_id: &self.job.job_id,
                plan_id: self.job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                request_id: request,
                expected_sequence: sequence,
                mode,
            },
            &targets,
            check,
        )
    }
}

#[test]
fn observing_a_prepared_batch_does_not_create_an_execution_lock() {
    let fixture = Fixture::new();
    let file = fixture
        .profile
        .path()
        .join("migrations")
        .join(format!(".{}.runner.lock", fixture.job.job_id));
    assert!(!file.exists());
    let store = MigrationStore::open_existing(fixture.profile.path()).unwrap();
    assert!(!store.batch_execution_active(&fixture.job.job_id).unwrap());
    assert!(!file.exists());
}

#[test]
fn losing_the_worker_during_capture_preserves_the_same_child_for_explicit_resume() {
    let fixture = Fixture::new();
    let mut stopped = false;
    let error = fixture
        .run(
            BatchRunMode::Apply,
            "owned-worker",
            fixture.job.sequence,
            &mut |event| {
                stopped |= matches!(event, BatchRunEvent::History { .. });
                !stopped
            },
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "migration_batch_worker_stopped");
    let store = MigrationStore::open_existing(fixture.profile.path()).unwrap();
    let observed = store.read(&fixture.job.job_id).unwrap();
    assert_eq!(observed.status, MigrationJobStatus::Applying);
    assert!(observed.receipts.is_empty());
    let history = HistoryJobStore::open(fixture.profile.path()).unwrap();
    assert_eq!(
        history.read(&fixture.child).unwrap().stage,
        HistoryImportStage::Cancelled
    );
    let completed = fixture
        .run(
            BatchRunMode::Resume,
            "confirmed-resume",
            observed.sequence,
            &mut |_| true,
        )
        .unwrap();
    assert_eq!(completed.status, MigrationJobStatus::Completed);
    assert_eq!(completed.receipts.len(), 1);
    assert_eq!(completed.receipts[0].target_id, fixture.child);
    let repeated = fixture
        .run(
            BatchRunMode::Resume,
            "confirmed-resume",
            observed.sequence,
            &mut |_| panic!("completed request must only be observed"),
        )
        .unwrap();
    assert_eq!(repeated, completed);
    assert!(!fixture.profile.path().join("sessions").exists());
}

#[test]
fn status_and_durable_cancel_remain_available_while_capture_is_paused_in_a_worker() {
    let fixture = std::sync::Arc::new(Fixture::new());
    let (paused_tx, paused_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let worker_fixture = fixture.clone();
    let worker = std::thread::spawn(move || {
        let mut paused = false;
        worker_fixture.run(
            BatchRunMode::Apply,
            "controlled-cancel",
            worker_fixture.job.sequence,
            &mut |event| {
                if !paused && matches!(event, BatchRunEvent::History { .. }) {
                    paused = true;
                    paused_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                }
                true
            },
        )
    });
    paused_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let store = MigrationStore::open_existing(fixture.profile.path()).unwrap();
    let observed = store.read(&fixture.job.job_id);
    let active = store.batch_execution_active(&fixture.job.job_id);
    let cancelled = observed
        .as_ref()
        .ok()
        .map(|job| store.cancel(&job.job_id, job.sequence));
    // Always release the owned thread before asserting the observed results.
    let _ = release_tx.send(());
    assert_eq!(observed.unwrap().status, MigrationJobStatus::Applying);
    assert!(active.unwrap());
    assert_eq!(
        cancelled.unwrap().unwrap().status,
        MigrationJobStatus::CancelRequested
    );
    let stopped = worker.join().unwrap().unwrap();
    assert!(!store.batch_execution_active(&fixture.job.job_id).unwrap());
    assert_eq!(stopped.status, MigrationJobStatus::Cancelled);
    let history = HistoryJobStore::open(fixture.profile.path()).unwrap();
    assert_eq!(
        history.read(&fixture.child).unwrap().stage,
        HistoryImportStage::Cancelled
    );
    let completed = fixture
        .run(
            BatchRunMode::Resume,
            "after-user-cancel",
            stopped.sequence,
            &mut |_| true,
        )
        .unwrap();
    assert_eq!(completed.status, MigrationJobStatus::Completed);
    assert_eq!(completed.receipts[0].target_id, fixture.child);
}
