use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Offset, TimeZone, Timelike, Utc};
use fs2::FileExt;
use kcoder_types::ContentBlock;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::ffi::OsStr;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, broadcast};

mod delivery;

const STALE_AFTER: ChronoDuration = ChronoDuration::days(7);
const DEFAULT_JITTER_SECONDS: u64 = 30;
pub const APP_PROJECT_CRON_OWNER: &str = "kcoder-project-automations";

pub use kcoder_types::CronSchedule;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronJob {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub id: String,
    pub prompt: String,
    pub schedule: CronSchedule,
    pub created_at: DateTime<Utc>,
    pub next_run_at: DateTime<Utc>,
    pub last_fired_at: Option<DateTime<Utc>>,
    pub jitter_seconds: u64,
}

#[derive(Debug, Clone)]
pub struct CronFire {
    pub session_id: Option<String>,
    pub id: String,
    pub prompt: String,
    pub scheduled_at: DateTime<Utc>,
    pub coalesced: usize,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CronFile {
    #[serde(default = "cron_file_version")]
    version: u32,
    jobs: Vec<CronJob>,
    #[serde(default)]
    receipts: Vec<delivery::Receipt>,
    #[serde(default)]
    receipts_pruned: u64,
    #[serde(default)]
    confirmed_receipts_pruned: u64,
}

fn cron_file_version() -> u32 {
    1
}

#[derive(Debug)]
struct CronInner {
    path: PathBuf,
    owner_instance: String,
    acknowledgement_uncertain: std::sync::atomic::AtomicBool,
    jobs: Mutex<Vec<CronJob>>,
    tx: broadcast::Sender<CronFire>,
    owned_tx: broadcast::Sender<CronFire>,
    owners: Mutex<HashMap<String, usize>>,
    wake: Notify,
}

#[derive(Debug, Clone)]
pub struct CronScheduler(Arc<CronInner>);

/// Keeps local firing and cross-process schedule writes fenced during idle shutdown checks.
pub struct CronIdleReservation<'a> {
    _jobs: std::sync::MutexGuard<'a, Vec<CronJob>>,
    _file: JobsLock,
}

pub struct SessionCronSubscription {
    scheduler: CronScheduler,
    session_id: String,
    receiver: broadcast::Receiver<CronFire>,
}

impl SessionCronSubscription {
    /// Call while holding the scheduler's idle reservation to exclude new publication.
    pub fn has_pending_events(&self) -> bool {
        !self.receiver.is_empty()
    }
    pub async fn recv(&mut self) -> Result<CronFire, broadcast::error::RecvError> {
        loop {
            let event = self.receiver.recv().await?;
            if event.session_id.as_deref() == Some(self.session_id.as_str()) {
                if let Err(error) = self.scheduler.acknowledge_delivery(&event) {
                    tracing::warn!(%error, job_id = %event.id, "cron delivery acknowledgement failed; receipt remains uncertain, event will not be replayed");
                }
                return Ok(event);
            }
        }
    }
}

impl Drop for SessionCronSubscription {
    fn drop(&mut self) {
        let mut owners = self
            .scheduler
            .0
            .owners
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(count) = owners.get_mut(&self.session_id) {
            *count -= 1;
            if *count == 0 {
                owners.remove(&self.session_id);
            }
        }
    }
}

impl CronScheduler {
    pub fn load(cwd: &Path) -> Self {
        let path = cwd.join(".kcoder").join("cron").join("jobs.json");
        let mut jobs = Vec::new();
        if let Err(error) = refresh_jobs(&path, &mut jobs) {
            tracing::warn!(%error, "failed to load cron jobs");
        }
        let (tx, _) = broadcast::channel(64);
        let (owned_tx, _) = broadcast::channel(1024);
        Self(Arc::new(CronInner {
            path,
            owner_instance: delivery::owner_instance(),
            acknowledgement_uncertain: std::sync::atomic::AtomicBool::new(false),
            jobs: Mutex::new(jobs),
            tx,
            owned_tx,
            owners: Mutex::new(HashMap::new()),
            wake: Notify::new(),
        }))
    }

