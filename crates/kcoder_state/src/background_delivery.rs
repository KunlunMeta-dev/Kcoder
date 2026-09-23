//! Durable run-scoped terminal delivery. Lock order is session persistence, inner,
//! then history source mutation. No State lock is held while awaiting the flusher.
use super::*;
use kcoder_types::{BackgroundEventIdentity, BackgroundRunKey};

pub const MAX_BACKGROUND_RUNS_PER_TASK: usize = 256;
pub const MAX_BACKGROUND_TASK_IDENTITIES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundHookReceipt {
    #[serde(default = "default_hook_claimed")]
    pub claimed: bool,
    pub completed: bool,
}

fn default_hook_claimed() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundRunRecord {
    pub key: BackgroundRunKey,
    #[serde(default)]
    pub run_started_at_ms: Option<u64>,
    pub status: TaskStatus,
    pub terminal: Option<BackgroundEventIdentity>,
    pub output_path: Option<PathBuf>,
    pub output_snapshot: Option<String>,
    pub delivery: TaskDelivery,
    pub notification_message_id: Option<String>,
    pub delivered_message_id: Option<String>,
    #[serde(default)]
    pub pending_result_message_id: Option<String>,
    #[serde(default)]
    pub suppressed: bool,
    #[serde(default)]
    pub legacy_uncertain: bool,
    #[serde(default)]
    pub imported_history: bool,
    #[serde(default)]
    pub hook_claimed: bool,
    #[serde(default)]
    pub hook_completed: bool,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub hook_executions: HashMap<String, BackgroundHookReceipt>,
    #[serde(default)]
    pub hooks_prepared: bool,
    #[serde(default)]
    pub followup_turn_id: Option<String>,
    #[serde(default)]
    pub followup_started: bool,
    #[serde(default)]
    pub followup_handled: bool,
}

impl BackgroundRunRecord {
    pub fn has_pending_hooks(&self) -> bool {
        !self.suppressed
            && ((!self.hooks_prepared && !self.hook_claimed)
                || self
                    .hook_executions
                    .values()
                    .any(|receipt| !receipt.claimed))
    }
}

/// Legacy ownership without a provable run timestamp is retained for diagnostics,
/// but cannot schedule a surprise notification or execute old hooks.
pub(super) fn migrate_legacy_background_run(task: &mut Task, parent_session_id: &str) {
    if task.background_run.is_some()
        || !task.background_runs.is_empty()
        || !(task.managed || matches!(task.kind, TaskKind::Subagent | TaskKind::Workflow))
    {
        return;
    }
    use sha2::Digest;
    let stable = format!(
        "{}\0{}\0{}",
        parent_session_id,
        task.id,
        task.run_started_at_ms.unwrap_or(task.created_at_ms)
    );
    let key = BackgroundRunKey {
        parent_session_id: parent_session_id.to_owned(),
        agent_id: task.id.clone(),
        run_id: format!("legacy-{:x}", sha2::Sha256::digest(stable.as_bytes())),
    };
    // Old terminal markers were best-effort and carry no committed history UUID.
    // Conservatively require an explicit result read rather than replay a possibly
    // already delivered completion during upgrade.
    let uncertain = matches!(
        task.status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Halted
    ) || task.run_started_at_ms.is_none_or(|value| value == 0)
        || task
            .parent_session_id
            .as_deref()
            .is_some_and(|id| id != parent_session_id);
    let delivered = task
        .notification_injected_at_ms
        .zip(task.run_started_at_ms)
        .is_some_and(|(delivered, start)| delivered >= start);
    let terminal = matches!(
        task.status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Halted
    )
    .then(|| BackgroundEventIdentity::terminal(key.clone()));
    task.background_runs.push(BackgroundRunRecord {
        key: key.clone(),
        run_started_at_ms: task.run_started_at_ms,
        status: task.status,
        terminal,
        output_path: task.output_path.clone(),
        output_snapshot: task
            .output
            .as_ref()
            .map(|value| value.chars().take(65_536).collect()),
        delivery: task.delivery,
        notification_message_id: None,
        delivered_message_id: delivered.then(|| format!("{}:legacy-delivered", key.run_id)),
        pending_result_message_id: None,
        suppressed: uncertain,
        legacy_uncertain: uncertain,
        imported_history: false,
        hook_claimed: delivered || uncertain,
        hook_completed: delivered,
        hook_executions: HashMap::new(),
        hooks_prepared: false,
        followup_turn_id: None,
        followup_started: false,
        followup_handled: delivered || uncertain,
    });
    task.background_run = Some(key);
}

impl AppState {
    /// Re-read authority under the cross-process source lock before changing a run.
    fn transact_background<R>(
        &self,
        id: &str,
        update: impl FnOnce(&mut Task) -> anyhow::Result<R>,
    ) -> anyhow::Result<R> {
        self.transact_background_with_initial(id, None, update)
    }

    fn transact_background_with_initial<R>(
        &self,
        id: &str,
        initial: Option<Task>,
        update: impl FnOnce(&mut Task) -> anyhow::Result<R>,
    ) -> anyhow::Result<R> {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        let mut task = inner
            .tasks
            .get(id)
            .cloned()
            .or(initial)
            .context("background task missing")?;
        let mut update = Some(update);
        let mut result = None;
        if let Some(path) = inner.session_state_path.as_ref() {
            let source = inner
                .history_source
                .as_ref()
                .context("background state has no bound history source")?;
            source.write_metadata(path, || {
                let mut state = load_session_state(path)?;
                anyhow::ensure!(
                    !state.background_tombstones.contains_key(id),
                    "background task was deleted"
                );
                if let Some(stored) = state.tasks.get(id) {
                    task = stored.clone();
                }
                if task.background_runs.is_empty() {
                    anyhow::ensure!(
                        state.background_tombstones.len()
                            + state
                                .tasks
                                .values()
                                .filter(|task| !task.background_runs.is_empty())
                                .count()
                            < MAX_BACKGROUND_TASK_IDENTITIES,
                        "background session identity capacity reached (4096); archive this conversation and start a new session; delivery receipts are retained to prevent duplicate notifications"
                    );
                }
                result = Some(update.take().unwrap()(&mut task)?);
                state.tasks.insert(id.to_owned(), task.clone());
                prepare_session_state_write(path, &state)
            })?;
        } else {
            result = Some(update.take().unwrap()(&mut task)?);
        }
        inner.tasks.insert(id.to_owned(), task);
        result.context("background transaction did not execute")
    }

