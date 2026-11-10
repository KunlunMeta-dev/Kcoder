use super::*;
use crate::{
    asset_sources::AssetBundleBinding,
    assets::{AssetResolution, AssetTarget},
    batch::{BatchResolution, BatchSource},
    mcp::McpTarget,
};
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_types::migration::{MigrationCategory, MigrationJobStatus, MigrationSourceKind};

struct Fixture {
    _root: tempfile::TempDir,
    profile: std::path::PathBuf,
    store: MigrationStore,
    provider: ProviderTarget,
    mcp: McpTarget,
    assets: AssetTarget,
    job: MigrationJob,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("skills");
        for index in 0..4 {
            let skill = source.join(format!("owned-{index}"));
            std::fs::create_dir_all(&skill).unwrap();
            std::fs::write(skill.join("SKILL.md"), format!("---\nname: owned-{index}\ndescription: Owned control fixture\n---\nStatic content, never executed.\n")).unwrap();
        }
        let profile = root.path().join("profile");
        std::fs::create_dir(&profile).unwrap();
        std::fs::write(profile.join("settings.json"), "{}").unwrap();
        let store = MigrationStore::open_or_create(&profile).unwrap();
        let provider = ProviderTarget::open(&profile).unwrap();
        let mcp = McpTarget::open(&profile).unwrap();
        let assets = AssetTarget::open(&profile).unwrap();
        let scanned = store
            .create_batch_scan(vec![BatchSource::Assets(
                AssetBundleBinding::capture(
                    &source,
                    MigrationSourceKind::ClaudeCode,
                    MigrationCategory::Skill,
                    ImportedContextScope::Global,
                    true,
                )
                .unwrap(),
            )])
            .unwrap();
        let choices = scanned
            .inventory
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                BatchResolution::Asset(AssetResolution {
                    item_id: item.preview.id.clone(),
                    target_name: format!("control-target-{index}"),
                    enable_after_import: false,
                    memory_scope: None,
                    agent_adaptation: None,
                })
            })
            .collect::<Vec<_>>();
        let job = store
            .prepare_batch(
                &scanned.job_id,
                scanned.sequence,
                &choices,
                &BatchTargets {
                    provider: &provider,
                    mcp: &mcp,
                    assets: &assets,
                    history: None,
                    credentials: None,
                },
            )
            .unwrap();
        Self {
            _root: root,
            profile,
            store,
            provider,
            mcp,
            assets,
            job,
        }
    }
    fn targets(&self) -> BatchTargets<'_> {
        BatchTargets {
            provider: &self.provider,
            mcp: &self.mcp,
            assets: &self.assets,
            history: None,
            credentials: None,
        }
    }
    fn execution<'a>(&'a self, request: &'a str, mode: BatchRunMode) -> BatchExecution<'a> {
        BatchExecution {
            job_id: &self.job.job_id,
            plan_id: self.job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            request_id: request,
            expected_sequence: self.store.read(&self.job.job_id).unwrap().sequence,
            mode,
        }
    }
    fn intent(&self, generation: &BatchControlGeneration) -> BatchCancellationIntent {
        BatchCancellationIntent {
            job_id: self.job.job_id.clone(),
            command_id: uuid::Uuid::new_v4().to_string(),
            plan_id: generation.plan_id.clone(),
            run_request_id: generation.run_request_id.clone(),
            admission_sequence: generation.admission_sequence,
        }
    }
    fn cancelled_after_progress(&self) -> (BatchCancellationIntent, BatchCancellationReceipt) {
        let mut first = None;
        let mut old_sequence = 0;
        let mut accepted = None;
        let result = self
            .store
            .run_batch_controlled(
                self.execution("original-apply", BatchRunMode::Apply),
                &self.targets(),
                &mut |event| {
                    if let BatchRunEvent::Action { index, .. } = event {
                        if index == 0 {
                            let view = self
                                .store
                                .observe_batch_control(&self.job.job_id, None)
                                .unwrap();
                            old_sequence = view.current_sequence;
                            first = Some(self.intent(view.generation.as_ref().unwrap()));
                        }
                        if index == 1 {
                            assert!(
                                self.store.read(&self.job.job_id).unwrap().sequence > old_sequence
                            );
                            assert_eq!(
                                self.store
                                    .cancel(&self.job.job_id, old_sequence)
                                    .unwrap_err()
                                    .to_string(),
                                "migration_revision_conflict"
                            );
                            let view = self
                                .store
                                .cancel_batch_execution(first.as_ref().unwrap())
                                .unwrap();
                            assert!(view.cancel_requested);
                            accepted = view.requested_receipt;
                        }
                    }
                    true
                },
            )
            .unwrap();
        assert_eq!(result.status, MigrationJobStatus::Cancelled);
        assert_eq!(
            result
                .inventory
                .items
                .iter()
                .filter(|item| item.preview.status == ItemStatus::Committed)
                .count(),
            2
        );
        (first.unwrap(), accepted.unwrap())
    }
}