    pub fn schedule_runner(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let scheduler = self.clone();
        runtime.spawn(async move { scheduler.run().await });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CronFire> {
        self.0.tx.subscribe()
    }

    pub fn subscribe_session(&self, session_id: String) -> SessionCronSubscription {
        *self
            .0
            .owners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(session_id.clone())
            .or_default() += 1;
        SessionCronSubscription {
            scheduler: self.clone(),
            session_id,
            receiver: self.0.owned_tx.subscribe(),
        }
    }

    fn tool_session(&self, session_id: &str) -> Result<Option<String>, String> {
        let owners = self.0.owners.lock().unwrap_or_else(|p| p.into_inner());
        if owners.contains_key(APP_PROJECT_CRON_OWNER) {
            return Ok(Some(APP_PROJECT_CRON_OWNER.to_string()));
        }
        if owners.is_empty() {
            return Ok(None);
        }
        if owners.contains_key(session_id) {
            return Ok(Some(session_id.to_string()));
        }
        Err("scheduled tasks require a connected owning session".into())
    }

    pub fn create_for_session(
        &self,
        session_id: String,
        prompt: String,
        schedule: CronSchedule,
        jitter_seconds: Option<u64>,
    ) -> Result<CronJob, String> {
        self.create_owned(Some(session_id), prompt, schedule, jitter_seconds)
    }

    /// Upgrade App-owned jobs without changing their schedule, prompt or due time.
    /// Unbound standalone TUI jobs retain their existing execution semantics.
    pub fn migrate_app_jobs_to_project(&self) -> Result<usize, String> {
        if !self.0.path.exists() {
            return Ok(0);
        }
        let mut jobs = self.0.jobs.lock().unwrap_or_else(|p| p.into_inner());
        let _lock = lock_jobs(&self.0.path)?;
        refresh_jobs(&self.0.path, &mut jobs)?;
        let mut candidate = jobs.clone();
        let mut changed = 0;
        for job in &mut candidate {
            if job
                .session_id
                .as_deref()
                .is_some_and(|owner| owner != APP_PROJECT_CRON_OWNER)
            {
                job.session_id = Some(APP_PROJECT_CRON_OWNER.to_string());
                changed += 1;
            }
        }
        if changed == 0 {
            return Ok(0);
        }
        let parent = std::path::absolute(self.0.path.parent().ok_or("invalid cron path")?)
            .map_err(|e| e.to_string())?;
        let directory =
            kcoder_config::PrivateDirectory::open_existing(&parent).map_err(|e| e.to_string())?;
        let backup = format!(
            "jobs.before-project-{}.json",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let file = directory
            .open_regular_file(OsStr::new("jobs.json"))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("cron store exceeds 16 MiB".into());
        }
        directory
            .atomic_replace(OsStr::new(&backup), &bytes)
            .map_err(|e| e.to_string())?;
        persist_jobs(&self.0.path, &candidate)?;
        *jobs = candidate;
        Ok(changed)
    }

    pub fn create(
        &self,
        prompt: String,
        schedule: CronSchedule,
        jitter_seconds: Option<u64>,
    ) -> Result<CronJob, String> {
        self.create_owned(None, prompt, schedule, jitter_seconds)
    }

    fn create_owned(
        &self,
        session_id: Option<String>,
        prompt: String,
        schedule: CronSchedule,
        jitter_seconds: Option<u64>,
    ) -> Result<CronJob, String> {
        let prompt = prompt.trim().to_string();
        if prompt.is_empty() {
            return Err("cron prompt must not be empty".to_string());
        }
        if prompt.len() > 32 * 1024 {
            return Err("cron prompt exceeds 32 KiB".into());
        }
        let now = Utc::now();
        let mut hasher = DefaultHasher::new();
        prompt.hash(&mut hasher);
        now.timestamp_nanos_opt()
            .unwrap_or_default()
            .hash(&mut hasher);
        let id = format!("cron-{:x}", hasher.finish());
        let default_jitter = if matches!(&schedule, CronSchedule::At { .. }) {
            0
        } else {
            DEFAULT_JITTER_SECONDS
        };
        let jitter_seconds = jitter_seconds.unwrap_or(default_jitter).min(3600);
        let nominal = next_nominal(&schedule, now)?;
        let next_run_at = nominal
            .checked_add_signed(deterministic_jitter(&id, jitter_seconds))
            .ok_or_else(|| "scheduled time is out of range".to_string())?;
        let job = CronJob {
            session_id,
            id,
            prompt,
            schedule,
            created_at: now,
            next_run_at,
            last_fired_at: None,
            jitter_seconds,
        };
        let mut jobs = self.0.jobs.lock().unwrap_or_else(|p| p.into_inner());
        let _lock = lock_jobs(&self.0.path)?;
        refresh_jobs(&self.0.path, &mut jobs)?;
        if jobs.len() >= 256 {
            return Err("at most 256 scheduled tasks are allowed per workspace".into());
        }
        let mut candidate = jobs.clone();
        candidate.push(job.clone());
        persist_jobs(&self.0.path, &candidate)?;
        *jobs = candidate;
        drop(jobs);
        self.0.wake.notify_waiters();
        Ok(job)
    }

    pub fn delete(&self, id: &str) -> Result<bool, String> {
        self.delete_owned(id, None)
    }

    pub fn delete_for_session(&self, id: &str, session_id: &str) -> Result<bool, String> {
        self.delete_owned(id, Some(session_id))
    }

    fn delete_owned(&self, id: &str, session_id: Option<&str>) -> Result<bool, String> {
        self.delete_owned_mode(id, session_id, false)
    }

    fn delete_owned_mode(&self, id: &str, session_id: Option<&str>, receipts_only: bool) -> Result<bool, String> {
        let mut jobs = self.0.jobs.lock().unwrap_or_else(|p| p.into_inner());
        let _lock = lock_jobs(&self.0.path)?;
        refresh_jobs(&self.0.path, &mut jobs)?;
        let before = jobs.len();
        let mut candidate = jobs.clone();
        candidate.retain(|job| {
            receipts_only || job.id != id || session_id.is_some_and(|owner| job.session_id.as_deref() != Some(owner))
        });
        let mut file = read_cron_file(&self.0.path)?.unwrap_or_default();
        let receipt_count = file.receipts.len();
        file.receipts.retain(|receipt| receipt.job_id != id ||
            if receipts_only { receipt.session_id.as_deref() != session_id }
            else { session_id.is_some_and(|owner| receipt.session_id.as_deref() != Some(owner)) });
        let cleared = receipt_count - file.receipts.len();
        let deleted = candidate.len() != before || cleared > 0;
        if deleted {
            file.jobs = candidate.clone();
            file.receipts_pruned = file.receipts_pruned.saturating_add(cleared as u64);
            persist_cron_file(&self.0.path, &file)?;
            *jobs = candidate;
            self.0.wake.notify_waiters();
        }
        Ok(deleted)
    }

    pub fn list(&self) -> Vec<CronJob> {
        let mut jobs = self.0.jobs.lock().unwrap_or_else(|p| p.into_inner());
        if let Err(error) = refresh_jobs(&self.0.path, &mut jobs) {
            tracing::warn!(%error, "failed to refresh cron jobs");
        }
        jobs.clone()
    }

    pub fn list_for_session(&self, session_id: &str) -> Result<Vec<CronJob>, String> {
        let mut jobs = self.0.jobs.lock().unwrap_or_else(|p| p.into_inner());
        refresh_jobs(&self.0.path, &mut jobs)?;
        Ok(jobs
            .iter()
            .filter(|job| job.session_id.as_deref() == Some(session_id))
            .cloned()
            .collect())
    }

    pub fn try_reserve_idle(&self) -> Result<Option<CronIdleReservation<'_>>, String> {
        let Ok(mut jobs) = self.0.jobs.try_lock() else {
            return Ok(None);
        };
        let file = lock_jobs(&self.0.path)?;
        refresh_jobs(&self.0.path, &mut jobs)?;
        if !jobs.is_empty() {
            return Ok(None);
        }
        Ok(Some(CronIdleReservation {
            _jobs: jobs,
            _file: file,
        }))
    }

