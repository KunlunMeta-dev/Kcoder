use super::*;
use kcoder_migration::batch::execution::{BatchExecution, BatchRunEvent, BatchRunMode};
use kcoder_migration::history_jobs::{HISTORY_IMPORT_CONCURRENCY, HistoryExecutionState};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

fn sources(root: &Path, count: usize) -> Vec<BatchSource> {
    (0..count).map(|index| {
        let selected = root.join(format!("source-{index}"));
        let directory = selected.join("projects/fixture");
        fs::create_dir_all(&directory).unwrap();
        let mut data = String::new();
        // A longer first input makes completion-order publication observable.
        for record in 0..if index == 0 { 12 } else { 2 } {
            data.push_str(&json!({"type":"user","uuid":format!("message-{record}"),"sessionId":SESSION,
                "message":{"role":"user","content":format!("Owned synthetic conversation {index} record {record}")}}).to_string());
            data.push('\n');
        }
        fs::write(directory.join(format!("{SESSION}.jsonl")), data).unwrap();
        let catalog = HistoryCatalog::discover(&selected, MigrationSourceKind::ClaudeCode, |_| true).unwrap();
        let page = catalog.page(None, |_| true).unwrap();
        let pending = catalog.selection(&page.items[0].source_handle).unwrap().pin().unwrap();
        BatchSource::History(Box::new(HistoryBatchSource::new(pending).unwrap()))
    }).collect()
}

#[test]
fn independently_selected_histories_use_sixty_four_owned_lanes_and_one_parent_receipt_writer() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    fs::write(profile.path().join("settings.json"), "{}").unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let history = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: Some(&history),
    };
    let job = prepare(
        &store,
        sources(source.path(), HISTORY_IMPORT_CONCURRENCY),
        &targets,
    );
    let children: Vec<_> = job
        .batch
        .as_ref()
        .unwrap()
        .actions
        .iter()
        .map(|action| match &action.action {
            BatchActionKind::History { plan } => plan.history_job_id.clone(),
            _ => panic!("unexpected non-history action"),
        })
        .collect();
    let owner = std::thread::current().id();
    #[cfg(target_os = "linux")]
    let fd_baseline = fs::read_dir("/proc/self/fd").unwrap().count();
    #[cfg(target_os = "linux")]
    let mut fd_peak = fd_baseline;
    let mut peak = 0;
    let mut first_progress = true;
    let mut completed = Vec::new();
    let result = store
        .run_batch_controlled(
            BatchExecution {
                job_id: &job.job_id,
                plan_id: job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                request_id: "parallel-original-request",
                expected_sequence: job.sequence,
                mode: BatchRunMode::Apply,
            },
            &targets,
            &mut |event| {
                assert_eq!(
                    std::thread::current().id(),
                    owner,
                    "the original callback never leaves its owning thread"
                );
                if matches!(event, BatchRunEvent::History { .. }) && first_progress {
                    let deadline = Instant::now() + Duration::from_secs(20);
                    loop {
                        let running = children
                            .iter()
                            .filter(|id| {
                                history
                                    .observe_execution(id)
                                    .is_ok_and(|(_, state)| state == HistoryExecutionState::Running)
                            })
                            .count();
                        peak = peak.max(running);
                        assert!(running <= HISTORY_IMPORT_CONCURRENCY);
                        if !first_progress || running == HISTORY_IMPORT_CONCURRENCY {
                            break;
                        }
                        assert!(
                            Instant::now() < deadline,
                            "sixty-four independent children never acquired execution"
                        );
                        std::thread::yield_now();
                    }
                    if first_progress {
                        #[cfg(target_os = "linux")]
                        {
                            fd_peak = fd_peak.max(fs::read_dir("/proc/self/fd").unwrap().count());
                        }
                        first_progress = false;
                    }
                }
                if let BatchRunEvent::Action { action_id, .. } = event {
                    let current = store.read(&job.job_id).unwrap();
                    if current
                        .receipts
                        .iter()
                        .any(|receipt| receipt.operation_id == action_id)
                        && !completed.iter().any(|id| id == action_id)
                    {
                        completed.push(action_id.to_owned());
                    }
                }
                true
            },
        )
        .unwrap();
    #[cfg(target_os = "linux")]
    eprintln!(
        "owned history lanes={peak}, fd_baseline={fd_baseline}, fd_peak={fd_peak}, fd_delta={}",
        fd_peak.saturating_sub(fd_baseline)
    );
    assert_eq!(peak, HISTORY_IMPORT_CONCURRENCY);
    assert_eq!(
        result.status,
        MigrationJobStatus::Completed,
        "{:?}",
        result
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .map(|action| (action.status, action.error.as_deref()))
            .collect::<Vec<_>>()
    );
    assert_eq!(completed.len(), HISTORY_IMPORT_CONCURRENCY);
    assert_eq!(result.receipts.len(), HISTORY_IMPORT_CONCURRENCY);
    assert_eq!(
        result
            .receipts
            .iter()
            .map(|receipt| &receipt.operation_id)
            .collect::<BTreeSet<_>>()
            .len(),
        HISTORY_IMPORT_CONCURRENCY
    );
    for child in &children {
        assert_eq!(
            history.read(child).unwrap().stage,
            HistoryImportStage::Normalized
        );
    }
    let repeated = store
        .run_batch_controlled(
            BatchExecution {
                job_id: &job.job_id,
                plan_id: job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                request_id: "parallel-original-request",
                expected_sequence: job.sequence,
                mode: BatchRunMode::Apply,
            },
            &targets,
            &mut |_| panic!("a finished original request must not execute again"),
        )
        .unwrap();
    assert_eq!(repeated.sequence, result.sequence);
    assert_eq!(repeated.receipts, result.receipts);
}

#[test]
fn stopping_parallel_history_drains_owned_children() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    fs::write(profile.path().join("settings.json"), "{}").unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let history = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: Some(&history),
    };
    let job = prepare(
        &store,
        sources(source.path(), HISTORY_IMPORT_CONCURRENCY),
        &targets,
    );
    let children: Vec<_> = job
        .batch
        .as_ref()
        .unwrap()
        .actions
        .iter()
        .map(|action| match &action.action {
            BatchActionKind::History { plan } => plan.history_job_id.clone(),
            _ => unreachable!(),
        })
        .collect();
    let result = store.run_batch_controlled(
        BatchExecution {
            job_id: &job.job_id,
            plan_id: job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            request_id: "parallel-stop-request",
            expected_sequence: job.sequence,
            mode: BatchRunMode::Apply,
        },
        &targets,
        &mut |event| !matches!(event, BatchRunEvent::History { .. }),
    );
    assert!(result.is_err());
    for child in children.iter().take(HISTORY_IMPORT_CONCURRENCY) {
        if let Ok((_, state)) = history.observe_execution(child) {
            assert_ne!(state, HistoryExecutionState::Running);
        }
    }
    let current = store.read(&job.job_id).unwrap();
    assert!(
        !current
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .any(|action| action.status == MigrationItemStatus::Committed)
    );
}