    pub(super) fn remove_task_with_background_tombstone(&self, id: &str) -> anyhow::Result<bool> {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        let Some(task) = inner.tasks.get(id).cloned() else {
            return Ok(false);
        };
        if let Some(path) = inner.session_state_path.as_ref() {
            let source = inner
                .history_source
                .as_ref()
                .context("background state has no bound history source")?;
            source.write_metadata(path, || {
                let mut state = load_session_state(path)?;
                let mut records = state.tasks.remove(id).unwrap_or(task).background_runs;
                for record in &mut records {
                    record.suppressed = true;
                    record.output_snapshot = None;
                    record.output_path = None;
                }
                if !records.is_empty() {
                    state.background_tombstones.insert(id.to_owned(), records);
                }
                prepare_session_state_write(path, &state)
            })?;
        }
        inner.tasks.remove(id);
        Ok(true)
    }

    pub fn begin_background_run(&self, id: &str) -> anyhow::Result<BackgroundRunKey> {
        let key = BackgroundRunKey {
            parent_session_id: self.session_id(),
            agent_id: id.to_owned(),
            run_id: uuid::Uuid::new_v4().to_string(),
        };
        self.transact_background(id, |task| Self::initialize_background_run(task, key))
    }

    fn initialize_background_run(
        task: &mut Task,
        key: BackgroundRunKey,
    ) -> anyhow::Result<BackgroundRunKey> {
        if let Some(previous) = task.background_run.as_ref().and_then(|key| {
            task.background_runs
                .iter_mut()
                .find(|record| &record.key == key)
        }) {
            anyhow::ensure!(
                !previous.imported_history,
                "imported background tasks are history only; spawn a new agent"
            );
            anyhow::ensure!(
                previous.terminal.is_some() || matches!(task.status, TaskStatus::Paused),
                "previous background run has no durable terminal"
            );
            if previous.terminal.is_none() {
                previous.status = TaskStatus::Paused;
                previous.suppressed = true;
            }
        }
        anyhow::ensure!(
            task.background_runs.len() < MAX_BACKGROUND_RUNS_PER_TASK,
            "background run retention capacity reached (256); start a new agent to continue; retained delivery receipts cannot be safely discarded"
        );
        task.background_runs.push(BackgroundRunRecord {
            key: key.clone(),
            run_started_at_ms: task.run_started_at_ms.or_else(|| Some(now_millis())),
            status: TaskStatus::Running,
            terminal: None,
            output_path: None,
            output_snapshot: None,
            delivery: task.delivery,
            notification_message_id: None,
            delivered_message_id: None,
            pending_result_message_id: None,
            suppressed: false,
            legacy_uncertain: false,
            imported_history: false,
            hook_claimed: false,
            hook_completed: false,
            hook_executions: HashMap::new(),
            hooks_prepared: false,
            followup_turn_id: None,
            followup_started: false,
            followup_handled: false,
        });
        task.background_run = Some(key.clone());
        task.notification_injected_at_ms = None;
        Ok(key)
    }

    /// Atomically admit a new task/continuation and allocate its durable run identity.
    pub fn start_background_task_run(&self, mut task: Task) -> anyhow::Result<BackgroundRunKey> {
        let id = task.id.clone();
        let key = BackgroundRunKey {
            parent_session_id: self.session_id(),
            agent_id: id.clone(),
            run_id: uuid::Uuid::new_v4().to_string(),
        };
        self.transact_background_with_initial(&id, Some(task.clone()), |existing| {
            task.background_run = existing.background_run.clone();
            task.background_runs = existing.background_runs.clone();
            task.pending_messages = existing.pending_messages.clone();
            task.message_queue = existing.message_queue.clone();
            task.dead_letter_messages = existing.dead_letter_messages.clone();
            task.control = existing.control.clone();
            task.breaker = existing.breaker.clone();
            task.status = existing.status;
            let key = Self::initialize_background_run(&mut task, key)?;
            task.status = TaskStatus::Running;
            *existing = task;
            Ok(key)
        })
    }

    pub fn background_run_record(&self, key: &BackgroundRunKey) -> Option<BackgroundRunRecord> {
        if key.parent_session_id != self.session_id() {
            return None;
        }
        self.task(&key.agent_id)?
            .background_runs
            .into_iter()
            .find(|record| &record.key == key)
    }

    pub fn task_for_background_run(&self, key: &BackgroundRunKey) -> Option<Task> {
        let record = self.background_run_record(key)?;
        let mut task = self.task(&key.agent_id)?;
        if task.background_run.as_ref() == Some(key) && record.terminal.is_none() {
            if matches!(
                task.status,
                TaskStatus::Completed
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
                    | TaskStatus::Halted
            ) {
                // Producers may publish a legacy task snapshot before committing the
                // run outbox. Readers cannot consume that uncommitted terminal yet.
                task.status = record.status;
            }
            return Some(task);
        }
        if task.background_run.as_ref() != Some(key) {
            // Never attach a later execution's validation evidence to an old result.
            task.artifact_validation_report = None;
            task.artifact_validation_run = None;
            task.review_vote_summary = None;
        }
        task.background_run = Some(key.clone());
        task.run_started_at_ms = record.run_started_at_ms;
        task.status = record.status;
        task.output = record.output_snapshot;
        task.output_path = record.output_path;
        task.delivery = record.delivery;
        Some(task)
    }