    async fn run(&self) {
        loop {
            self.fire_due(Utc::now());
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                _ = self.0.wake.notified() => {},
            }
        }
    }

    fn fire_due(&self, now: DateTime<Utc>) {
        // Do not advance durable state until a facade is listening. This is
        // the first half of idle gating: a headless/inactive session cannot
        // silently consume a trigger.
        if self.0.tx.receiver_count() == 0 && self.0.owned_tx.receiver_count() == 0 {
            return;
        }
        let mut events = Vec::new();
        let mut jobs = self.0.jobs.lock().unwrap_or_else(|p| p.into_inner());
        if jobs.is_empty() && !self.0.path.exists() {
            return;
        }
        let _lock = match lock_jobs(&self.0.path) {
            Ok(lock) => lock,
            Err(error) => {
                tracing::warn!(%error, "cron store is unavailable");
                return;
            }
        };
        if let Err(error) = refresh_jobs(&self.0.path, &mut jobs) {
            tracing::warn!(%error, "cron store is unreadable");
            return;
        }
        let owners = self.0.owners.lock().unwrap_or_else(|p| p.into_inner());
        let original_len = jobs.len();
        let mut candidate = jobs.clone();
        candidate.retain(|job| now - job.next_run_at <= STALE_AFTER);
        let mut remove = Vec::new();
        for job in candidate.iter_mut() {
            let listening = match &job.session_id {
                Some(owner) => owners.contains_key(owner),
                None => self.0.tx.receiver_count() > 0,
            };
            if !listening {
                continue;
            }
            if job.next_run_at > now {
                continue;
            }
            let scheduled_at = job.next_run_at;
            let mut coalesced = 0usize;
            match &job.schedule {
                CronSchedule::At { .. } => remove.push(job.id.clone()),
                schedule => {
                    let jitter = deterministic_jitter(&job.id, job.jitter_seconds);
                    let Some(mut nominal_cursor) = job.next_run_at.checked_sub_signed(jitter)
                    else {
                        tracing::warn!(job_id = %job.id, "cron cursor is out of range");
                        return;
                    };
                    loop {
                        let next_nominal_at = match next_nominal(schedule, nominal_cursor) {
                            Ok(next) => next,
                            Err(error) => {
                                tracing::warn!(job_id = %job.id, %error, "failed to advance cron cursor");
                                return;
                            }
                        };
                        nominal_cursor = next_nominal_at;
                        let Some(next_run_at) = next_nominal_at.checked_add_signed(jitter) else {
                            tracing::warn!(job_id = %job.id, "cron cursor is out of range");
                            return;
                        };
                        if next_run_at > now {
                            job.next_run_at = next_run_at;
                            break;
                        }
                        coalesced = coalesced.saturating_add(1);
                    }
                    job.last_fired_at = Some(now);
                }
            }
            events.push(CronFire {
                session_id: job.session_id.clone(),
                id: job.id.clone(),
                prompt: job.prompt.clone(),
                scheduled_at,
                coalesced,
            });
        }
        if !remove.is_empty() {
            candidate.retain(|job| !remove.contains(&job.id));
        }
        if candidate.len() == original_len && events.is_empty() { return; }
        let mut file = match read_cron_file(&self.0.path) {
            Ok(file) => file.unwrap_or_default(),
            Err(error) => { tracing::warn!(%error, "cron receipt store is unreadable"); return; }
        };
        file.jobs = candidate.clone();
        for event in &events {
            file.receipts.push(delivery::Receipt {
                job_id: event.id.clone(), scheduled_at: event.scheduled_at,
                session_id: event.session_id.clone(), recorded_at: now,
                owner_instance: self.0.owner_instance.clone(), phase: delivery::Phase::DispatchPending,
            });
        }
        delivery::retain_confirmed(&mut file, now);
        if file.receipts.len() > delivery::MAX_RECEIPTS {
            tracing::warn!("cron delivery receipt capacity reached; explicit receipt cleanup is required before new triggers");
            return;
        }
        #[cfg(test)]
        delivery::crash_point(&self.0.path, "before_commit");
        // The cursor and trigger evidence are one atomic authority write.
        if let Err(error) = persist_cron_file(&self.0.path, &file) {
            tracing::warn!(%error, "failed to persist cron schedule and trigger before firing");
            return;
        }
        *jobs = candidate;
        drop(jobs);
        #[cfg(test)]
        delivery::crash_point(&self.0.path, "after_commit");
        let mut queued = false;
        for event in events {
            let channel = if event.session_id.is_some() { &self.0.owned_tx } else { &self.0.tx };
            if channel.send(event.clone()).is_ok() {
                if let Some(receipt) = file.receipts.iter_mut().rev().find(|receipt|
                    receipt.job_id == event.id && receipt.scheduled_at == event.scheduled_at) {
                    receipt.phase = delivery::Phase::Queued;
                    queued = true;
                }
            }
        }
        // Keep the file lock until this annotation is committed. Failure retains
        // dispatch_pending: delivery is uncertain and must never be replayed.
        if queued && let Err(error) = persist_cron_file(&self.0.path, &file) {
            tracing::warn!(%error, "cron trigger queued but acknowledgement persistence failed");
        }
        #[cfg(test)]
        delivery::crash_point(&self.0.path, "after_queued");
    }
}

struct JobsLock(fs::File);

impl Drop for JobsLock {
    fn drop(&mut self) {
        // A concurrent fork can retain this open file description until exec.
        // Closing our descriptor alone would leave the transaction locked.
        if let Err(error) = FileExt::unlock(&self.0) {
            tracing::warn!(%error, "failed to unlock cron store");
        }
    }
}

