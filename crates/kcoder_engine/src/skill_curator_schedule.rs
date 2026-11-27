//! Durable, idle-gated scheduling for the automatic (non-LLM) skill curator.
//!
//! The last-run time lives in the project skill store (see
//! `kcoder_skills::CuratorScheduleState`), so restarts and concurrent KCoder
//! processes share one schedule. Hosts call [`QueryEngine::poll_idle_maintenance`]
//! from their idle ticks; the engine also polls at each completed turn. A poll
//! is cheap: in-memory gates run first and the persisted schedule is re-read
//! at most once per recheck window. The curator job itself never sleeps for
//! the idle window: it is only spawned once the interval has elapsed and the
//! foreground has been idle for `min_idle`.

use super::*;
use crate::skill_maintenance_runtime::ResetFlagOnDrop;
use kcoder_skills::{CuratorRunLease, CuratorScheduleState, SkillStore, SkillStoreError};

/// Upper bound between persisted-schedule reads, so settings changes and runs
/// by other processes are observed without re-reading the file every tick.
pub(crate) const CURATOR_RECHECK_CAP: Duration = Duration::from_secs(15 * 60);
/// Back-off after another owner holds the run lease or a transient store error.
pub(crate) const CURATOR_BUSY_RETRY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CuratorScheduleDecision {
    /// No usable schedule: record a seed and wait one full interval.
    Seed,
    /// The interval has not elapsed; check again after the given duration.
    NotDue(Duration),
    Due,
}

/// Decide from the persisted last-run instant whether a run is due. A
/// timestamp more than one interval in the future (wall clock moved back) is
/// re-seeded so a clock rollback delays the curator by at most one interval.
pub(crate) fn curator_schedule_decision(
    now: SystemTime,
    last_run_at: Option<SystemTime>,
    interval: Duration,
) -> CuratorScheduleDecision {
    let Some(last_run_at) = last_run_at else {
        return CuratorScheduleDecision::Seed;
    };
    match now.duration_since(last_run_at) {
        Ok(elapsed) if elapsed >= interval => CuratorScheduleDecision::Due,
        Ok(elapsed) => CuratorScheduleDecision::NotDue(interval - elapsed),
        Err(ahead) if ahead.duration() > interval => CuratorScheduleDecision::Seed,
        Err(ahead) => CuratorScheduleDecision::NotDue(interval + ahead.duration()),
    }
}

/// Foreground idle time: zero while a main-thread turn is running, otherwise
/// the time since the last turn started or finished.
pub(crate) fn curator_foreground_idle(
    now: SystemTime,
    last_activity: SystemTime,
    turn_active: bool,
) -> Duration {
    if turn_active {
        return Duration::ZERO;
    }
    now.duration_since(last_activity).unwrap_or(Duration::ZERO)
}

struct AutoCuratorConfig {
    interval: Duration,
    min_idle: Duration,
    stale_after_days: i64,
    archive_after_days: i64,
    prune_builtins: bool,
}

fn hours_to_duration(hours: u64) -> Duration {
    Duration::from_secs(hours.saturating_mul(60 * 60))
}

