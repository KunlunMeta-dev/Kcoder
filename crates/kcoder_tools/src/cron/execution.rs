//! Execution evidence supplements delivery receipts. Unknown work is never replayed.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionRecord {
    pub trigger_id: String,
    pub title: String,
    pub coalesced: usize,
    #[serde(default)]
    pub schedule: Option<CronSchedule>,
    pub status: String,
    pub workspace_path: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub attempt_id: Option<String>,
    pub request_id: Option<String>,
    pub model: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub reply_preview: Option<String>,
    pub error: Option<String>,
    pub failure_stage: Option<String>,
    pub merged_into_trigger_id: Option<String>,
}

impl CronFire {
    pub fn trigger_id(&self) -> String {
        format!("cron:{}:{}", self.id, self.scheduled_at.to_rfc3339())
    }
    pub fn execution_thread_request_id(&self) -> String {
        format!("kcoder-automation-thread:{}", self.trigger_id())
    }
    pub fn execution_turn_request_id(&self) -> String {
        format!("kcoder-automation-turn:{}", self.trigger_id())
    }
}

pub(super) fn pending(event: &CronFire) -> ExecutionRecord {
    ExecutionRecord {
        trigger_id: event.trigger_id(),
        title: event
            .prompt
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(80)
            .collect(),
        coalesced: event.coalesced,
        schedule: None,
        status: "waiting".into(),
        workspace_path: None,
        thread_id: None,
        turn_id: None,
        attempt_id: None,
        request_id: None,
        model: None,
        started_at: None,
        finished_at: None,
        reply_preview: None,
        error: None,
        failure_stage: None,
        merged_into_trigger_id: None,
    }
}

fn terminal(status: &str) -> bool {
    matches!(
        status,
        "succeeded" | "failed" | "interrupted" | "coalesced" | "expired"
    )
}

impl CronScheduler {
    fn execution_storage_result<T>(&self, result: Result<T, String>) -> Result<T, String> {
        result.inspect_err(|_| {
            self.0
                .execution_uncertain
                .store(true, std::sync::atomic::Ordering::Release);
        })
    }

    fn update_execution<T>(
        &self,
        update: impl FnOnce(&mut CronFile) -> Result<T, String>,
    ) -> Result<T, String> {
        let started = std::time::Instant::now();
        let _lock = loop {
            match lock_jobs(&self.0.path) {
                Ok(lock) => break lock,
                Err(error)
                    if error.starts_with("cron store is busy:")
                        && started.elapsed() < Duration::from_secs(2) =>
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => return self.execution_storage_result(Err(error)),
            }
        };
        let mut file = self.execution_storage_result(
            read_cron_file(&self.0.path)
                .and_then(|file| file.ok_or_else(|| "cron receipt store missing".into())),
        )?;
        let before = file
            .receipts
            .iter()
            .filter_map(|receipt| receipt.execution.as_ref())
            .map(|run| (run.trigger_id.clone(), run.status.clone()))
            .collect::<HashMap<_, _>>();
        // Validation refusals do not make an already-running attempt's evidence uncertain.
        let value = update(&mut file)?;
        self.execution_storage_result(persist_cron_file(&self.0.path, &file))?;
        for receipt in &file.receipts {
            if let Some(run) = &receipt.execution
                && before.get(&run.trigger_id) != Some(&run.status)
            {
                tracing::info!(trigger_id = %run.trigger_id, job_id = %receipt.job_id,
                    thread_id = ?run.thread_id, turn_id = ?run.turn_id, attempt_id = ?run.attempt_id,
                    status = %run.status, "automation execution evidence committed");
            }
        }
        Ok(value)
    }

    /// Claim before creating any thread. Existing or stale-owner claims never replay.
    pub fn begin_execution(&self, event: &CronFire, workspace: &Path) -> Result<bool, String> {
        let workspace = std::path::absolute(workspace).map_err(|error| error.to_string())?;
        self.update_execution(|file| {
            let receipt = file
                .receipts
                .iter_mut()
                .find(|receipt| {
                    receipt.job_id == event.id
                        && receipt.scheduled_at == event.scheduled_at
                        && receipt.session_id == event.session_id
                })
                .ok_or("automation trigger receipt missing")?;
            if receipt.owner_instance != self.0.owner_instance {
                return Ok(false);
            }
            let run = receipt
                .execution
                .as_mut()
                .ok_or("automation execution receipt missing")?;
            if run.status != "waiting" {
                return Ok(false);
            }
            run.status = "creating_thread".into();
            run.coalesced = run.coalesced.max(event.coalesced);
            run.workspace_path = Some(workspace.to_string_lossy().into_owned());
            run.request_id = Some(event.execution_thread_request_id());
            Ok(true)
        })
    }