fn lock_jobs(path: &Path) -> Result<JobsLock, String> {
    let parent = path.parent().ok_or("invalid cron path")?;
    let parent = std::path::absolute(parent).map_err(|error| error.to_string())?;
    let directory = kcoder_config::PrivateDirectory::open_or_create(&parent)
        .map_err(|error| error.to_string())?;
    directory
        .append(OsStr::new("jobs.lock"), b"")
        .map_err(|error| error.to_string())?;
    let file = directory
        .open_regular_file(OsStr::new("jobs.lock"))
        .map_err(|error| error.to_string())?;
    file.try_lock_exclusive()
        .map_err(|error| format!("cron store is busy: {error}"))?;
    Ok(JobsLock(file))
}

fn read_cron_file(path: &Path) -> Result<Option<CronFile>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err("cron store must be a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let parent = std::path::absolute(path.parent().ok_or("invalid cron path")?)
        .map_err(|error| error.to_string())?;
    let directory = kcoder_config::PrivateDirectory::open_existing(&parent)
        .map_err(|error| error.to_string())?;
    let file = directory
        .open_regular_file(path.file_name().ok_or("invalid cron filename")?)
        .map_err(|error| error.to_string())?;
    const LIMIT: u64 = 16 * 1024 * 1024;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("cron store exceeds 16 MiB".into());
    }
    let file: CronFile =
        serde_json::from_slice(&bytes).map_err(|error| format!("invalid cron store: {error}"))?;
    if !(1..=3).contains(&file.version) {
        return Err("unsupported cron store version".into());
    }
    if file.receipts.len() > delivery::MAX_RECEIPTS {
        return Err("cron receipt count exceeds limit".into());
    }
    Ok(Some(file))
}

fn refresh_jobs(path: &Path, jobs: &mut Vec<CronJob>) -> Result<(), String> {
    if let Some(file) = read_cron_file(path)? { *jobs = file.jobs; }
    Ok(())
}

fn persist_jobs(path: &Path, jobs: &[CronJob]) -> Result<(), String> {
    let mut file = read_cron_file(path)?.unwrap_or_default();
    file.jobs = jobs.to_vec();
    delivery::retain_confirmed(&mut file, Utc::now());
    persist_cron_file(path, &file)
}

fn persist_cron_file(path: &Path, file: &CronFile) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid cron path".to_string())?;
    let parent = std::path::absolute(parent).map_err(|error| error.to_string())?;
    let directory = kcoder_config::PrivateDirectory::open_or_create(&parent)
        .map_err(|error| error.to_string())?;
    // v1/v2 are read-compatible; old binaries reject v3 instead of silently
    // discarding receipts. Keep the exact pre-migration file for explicit rollback.
    if let Some(previous) = read_cron_file(path)? && previous.version < 3 {
        let backup = OsStr::new("jobs.before-delivery-v3.json");
        match directory.open_regular_file(backup) {
            Ok(_) => {},
            Err(error) if error.chain().any(|cause| cause.downcast_ref::<std::io::Error>()
                .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)) => {
                let mut bytes = Vec::new();
                directory.open_regular_file(OsStr::new("jobs.json")).map_err(|e| e.to_string())?
                    .take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                if bytes.len() > 16 * 1024 * 1024 { return Err("cron backup exceeds limit".into()); }
                directory.atomic_replace(backup, &bytes).map_err(|e| e.to_string())?;
            },
            Err(error) => return Err(error.to_string()),
        }
    }
    let bytes = serde_json::to_vec_pretty(&CronFile {
        version: 3,
        jobs: file.jobs.clone(),
        receipts: file.receipts.clone(),
        receipts_pruned: file.receipts_pruned,
        confirmed_receipts_pruned: file.confirmed_receipts_pruned,
    })
    .map_err(|error| error.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 { return Err("cron store exceeds 16 MiB".into()); }
    let name = path
        .file_name()
        .ok_or_else(|| "invalid cron path".to_string())?;
    directory
        .atomic_replace(name, &bytes)
        .map_err(|error| error.to_string())
}

fn deterministic_jitter(id: &str, max_seconds: u64) -> ChronoDuration {
    // Persisted tasks may also contain oversized values; enforce the one-hour creation limit consistently.
    let max_seconds = max_seconds.min(3600);
    if max_seconds == 0 {
        return ChronoDuration::zero();
    }
    let mut hasher = DefaultHasher::new();
    id.hash(&mut hasher);
    ChronoDuration::seconds((hasher.finish() % (max_seconds + 1)) as i64)
}

/// Read-only calendar validation and nominal next occurrence. Does not create a job.
pub fn preview_schedule(schedule: &CronSchedule) -> Result<DateTime<Utc>, String> {
    next_nominal(schedule, Utc::now())
}

fn next_nominal(schedule: &CronSchedule, after: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
    match schedule {
        CronSchedule::At { at } => {
            let at = DateTime::parse_from_rfc3339(at)
                .map_err(|_| "at must be an RFC3339 timestamp".to_string())?
                .with_timezone(&Utc);
            if at > after {
                Ok(at)
            } else {
                Err("scheduled time must be in the future".to_string())
            }
        }
        CronSchedule::Every { every_seconds } if *every_seconds > 0 => {
            let interval = i64::try_from(*every_seconds)
                .ok()
                .and_then(ChronoDuration::try_seconds)
                .ok_or_else(|| "every_seconds is out of range".to_string())?;
            after
                .checked_add_signed(interval)
                .ok_or_else(|| "scheduled time is out of range".to_string())
        }
        CronSchedule::Every { .. } => Err("every_seconds must be greater than zero".to_string()),
        CronSchedule::Cron { expression } => next_cron_minute(expression, after),
        CronSchedule::ZonedCron {
            expression,
            timezone,
        } => {
            let timezone = timezone
                .parse::<chrono_tz::Tz>()
                .map_err(|_| "invalid IANA timezone".to_string())?;
            next_cron_minute_in_zone(expression, after, timezone)
        }
    }
}

fn next_cron_minute(expression: &str, after: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
    next_cron_minute_in_zone(expression, after, chrono_tz::UTC)
}