fn u64_to_i64_saturating(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn schedule_last_run(state: Option<&CuratorScheduleState>) -> Option<SystemTime> {
    state.map(|state| SystemTime::from(state.last_run_at))
}

impl QueryEngine {
    /// Idle-tick entry point for hosts (REPL, app-server); call it only while
    /// no foreground turn is active and the host is not shutting down. It may
    /// start the automatic skill curator (persisted interval elapsed, idle for
    /// `min_idle`, cross-process run lease won) and the background skill
    /// review (idle deadline reached with enough new tool calls), and runs
    /// the self-evolution idle step (window closing, artifact checks, at most
    /// one classification or distillation job, consolidation proposals). Safe to call
    /// frequently: in-memory gates run before any file or transcript access.
    pub fn poll_idle_maintenance(&self) {
        self.maybe_spawn_auto_curator();
        self.maybe_spawn_skill_review();
        self.poll_evolution();
    }

    fn auto_curator_config(&self) -> Option<AutoCuratorConfig> {
        let settings = recover_read_lock(&self.settings, "settings");
        settings
            .skills
            .auto_curator_enabled
            .then(|| AutoCuratorConfig {
                interval: hours_to_duration(settings.skills.auto_curator_interval_hours.max(1)),
                min_idle: hours_to_duration(settings.skills.auto_curator_min_idle_hours),
                stale_after_days: u64_to_i64_saturating(settings.skills.stale_after_days),
                archive_after_days: u64_to_i64_saturating(settings.skills.archive_after_days),
                prune_builtins: settings.skills.prune_builtins,
            })
    }

    fn defer_auto_curator_check(&self, after: Duration) {
        *self
            .auto_curator_next_check
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            Some(Instant::now() + after.min(CURATOR_RECHECK_CAP));
    }

    pub(super) fn maybe_spawn_auto_curator(&self) {
        if self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft {
            return;
        }
        if !self
            .workspace_persistence_mode
            .allows_implicit_project_writes()
            || self.tools.get("skill_curator").is_none()
        {
            return;
        }
        let Some(config) = self.auto_curator_config() else {
            return;
        };
        if self.auto_curator_running.load(Ordering::SeqCst) {
            return;
        }

        let now = SystemTime::now();
        let last_activity =
            *recover_read_lock(&self.foreground_last_activity, "foreground_last_activity");
        if curator_foreground_idle(now, last_activity, self.turn_driver_active()) < config.min_idle
        {
            return;
        }
        if self
            .auto_curator_next_check
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some_and(|next| Instant::now() < next)
        {
            return;
        }

        let root = kcoder_tools::skill_telemetry::project_skills_root(&self.state.cwd());
        // No skill store means nothing to curate; do not create project
        // directories just to hold a schedule.
        if !root.is_dir() {
            self.defer_auto_curator_check(CURATOR_RECHECK_CAP);
            return;
        }
        let store = match SkillStore::open(&root) {
            Ok(store) => store,
            Err(error) => {
                warn!(%error, "automatic skill curator could not open the skill store");
                self.defer_auto_curator_check(CURATOR_RECHECK_CAP);
                return;
            }
        };
        let persisted = match store.curator_schedule() {
            Ok(state) => state,
            // A malformed schedule is re-seeded by the lease owner below.
            Err(SkillStoreError::JournalCorrupt(reason)) => {
                warn!(%reason, "re-seeding malformed skill curator schedule");
                None
            }
            Err(error) => {
                warn!(%error, "automatic skill curator could not read its schedule");
                self.defer_auto_curator_check(CURATOR_RECHECK_CAP);
                return;
            }
        };
        match curator_schedule_decision(now, schedule_last_run(persisted.as_ref()), config.interval)
        {
            CuratorScheduleDecision::NotDue(remaining) => {
                self.defer_auto_curator_check(remaining);
                return;
            }
            CuratorScheduleDecision::Seed => {
                self.seed_auto_curator_schedule(&store, config.interval);
                return;
            }
            CuratorScheduleDecision::Due => {}
        }

        let lease = match store.try_curator_run_lease() {
            Ok(Some(lease)) => lease,
            Ok(None) => {
                // Another process (or engine) owns the run right now.
                self.defer_auto_curator_check(CURATOR_BUSY_RETRY);
                return;
            }
            Err(error) => {
                warn!(%error, "automatic skill curator could not take its run lease");
                self.defer_auto_curator_check(CURATOR_BUSY_RETRY);
                return;
            }
        };
        // Re-read under the lease: the previous owner may have just finished.
        let current = match lease.current() {
            Ok(state) => state,
            Err(SkillStoreError::JournalCorrupt(_)) => None,
            Err(error) => {
                warn!(%error, "automatic skill curator could not re-read its schedule");
                self.defer_auto_curator_check(CURATOR_BUSY_RETRY);
                return;
            }
        };
        match curator_schedule_decision(
            SystemTime::now(),
            schedule_last_run(current.as_ref()),
            config.interval,
        ) {
            CuratorScheduleDecision::Due => {}
            CuratorScheduleDecision::NotDue(remaining) => {
                self.defer_auto_curator_check(remaining);
                return;
            }
            CuratorScheduleDecision::Seed => {
                self.record_auto_curator_seed(&lease, config.interval);
                return;
            }
        }

        if self.auto_curator_running.swap(true, Ordering::SeqCst) {
            return;
        }
        self.spawn_auto_curator_job(lease, config);
    }

    fn seed_auto_curator_schedule(&self, store: &SkillStore, interval: Duration) {
        match store.try_curator_run_lease() {
            Ok(Some(lease)) => {
                // Another owner may have seeded or run while we were unlocked.
                let current = lease.current().ok().flatten();
                match curator_schedule_decision(
                    SystemTime::now(),
                    schedule_last_run(current.as_ref()),
                    interval,
                ) {
                    CuratorScheduleDecision::Seed => {
                        self.record_auto_curator_seed(&lease, interval)
                    }
                    CuratorScheduleDecision::NotDue(remaining) => {
                        self.defer_auto_curator_check(remaining)
                    }
                    // Due on the next poll; keep the check window open.
                    CuratorScheduleDecision::Due => {}
                }
            }
            Ok(None) => self.defer_auto_curator_check(CURATOR_BUSY_RETRY),
            Err(error) => {
                warn!(%error, "automatic skill curator could not take its run lease");
                self.defer_auto_curator_check(CURATOR_BUSY_RETRY);
            }
        }
    }

    fn record_auto_curator_seed(&self, lease: &CuratorRunLease, interval: Duration) {
        // A fresh store waits one full interval instead of running at startup.
        match lease.record(&CuratorScheduleState::seeded(chrono::Utc::now())) {
            Ok(()) => self.defer_auto_curator_check(interval),
            Err(error) => {
                warn!(%error, "automatic skill curator could not seed its schedule");
                self.defer_auto_curator_check(CURATOR_BUSY_RETRY);
            }
        }
    }

    fn spawn_auto_curator_job(&self, lease: CuratorRunLease, config: AutoCuratorConfig) {
        // Aborts (session replacement, goal stop) kill the spawned future at an
        // arbitrary await; the guard resets the flag and the lease drop
        // releases the cross-process run lock.
        let reset_on_drop = ResetFlagOnDrop(self.auto_curator_running.clone());
        let job_id = format!(
            "auto-curator-{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let engine = self.clone();
        let description = format!("{INTERNAL_SKILL_CURATOR_PREFIX} scheduled run");
        let spawn_result = self.background_jobs.spawn(
            description,
            Box::pin(async move {
                let _reset_on_drop = reset_on_drop;
                let lease = lease;
                let running = CuratorScheduleState::running(chrono::Utc::now(), job_id.clone());
                // Consume the interval before running. If the schedule cannot be
                // persisted, do not run: an unrecorded run would repeat every tick.
                if let Err(error) = lease.record(&running) {
                    warn!(%error, "automatic skill curator could not record its run");
                    engine.defer_auto_curator_check(CURATOR_BUSY_RETRY);
                    return ToolOutput::error(format!(
                        "automatic skill curator skipped: schedule could not be recorded: {error}"
                    ));
                }

                let (max_out, head_out, tail_out, max_subagents) = {
                    let settings = recover_read_lock(&engine.settings, "settings");
                    (
                        settings.max_tool_output_bytes,
                        settings.tool_output_head_bytes,
                        settings.tool_output_tail_bytes,
                        Some(effective_max_concurrent_subagents(&settings)),
                    )
                };
                let ctx = engine
                    .base_tool_context(max_out, head_out, tail_out, max_subagents)
                    .with_skill_mutation_actor(kcoder_skills::SkillMutationActor::AutoCurator {
                        session_id: engine.state.session_id(),
                        job_id,
                    });
                let input = serde_json::json!({
                    "action": "run",
                    "stale_after_days": config.stale_after_days,
                    "archive_after_days": config.archive_after_days,
                    "include_non_agent_created": false,
                    "include_bundled": config.prune_builtins,
                });
                let (output, detail) = match SkillCuratorTool.call(input, &ctx).await {
                    Ok(output) => {
                        // The schedule bounds `detail`; keep only the error text.
                        let detail = output.is_error.then(|| {
                            output
                                .content
                                .iter()
                                .filter_map(|block| match block {
                                    ContentBlock::Text { text } => Some(text.as_str()),
                                    _ => None,
                                })
                                .collect::<Vec<_>>()
                                .join(" ")
                        });
                        (output, detail)
                    }
                    Err(error) => {
                        warn!("automatic skill curator failed: {}", error);
                        let message = format!("automatic skill curator failed: {error}");
                        (ToolOutput::error(message.clone()), Some(message))
                    }
                };
                let finished =
                    running.finished(chrono::Utc::now(), detail.is_none(), detail.as_deref());
                if let Err(error) = lease.record(&finished) {
                    warn!(%error, "automatic skill curator could not record its outcome");
                }
                engine.defer_auto_curator_check(config.interval);
                engine.auto_curator_running.store(false, Ordering::SeqCst);
                output
            }),
        );

        if let Err(error) = spawn_result {
            self.auto_curator_running.store(false, Ordering::SeqCst);
            self.defer_auto_curator_check(CURATOR_BUSY_RETRY);
            warn!("failed to spawn automatic skill curator: {}", error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(60 * 60);

    #[test]
    fn decision_seeds_missing_schedule_and_waits_one_interval() {
        let now = SystemTime::UNIX_EPOCH + 1_000 * HOUR;
        assert_eq!(
            curator_schedule_decision(now, None, 168 * HOUR),
            CuratorScheduleDecision::Seed
        );
        assert_eq!(
            curator_schedule_decision(now, Some(now), 168 * HOUR),
            CuratorScheduleDecision::NotDue(168 * HOUR)
        );
        assert_eq!(
            curator_schedule_decision(now, Some(now - 168 * HOUR), 168 * HOUR),
            CuratorScheduleDecision::Due
        );
        assert_eq!(
            curator_schedule_decision(now, Some(now - 100 * HOUR), 168 * HOUR),
            CuratorScheduleDecision::NotDue(68 * HOUR)
        );
    }

    #[test]
    fn decision_reseeds_after_large_clock_rollback() {
        let now = SystemTime::UNIX_EPOCH + 1_000 * HOUR;
        assert_eq!(
            curator_schedule_decision(now, Some(now + 2 * HOUR), HOUR),
            CuratorScheduleDecision::Seed
        );
        assert_eq!(
            curator_schedule_decision(now, Some(now + HOUR / 2), HOUR),
            CuratorScheduleDecision::NotDue(HOUR + HOUR / 2)
        );
    }

    #[test]
    fn foreground_idle_is_zero_during_a_turn() {
        let now = SystemTime::UNIX_EPOCH + 10 * HOUR;
        assert_eq!(
            curator_foreground_idle(now, now - HOUR, true),
            Duration::ZERO
        );
        assert_eq!(curator_foreground_idle(now, now - HOUR, false), HOUR);
        assert_eq!(
            curator_foreground_idle(now, now + HOUR, false),
            Duration::ZERO
        );
    }
}