    /// Merge only waiting triggers. Both receipts remain discoverable.
    pub fn coalesce_execution(&self, retained: &CronFire, merged: &CronFire) -> Result<(), String> {
        self.update_execution(|file| {
            let target = retained.trigger_id();
            let source = merged.trigger_id();
            if target == source {
                return Ok(());
            }
            let record = file
                .receipts
                .iter_mut()
                .filter_map(|r| r.execution.as_mut())
                .find(|r| r.trigger_id == source)
                .ok_or("merged execution receipt missing")?;
            if record.merged_into_trigger_id.as_deref() == Some(&target) {
                return Ok(());
            }
            if record.status != "waiting" {
                return Err("only waiting triggers may coalesce".into());
            }
            record.status = "coalesced".into();
            record.merged_into_trigger_id = Some(target.clone());
            record.finished_at = Some(Utc::now());
            let record = file
                .receipts
                .iter_mut()
                .filter_map(|r| r.execution.as_mut())
                .find(|r| r.trigger_id == target)
                .ok_or("retained execution receipt missing")?;
            if record.status != "waiting" {
                return Err("retained trigger has already started".into());
            }
            record.coalesced = record
                .coalesced
                .saturating_add(merged.coalesced)
                .saturating_add(1);
            Ok(())
        })
    }

    /// Recover a completed creation receipt's conversation link only. This never queues a turn.
    pub fn execution_reconcile_created_thread(
        &self,
        trigger: &str,
        thread: &str,
    ) -> Result<bool, String> {
        self.update_execution(|file| {
            let Some(run) = file
                .receipts
                .iter_mut()
                .filter_map(|r| r.execution.as_mut())
                .find(|r| r.trigger_id == trigger)
            else {
                return Ok(false);
            };
            if run.status != "creating_thread" || run.thread_id.is_some() {
                return Ok(false);
            }
            run.thread_id = Some(thread.into());
            Ok(true)
        })
    }

    pub fn execution_thread_created(
        &self,
        event: &CronFire,
        thread: &str,
        request: &str,
    ) -> Result<(), String> {
        self.update_execution(|file| {
            let run = file
                .receipts
                .iter_mut()
                .filter_map(|r| r.execution.as_mut())
                .find(|r| r.trigger_id == event.trigger_id())
                .ok_or("execution claim missing")?;
            if run.status != "creating_thread" {
                return Err("execution is not awaiting thread creation".into());
            }
            run.thread_id = Some(thread.into());
            run.request_id = Some(request.into());
            run.status = "starting_turn".into();
            Ok(())
        })
    }

    /// Returns false for an unrelated manual turn. A mismatched identity refuses dispatch.
    pub fn execution_accepted(
        &self,
        request: &str,
        thread: &str,
        turn: &str,
        attempt: &str,
        model: Option<&str>,
    ) -> Result<bool, String> {
        self.update_execution(|file| {
            let Some(run) = file
                .receipts
                .iter_mut()
                .filter_map(|r| r.execution.as_mut())
                .find(|r| r.request_id.as_deref() == Some(request))
            else {
                return Ok(false);
            };
            if run.status != "starting_turn" || run.thread_id.as_deref() != Some(thread) {
                return Err("automation execution identity already accepted or mismatched".into());
            }
            run.turn_id = Some(turn.into());
            run.attempt_id = Some(attempt.into());
            run.model = model.map(|s| s.chars().take(256).collect());
            run.status = "running".into();
            run.started_at = Some(Utc::now());
            Ok(true)
        })
    }