fn next_cron_minute_in_zone(
    expression: &str,
    after: DateTime<Utc>,
    timezone: chrono_tz::Tz,
) -> Result<DateTime<Utc>, String> {
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err(
            "cron expression must have 5 fields: minute hour day month weekday".to_string(),
        );
    }
    let bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];
    let masks = fields
        .iter()
        .zip(bounds)
        .map(|(field, (min, max))| cron_field_mask(field, min, max))
        .collect::<Result<Vec<_>, _>>()?;
    let mut cursor = after
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(after)
        .checked_add_signed(ChronoDuration::minutes(1))
        .ok_or_else(|| "scheduled time is out of range".to_string())?;
    // Scan absolute instants: nonexistent local minutes are skipped, and both
    // occurrences of a repeated local minute can match. Keep the existing
    // all-fields (AND), jitter, idle and missed-run semantics unchanged.
    for _ in 0..(366 * 24 * 60) {
        let offset = timezone
            .offset_from_utc_datetime(&cursor.naive_utc())
            .fix()
            .local_minus_utc();
        let local = cursor
            .naive_utc()
            .checked_add_signed(ChronoDuration::seconds(i64::from(offset)))
            .ok_or_else(|| "scheduled local time is out of range".to_string())?;
        let values = [
            local.minute(),
            local.hour(),
            local.day(),
            local.month(),
            local.weekday().num_days_from_sunday(),
        ];
        if masks
            .iter()
            .zip(values)
            .all(|(mask, value)| mask & (1u64 << value) != 0)
        {
            return Ok(cursor);
        }
        cursor = cursor
            .checked_add_signed(ChronoDuration::minutes(1))
            .ok_or_else(|| "scheduled time is out of range".to_string())?;
    }
    Err("cron expression has no trigger in the next 366 days".to_string())
}

fn cron_field_mask(field: &str, min: u32, max: u32) -> Result<u64, String> {
    let mut mask = 0u64;
    let number = |text: &str| -> Result<u32, String> {
        let value = text
            .parse::<u32>()
            .map_err(|_| "invalid cron field".to_string())?;
        if value < min || value > max {
            return Err("cron field is out of range".to_string());
        }
        Ok(value)
    };
    for part in field.split(',') {
        let (range, step) = if let Some((range, step)) = part.split_once('/') {
            let step = step
                .parse::<u32>()
                .map_err(|_| "invalid cron step".to_string())?;
            if step == 0 {
                return Err("cron step must be greater than zero".to_string());
            }
            (range, step)
        } else {
            (part, 1)
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            (number(start)?, number(end)?)
        } else {
            let start = number(range)?;
            (start, if part.contains('/') { max } else { start })
        };
        if start > end {
            return Err("cron range is reversed".to_string());
        }
        for value in (start..=end).step_by(step as usize) {
            let value = if max == 7 && value == 7 { 0 } else { value };
            mask |= 1u64 << value;
        }
    }
    Ok(mask)
}

#[cfg(test)]
fn cron_field_matches(field: &str, value: u32, min: u32, max: u32) -> Result<bool, String> {
    Ok(cron_field_mask(field, min, max)? & (1u64 << value) != 0)
}

#[derive(Debug, Default)]
pub struct CronCreateTool;
#[derive(Debug, Deserialize, JsonSchema)]
pub struct CronCreateInput {
    /// Reminder/task prompt to inject when the schedule fires.
    pub prompt: String,
    /// One-time, interval, legacy UTC cron, or explicitly zoned calendar schedule.
    pub schedule: CronSchedule,
    /// Deterministic anti-herd offset; defaults to 30 seconds. Use 0 for exact timing.
    pub jitter_seconds: Option<u64>,
}

#[async_trait]
impl Tool for CronCreateTool {
    fn name(&self) -> String {
        "cron_create".to_string()
    }
    fn description(&self) -> String {
        "Create a persistent scheduled task only after the user explicitly asks for it. Supports a one-time RFC3339 UTC time, an every_seconds interval, a legacy five-field UTC cron expression, or zoned_cron with an IANA timezone. Zoned clocks skip nonexistent local minutes and may fire at both instances of a repeated local minute. Triggers wait behind an active turn, missed occurrences coalesce into one delivery, deterministic jitter avoids synchronized bursts, and undelivered schedules older than seven days expire. Never create a job merely because a background review suggested one; present the proposal and obtain user consent first.".to_string()
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CronCreateInput))
    }
    fn is_read_only(&self) -> bool {
        false
    }
    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CronCreateInput = parse_input(&input)?;
        let scheduler = ctx
            .cron_scheduler
            .as_ref()
            .ok_or_else(|| ToolError::Execution("cron scheduler is unavailable".to_string()))?;
        let owner = scheduler
            .tool_session(&ctx.state.session_id())
            .map_err(ToolError::Execution)?;
        let job = scheduler
            .create_owned(owner, input.prompt, input.schedule, input.jitter_seconds)
            .map_err(ToolError::Execution)?;
        json_output(&job)
    }
}

#[derive(Debug, Default)]
pub struct CronDeleteTool;
#[derive(Debug, Deserialize, JsonSchema)]
pub struct CronDeleteInput {
    pub id: String,
    /// Clear delivery diagnostics only; leave the schedule and cursor unchanged.
    #[serde(default)]
    pub receipts_only: bool,
    /// Required when clearing uncertain delivery evidence.
    #[serde(default)]
    pub confirmed: bool,
}

#[async_trait]
impl Tool for CronDeleteTool {
    fn name(&self) -> String {
        "cron_delete".to_string()
    }
    fn description(&self) -> String {
        "Delete one persistent cron job by its exact id. To clear delivery diagnostics WITHOUT deleting an active schedule, set receipts_only:true and confirmed:true after explicit user confirmation. Missing records return deleted=false; no operation replays a trigger.".to_string()
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CronDeleteInput))
    }
    fn is_read_only(&self) -> bool {
        false
    }
    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CronDeleteInput = parse_input(&input)?;
        let scheduler = ctx
            .cron_scheduler
            .as_ref()
            .ok_or_else(|| ToolError::Execution("cron scheduler is unavailable".to_string()))?;
        let owner = scheduler
            .tool_session(&ctx.state.session_id())
            .map_err(ToolError::Execution)?;
        if input.receipts_only && !input.confirmed {
            return Err(ToolError::Execution("receipt cleanup requires explicit confirmation".into()));
        }
        let deleted = if input.receipts_only {
            scheduler.clear_delivery_receipts(&input.id, owner.as_deref())
        } else { scheduler.delete_owned(&input.id, owner.as_deref()) }.map_err(ToolError::Execution)?;
        json_output(&serde_json::json!({"deleted":deleted, "receiptsOnly":input.receipts_only,
            "schedulePreserved":input.receipts_only}))
    }
}