#[test]
fn progress_invalidates_old_job_cas_but_not_the_original_execution_cancel() {
    let f = Fixture::new();
    let (intent, receipt) = f.cancelled_after_progress();
    let before = f.store.read(&f.job.job_id).unwrap();
    let reopened = MigrationStore::open_existing(&f.profile).unwrap();
    assert_eq!(
        reopened
            .observe_batch_control(&f.job.job_id, Some(&intent.command_id))
            .unwrap()
            .requested_receipt,
        Some(receipt.clone())
    );
    assert_eq!(
        reopened
            .cancel_batch_execution(&intent)
            .unwrap()
            .requested_receipt,
        Some(receipt)
    );
    assert_eq!(
        reopened.read(&f.job.job_id).unwrap(),
        before,
        "lost acknowledgement recovery never replays the cancellation"
    );
}

#[test]
fn old_cancellation_receipts_never_cancel_a_new_resume_generation() {
    let f = Fixture::new();
    let (original, receipt) = f.cancelled_after_progress();
    let mut checked = false;
    let result = f
        .store
        .run_batch_controlled(
            f.execution("explicit-new-resume", BatchRunMode::Resume),
            &f.targets(),
            &mut |event| {
                if matches!(event, BatchRunEvent::Action { .. }) && !checked {
                    checked = true;
                    let current = f.store.observe_batch_control(&f.job.job_id, None).unwrap();
                    let generation = current.generation.unwrap();
                    assert!(generation.admission_sequence > original.admission_sequence);
                    let recovered = f.store.cancel_batch_execution(&original).unwrap();
                    assert_eq!(recovered.requested_receipt, Some(receipt.clone()));
                    assert!(!recovered.cancel_requested);
                    let before = f.store.read(&f.job.job_id).unwrap();
                    let mut stale = original.clone();
                    stale.command_id = uuid::Uuid::new_v4().to_string();
                    assert_eq!(
                        f.store
                            .cancel_batch_execution(&stale)
                            .unwrap_err()
                            .to_string(),
                        "migration_batch_control_changed"
                    );
                    let mut reused = f.intent(&generation);
                    reused.command_id = original.command_id.clone();
                    assert_eq!(
                        f.store
                            .cancel_batch_execution(&reused)
                            .unwrap_err()
                            .to_string(),
                        "migration_batch_cancel_command_changed"
                    );
                    assert_eq!(f.store.read(&f.job.job_id).unwrap(), before);
                }
                true
            },
        )
        .unwrap();
    assert!(checked);
    assert_eq!(result.status, MigrationJobStatus::Completed);
}