    pub fn execution_request_failed(
        &self,
        request: &str,
        stage: &str,
        error: &str,
    ) -> Result<bool, String> {
        self.update_execution(|file| {
            let Some(run) = file
                .receipts
                .iter_mut()
                .filter_map(|r| r.execution.as_mut())
                .find(|r| r.request_id.as_deref() == Some(request))
            else {
                return Ok(false);
            };
            if terminal(&run.status) || run.status == "running" {
                return Ok(false);
            }
            run.status = "failed".into();
            run.failure_stage = Some(stage.chars().take(80).collect());
            run.error = Some(error.chars().take(2048).collect());
            run.finished_at = Some(Utc::now());
            Ok(true)
        })
    }

    /// Call only with persisted attempt/transcript evidence; a bare "completed" is insufficient.
    pub fn execution_finished(
        &self,
        thread: &str,
        turn: &str,
        attempt: &str,
        status: &str,
        reply: &str,
        error: Option<&str>,
    ) -> Result<bool, String> {
        self.execution_finished_at(thread, turn, attempt, status, reply, error, Utc::now())
    }

    /// Reconciliation retains the actual persisted completion time, never the read time.
    #[expect(
        clippy::too_many_arguments,
        reason = "Explicit attempt identity and persisted evidence"
    )]
    pub fn execution_finished_at(
        &self,
        thread: &str,
        turn: &str,
        attempt: &str,
        status: &str,
        reply: &str,
        error: Option<&str>,
        finished_at: DateTime<Utc>,
    ) -> Result<bool, String> {
        self.update_execution(|file| {
            let Some(run) = file
                .receipts
                .iter_mut()
                .filter_map(|r| r.execution.as_mut())
                .find(|r| {
                    r.thread_id.as_deref() == Some(thread)
                        && r.turn_id.as_deref() == Some(turn)
                        && r.attempt_id.as_deref() == Some(attempt)
                })
            else {
                return Ok(false);
            };
            if terminal(&run.status) {
                return Ok(false);
            }
            run.status = match status {
                "completed" if !reply.trim().is_empty() => "succeeded",
                "completed" | "failed" => "failed",
                "interrupted" => "interrupted",
                _ => return Err("invalid execution terminal status".into()),
            }
            .into();
            run.reply_preview =
                (!reply.trim().is_empty()).then(|| reply.chars().take(2048).collect());
            run.error = error.map(|s| s.chars().take(2048).collect()).or_else(|| {
                (status == "completed" && reply.trim().is_empty()).then(|| "empty_reply".into())
            });
            run.failure_stage = (run.status != "succeeded").then(|| "execution".into());
            run.finished_at = Some(finished_at);
            Ok(true)
        })
    }

    /// Bounded fair read batches prevent permanently-unknown rows starving older evidence.
    pub fn execution_reconciliation_candidates(
        &self,
        owner: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Value>, String> {
        let diagnostics = self.execution_diagnostics(owner)?;
        let candidates = diagnostics["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|run| matches!(run["status"].as_str(), Some("unknown" | "running")))
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 64).min(candidates.len());
        let start = self
            .0
            .execution_reconcile_cursor
            .fetch_add(limit, std::sync::atomic::Ordering::Relaxed)
            % candidates.len();
        Ok((0..limit)
            .map(|offset| candidates[(start + offset) % candidates.len()].clone())
            .collect())
    }

    pub fn execution_diagnostics(&self, owner: Option<&str>) -> Result<Value, String> {
        let file = read_cron_file(&self.0.path)?.unwrap_or_default();
        let runs = file.receipts.iter().rev().filter(|r| r.session_id.as_deref() == owner)
            .map(|receipt| {
                let mut row = match receipt.execution.as_ref() {
                    Some(run) => serde_json::to_value(run).map_err(|error| error.to_string())?,
                    None => serde_json::json!({"triggerId":format!("cron:{}:{}", receipt.job_id, receipt.scheduled_at.to_rfc3339()), "status":"unknown"}),
                };
                if (receipt.owner_instance != self.0.owner_instance
                    || self.0.execution_uncertain.load(std::sync::atomic::Ordering::Acquire))
                    && !terminal(row["status"].as_str().unwrap_or("unknown")) {
                    row["lastRecordedStatus"] = row["status"].clone();
                    row["status"] = Value::String("unknown".into());
                }
                row["jobId"] = Value::String(receipt.job_id.clone());
                row["scheduledAt"] = serde_json::json!(receipt.scheduled_at);
                row["recordedAt"] = serde_json::json!(receipt.recorded_at);
                row["deliveryConfirmed"] = serde_json::json!(matches!(receipt.phase, delivery::Phase::DeliveredToSubscriber));
                row["automaticReplay"] = Value::Bool(false);
                Ok(row)
            }).collect::<Result<Vec<_>, String>>()?;
        Ok(
            serde_json::json!({"runs":runs,"automaticReplay":false,"serviceRequired":true,
            "offlinePolicy":"wait-for-host-and-service; coalesce-missed; expire-after-seven-days"}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn due_fixture() -> (tempfile::TempDir, CronScheduler, CronFire) {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let _subscription = scheduler.subscribe_session(APP_PROJECT_CRON_OWNER.into());
        let job = scheduler
            .create_for_session(
                APP_PROJECT_CRON_OWNER.into(),
                "fixture task".into(),
                CronSchedule::At {
                    at: (Utc::now() + ChronoDuration::seconds(60)).to_rfc3339(),
                },
                Some(0),
            )
            .unwrap();
        scheduler.fire_due(job.next_run_at);
        let event = CronFire {
            session_id: Some(APP_PROJECT_CRON_OWNER.into()),
            id: job.id,
            prompt: job.prompt,
            scheduled_at: job.next_run_at,
            coalesced: 0,
        };
        (root, scheduler, event)
    }

    fn first(scheduler: &CronScheduler) -> Value {
        scheduler
            .execution_diagnostics(Some(APP_PROJECT_CRON_OWNER))
            .unwrap()["runs"][0]
            .clone()
    }

    #[test]
    fn delivered_one_shot_is_not_success_and_claim_is_deduplicated_across_restart() {
        let (root, scheduler, event) = due_fixture();
        scheduler.acknowledge_delivery(&event).unwrap();
        assert!(
            scheduler
                .list_for_session(APP_PROJECT_CRON_OWNER)
                .unwrap()
                .is_empty()
        );
        assert_eq!(first(&scheduler)["status"], "waiting");
        assert_eq!(first(&scheduler)["deliveryConfirmed"], true);
        assert!(
            scheduler
                .begin_execution(&event, Path::new("/fixture"))
                .unwrap()
        );
        assert!(
            !scheduler
                .begin_execution(&event, Path::new("/fixture"))
                .unwrap()
        );
        let restarted = CronScheduler::load(root.path());
        assert_eq!(first(&restarted)["status"], "unknown");
        assert_eq!(first(&restarted)["lastRecordedStatus"], "creating_thread");
        assert_eq!(first(&restarted)["automaticReplay"], false);
        assert!(
            !restarted
                .begin_execution(&event, Path::new("/fixture"))
                .unwrap()
        );
        assert!(
            restarted
                .execution_diagnostics(Some("different-owner"))
                .unwrap()["runs"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn empty_thread_and_empty_completed_reply_are_not_success() {
        let (_root, scheduler, event) = due_fixture();
        scheduler
            .begin_execution(&event, Path::new("/fixture"))
            .unwrap();
        let request = event.execution_turn_request_id();
        scheduler
            .execution_thread_created(&event, "thread", &request)
            .unwrap();
        assert_eq!(first(&scheduler)["status"], "starting_turn");
        assert!(
            !scheduler
                .execution_finished("thread", "turn", "attempt", "completed", "reply", None)
                .unwrap()
        );
        assert!(
            scheduler
                .execution_accepted(
                    &request,
                    "thread",
                    "turn",
                    "attempt",
                    Some("provider/model")
                )
                .unwrap()
        );
        assert!(
            scheduler
                .execution_accepted(&request, "thread", "turn", "attempt", None)
                .is_err()
        );
        assert_eq!(first(&scheduler)["status"], "running");
        assert!(
            !scheduler
                .execution_finished(
                    "thread",
                    "turn",
                    "wrong-attempt",
                    "completed",
                    "reply",
                    None
                )
                .unwrap()
        );
        scheduler
            .execution_finished("thread", "turn", "attempt", "completed", " \n", None)
            .unwrap();
        let run = first(&scheduler);
        assert_eq!(run["status"], "failed");
        assert_eq!(run["error"], "empty_reply");
        assert_eq!(run["model"], "provider/model");
    }

    #[test]
    fn actual_reply_is_correlated_and_startup_failure_keeps_thread_link() {
        let (_root, scheduler, event) = due_fixture();
        scheduler
            .begin_execution(&event, Path::new("/fixture"))
            .unwrap();
        let request = event.execution_turn_request_id();
        scheduler
            .execution_thread_created(&event, "thread", &request)
            .unwrap();
        scheduler
            .execution_request_failed(&request, "turn_start", "provider unavailable")
            .unwrap();
        assert_eq!(first(&scheduler)["status"], "failed");
        assert_eq!(first(&scheduler)["threadId"], "thread");
        assert_eq!(first(&scheduler)["failureStage"], "turn_start");
        assert!(
            !scheduler
                .begin_execution(&event, Path::new("/fixture"))
                .unwrap()
        );
        let (root, scheduler, event) = due_fixture();
        scheduler
            .begin_execution(&event, Path::new("/fixture"))
            .unwrap();
        let request = event.execution_turn_request_id();
        scheduler
            .execution_thread_created(&event, "thread", &request)
            .unwrap();
        scheduler
            .execution_accepted(&request, "thread", "turn-1", "turn-1", None)
            .unwrap();
        scheduler
            .execution_finished(
                "thread",
                "turn-1",
                "turn-1",
                "completed",
                "Actual assistant response",
                None,
            )
            .unwrap();
        let restarted = CronScheduler::load(root.path());
        let run = first(&restarted);
        assert_eq!(run["status"], "succeeded");
        assert_eq!(run["replyPreview"], "Actual assistant response");
        assert_eq!(run["triggerId"], event.trigger_id());
        assert!(
            !restarted
                .delete_for_session(&event.id, APP_PROJECT_CRON_OWNER)
                .unwrap()
        );
        assert_eq!(first(&restarted)["status"], "succeeded");
    }

    #[test]
    fn unfinished_confirmed_receipts_survive_retention_and_explicit_cleanup_is_separate() {
        let (_root, scheduler, event) = due_fixture();
        scheduler.acknowledge_delivery(&event).unwrap();
        let mut file = read_cron_file(&scheduler.0.path).unwrap().unwrap();
        file.receipts[0].recorded_at = Utc::now() - ChronoDuration::days(90);
        delivery::retain_confirmed(&mut file, Utc::now());
        assert_eq!(file.receipts.len(), 1);
        persist_cron_file(&scheduler.0.path, &file).unwrap();
        assert!(
            !scheduler
                .delete_for_session(&event.id, APP_PROJECT_CRON_OWNER)
                .unwrap()
        );
        assert!(
            scheduler
                .clear_delivery_receipts(&event.id, Some(APP_PROJECT_CRON_OWNER))
                .unwrap()
        );
        assert!(
            scheduler
                .execution_diagnostics(Some(APP_PROJECT_CRON_OWNER))
                .unwrap()["runs"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn waiting_triggers_merge_without_losing_original_identity_or_replaying() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let _subscription = scheduler.subscribe_session(APP_PROJECT_CRON_OWNER.into());
        let job = scheduler
            .create_for_session(
                APP_PROJECT_CRON_OWNER.into(),
                "fixture".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        scheduler.fire_due(job.next_run_at);
        let retained = CronFire {
            session_id: Some(APP_PROJECT_CRON_OWNER.into()),
            id: job.id.clone(),
            prompt: job.prompt.clone(),
            scheduled_at: job.next_run_at,
            coalesced: 0,
        };
        let next = scheduler.list_for_session(APP_PROJECT_CRON_OWNER).unwrap()[0].next_run_at;
        scheduler.fire_due(next);
        let merged = CronFire {
            scheduled_at: next,
            ..retained.clone()
        };
        scheduler.coalesce_execution(&retained, &merged).unwrap();
        scheduler.coalesce_execution(&retained, &merged).unwrap();
        let runs = scheduler
            .execution_diagnostics(Some(APP_PROJECT_CRON_OWNER))
            .unwrap()["runs"]
            .clone();
        assert_eq!(runs[0]["status"], "coalesced");
        assert_eq!(runs[0]["mergedIntoTriggerId"], retained.trigger_id());
        assert_eq!(runs[1]["coalesced"], 1);
        assert!(
            !scheduler
                .begin_execution(&merged, Path::new("/fixture"))
                .unwrap()
        );
        assert!(
            scheduler
                .begin_execution(&retained, Path::new("/fixture"))
                .unwrap()
        );
    }

    #[test]
    fn legacy_v3_receipt_migrates_as_unknown_with_exact_backup_and_no_replay() {
        let (root, scheduler, _event) = due_fixture();
        let mut file = read_cron_file(&scheduler.0.path).unwrap().unwrap();
        file.version = 3;
        file.receipts[0].execution = None;
        let bytes = serde_json::to_vec(&file).unwrap();
        fs::write(&scheduler.0.path, &bytes).unwrap();
        assert_eq!(first(&scheduler)["status"], "unknown");
        scheduler
            .create(
                "other fixture".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        assert_eq!(
            fs::read(
                scheduler
                    .0
                    .path
                    .with_file_name("jobs.before-execution-v4.json")
            )
            .unwrap(),
            bytes
        );
        assert_eq!(
            read_cron_file(&scheduler.0.path).unwrap().unwrap().version,
            4
        );
        let restarted = CronScheduler::load(root.path());
        assert_eq!(first(&restarted)["status"], "unknown");
    }
    #[test]
    fn overdue_project_schedule_expires_with_visible_evidence_and_no_dispatch() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let mut subscription = scheduler.subscribe_session(APP_PROJECT_CRON_OWNER.into());
        let job = scheduler
            .create_for_session(
                APP_PROJECT_CRON_OWNER.into(),
                "fixture".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        let mut file = read_cron_file(&scheduler.0.path).unwrap().unwrap();
        file.jobs[0].next_run_at = Utc::now() - ChronoDuration::days(8);
        persist_cron_file(&scheduler.0.path, &file).unwrap();
        scheduler.fire_due(Utc::now());
        assert!(subscription.receiver.try_recv().is_err());
        assert!(
            scheduler
                .list_for_session(APP_PROJECT_CRON_OWNER)
                .unwrap()
                .is_empty()
        );
        let run = first(&scheduler);
        assert_eq!(run["jobId"], job.id);
        assert_eq!(run["status"], "expired");
        assert_eq!(run["deliveryConfirmed"], false);
        assert_eq!(run["schedule"]["kind"], "every");
        assert_eq!(run["automaticReplay"], false);
    }
    #[test]
    fn restored_creation_link_does_not_start_or_replay_unknown_work() {
        let (root, scheduler, event) = due_fixture();
        scheduler
            .begin_execution(&event, Path::new("/fixture"))
            .unwrap();
        let restarted = CronScheduler::load(root.path());
        assert!(
            restarted
                .execution_reconcile_created_thread(&event.trigger_id(), "created-thread")
                .unwrap()
        );
        let run = first(&restarted);
        assert_eq!(run["status"], "unknown");
        assert_eq!(run["threadId"], "created-thread");
        assert_eq!(run["turnId"], Value::Null);
        assert_eq!(run["automaticReplay"], false);
        assert!(
            !restarted
                .begin_execution(&event, Path::new("/fixture"))
                .unwrap()
        );
    }
    #[test]
    fn bounded_reconciliation_visits_older_unknown_records_without_starvation() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let _subscription = scheduler.subscribe_session(APP_PROJECT_CRON_OWNER.into());
        scheduler
            .create_for_session(
                APP_PROJECT_CRON_OWNER.into(),
                "fixture".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        for _ in 0..32 {
            let due = scheduler.list_for_session(APP_PROJECT_CRON_OWNER).unwrap()[0].next_run_at;
            scheduler.fire_due(due);
        }
        let restarted = CronScheduler::load(root.path());
        let first = restarted
            .execution_reconciliation_candidates(Some(APP_PROJECT_CRON_OWNER), 16)
            .unwrap();
        let second = restarted
            .execution_reconciliation_candidates(Some(APP_PROJECT_CRON_OWNER), 16)
            .unwrap();
        assert_eq!(first.len(), 16);
        assert_eq!(second.len(), 16);
        let ids = first
            .into_iter()
            .chain(second)
            .map(|run| run["triggerId"].as_str().unwrap().to_owned())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 32);
        assert!(
            restarted
                .execution_reconciliation_candidates(Some("other-owner"), 16)
                .unwrap()
                .is_empty()
        );
    }
}