#[derive(Debug, Default)]
pub struct CronListTool;
#[derive(Debug, Deserialize, JsonSchema)]
pub struct CronListInput {}

#[async_trait]
impl Tool for CronListTool {
    fn name(&self) -> String {
        "cron_list".to_string()
    }
    fn description(&self) -> String {
        "List persistent scheduled jobs with ids, prompts, schedules, next trigger times, jitter, and last delivery times.".to_string()
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CronListInput))
    }
    fn is_read_only(&self) -> bool {
        true
    }
    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let _: CronListInput = parse_input(&input)?;
        let scheduler = ctx
            .cron_scheduler
            .as_ref()
            .ok_or_else(|| ToolError::Execution("cron scheduler is unavailable".to_string()))?;
        let owner = scheduler
            .tool_session(&ctx.state.session_id())
            .map_err(ToolError::Execution)?;
        let mut output = match owner.as_deref() {
            Some(owner) => json_output(&scheduler.list_for_session(owner).map_err(ToolError::Execution)?),
            None => json_output(&scheduler.list()),
        }?;
        // Preserve the original jobs-array text block for existing consumers.
        output.content.push(ContentBlock::Text { text: serde_json::json!({
            "deliveryDiagnostics": scheduler.delivery_diagnostics(owner.as_deref()).map_err(ToolError::Execution)?
        }).to_string() });
        Ok(output)
    }
}