    /// The first durable terminal wins; replays preserve its event identity and result.
    pub fn commit_background_terminal(
        &self,
        event: &BackgroundEventIdentity,
        status: TaskStatus,
        output_path: Option<PathBuf>,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            event.run.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        anyhow::ensure!(
            matches!(
                status,
                TaskStatus::Completed
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
                    | TaskStatus::Halted
            ),
            "background status is not terminal"
        );
        self.transact_background(&event.run.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| record.key == event.run)
                .context("unknown background run")?;
            if let Some(existing) = &record.terminal {
                anyhow::ensure!(
                    existing == event
                        && record.status == status
                        && record.output_path == output_path,
                    "conflicting background terminal"
                );
                return Ok(false);
            }
            anyhow::ensure!(
                task.background_run.as_ref() == Some(&event.run),
                "cannot freeze current output for a stale background run"
            );
            record.status = status;
            record.terminal = Some(event.clone());
            record.output_path = output_path;
            record.output_snapshot = task
                .output
                .as_ref()
                .map(|text| text.chars().take(65_536).collect());
            record.delivery = task.delivery;
            task.status = status;
            task.updated_at_ms = now_millis();
            Ok(true)
        })
    }

    pub fn pending_background_terminals(&self) -> Vec<BackgroundRunRecord> {
        let parent = self.session_id();
        self.tasks()
            .into_values()
            .flat_map(|task| task.background_runs)
            .filter(|record| {
                record.key.parent_session_id == parent
                    && record.terminal.is_some()
                    && record.delivered_message_id.is_none()
                    && !record.suppressed
            })
            .collect()
    }

    /// Repeated handoff never clears a terminal receipt or allocates another identity.
    pub fn promote_background_run(&self, key: &BackgroundRunKey) -> anyhow::Result<bool> {
        anyhow::ensure!(
            key.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        self.transact_background(&key.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| &record.key == key)
                .context("unknown background run")?;
            if record.delivery == TaskDelivery::Background {
                return Ok(false);
            }
            record.delivery = TaskDelivery::Background;
            if task.background_run.as_ref() == Some(key) {
                task.delivery = TaskDelivery::Background;
            }
            Ok(true)
        })
    }

    pub fn suppress_background_run(&self, key: &BackgroundRunKey) -> anyhow::Result<()> {
        anyhow::ensure!(
            key.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        self.transact_background(&key.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| &record.key == key)
                .context("unknown background run")?;
            record.suppressed = true;
            Ok(())
        })
    }

    /// Freeze the eligible hook identities before any external hook starts.
    pub fn prepare_background_hook_executions(
        &self,
        key: &BackgroundRunKey,
        hook_ids: &[String],
    ) -> anyhow::Result<Vec<String>> {
        anyhow::ensure!(
            key.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        anyhow::ensure!(
            hook_ids.len() <= 256 && hook_ids.iter().all(|id| !id.is_empty() && id.len() <= 256),
            "invalid background hook identity set"
        );
        self.transact_background(&key.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| &record.key == key)
                .context("unknown background run")?;
            anyhow::ensure!(record.terminal.is_some(), "background run is not terminal");
            if record.suppressed || (record.hook_claimed && record.hook_executions.is_empty()) {
                return Ok(Vec::new());
            }
            if !record.hooks_prepared {
                for id in hook_ids {
                    record
                        .hook_executions
                        .entry(id.clone())
                        .or_insert(BackgroundHookReceipt {
                            claimed: false,
                            completed: false,
                        });
                }
                record.hooks_prepared = true;
            }
            let mut pending: Vec<_> = record
                .hook_executions
                .iter()
                .filter(|(_, receipt)| !receipt.claimed)
                .map(|(id, _)| id.clone())
                .collect();
            pending.sort();
            Ok(pending)
        })
    }

    /// Return the frozen full set, including completed and uncertain entries.
    pub fn prepare_background_hooks(
        &self,
        key: &BackgroundRunKey,
        hook_ids: &[String],
    ) -> anyhow::Result<Vec<String>> {
        self.prepare_background_hook_executions(key, hook_ids)?;
        let record = self
            .background_run_record(key)
            .context("unknown background run")?;
        let mut ids: Vec<_> = record.hook_executions.keys().cloned().collect();
        ids.sort();
        Ok(ids)
    }

    /// Persist each hook fingerprint/occurrence before invoking an external effect.
    /// Claimed but unfinished entries are uncertain and never automatically re-claimed.
    pub fn claim_background_hook_execution(
        &self,
        key: &BackgroundRunKey,
        hook_id: &str,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            key.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        anyhow::ensure!(
            !hook_id.is_empty() && hook_id.len() <= 256,
            "invalid background hook identity"
        );
        self.transact_background(&key.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| &record.key == key)
                .context("unknown background run")?;
            anyhow::ensure!(record.terminal.is_some(), "background run is not terminal");
            if record.suppressed
                || record
                    .hook_executions
                    .get(hook_id)
                    .is_some_and(|receipt| receipt.claimed)
                || (record.hook_claimed && record.hook_executions.is_empty())
            {
                return Ok(false);
            }
            anyhow::ensure!(
                !record.hooks_prepared || record.hook_executions.contains_key(hook_id),
                "hook is not in prepared background hook set"
            );
            anyhow::ensure!(
                record.hook_executions.contains_key(hook_id) || record.hook_executions.len() < 256,
                "background hook receipt capacity reached"
            );
            record.hook_executions.insert(
                hook_id.to_owned(),
                BackgroundHookReceipt {
                    claimed: true,
                    completed: false,
                },
            );
            record.hook_claimed = true;
            record.hook_completed = false;
            Ok(true)
        })
    }

    pub fn finish_background_hook_execution(
        &self,
        key: &BackgroundRunKey,
        hook_id: &str,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            key.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        self.transact_background(&key.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| &record.key == key)
                .context("unknown background run")?;
            let receipt = record
                .hook_executions
                .get_mut(hook_id)
                .context("background hook was not claimed")?;
            anyhow::ensure!(receipt.claimed, "background hook was not claimed");
            receipt.completed = true;
            record.hook_completed = record
                .hook_executions
                .values()
                .all(|receipt| receipt.completed);
            Ok(())
        })
    }

    /// A claimed but unfinished hook is uncertain after a crash and is never replayed automatically.
    pub fn claim_background_hook(&self, key: &BackgroundRunKey) -> anyhow::Result<bool> {
        anyhow::ensure!(
            key.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        self.transact_background(&key.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| &record.key == key)
                .context("unknown background run")?;
            anyhow::ensure!(record.terminal.is_some(), "background run is not terminal");
            if record.hook_claimed || record.suppressed {
                return Ok(false);
            }
            record.hook_claimed = true;
            Ok(true)
        })
    }

    pub fn finish_background_hook(&self, key: &BackgroundRunKey) -> anyhow::Result<()> {
        anyhow::ensure!(
            key.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        self.transact_background(&key.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| &record.key == key)
                .context("unknown background run")?;
            anyhow::ensure!(record.hook_claimed, "background hook was not claimed");
            record.hook_completed = true;
            Ok(())
        })
    }

    fn transact_background_batch<R>(
        &self,
        keys: &[BackgroundRunKey],
        update: impl FnOnce(&mut HashMap<String, Task>) -> anyhow::Result<R>,
    ) -> anyhow::Result<R> {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            keys.iter()
                .all(|key| key.parent_session_id == inner.session_id),
            "background parent mismatch"
        );
        let mut tasks = inner.tasks.clone();
        let mut update = Some(update);
        let mut result = None;
        if let Some(path) = inner.session_state_path.as_ref() {
            let source = inner
                .history_source
                .as_ref()
                .context("background state has no bound history source")?;
            source.write_metadata(path, || {
                let mut state = load_session_state(path)?;
                anyhow::ensure!(
                    keys.iter()
                        .all(|key| !state.background_tombstones.contains_key(&key.agent_id)),
                    "background task was deleted"
                );
                for key in keys {
                    if let Some(stored) = state.tasks.get(&key.agent_id) {
                        tasks.insert(key.agent_id.clone(), stored.clone());
                    }
                }
                result = Some(update.take().unwrap()(&mut tasks)?);
                for key in keys {
                    if let Some(task) = tasks.get(&key.agent_id) {
                        state.tasks.insert(key.agent_id.clone(), task.clone());
                    }
                }
                prepare_session_state_write(path, &state)
            })?;
        } else {
            result = Some(update.take().unwrap()(&mut tasks)?);
        }
        for key in keys {
            if let Some(task) = tasks.remove(&key.agent_id) {
                inner.tasks.insert(key.agent_id.clone(), task);
            }
        }
        result.context("background transaction did not execute")
    }

    pub fn reserve_background_followup(
        &self,
        keys: &[BackgroundRunKey],
        turn_id: &str,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            !keys.is_empty() && !turn_id.is_empty() && turn_id.len() <= 128,
            "invalid background followup batch"
        );
        self.transact_background_batch(keys, |tasks| {
            for key in keys {
                let record = tasks
                    .get(&key.agent_id)
                    .and_then(|task| {
                        task.background_runs
                            .iter()
                            .find(|record| &record.key == key)
                    })
                    .context("unknown background run")?;
                anyhow::ensure!(record.terminal.is_some(), "background run is not terminal");
                if record.delivered_message_id.is_none()
                    || record.pending_result_message_id.is_some()
                    || record.suppressed
                    || record.followup_handled
                    || record
                        .followup_turn_id
                        .as_deref()
                        .is_some_and(|id| id != turn_id)
                {
                    return Ok(false);
                }
            }
            for key in keys {
                let record = tasks
                    .get_mut(&key.agent_id)
                    .unwrap()
                    .background_runs
                    .iter_mut()
                    .find(|record| &record.key == key)
                    .unwrap();
                record.followup_turn_id = Some(turn_id.to_owned());
            }
            Ok(true)
        })
    }

    pub fn mark_background_followup_started(
        &self,
        keys: &[BackgroundRunKey],
        turn_id: &str,
    ) -> anyhow::Result<bool> {
        self.transact_background_batch(keys, |tasks| {
            for key in keys {
                let record = tasks
                    .get(&key.agent_id)
                    .and_then(|task| {
                        task.background_runs
                            .iter()
                            .find(|record| &record.key == key)
                    })
                    .context("unknown background run")?;
                anyhow::ensure!(
                    record.followup_turn_id.as_deref() == Some(turn_id),
                    "background followup identity mismatch"
                );
                if record.delivered_message_id.is_none()
                    || record.pending_result_message_id.is_some()
                    || record.suppressed
                    || record.followup_handled
                    || record.followup_started
                {
                    return Ok(false);
                }
            }
            for key in keys {
                tasks
                    .get_mut(&key.agent_id)
                    .unwrap()
                    .background_runs
                    .iter_mut()
                    .find(|record| &record.key == key)
                    .unwrap()
                    .followup_started = true;
            }
            Ok(true)
        })
    }

    pub fn finish_background_followup(
        &self,
        keys: &[BackgroundRunKey],
        turn_id: &str,
    ) -> anyhow::Result<()> {
        self.transact_background_batch(keys, |tasks| {
            for key in keys {
                let record = tasks
                    .get_mut(&key.agent_id)
                    .and_then(|task| {
                        task.background_runs
                            .iter_mut()
                            .find(|record| &record.key == key)
                    })
                    .context("unknown background run")?;
                anyhow::ensure!(
                    record.followup_turn_id.as_deref() == Some(turn_id) && record.followup_started,
                    "background followup was not started"
                );
                record.followup_handled = true;
            }
            Ok(())
        })
    }

    /// Invoke only after a parent response carrying these results is committed.
    pub fn acknowledge_background_runs_in_parent(
        &self,
        keys: &[BackgroundRunKey],
    ) -> anyhow::Result<()> {
        self.transact_background_batch(keys, |tasks| {
            for key in keys {
                let record = tasks
                    .get_mut(&key.agent_id)
                    .and_then(|task| {
                        task.background_runs
                            .iter_mut()
                            .find(|record| &record.key == key)
                    })
                    .context("unknown background run")?;
                anyhow::ensure!(
                    record.delivered_message_id.is_some(),
                    "background result has not been delivered"
                );
                record.followup_handled = true;
            }
            Ok(())
        })
    }

    /// Verify the complete append-only history, including records removed from model context.
    fn committed_message_exists(&self, message_id: &str) -> anyhow::Result<bool> {
        let inner = self.read_inner();
        check_direct_history_fault(&inner)?;
        let Some(path) = inner.history_path.as_ref() else {
            return Ok(inner
                .message_history_ids
                .iter()
                .flatten()
                .any(|id| id == message_id));
        };
        inner
            .history_source
            .as_ref()
            .context("history source missing")?
            .check()?;
        if !path.exists() {
            return Ok(false);
        }
        let file = fs::File::open(path)?;
        let length = file.metadata()?.len();
        if let Some(committed) =
            crate::history_store::committed_source_stamp(path)?.known_committed_bytes()
        {
            anyhow::ensure!(
                length == committed,
                "history length diverged from committed watermark"
            );
        }
        let reader = std::io::BufReader::new(std::io::Read::take(file, length));
        for line in reader.lines() {
            let value: serde_json::Value = serde_json::from_str(&line?)?;
            if value.get("uuid").and_then(serde_json::Value::as_str) == Some(message_id) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn reserve_background_result_delivery(
        &self,
        keys: &[BackgroundRunKey],
        message_id: &str,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !message_id.is_empty() && message_id.len() <= 128,
            "invalid background result message identity"
        );
        self.transact_background_batch(keys, |tasks| {
            for key in keys {
                let record = tasks
                    .get_mut(&key.agent_id)
                    .and_then(|task| {
                        task.background_runs
                            .iter_mut()
                            .find(|record| &record.key == key)
                    })
                    .context("unknown background run")?;
                anyhow::ensure!(record.terminal.is_some(), "background run is not terminal");
                anyhow::ensure!(
                    record
                        .pending_result_message_id
                        .as_deref()
                        .is_none_or(|id| id == message_id),
                    "background result already reserved by another tool batch"
                );
                record.pending_result_message_id = Some(message_id.to_owned());
            }
            Ok(())
        })
    }

    /// Release only a batch the owning turn has definitively aborted. Process recovery
    /// performs this reconciliation against the prepared committed transcript as well.
    pub fn release_background_result_delivery(
        &self,
        keys: &[BackgroundRunKey],
        message_id: &str,
    ) -> anyhow::Result<()> {
        let committed = self.committed_message_exists(message_id)?;
        self.transact_background_batch(keys, |tasks| {
            for key in keys {
                let record = tasks
                    .get_mut(&key.agent_id)
                    .and_then(|task| {
                        task.background_runs
                            .iter_mut()
                            .find(|record| &record.key == key)
                    })
                    .context("unknown background run")?;
                if record.pending_result_message_id.as_deref() == Some(message_id) {
                    if committed {
                        if record.delivered_message_id.is_none() {
                            record.delivered_message_id = Some(message_id.to_owned());
                        }
                        record.followup_handled = true;
                    }
                    record.pending_result_message_id = None;
                }
            }
            Ok(())
        })
    }

    pub fn background_runs_in_current_messages(&self) -> Vec<BackgroundRunKey> {
        let inner = self.read_inner();
        let ids: HashSet<&str> = inner
            .message_history_ids
            .iter()
            .flatten()
            .map(String::as_str)
            .collect();
        inner
            .tasks
            .values()
            .flat_map(|task| &task.background_runs)
            .filter(|record| {
                !record.followup_handled
                    && record
                        .delivered_message_id
                        .as_deref()
                        .is_some_and(|id| ids.contains(id))
            })
            .map(|record| record.key.clone())
            .collect()
    }

    /// Called only after the normal tool-result batch has flushed successfully.
    pub fn confirm_background_result_delivery(
        &self,
        key: &BackgroundRunKey,
        message_id: &str,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            key.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        anyhow::ensure!(
            self.committed_message_exists(message_id)?,
            "background result message is not committed"
        );
        self.transact_background(&key.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| &record.key == key)
                .context("unknown background run")?;
            anyhow::ensure!(record.terminal.is_some(), "background run is not terminal");
            let matches_tool = record.pending_result_message_id.as_deref() == Some(message_id);
            if matches_tool {
                record.followup_handled = true;
                record.pending_result_message_id = None;
            }
            if record.delivered_message_id.is_some() || record.suppressed {
                return Ok(false);
            }
            record.delivered_message_id = Some(message_id.to_owned());
            if task.background_run.as_ref() == Some(key) {
                task.notification_injected_at_ms = Some(now_millis());
            }
            Ok(true)
        })
    }

    /// Flush earlier queued writes, then commit and project one stable UUID atomically.
    pub async fn commit_message_with_uuid(
        &self,
        message: Message,
        message_id: &str,
    ) -> anyhow::Result<()> {
        self.commit_message_with_uuid_guarded(message, message_id, None)
            .await
    }

    async fn commit_message_with_uuid_guarded(
        &self,
        message: Message,
        message_id: &str,
        notification: Option<&BackgroundEventIdentity>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !message_id.is_empty() && message_id.len() <= 128,
            "invalid history message identity"
        );
        loop {
            let before = self.read_inner().last_history_uuid.clone();
            self.flush_history().await?;
            let mut inner = self.write_inner();
            if inner.last_history_uuid != before {
                continue;
            }
            check_direct_history_fault(&inner)?;
            if inner
                .message_history_ids
                .iter()
                .flatten()
                .any(|id| id == message_id)
            {
                return Ok(());
            }
            let timestamp_ms = now_millis();
            let entry = HistoryEntry {
                session_id: inner.session_id.clone(),
                timestamp_ms,
                uuid: Some(message_id.to_owned()),
                parent_uuid: inner.last_history_uuid.clone(),
                message: message.clone(),
            };
            if let Some(source) = inner.history_source.as_ref() {
                let mut bytes = serde_json::to_vec(&entry)?;
                bytes.push(b'\n');
                let allowed = |record: &BackgroundRunRecord| {
                    record.terminal.as_ref() == notification
                        && record.notification_message_id.as_deref() == Some(message_id)
                        && record.pending_result_message_id.is_none()
                        && record.delivered_message_id.is_none()
                        && !record.suppressed
                };
                let appended = if let Some(event) = notification {
                    let path = inner
                        .session_state_path
                        .as_ref()
                        .context("notification history has no sidecar")?;
                    source.append_unique_when(&bytes, message_id, || {
                        let state = load_session_state(path)?;
                        Ok(state
                            .tasks
                            .get(&event.run.agent_id)
                            .and_then(|task| {
                                task.background_runs
                                    .iter()
                                    .find(|record| record.key == event.run)
                            })
                            .is_some_and(allowed))
                    })?
                } else {
                    source.append_unique(&bytes, message_id)?
                };
                if !appended {
                    // An existing append-only identity may have been intentionally
                    // rewound out of this projection. Never reintroduce it with a
                    // newly synthesized body or undo a user's history boundary.
                    return Ok(());
                }
            } else {
                anyhow::ensure!(inner.history_path.is_none(), "history source missing");
                if let Some(event) = notification {
                    let allowed = inner
                        .tasks
                        .get(&event.run.agent_id)
                        .and_then(|task| {
                            task.background_runs
                                .iter()
                                .find(|record| record.key == event.run)
                        })
                        .is_some_and(|record| {
                            record.notification_message_id.as_deref() == Some(message_id)
                                && record.pending_result_message_id.is_none()
                                && record.delivered_message_id.is_none()
                                && !record.suppressed
                        });
                    if !allowed {
                        return Ok(());
                    }
                }
            }
            inner.conversation_started = true;
            inner.session_updated_at_ms = inner.session_updated_at_ms.max(timestamp_ms);
            inner.last_history_uuid = Some(message_id.to_owned());
            if matches!(message, Message::Assistant { .. }) {
                inner.last_assistant_message_timestamp_ms = Some(timestamp_ms);
            }
            inner.message_revision = MessageRevision::default();
            inner.messages.push(message);
            inner.message_history_ids.push(Some(message_id.to_owned()));
            Self::truncate_messages(&mut inner);
            return Ok(());
        }
    }

    pub async fn deliver_background_notification(
        &self,
        event: &BackgroundEventIdentity,
        message: Message,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            event.run.parent_session_id == self.session_id(),
            "background parent mismatch"
        );
        if let Some(pending) = self
            .background_run_record(&event.run)
            .and_then(|record| record.pending_result_message_id)
        {
            if self.committed_message_exists(&pending)? {
                self.confirm_background_result_delivery(&event.run, &pending)?;
            }
            // The active tool batch retains its reservation until commit or explicit abort.
            return Ok(false);
        }
        let message_id = self.transact_background(&event.run.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| record.key == event.run)
                .context("unknown background run")?;
            anyhow::ensure!(
                record.terminal.as_ref() == Some(event),
                "background terminal identity mismatch"
            );
            if record.delivered_message_id.is_some()
                || record.suppressed
                || record.pending_result_message_id.is_some()
            {
                return Ok(None);
            }
            Ok(Some(
                record
                    .notification_message_id
                    .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
                    .clone(),
            ))
        })?;
        let Some(message_id) = message_id else {
            return Ok(false);
        };
        self.flush_history().await?;
        if !self.committed_message_exists(&message_id)? {
            self.commit_message_with_uuid_guarded(message, &message_id, Some(event))
                .await?;
        }
        if !self.committed_message_exists(&message_id)? {
            return Ok(false);
        }
        self.confirm_background_result_delivery(&event.run, &message_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, AppState, BackgroundEventIdentity) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path());
        state.with_history_path(dir.path().join(format!("{}.jsonl", state.session_id())));
        let mut task = Task::new("agent", "test");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        state.upsert_task(task);
        let key = state.begin_background_run("agent").unwrap();
        let event = BackgroundEventIdentity::terminal(key);
        (dir, state, event)
    }

    #[tokio::test]
    async fn repeated_terminal_delivery_has_one_committed_message() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        for i in 0..100 {
            assert_eq!(
                state
                    .deliver_background_notification(&event, Message::user_text("done"))
                    .await
                    .unwrap(),
                i == 0
            );
        }
        let path = state.read_inner().history_path.clone().unwrap();
        assert_eq!(load_history(&path).unwrap().len(), 1);
        assert_eq!(state.messages().len(), 1);
    }

    #[tokio::test]
    async fn old_run_delivery_never_claims_new_run() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        let next = state.begin_background_run("agent").unwrap();
        assert_ne!(event.run, next);
        assert!(
            state
                .deliver_background_notification(&event, Message::user_text("old done"))
                .await
                .unwrap()
        );
        assert!(
            state
                .background_run_record(&next)
                .unwrap()
                .delivered_message_id
                .is_none()
        );
        assert!(
            state
                .task("agent")
                .unwrap()
                .notification_injected_at_ms
                .is_none()
        );
        assert_eq!(
            state.task_for_background_run(&event.run).unwrap().status,
            TaskStatus::Completed
        );
    }

    #[test]
    fn failed_terminal_commit_leaves_run_uncommitted() {
        let (_dir, state, event) = fixture();
        let _fail = install_atomic_replace_failpoint(state.session_state_path().unwrap());
        assert!(
            state
                .commit_background_terminal(&event, TaskStatus::Completed, None)
                .is_err()
        );
        assert!(
            state
                .background_run_record(&event.run)
                .unwrap()
                .terminal
                .is_none()
        );
    }

    #[test]
    fn conflicting_terminal_cannot_replace_first_result() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        assert!(
            !state
                .commit_background_terminal(&event, TaskStatus::Completed, None)
                .unwrap()
        );
        assert!(
            state
                .commit_background_terminal(&event, TaskStatus::Failed, None)
                .is_err()
        );
        assert_eq!(
            state.background_run_record(&event.run).unwrap().status,
            TaskStatus::Completed
        );
    }

    #[tokio::test]
    async fn committed_history_before_receipt_recovers_without_append() {
        let (dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        state
            .transact_background("agent", |task| {
                task.background_runs[0].notification_message_id =
                    Some("stable-notification".to_owned());
                Ok(())
            })
            .unwrap();
        state
            .commit_message_with_uuid(Message::user_text("done"), "stable-notification")
            .await
            .unwrap();
        let restored = AppState::new(dir.path());
        let history = state.read_inner().history_path.clone().unwrap();
        restored.resume_from_history(&history).unwrap();
        assert!(
            !restored
                .deliver_background_notification(&event, Message::user_text("done"))
                .await
                .unwrap()
        );
        assert_eq!(load_history(&history).unwrap().len(), 1);
    }

    #[test]
    fn uncommitted_message_cannot_acknowledge_terminal() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        assert!(
            state
                .confirm_background_result_delivery(&event.run, "missing")
                .is_err()
        );
        assert!(
            state
                .background_run_record(&event.run)
                .unwrap()
                .delivered_message_id
                .is_none()
        );
    }

    #[test]
    fn uncertain_hook_claim_is_not_automatically_replayed() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        assert!(state.claim_background_hook(&event.run).unwrap());
        assert!(!state.claim_background_hook(&event.run).unwrap());
        let record = state.background_run_record(&event.run).unwrap();
        assert!(record.hook_claimed && !record.hook_completed);
        state.finish_background_hook(&event.run).unwrap();
        assert!(
            state
                .background_run_record(&event.run)
                .unwrap()
                .hook_completed
        );
    }

    #[tokio::test]
    async fn concurrent_receivers_share_fixed_message_identity() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        let (a, b) = tokio::join!(
            state.deliver_background_notification(&event, Message::user_text("done")),
            state.deliver_background_notification(&event, Message::user_text("done"))
        );
        assert_ne!(a.unwrap(), b.unwrap());
        let path = state.read_inner().history_path.clone().unwrap();
        assert_eq!(load_history(&path).unwrap().len(), 1);
    }
    #[tokio::test]
    async fn tool_batch_reservation_blocks_notification_until_abort_or_commit() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        let keys = [event.run.clone()];
        state
            .reserve_background_result_delivery(&keys, "tool-batch")
            .unwrap();
        assert!(
            !state
                .deliver_background_notification(&event, Message::user_text("redundant"))
                .await
                .unwrap()
        );
        assert!(state.messages().is_empty());
        state
            .commit_message_with_uuid(Message::user_text("terminal tool result"), "tool-batch")
            .await
            .unwrap();
        assert!(
            !state
                .deliver_background_notification(&event, Message::user_text("redundant"))
                .await
                .unwrap()
        );
        assert!(
            state
                .background_run_record(&event.run)
                .unwrap()
                .followup_handled
        );
        state.acknowledge_background_runs_in_parent(&keys).unwrap();
        assert!(state.background_runs_in_current_messages().is_empty());
    }

    #[tokio::test]
    async fn aborting_uncommitted_tool_batch_releases_notification() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        let keys = [event.run.clone()];
        state
            .reserve_background_result_delivery(&keys, "aborted-batch")
            .unwrap();
        state
            .release_background_result_delivery(&keys, "aborted-batch")
            .unwrap();
        assert!(
            state
                .deliver_background_notification(&event, Message::user_text("done"))
                .await
                .unwrap()
        );
    }

    #[test]
    fn followup_batch_preserves_fixed_turn_and_close_prevents_start() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        state
            .add_message_with_uuid(Message::user_text("done"), "notification")
            .unwrap();
        state
            .confirm_background_result_delivery(&event.run, "notification")
            .unwrap();
        let keys = [event.run.clone()];
        assert!(
            state
                .reserve_background_followup(&keys, "turn-one")
                .unwrap()
        );
        assert!(
            state
                .reserve_background_followup(&keys, "turn-one")
                .unwrap()
        );
        assert!(
            !state
                .reserve_background_followup(&keys, "turn-two")
                .unwrap()
        );
        state.suppress_background_run(&event.run).unwrap();
        assert!(
            !state
                .mark_background_followup_started(&keys, "turn-one")
                .unwrap()
        );
    }

    #[test]
    fn failed_followup_reservation_rolls_back_every_record() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        state
            .add_message_with_uuid(Message::user_text("done"), "notification")
            .unwrap();
        state
            .confirm_background_result_delivery(&event.run, "notification")
            .unwrap();
        let _fail = install_atomic_replace_failpoint(state.session_state_path().unwrap());
        assert!(
            state
                .reserve_background_followup(&[event.run.clone()], "turn-one")
                .is_err()
        );
        assert!(
            state
                .background_run_record(&event.run)
                .unwrap()
                .followup_turn_id
                .is_none()
        );
    }
    #[tokio::test]
    async fn stale_full_task_snapshot_cannot_erase_receipt_or_resurrect_deleted_agent() {
        let (dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        state
            .commit_message_with_uuid(Message::user_text("seed"), "seed")
            .await
            .unwrap();
        let other = AppState::new(dir.path());
        let history = state.read_inner().history_path.clone().unwrap();
        other.resume_from_history(&history).unwrap();
        let stale = other.task("agent").unwrap();
        state
            .deliver_background_notification(&event, Message::user_text("done"))
            .await
            .unwrap();
        other.upsert_task(stale.clone());
        other.persist_latest_session_state();
        let stored = load_session_state(&state.session_state_path().unwrap()).unwrap();
        assert!(
            stored.tasks["agent"].background_runs[0]
                .delivered_message_id
                .is_some()
        );
        assert!(state.remove_task("agent"));
        other.upsert_task(stale);
        other.persist_latest_session_state();
        let stored = load_session_state(&state.session_state_path().unwrap()).unwrap();
        assert!(!stored.tasks.contains_key("agent"));
        assert!(stored.background_tombstones["agent"][0].suppressed);
        assert!(other.begin_background_run("agent").is_err());
    }

    #[test]
    fn reserved_capacity_always_accepts_last_terminal() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("agent", "capacity");
        task.kind = TaskKind::Subagent;
        state.upsert_task(task);
        for _ in 0..MAX_BACKGROUND_RUNS_PER_TASK {
            let run = state.begin_background_run("agent").unwrap();
            state
                .commit_background_terminal(
                    &BackgroundEventIdentity::terminal(run),
                    TaskStatus::Completed,
                    None,
                )
                .unwrap();
        }
        assert!(state.begin_background_run("agent").is_err());
        assert_eq!(
            state.pending_background_terminals().len(),
            MAX_BACKGROUND_RUNS_PER_TASK
        );
    }

    #[test]
    fn legacy_migration_is_stable_and_ambiguous_runs_are_suppressed() {
        let mut old = Task::new("agent", "legacy");
        old.kind = TaskKind::Subagent;
        old.status = TaskStatus::Completed;
        let mut again = old.clone();
        migrate_legacy_background_run(&mut old, "session");
        migrate_legacy_background_run(&mut again, "session");
        assert_eq!(old.background_run, again.background_run);
        assert!(old.background_runs[0].legacy_uncertain);
        assert!(old.background_runs[0].suppressed);
        assert!(old.background_runs[0].followup_handled);
    }
    #[test]
    fn prepared_hooks_recover_unstarted_occurrences_but_never_replay_uncertain_effects() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        let ids = vec!["fingerprint:0".to_owned(), "fingerprint:1".to_owned()];
        assert_eq!(
            state.prepare_background_hooks(&event.run, &ids).unwrap(),
            ids
        );
        assert!(
            state
                .claim_background_hook_execution(&event.run, &ids[0])
                .unwrap()
        );
        assert!(
            !state
                .claim_background_hook_execution(&event.run, &ids[0])
                .unwrap()
        );
        let record = state.background_run_record(&event.run).unwrap();
        assert!(record.has_pending_hooks());
        assert!(!record.hook_executions[&ids[0]].completed);
        assert_eq!(
            state
                .prepare_background_hooks(&event.run, &["new-configuration".to_owned()])
                .unwrap(),
            ids
        );
        assert!(
            state
                .claim_background_hook_execution(&event.run, "new-configuration")
                .is_err()
        );
        assert!(
            state
                .claim_background_hook_execution(&event.run, &ids[1])
                .unwrap()
        );
        state
            .finish_background_hook_execution(&event.run, &ids[1])
            .unwrap();
        let record = state.background_run_record(&event.run).unwrap();
        assert!(!record.has_pending_hooks());
        assert!(!record.hook_completed);
    }

    #[test]
    fn undelivered_terminal_cannot_reserve_automatic_followup() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        assert!(
            !state
                .reserve_background_followup(&[event.run], "premature-turn")
                .unwrap()
        );
    }
    #[tokio::test]
    async fn same_parent_import_clears_message_identity_and_does_not_replay_receipts() {
        let (dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        state
            .deliver_background_notification(&event, Message::user_text("done"))
            .await
            .unwrap();
        assert_eq!(
            state.background_runs_in_current_messages(),
            [event.run.clone()]
        );
        let mut snapshot = state.snapshot();
        snapshot.messages = vec![Message::user_text("unrelated imported message")];
        let path = dir.path().join("import.json");
        fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
        state.import_snapshot(&path).unwrap();
        assert!(state.background_runs_in_current_messages().is_empty());
        let record = state.background_run_record(&event.run).unwrap();
        assert!(record.suppressed && record.imported_history && record.followup_handled);
        assert!(record.delivered_message_id.is_some());
        assert!(
            !state
                .deliver_background_notification(&event, Message::user_text("duplicate"))
                .await
                .unwrap()
        );
    }

    #[test]
    fn cross_parent_import_keeps_background_tasks_as_history_only() {
        let (dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        let path = dir.path().join("import.json");
        state.export_snapshot(&path).unwrap();
        let target = AppState::new(dir.path());
        let parent = target.session_id();
        target.import_snapshot(&path).unwrap();
        assert_eq!(target.session_id(), parent);
        assert!(target.pending_background_terminals().is_empty());
        let task = target.task("agent").unwrap();
        assert_eq!(
            task.background_runs[0].key.parent_session_id,
            event.run.parent_session_id
        );
        assert!(task.background_runs[0].imported_history);
        assert!(target.start_background_task_run(task).is_err());
    }

    #[test]
    fn snapshot_import_rejects_live_managed_tasks_without_replacing_messages() {
        let (dir, state, _event) = fixture();
        let path = dir.path().join("import.json");
        state.export_snapshot(&path).unwrap();
        state.update_task("agent", |task| task.managed = true);
        assert!(state.import_snapshot(&path).is_err());
        assert_eq!(state.task("agent").unwrap().status, TaskStatus::Running);
    }

    #[test]
    fn new_run_preserves_messages_enqueued_after_caller_prepared_task() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        let prepared = state.task("agent").unwrap();
        state
            .enqueue_subagent_delivery("agent", "concurrent message")
            .unwrap()
            .unwrap();
        state.start_background_task_run(prepared).unwrap();
        assert_eq!(state.task("agent").unwrap().message_queue.len(), 1);
    }
    #[tokio::test]
    async fn tool_reservation_in_another_state_wins_before_notification_append() {
        let (dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        state
            .commit_message_with_uuid(Message::user_text("seed"), "seed")
            .await
            .unwrap();
        state
            .transact_background("agent", |task| {
                task.background_runs[0].notification_message_id =
                    Some("notification-race".to_owned());
                Ok(())
            })
            .unwrap();
        let other = AppState::new(dir.path());
        other
            .resume_from_history(&state.read_inner().history_path.clone().unwrap())
            .unwrap();
        other
            .reserve_background_result_delivery(&[event.run.clone()], "tool-race")
            .unwrap();
        // The notifier already passed reservation and now reaches its commit boundary.
        state
            .commit_message_with_uuid_guarded(
                Message::user_text("redundant"),
                "notification-race",
                Some(&event),
            )
            .await
            .unwrap();
        assert!(!state.committed_message_exists("notification-race").unwrap());
        other
            .commit_message_with_uuid(Message::user_text("terminal tool result"), "tool-race")
            .await
            .unwrap();
        other
            .confirm_background_result_delivery(&event.run, "tool-race")
            .unwrap();
        assert!(
            !state
                .deliver_background_notification(&event, Message::user_text("redundant"))
                .await
                .unwrap()
        );
        let record = other.background_run_record(&event.run).unwrap();
        assert_eq!(record.delivered_message_id.as_deref(), Some("tool-race"));
        assert!(record.followup_handled);
    }

    #[tokio::test]
    async fn notification_confirmation_never_clears_another_tool_batch_reservation() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        state
            .transact_background("agent", |task| {
                task.background_runs[0].notification_message_id =
                    Some("notification-first".to_owned());
                Ok(())
            })
            .unwrap();
        state
            .commit_message_with_uuid_guarded(
                Message::user_text("done"),
                "notification-first",
                Some(&event),
            )
            .await
            .unwrap();
        state
            .reserve_background_result_delivery(&[event.run.clone()], "later-tool")
            .unwrap();
        assert!(
            state
                .confirm_background_result_delivery(&event.run, "notification-first")
                .unwrap()
        );
        assert_eq!(
            state
                .background_run_record(&event.run)
                .unwrap()
                .pending_result_message_id
                .as_deref(),
            Some("later-tool")
        );
        state
            .commit_message_with_uuid(Message::user_text("explicit read"), "later-tool")
            .await
            .unwrap();
        assert!(
            !state
                .confirm_background_result_delivery(&event.run, "later-tool")
                .unwrap()
        );
        let record = state.background_run_record(&event.run).unwrap();
        assert!(record.pending_result_message_id.is_none());
        assert!(record.followup_handled);
        assert_eq!(
            record.delivered_message_id.as_deref(),
            Some("notification-first")
        );
    }

    #[tokio::test]
    async fn aborted_tool_takeover_does_not_strand_reserved_notification() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        state
            .transact_background("agent", |task| {
                task.background_runs[0].notification_message_id =
                    Some("retry-after-abort".to_owned());
                Ok(())
            })
            .unwrap();
        state
            .reserve_background_result_delivery(&[event.run.clone()], "aborted-reader")
            .unwrap();
        state
            .commit_message_with_uuid_guarded(
                Message::user_text("done"),
                "retry-after-abort",
                Some(&event),
            )
            .await
            .unwrap();
        assert!(!state.committed_message_exists("retry-after-abort").unwrap());
        state
            .release_background_result_delivery(&[event.run.clone()], "aborted-reader")
            .unwrap();
        assert!(
            state
                .deliver_background_notification(&event, Message::user_text("done"))
                .await
                .unwrap()
        );
    }
    #[test]
    fn terminal_task_snapshot_is_not_readable_as_terminal_before_run_commit() {
        let (_dir, state, event) = fixture();
        state.update_task("agent", |task| {
            task.status = TaskStatus::Completed;
            task.output = Some("not yet committed".to_owned());
        });
        assert_eq!(
            state.task_for_background_run(&event.run).unwrap().status,
            TaskStatus::Running
        );
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        assert_eq!(
            state.task_for_background_run(&event.run).unwrap().status,
            TaskStatus::Completed
        );
    }
    #[test]
    fn legacy_terminal_without_commit_identity_is_not_automatically_replayed() {
        let mut task = Task::new("legacy-completed", "fixture");
        task.kind = TaskKind::Subagent;
        task.managed = true;
        task.status = TaskStatus::Completed;
        task.run_started_at_ms = Some(100);
        migrate_legacy_background_run(&mut task, "parent");
        assert!(task.background_runs[0].legacy_uncertain);
        assert!(task.background_runs[0].suppressed);
        assert!(task.background_runs[0].terminal.is_some());
    }

    #[test]
    fn historical_run_does_not_inherit_the_current_review_vote() {
        let (_dir, state, event) = fixture();
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        let next = state.begin_background_run(&event.run.agent_id).unwrap();
        state.update_task(&event.run.agent_id, |task| {
            task.review_vote_summary = Some("new run vote".into())
        });
        assert!(
            state
                .task_for_background_run(&event.run)
                .unwrap()
                .review_vote_summary
                .is_none()
        );
        assert_eq!(
            state
                .task_for_background_run(&next)
                .unwrap()
                .review_vote_summary
                .as_deref(),
            Some("new run vote")
        );
    }
}
