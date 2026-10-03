//! Diagnostic trigger receipts, committed in the same file as the schedule cursor.
//! A queue acknowledgement is not execution, and no receipt is replayed automatically.
use super::*;

pub(super) const MAX_RECEIPTS: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    pub job_id: String,
    pub scheduled_at: DateTime<Utc>,
    pub session_id: Option<String>,
    pub recorded_at: DateTime<Utc>,
    pub owner_instance: String,
    pub phase: Phase,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Phase {
    DispatchPending,
    Queued,
    DeliveredToSubscriber,
}

pub(super) fn owner_instance() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    format!(
        "{}-{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

/// Only confirmed subscriber delivery is eligible for automatic retention.
/// Pending/queued receipts are never evicted by age or capacity.
pub(super) fn retain_confirmed(file: &mut CronFile, now: DateTime<Utc>) {
    let mut retained = 0usize;
    let before = file.receipts.len();
    for receipt in file.receipts.iter().rev() {
        if matches!(receipt.phase, Phase::DeliveredToSubscriber)
            && now.signed_duration_since(receipt.recorded_at).num_days() < 30
        {
            retained += 1;
        }
    }
    let mut excess = retained.saturating_sub(256);
    file.receipts.retain(|receipt| {
        if !matches!(receipt.phase, Phase::DeliveredToSubscriber) {
            return true;
        }
        if now.signed_duration_since(receipt.recorded_at).num_days() >= 30 {
            return false;
        }
        if excess > 0 {
            excess -= 1;
            return false;
        }
        true
    });
    file.confirmed_receipts_pruned = file
        .confirmed_receipts_pruned
        .saturating_add((before - file.receipts.len()) as u64);
}

impl CronScheduler {
    /// Persist that an event reached a consumer queue. This never claims model or
    /// tool execution. On error the pending/queued receipt is retained; callers
    /// must surface the error and must not resend the event as a recovery action.
    pub fn acknowledge_delivery(&self, event: &CronFire) -> Result<(), String> {
        let result = self.acknowledge_delivery_inner(event);
        if result.is_err() {
            self.0
                .acknowledgement_uncertain
                .store(true, std::sync::atomic::Ordering::Release);
        }
        result
    }

    fn acknowledge_delivery_inner(&self, event: &CronFire) -> Result<(), String> {
        let started = std::time::Instant::now();
        let _lock = loop {
            match lock_jobs(&self.0.path) {
                Ok(lock) => break lock,
                Err(error)
                    if error.starts_with("cron store is busy:")
                        && started.elapsed() < Duration::from_secs(2) =>
                {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(error) => return Err(error),
            }
        };
        let mut file = read_cron_file(&self.0.path)?.ok_or("cron receipt store missing")?;
        let receipt = file
            .receipts
            .iter_mut()
            .find(|receipt| {
                receipt.job_id == event.id
                    && receipt.scheduled_at == event.scheduled_at
                    && receipt.session_id == event.session_id
                    && receipt.owner_instance == self.0.owner_instance
            })
            .ok_or("cron delivery receipt is unavailable for this owner")?;
        if matches!(receipt.phase, Phase::DeliveredToSubscriber) {
            return Ok(());
        }
        receipt.phase = Phase::DeliveredToSubscriber;
        retain_confirmed(&mut file, Utc::now());
        persist_cron_file(&self.0.path, &file)
    }

    /// Explicit diagnostic cleanup, separate from deleting an active schedule.
    pub fn clear_delivery_receipts(
        &self,
        job_id: &str,
        session_id: Option<&str>,
    ) -> Result<bool, String> {
        self.delete_owned_mode(job_id, session_id, true)
    }

    /// Read-only, owner-scoped receipt diagnostics, including removed one-shot jobs.
    /// Another scheduler/restarted process cannot infer that queued work executed.
    pub fn delivery_diagnostics(&self, session_id: Option<&str>) -> Result<Value, String> {
        let file = read_cron_file(&self.0.path)?.unwrap_or_default();
        let receipts = file.receipts.iter().filter(|receipt| receipt.session_id.as_deref() == session_id)
            .map(|receipt| serde_json::json!({
                "jobId": receipt.job_id, "scheduledAt": receipt.scheduled_at,
                "recordedAt": receipt.recorded_at, "lastRecordedPhase": receipt.phase,
                "deliveryConfirmed": matches!(receipt.phase, Phase::DeliveredToSubscriber),
                "status": if matches!(receipt.phase, Phase::DeliveredToSubscriber) {
                    "delivered_to_subscriber"
                } else if !self.0.acknowledgement_uncertain.load(std::sync::atomic::Ordering::Acquire)
                    && receipt.owner_instance == self.0.owner_instance && matches!(receipt.phase, Phase::Queued) {
                    "queued"
                } else { "delivery_unknown" },
                "executionConfirmed": false, "automaticReplay": false,
            })).collect::<Vec<_>>();
        Ok(
            serde_json::json!({"receipts":receipts, "maxRecords":MAX_RECEIPTS,
            "acknowledgementErrorsObserved": self.0.acknowledgement_uncertain.load(std::sync::atomic::Ordering::Acquire),
            "automaticPruning":"confirmed-delivery-only", "confirmedRetentionLimit":256,
            "confirmedRetentionDays":30, "confirmedPrunedRecords":file.confirmed_receipts_pruned,
            "explicitlyClearedRecords":file.receipts_pruned,
            "code":if file.receipts.len() >= MAX_RECEIPTS { Some("cron_delivery_capacity") } else { None },
            "capacityBlocked":file.receipts.len() >= MAX_RECEIPTS,
            "policy":"no-execution-claim-no-replay; cron_delete with receipts_only=true and confirmed=true clears receipts without deleting the job"}),
        )
    }
}

#[cfg(test)]
pub(super) fn crash_point(path: &Path, stage: &str) {
    if std::env::var_os("KCODER_TEST_CRON_RECEIPT_ROOT").is_some_and(|root| path.starts_with(root))
        && std::env::var("KCODER_TEST_CRON_RECEIPT_CUT")
            .ok()
            .as_deref()
            == Some(stage)
    {
        std::process::exit(73);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_trigger_crash_child() {
        let Some(root) = std::env::var_os("KCODER_TEST_CRON_RECEIPT_ROOT") else {
            return;
        };
        let scheduler = CronScheduler::load(Path::new(&root));
        let _receiver = scheduler.subscribe_session("fixture-owner".into());
        let due = scheduler.list_for_session("fixture-owner").unwrap()[0].next_run_at;
        scheduler.fire_due(due);
        panic!("crash point did not terminate the child");
    }

    #[test]
    fn real_process_crash_before_commit_after_commit_and_after_queue_has_explicit_outcome() {
        for stage in ["before_commit", "after_commit", "after_queued"] {
            let root = tempfile::tempdir().unwrap();
            let scheduler = CronScheduler::load(root.path());
            let job = scheduler
                .create_for_session(
                    "fixture-owner".into(),
                    "private prompt excluded from diagnostics".into(),
                    CronSchedule::At {
                        at: (Utc::now() + ChronoDuration::seconds(60)).to_rfc3339(),
                    },
                    Some(0),
                )
                .unwrap();
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "cron::delivery::tests::durable_trigger_crash_child",
                    "--nocapture",
                ])
                .env("KCODER_TEST_CRON_RECEIPT_ROOT", root.path())
                .env("KCODER_TEST_CRON_RECEIPT_CUT", stage)
                .output()
                .unwrap();
            assert_eq!(
                child.status.code(),
                Some(73),
                "{stage}: {}",
                String::from_utf8_lossy(&child.stderr)
            );
            let restarted = CronScheduler::load(root.path());
            let mut receiver = restarted.subscribe_session("fixture-owner".into());
            let diagnostics = restarted
                .delivery_diagnostics(Some("fixture-owner"))
                .unwrap();
            assert!(!diagnostics.to_string().contains("private prompt"));
            if stage == "before_commit" {
                assert_eq!(
                    restarted.list_for_session("fixture-owner").unwrap().len(),
                    1
                );
                assert!(diagnostics["receipts"].as_array().unwrap().is_empty());
                restarted.fire_due(job.next_run_at);
                assert_eq!(receiver.receiver.try_recv().unwrap().id, job.id);
            } else {
                assert!(
                    restarted
                        .list_for_session("fixture-owner")
                        .unwrap()
                        .is_empty()
                );
                assert_eq!(diagnostics["receipts"][0]["status"], "delivery_unknown");
                assert_eq!(
                    diagnostics["receipts"][0]["lastRecordedPhase"],
                    if stage == "after_commit" {
                        "dispatch_pending"
                    } else {
                        "queued"
                    }
                );
                assert_eq!(diagnostics["receipts"][0]["jobId"], job.id);
                assert_eq!(diagnostics["receipts"][0]["executionConfirmed"], false);
                assert!(
                    restarted.delivery_diagnostics(Some("other-owner")).unwrap()["receipts"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
                restarted.fire_due(job.next_run_at);
                assert!(
                    receiver.receiver.try_recv().is_err(),
                    "uncertain trigger must not replay"
                );
                assert!(
                    !restarted
                        .delete_for_session(&job.id, "other-owner")
                        .unwrap()
                );
                assert!(
                    restarted
                        .delete_for_session(&job.id, "fixture-owner")
                        .unwrap()
                );
                assert!(
                    restarted
                        .delivery_diagnostics(Some("fixture-owner"))
                        .unwrap()["receipts"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
            }
        }
    }

    #[test]
    fn receipt_capacity_blocks_cursor_commit_until_explicit_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let job = scheduler
            .create(
                "next".into(),
                CronSchedule::At {
                    at: (Utc::now() + ChronoDuration::seconds(60)).to_rfc3339(),
                },
                Some(0),
            )
            .unwrap();
        let mut file = read_cron_file(&scheduler.0.path).unwrap().unwrap();
        file.receipts = (0..MAX_RECEIPTS)
            .map(|i| Receipt {
                job_id: format!("old-{i}"),
                scheduled_at: Utc::now(),
                session_id: None,
                recorded_at: Utc::now() - ChronoDuration::days(100),
                owner_instance: "dead-owner".into(),
                phase: Phase::Queued,
            })
            .collect();
        persist_cron_file(&scheduler.0.path, &file).unwrap();
        let mut receiver = scheduler.subscribe();
        let original = fs::read(&scheduler.0.path).unwrap();
        scheduler.fire_due(job.next_run_at);
        assert_eq!(fs::read(&scheduler.0.path).unwrap(), original);
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            scheduler.delivery_diagnostics(None).unwrap()["capacityBlocked"],
            true
        );
        assert!(scheduler.delete("old-0").unwrap());
        scheduler.fire_due(job.next_run_at);
        assert_eq!(receiver.try_recv().unwrap().id, job.id);
        let report = scheduler.delivery_diagnostics(None).unwrap();
        assert_eq!(report["receipts"].as_array().unwrap().len(), MAX_RECEIPTS);
        assert_eq!(report["explicitlyClearedRecords"], 1);
        assert_eq!(report["receipts"][MAX_RECEIPTS - 1]["status"], "queued");
        assert_eq!(
            report["receipts"][MAX_RECEIPTS - 1]["executionConfirmed"],
            false
        );
    }

    #[test]
    fn legacy_store_is_backed_up_exactly_and_unknown_versions_are_not_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        scheduler
            .create(
                "keep".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        let mut legacy =
            serde_json::to_value(read_cron_file(&scheduler.0.path).unwrap().unwrap()).unwrap();
        legacy["version"] = serde_json::json!(2);
        legacy.as_object_mut().unwrap().remove("receipts");
        legacy.as_object_mut().unwrap().remove("receipts_pruned");
        let original = serde_json::to_vec_pretty(&legacy).unwrap();
        fs::write(&scheduler.0.path, &original).unwrap();
        scheduler
            .create(
                "second".into(),
                CronSchedule::Every { every_seconds: 120 },
                Some(0),
            )
            .unwrap();
        assert_eq!(
            fs::read(
                scheduler
                    .0
                    .path
                    .with_file_name("jobs.before-delivery-v3.json")
            )
            .unwrap(),
            original
        );
        assert_eq!(
            read_cron_file(&scheduler.0.path).unwrap().unwrap().version,
            3
        );
        legacy["version"] = serde_json::json!(99);
        let future = serde_json::to_vec(&legacy).unwrap();
        fs::write(&scheduler.0.path, &future).unwrap();
        assert!(
            scheduler
                .create(
                    "reject".into(),
                    CronSchedule::Every { every_seconds: 60 },
                    Some(0)
                )
                .is_err()
        );
        assert_eq!(fs::read(&scheduler.0.path).unwrap(), future);
    }
    #[tokio::test]
    async fn confirmed_subscription_delivery_has_bounded_retention_without_claiming_execution() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let job = scheduler
            .create_for_session(
                "owner".into(),
                "periodic".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        let mut file = read_cron_file(&scheduler.0.path).unwrap().unwrap();
        file.receipts.push(Receipt {
            job_id: "unknown-old".into(),
            scheduled_at: Utc::now(),
            session_id: Some("owner".into()),
            recorded_at: Utc::now() - ChronoDuration::days(100),
            owner_instance: "dead".into(),
            phase: Phase::Queued,
        });
        persist_cron_file(&scheduler.0.path, &file).unwrap();
        let mut receiver = scheduler.subscribe_session("owner".into());
        for _ in 0..260 {
            let due = scheduler.list_for_session("owner").unwrap()[0].next_run_at;
            scheduler.fire_due(due);
            assert_eq!(receiver.recv().await.unwrap().id, job.id);
        }
        let report = scheduler.delivery_diagnostics(Some("owner")).unwrap();
        assert_eq!(report["receipts"].as_array().unwrap().len(), 257);
        assert_eq!(report["confirmedPrunedRecords"], 4);
        assert_eq!(report["receipts"][0]["status"], "delivery_unknown");
        assert_eq!(report["receipts"][256]["status"], "delivered_to_subscriber");
        assert_eq!(report["receipts"][256]["executionConfirmed"], false);
        assert_eq!(
            CronScheduler::load(root.path())
                .delivery_diagnostics(Some("owner"))
                .unwrap()["receipts"][256]["status"],
            "delivered_to_subscriber"
        );
    }

    #[test]
    fn receipt_only_cleanup_preserves_periodic_cursor_and_ack_failure_is_queryable() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let job = scheduler
            .create(
                "periodic".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        let mut receiver = scheduler.subscribe();
        scheduler.fire_due(job.next_run_at);
        let event = receiver.try_recv().unwrap();
        let next = scheduler.list()[0].next_run_at;
        let held = lock_jobs(&scheduler.0.path).unwrap();
        assert!(scheduler.acknowledge_delivery(&event).is_err());
        drop(held);
        let report = scheduler.delivery_diagnostics(None).unwrap();
        assert_eq!(report["receipts"][0]["status"], "delivery_unknown");
        assert_eq!(report["acknowledgementErrorsObserved"], true);
        assert!(scheduler.clear_delivery_receipts(&job.id, None).unwrap());
        assert_eq!(scheduler.list()[0].next_run_at, next);
        assert_eq!(scheduler.list()[0].id, job.id);
        assert!(
            scheduler.delivery_diagnostics(None).unwrap()["receipts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        scheduler.fire_due(next);
        assert_eq!(receiver.try_recv().unwrap().id, job.id);
        scheduler.fire_due(next);
        assert!(receiver.try_recv().is_err());
    }
}