#[test]
fn missing_or_replaced_born_runner_and_missing_record_stay_unknown_without_repair() {
    let f = Fixture::new();
    f.cancelled_after_progress();
    let directory = f.profile.join("migrations");
    let runner = directory.join(format!(".{}.runner.lock", f.job.job_id));
    let original = directory.join(".original-owned-runner");
    std::fs::rename(&runner, &original).unwrap();
    assert!(f.store.observe_batch_control(&f.job.job_id, None).is_err());
    assert!(!runner.exists());
    assert!(
        f.store
            .run_batch_controlled(
                f.execution("must-not-repair", BatchRunMode::Resume),
                &f.targets(),
                &mut |_| true
            )
            .is_err()
    );
    assert!(!runner.exists());
    std::fs::write(&runner, []).unwrap();
    assert!(f.store.observe_batch_control(&f.job.job_id, None).is_err());
    std::fs::remove_file(&runner).unwrap();
    std::fs::rename(&original, &runner).unwrap();
    let path = directory.join(format!("{}.json", f.job.job_id));
    let bytes = std::fs::read(&path).unwrap();
    let mut document: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    document["batch"]
        .as_object_mut()
        .unwrap()
        .remove("executionControl");
    let changed = serde_json::to_vec(&document).unwrap();
    std::fs::write(&path, &changed).unwrap();
    assert!(f.store.observe_batch_control(&f.job.job_id, None).is_err());
    assert_eq!(std::fs::read(path).unwrap(), changed);
}

#[test]
fn pure_control_read_of_an_unadmitted_batch_never_creates_a_runner_or_changes_the_job() {
    let f = Fixture::new();
    let before = f.store.read(&f.job.job_id).unwrap();
    let path = f
        .profile
        .join("migrations")
        .join(format!(".{}.runner.lock", f.job.job_id));
    assert!(!path.exists());
    let view = f.store.observe_batch_control(&f.job.job_id, None).unwrap();
    assert_eq!(view.phase, BatchControlPhase::Unadmitted);
    assert!(view.generation.is_none());
    assert_eq!(f.store.read(&f.job.job_id).unwrap(), before);
    assert!(!path.exists());
}

#[test]
fn missing_or_replaced_original_coordinator_never_authorizes_control_or_resume() {
    let f = Fixture::new();
    let (original, _) = f.cancelled_after_progress();
    let expected_sequence = f.store.read(&f.job.job_id).unwrap().sequence;
    let execution = || BatchExecution {
        job_id: &f.job.job_id,
        plan_id: f.job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
        request_id: "cannot-replace-journal",
        expected_sequence,
        mode: BatchRunMode::Resume,
    };
    let directory = f.profile.join("migrations");
    let lock = directory.join(".lock");
    let held = std::fs::File::open(&lock).unwrap();
    let moved = directory.join("original-journal-lock");
    std::fs::rename(&lock, &moved).unwrap();
    for replacement in [false, true] {
        if replacement {
            std::fs::write(&lock, b"").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
        assert!(f.store.observe_batch_control(&f.job.job_id, None).is_err());
        assert!(f.store.cancel_batch_execution(&original).is_err());
        assert!(
            f.store
                .run_batch_controlled(execution(), &f.targets(), &mut |_| panic!(
                    "no effects without original coordinator"
                ))
                .is_err()
        );
        assert_eq!(lock.exists(), replacement);
    }
    drop(held);
    std::fs::remove_file(&lock).unwrap();
    std::fs::rename(&moved, &lock).unwrap();
    assert!(f.store.observe_batch_control(&f.job.job_id, None).is_ok());
}

#[test]
fn cancellation_waits_for_the_original_journal_past_the_short_progress_window() {
    let f = Fixture::new();
    let mut requested = None;
    let result = f
        .store
        .run_batch_controlled(
            f.execution("contended-original-apply", BatchRunMode::Apply),
            &f.targets(),
            &mut |event| {
                if matches!(event, BatchRunEvent::Action { index: 0, .. }) {
                    let before = f.store.observe_batch_control(&f.job.job_id, None).unwrap();
                    let intent = f.intent(before.generation.as_ref().unwrap());
                    let held = f
                        .store
                        .control_journal_lease(PrivateLeaseMode::Exclusive)
                        .unwrap();
                    let release = std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(160));
                        drop(held);
                    });
                    let outcome = f.store.cancel_batch_execution(&intent);
                    release.join().unwrap();
                    let accepted = outcome.unwrap();
                    let receipt = accepted.requested_receipt.unwrap();
                    assert_eq!(receipt.command_id, intent.command_id);
                    assert_eq!(receipt.admission_sequence, intent.admission_sequence);
                    assert_eq!(receipt.accepted_sequence, before.current_sequence + 1);
                    let job = f.store.read(&f.job.job_id).unwrap();
                    assert_eq!(
                        job.batch
                            .as_ref()
                            .unwrap()
                            .execution_control
                            .as_ref()
                            .unwrap()
                            .cancellations,
                        vec![receipt.clone()]
                    );
                    requested = Some((intent, receipt));
                }
                true
            },
        )
        .unwrap();
    assert_eq!(result.status, MigrationJobStatus::Cancelled);
    let (intent, receipt) = requested.unwrap();
    let before = f.store.read(&f.job.job_id).unwrap();
    assert_eq!(
        f.store
            .cancel_batch_execution(&intent)
            .unwrap()
            .requested_receipt,
        Some(receipt)
    );
    assert_eq!(f.store.read(&f.job.job_id).unwrap(), before);
}