fn json_output(value: &impl Serialize) -> Result<ToolOutput, ToolError> {
    Ok(ToolOutput {
        content: vec![ContentBlock::Text {
            text: serde_json::to_string_pretty(value)
                .map_err(|error| ToolError::Execution(error.to_string()))?,
        }],
        is_error: false,
        execution_metadata: Vec::new(),
        user_context: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn idle_reservation_fences_other_scheduler_writes_and_preserves_due_events() {
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let other = CronScheduler::load(root.path());
        let reserved = scheduler.try_reserve_idle().unwrap().unwrap();
        assert!(scheduler.try_reserve_idle().unwrap().is_none());
        assert!(other.try_reserve_idle().is_err());
        assert!(
            other
                .create(
                    "blocked".into(),
                    CronSchedule::Every { every_seconds: 60 },
                    Some(0)
                )
                .is_err()
        );
        drop(reserved);
        let subscription = scheduler.subscribe_session(APP_PROJECT_CRON_OWNER.into());
        scheduler
            .create_for_session(
                APP_PROJECT_CRON_OWNER.into(),
                "once".into(),
                CronSchedule::At {
                    at: (Utc::now() + ChronoDuration::seconds(1)).to_rfc3339(),
                },
                Some(0),
            )
            .unwrap();
        assert!(scheduler.try_reserve_idle().unwrap().is_none());
        scheduler.fire_due(Utc::now() + ChronoDuration::seconds(2));
        let _reserved = scheduler.try_reserve_idle().unwrap().unwrap();
        assert!(
            subscription.has_pending_events(),
            "removed one-shot still has an undelivered trigger"
        );
    }
    #[cfg(unix)]
    #[test]
    fn lock_release_does_not_wait_for_inherited_file_descriptions() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".kcoder").join("cron").join("jobs.json");
        let lock = lock_jobs(&path).unwrap();
        // dup and fork retain the same open file description, including flock state.
        let inherited = lock.0.try_clone().unwrap();
        assert!(lock_jobs(&path).is_err());
        drop(lock);
        let next =
            lock_jobs(&path).expect("the transaction must release its lock before child exec");
        assert!(lock_jobs(&path).is_err());
        drop(inherited);
        assert!(lock_jobs(&path).is_err());
        drop(next);
        assert!(lock_jobs(&path).is_ok());
    }

    #[test]
    fn app_job_migration_is_idempotent_preserves_schedule_and_keeps_a_backup() {
        use super::*;
        let root = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(root.path());
        let old = scheduler
            .create_for_session(
                "old-thread".into(),
                "keep this prompt".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        scheduler
            .create(
                "standalone TUI".into(),
                CronSchedule::Every { every_seconds: 90 },
                Some(0),
            )
            .unwrap();
        let path = root.path().join(".kcoder/cron/jobs.json");
        let before = fs::read(&path).unwrap();
        assert_eq!(scheduler.migrate_app_jobs_to_project().unwrap(), 1);
        let migrated = scheduler
            .list_for_session(APP_PROJECT_CRON_OWNER)
            .unwrap()
            .remove(0);
        let mut expected = serde_json::to_value(old).unwrap();
        expected["session_id"] = serde_json::json!(APP_PROJECT_CRON_OWNER);
        assert_eq!(serde_json::to_value(migrated).unwrap(), expected);
        assert!(scheduler.list().iter().any(|job| job.session_id.is_none()));
        let backups = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("jobs.before-project-")
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(backups[0].path()).unwrap(), before);
        assert_eq!(
            CronScheduler::load(root.path())
                .migrate_app_jobs_to_project()
                .unwrap(),
            0
        );
    }
    use super::*;

    #[test]
    fn independent_managers_preserve_jobs_and_cannot_delete_other_session_jobs() {
        let temp = tempfile::tempdir().unwrap();
        let first = CronScheduler::load(temp.path());
        let second = CronScheduler::load(temp.path());
        let a = first
            .create_for_session(
                "a".into(),
                "A".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        let b = second
            .create_for_session(
                "b".into(),
                "B".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        assert_eq!(first.list().len(), 2);
        assert_eq!(first.list_for_session("a").unwrap()[0].id, a.id);
        assert!(!first.delete_for_session(&b.id, "a").unwrap());
        assert!(second.delete_for_session(&b.id, "b").unwrap());
        assert_eq!(first.list().len(), 1);
    }

    #[test]
    fn session_delivery_is_gated_and_claimed_once_across_managers() {
        let temp = tempfile::tempdir().unwrap();
        let first = CronScheduler::load(temp.path());
        let job = first
            .create_for_session(
                "a".into(),
                "A".into(),
                CronSchedule::At {
                    at: (Utc::now() + ChronoDuration::minutes(1)).to_rfc3339(),
                },
                Some(0),
            )
            .unwrap();
        let mut legacy = first.subscribe();
        first.fire_due(job.next_run_at);
        assert!(legacy.try_recv().is_err());
        assert_eq!(first.list().len(), 1);
        let second = CronScheduler::load(temp.path());
        let mut one = first.subscribe_session("a".into());
        let mut two = second.subscribe_session("a".into());
        first.fire_due(job.next_run_at);
        second.fire_due(job.next_run_at);
        assert_eq!(one.receiver.try_recv().unwrap().id, job.id);
        assert!(two.receiver.try_recv().is_err());
        assert!(legacy.try_recv().is_err());
    }

    #[test]
    fn empty_session_polling_does_not_create_workspace_files() {
        let temp = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(temp.path());
        let _subscriber = scheduler.subscribe_session("a".into());
        scheduler.fire_due(Utc::now());
        assert!(!temp.path().join(".kcoder").exists());
    }

    #[test]
    fn model_tools_share_session_binding_but_preserve_legacy_tui_delivery() {
        let temp = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(temp.path());
        let _legacy = scheduler.subscribe();
        assert_eq!(scheduler.tool_session("tui").unwrap(), None);
        let bound = scheduler.subscribe_session("connected".into());
        assert_eq!(
            scheduler.tool_session("connected").unwrap(),
            Some("connected".into())
        );
        assert!(scheduler.tool_session("unconnected-child").is_err());
        drop(bound);
        assert_eq!(scheduler.tool_session("tui").unwrap(), None);
    }

    #[test]
    fn deterministic_jitter_is_stable_and_bounded() {
        let first = deterministic_jitter("cron-a", 30);
        assert_eq!(first, deterministic_jitter("cron-a", 30));
        assert!(first <= ChronoDuration::seconds(30));
    }

    #[test]
    fn create_rejects_unrepresentable_intervals_and_dates() {
        let temp = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(temp.path());
        for every_seconds in [u64::MAX, i64::MAX as u64, 100_000_000_000_000] {
            assert!(
                scheduler
                    .create(
                        "review".into(),
                        CronSchedule::Every { every_seconds },
                        Some(0)
                    )
                    .is_err()
            );
        }
        assert!(
            next_nominal(
                &CronSchedule::Every { every_seconds: 1 },
                DateTime::<Utc>::MAX_UTC
            )
            .is_err()
        );
        assert!(next_cron_minute("* * * * *", DateTime::<Utc>::MAX_UTC).is_err());
        assert!(deterministic_jitter("cron-a", u64::MAX) <= ChronoDuration::seconds(3600));
        assert!(scheduler.list().is_empty());
    }

    #[test]
    fn zoned_calendar_keeps_weekdays_month_boundaries_and_dst_instants() {
        let next = |expression: &str, timezone: &str, after: &str| {
            next_nominal(
                &CronSchedule::ZonedCron {
                    expression: expression.into(),
                    timezone: timezone.into(),
                },
                DateTime::parse_from_rfc3339(after)
                    .unwrap()
                    .with_timezone(&Utc),
            )
            .unwrap()
            .to_rfc3339()
        };
        assert_eq!(
            next("30 0 * * 1", "Asia/Tokyo", "2026-09-20T14:00:00Z"),
            "2026-09-20T15:30:00+00:00"
        );
        assert_eq!(
            next("30 0 * * 1-5", "Asia/Tokyo", "2026-09-20T14:00:00Z"),
            "2026-09-20T15:30:00+00:00"
        );
        assert_eq!(
            next("30 0 1 * *", "Asia/Tokyo", "2026-09-30T12:00:00Z"),
            "2026-09-30T15:30:00+00:00"
        );
        assert_eq!(
            next("30 23 1 * *", "America/New_York", "2026-03-01T00:00:00Z"),
            "2026-03-02T04:30:00+00:00"
        );
        assert_eq!(
            next("10 0 * * *", "Asia/Kathmandu", "2026-09-20T18:00:00Z"),
            "2026-09-20T18:25:00+00:00"
        );
        assert_eq!(
            next("30 2 * * *", "Europe/Berlin", "2026-03-28T23:00:00Z"),
            "2026-03-30T00:30:00+00:00"
        );
        assert_eq!(
            next("30 2 * * *", "Europe/Berlin", "2026-10-24T23:00:00Z"),
            "2026-10-25T00:30:00+00:00"
        );
        assert_eq!(
            next("30 2 * * *", "Europe/Berlin", "2026-10-25T00:30:00Z"),
            "2026-10-25T01:30:00+00:00"
        );
        let legacy: CronSchedule =
            serde_json::from_value(serde_json::json!({"kind":"cron","expression":"30 0 * * 1"}))
                .unwrap();
        assert_eq!(
            next_nominal(
                &legacy,
                DateTime::parse_from_rfc3339("2026-09-20T14:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc)
            )
            .unwrap()
            .to_rfc3339(),
            "2026-09-21T00:30:00+00:00"
        );
        assert!(
            serde_json::from_value::<CronSchedule>(
                serde_json::json!({"kind":"cron","expression":"0 9 * * *","timezone":"Asia/Tokyo"})
            )
            .is_err()
        );
    }

    #[test]
    fn zoned_schedule_persists_timezone_and_next_instant_without_recalculation() {
        let temp = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(temp.path());
        let job = scheduler
            .create(
                "review".into(),
                CronSchedule::ZonedCron {
                    expression: "0 9 * * 1-5".into(),
                    timezone: "Asia/Tokyo".into(),
                },
                Some(0),
            )
            .unwrap();
        let restored = CronScheduler::load(temp.path()).list();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].next_run_at, job.next_run_at);
        assert!(
            matches!(&restored[0].schedule, CronSchedule::ZonedCron {timezone, ..} if timezone == "Asia/Tokyo")
        );
        assert!(
            scheduler
                .create(
                    "invalid".into(),
                    CronSchedule::ZonedCron {
                        expression: "* * * * *".into(),
                        timezone: "not-a-zone".into()
                    },
                    Some(0)
                )
                .is_err()
        );
        assert_eq!(scheduler.list().len(), 1);
    }

    #[test]
    fn studio_weekday_expression_accepts_ranges_and_validates_every_field() {
        assert!(cron_field_matches("1-5", 1, 0, 7).unwrap());
        assert!(cron_field_matches("1-5", 5, 0, 7).unwrap());
        assert!(!cron_field_matches("1-5", 0, 0, 7).unwrap());
        assert!(cron_field_matches("10-20/5", 15, 0, 59).unwrap());
        assert!(!cron_field_matches("10-20/5", 16, 0, 59).unwrap());
        for invalid in ["5-1", "1-8", "*/0", "1,garbage"] {
            assert!(cron_field_matches(invalid, 1, 0, 7).is_err());
        }
    }

    #[test]
    fn cron_parser_supports_lists_steps_and_sunday_seven() {
        assert!(cron_field_matches("*/5", 10, 0, 59).unwrap());
        assert!(cron_field_matches("1,3,7", 3, 0, 7).unwrap());
        assert!(cron_field_matches("7", 0, 0, 7).unwrap());
    }

    #[test]
    fn failed_persistence_does_not_commit_or_broadcast() {
        let temp = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(temp.path());
        let job = scheduler
            .create(
                "review".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        let original = serde_json::to_value(scheduler.list()).unwrap();
        fs::remove_file(&scheduler.0.path).unwrap();
        fs::create_dir(&scheduler.0.path).unwrap();
        assert!(
            scheduler
                .create(
                    "other".into(),
                    CronSchedule::Every { every_seconds: 60 },
                    Some(0)
                )
                .is_err()
        );
        assert_eq!(serde_json::to_value(scheduler.list()).unwrap(), original);
        assert!(scheduler.delete(&job.id).is_err());
        assert_eq!(serde_json::to_value(scheduler.list()).unwrap(), original);
        let mut receiver = scheduler.subscribe();
        scheduler.fire_due(job.next_run_at);
        assert!(receiver.try_recv().is_err());
        assert_eq!(serde_json::to_value(scheduler.list()).unwrap(), original);
        fs::remove_dir(&scheduler.0.path).unwrap();
        scheduler.fire_due(job.next_run_at);
        assert_eq!(receiver.try_recv().unwrap().id, job.id);
        scheduler.fire_due(job.next_run_at);
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            serde_json::to_value(CronScheduler::load(temp.path()).list()).unwrap(),
            serde_json::to_value(scheduler.list()).unwrap()
        );
    }

    #[test]
    fn failed_one_shot_persistence_keeps_job_for_retry() {
        let temp = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(temp.path());
        let job = scheduler
            .create(
                "one shot".into(),
                CronSchedule::At {
                    at: (Utc::now() + ChronoDuration::minutes(1)).to_rfc3339(),
                },
                Some(0),
            )
            .unwrap();
        let mut receiver = scheduler.subscribe();
        fs::remove_file(&scheduler.0.path).unwrap();
        fs::create_dir(&scheduler.0.path).unwrap();
        scheduler.fire_due(job.next_run_at);
        assert_eq!(scheduler.list().len(), 1);
        assert!(receiver.try_recv().is_err());
        fs::remove_dir(&scheduler.0.path).unwrap();
        scheduler.fire_due(job.next_run_at);
        assert_eq!(receiver.try_recv().unwrap().id, job.id);
        assert!(scheduler.list().is_empty());
        scheduler.fire_due(job.next_run_at);
        assert!(receiver.try_recv().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn persistence_ignores_legacy_temporary_symlink_and_is_private() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(temp.path());
        let outside = temp.path().join("outside");
        fs::write(&outside, "sentinel").unwrap();
        fs::create_dir_all(scheduler.0.path.parent().unwrap()).unwrap();
        symlink(&outside, scheduler.0.path.with_extension("json.tmp")).unwrap();
        scheduler
            .create(
                "review".into(),
                CronSchedule::Every { every_seconds: 60 },
                Some(0),
            )
            .unwrap();
        assert_eq!(fs::read_to_string(outside).unwrap(), "sentinel");
        assert_eq!(
            fs::metadata(&scheduler.0.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn missed_interval_triggers_coalesce_once_and_advance_durable_cursor() {
        let temp = tempfile::tempdir().unwrap();
        let scheduler = CronScheduler::load(temp.path());
        let mut receiver = scheduler.subscribe();
        let now = Utc::now().with_nanosecond(0).expect("valid nanoseconds");
        scheduler.0.jobs.lock().unwrap().push(CronJob {
            session_id: None,
            id: "cron-test".to_string(),
            prompt: "run review".to_string(),
            schedule: CronSchedule::Every { every_seconds: 60 },
            created_at: now - ChronoDuration::minutes(10),
            next_run_at: now - ChronoDuration::minutes(3),
            last_fired_at: None,
            jitter_seconds: 0,
        });

        scheduler.fire_due(now);

        let event = receiver.try_recv().expect("one coalesced fire");
        assert_eq!(event.coalesced, 3);
        assert!(receiver.try_recv().is_err());
        let jobs = scheduler.list();
        assert_eq!(jobs.len(), 1);
        assert!(jobs[0].next_run_at > now);
        assert!(scheduler.0.path.exists());
    }
}