thread_local! {
    static ON_JOURNAL_CONTENTION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn on_journal_contention() {
    let hook = ON_JOURNAL_CONTENTION.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

#[test]
fn a_journal_held_past_the_control_budget_never_writes_a_cancel_receipt() {
    let f = Fixture::new();
    let (mut intent, _) = f.cancelled_after_progress();
    intent.command_id = uuid::Uuid::new_v4().to_string();
    let journal = f
        .profile
        .join("migrations")
        .join(format!("{}.json", f.job.job_id));
    let before = std::fs::read(&journal).unwrap();
    for mode in [PrivateLeaseMode::Shared, PrivateLeaseMode::Exclusive] {
        let held = f.store.control_journal_lease(mode).unwrap();
        let started = Instant::now();
        let error = f.store.cancel_batch_execution(&intent).unwrap_err();
        let elapsed = started.elapsed();
        assert_eq!(error.to_string(), "migration_busy");
        assert_eq!(
            error
                .downcast_ref::<crate::contention::MigrationContention>()
                .unwrap()
                .lease,
            crate::contention::LeaseKind::JournalWrite
        );
        assert!(elapsed >= Duration::from_millis(450), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
        assert_eq!(std::fs::read(&journal).unwrap(), before);
        drop(held);
        assert!(
            f.store
                .observe_batch_control(&f.job.job_id, Some(&intent.command_id))
                .unwrap()
                .requested_receipt
                .is_none()
        );
    }
}

#[test]
fn journal_replacement_or_removal_while_waiting_never_changes_control_authority() {
    for replacement in [false, true] {
        let f = Fixture::new();
        let (mut intent, _) = f.cancelled_after_progress();
        intent.command_id = uuid::Uuid::new_v4().to_string();
        let directory = f.profile.join("migrations");
        let journal = directory.join(format!("{}.json", f.job.job_id));
        let before = std::fs::read(&journal).unwrap();
        let lock = directory.join(".lock");
        let original = directory.join(".owned-original-control-journal");
        let held = f
            .store
            .control_journal_lease(PrivateLeaseMode::Exclusive)
            .unwrap();
        let expected = held.identity().clone();
        let (lock_at_wait, original_at_wait) = (lock.clone(), original.clone());
        ON_JOURNAL_CONTENTION.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                std::fs::rename(&lock_at_wait, &original_at_wait).unwrap();
                if replacement {
                    std::fs::write(&lock_at_wait, b"").unwrap();
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(
                            &lock_at_wait,
                            std::fs::Permissions::from_mode(0o600),
                        )
                        .unwrap();
                    }
                }
            }));
        });
        assert!(f.store.cancel_batch_execution(&intent).is_err());
        assert!(ON_JOURNAL_CONTENTION.with(|slot| slot.borrow().is_none()));
        assert_eq!(lock.exists(), replacement);
        assert_eq!(std::fs::read(&journal).unwrap(), before);
        assert_eq!(
            f.store
                .directory
                .portable_regular_identity(OsStr::new(".owned-original-control-journal"))
                .unwrap(),
            expected
        );
        drop(held);
        if replacement {
            std::fs::remove_file(&lock).unwrap();
        }
        std::fs::rename(&original, &lock).unwrap();
        assert!(
            f.store
                .observe_batch_control(&f.job.job_id, Some(&intent.command_id))
                .unwrap()
                .requested_receipt
                .is_none()
        );
        assert_eq!(std::fs::read(&journal).unwrap(), before);
    }
}
