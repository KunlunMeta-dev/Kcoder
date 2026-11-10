use crate::validate_thread_id;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_app_protocol::Thread;
use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
use kcoder_state::history_index::{
    BaselineState, CommittedListProjection, HistoryListProjection, HistoryListProjectionReader,
    HistorySourceObservation, ListCatalogCheckpoint, ListCatalogDelta, ListCatalogSession,
    TrackedHistoryCatalog,
};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::ffi::OsStr;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Workspace and per-thread metadata from the authorized App Server runtime.
pub trait TrackedHistoryHost {
    fn history_path(&self) -> Option<PathBuf>;
    fn client_storage_root(&self) -> PathBuf;
    fn history_scan_roots(&self, history: &Path) -> Vec<PathBuf>;
    fn canonical_workspace(&self) -> Result<String>;
    fn has_creation_record(&self, id: &str) -> Result<bool>;
    fn decorate_snapshot(&self, id: &str, snapshot: &mut Value) -> Result<()>;
}

#[derive(Default)]
pub struct PersistedThreadSnapshotReport {
    pub threads: Vec<Value>,
    pub issue_count: u64,
}

pub fn candidate_thread_history_path(history_dir: &Path, thread_id: &str) -> Result<PathBuf> {
    validate_thread_id(thread_id)?;
    Ok(history_dir.join(format!("{thread_id}.jsonl")))
}

const MAX_SIDECAR_BYTES: u64 = 1024 * 1024;
const MAX_ROW_BYTES: usize = 64 * 1024;
const BUILDER_LOCK: &str = ".kcoder-tracked-list-builder.lock";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildPhase {
    Building,
    Ready,
    Incomplete,
}

#[derive(Clone, Debug)]
pub struct BuildProgress {
    pub phase: BuildPhase,
    pub examined_entries: u64,
    pub indexed_sessions: u64,
    pub issue_count: u64,
    pub issues: Vec<kcoder_app_protocol::ThreadHistoryRefreshIssue>,
}

#[derive(Clone, Copy)]
pub struct StepBudget {
    pub entries: usize,
    pub body_bytes: u64,
    pub line_bytes: usize,
    pub row_bytes: usize,
}

impl Default for StepBudget {
    fn default() -> Self {
        Self {
            entries: 128,
            body_bytes: 32 * 1024 * 1024,
            line_bytes: 4 * 1024 * 1024,
            row_bytes: 2 * 1024 * 1024,
        }
    }
}

pub struct ListBudget {
    pub dirty: StepBudget,
    pub max_rows: usize,
}
impl Default for ListBudget {
    fn default() -> Self {
        Self {
            dirty: StepBudget::default(),
            max_rows: 4096,
        }
    }
}

#[derive(Default)]
pub struct TrackedHistoryList {
    build: Option<BuildSession>,
}
impl TrackedHistoryList {
    pub fn begin(
        &mut self,
        host: &dyn TrackedHistoryHost,
        acknowledge_external_writers: bool,
    ) -> Result<BuildProgress> {
        ensure!(
            acknowledge_external_writers,
            "explicit acknowledgement of external-writer refresh is required"
        );
        ensure!(
            self.build.is_none(),
            "a tracked list build is already active"
        );
        let history_path = host.history_path().context("session history is disabled")?;
        let history_root = history_path
            .parent()
            .context("history source has no parent")?;
        // Explicit opt-in may initialize deferred storage, but never creates a ghost session.
        ensure_root(history_root)?;
        ensure_root(&host.client_storage_root())?;
        let scope = Scope::resolve(host)?;
        let guard = builder_guard(&scope.client)?;
        // Only explicit begin activates tracking; no lifecycle locks span enumeration.
        let mut source = JournalFence::try_acquire(&scope.history, JournalDomain::History)?;
        let mut client = JournalFence::try_acquire(&scope.client, JournalDomain::ClientMetadata)?;
        source.activate()?;
        client.activate()?;
        let mut catalog = scope
            .open(true)?
            .context("tracked list storage is unavailable")?;
        let checkpoint = catalog.begin_baseline(&catalog.checkpoint()?.revision)?;
        drop(client);
        drop(source);
        let scanners = scope
            .scan_roots
            .iter()
            .map(|root| kcoder_state::SessionCandidateScanner::open(root))
            .collect::<Result<std::collections::VecDeque<_>>>()?;
        let progress = BuildProgress {
            phase: BuildPhase::Building,
            examined_entries: 0,
            indexed_sessions: 0,
            issue_count: 0,
            issues: Vec::new(),
        };
        self.build = Some(BuildSession {
            scope,
            catalog,
            checkpoint,
            scanners,
            seen_candidate_ids: std::collections::HashSet::new(),
            pending: VecDeque::new(),
            reading: None,
            dirty: None,
            dirty_rows: Vec::new(),
            dirty_deleted: Vec::new(),
            enumeration_done: false,
            progress: progress.clone(),
            _guard: guard,
        });
        Ok(progress)
    }

    pub fn step(
        &mut self,
        host: &dyn TrackedHistoryHost,
        budget: StepBudget,
    ) -> Result<BuildProgress> {
        budget.validate()?;
        let build = self
            .build
            .as_mut()
            .context("no active tracked list build")?;
        ensure!(
            build.scope == Scope::resolve(host)?,
            "tracked list build belongs to another workspace"
        );
        if let Err(error) = build.advance(host, budget) {
            tracing::debug!(%error, "tracked list build incomplete; authority remains required");
            build.progress.issue_count = build.progress.issue_count.saturating_add(1);
            if build.progress.issues.len() < MAX_REFRESH_ISSUE_DETAILS {
                build
                    .progress
                    .issues
                    .push(kcoder_app_protocol::ThreadHistoryRefreshIssue {
                        session_id: None,
                        reason: error.to_string(),
                    });
            }
            build.progress.phase = BuildPhase::Incomplete;
        }
        let progress = build.progress.clone();
        if progress.phase != BuildPhase::Building {
            self.build = None;
        }
        Ok(progress)
    }

    pub fn cancel(&mut self) {
        self.build = None;
    }

    #[cfg(feature = "test-oracle")]
    pub fn test_scan_drained(&self) -> bool {
        let build = self.build.as_ref().expect("tracked list build active");
        build.enumeration_done && build.pending.is_empty() && build.reading.is_none()
    }

    #[cfg(feature = "test-oracle")]
    pub fn test_has_active_source(&self) -> bool {
        self.build
            .as_ref()
            .is_some_and(|build| build.reading.is_some())
    }

    #[cfg(feature = "test-oracle")]
    pub fn test_active_source_bytes_read(&self) -> Option<u64> {
        self.build
            .as_ref()?
            .reading
            .as_ref()
            .map(|source| source.reader.bytes_read())
    }

    pub fn try_list(
        host: &dyn TrackedHistoryHost,
        running: &HashSet<String>,
        excluded: &HashSet<String>,
        budget: ListBudget,
    ) -> Result<Option<PersistedThreadSnapshotReport>> {
        budget.dirty.validate()?;
        ensure!(
            (1..=4096).contains(&budget.max_rows),
            "invalid tracked list snapshot budget"
        );
        let attempt = || -> Result<Option<PersistedThreadSnapshotReport>> {
            let scope = Scope::resolve(host)?;
            // Probe existing storage read-only. Missing/building catalogs never cause creation.
            let Some(mut catalog) = scope.open(false)? else {
                return Ok(None);
            };
            if catalog.checkpoint()?.state != BaselineState::Ready {
                return Ok(None);
            }
            let ready = match catalog.read_ready(budget.max_rows)? {
                Some(ready) => ready,
                None => {
                    let delta = catalog.prepare_update(budget.dirty.entries)?;
                    drop(catalog);
                    let (rows, deleted) =
                        project_dirty(host, &scope, delta.session_ids(), budget.dirty)?;
                    let mut catalog = scope.open(true)?.context("tracked list disappeared")?;
                    let deleted: Vec<_> = deleted.iter().map(String::as_str).collect();
                    catalog.commit_update(delta, &rows, &deleted)?;
                    let Some(ready) = catalog.read_ready(budget.max_rows)? else {
                        return Ok(None);
                    };
                    ready
                }
            };
            let mut threads = Vec::new();
            for row in ready.sessions {
                ensure!(
                    row.metadata["id"].as_str() == Some(&row.session_id),
                    "tracked row identity mismatch"
                );
                if excluded.contains(&row.session_id) {
                    continue;
                }
                let _: kcoder_types::StudioWorkMode =
                    serde_json::from_value(row.metadata["studioWorkMode"].clone())
                        .context("tracked work mode projection is stale")?;
                ensure!(
                    row.metadata.get("modelSelectionMode").is_some()
                        && row.metadata.get("selectedModel").is_some(),
                    "tracked model selection projection is stale"
                );
                let mut snapshot = row.metadata;
                snapshot["status"] = serde_json::json!(if running.contains(&row.session_id) {
                    "running"
                } else {
                    "idle"
                });
                let _: Thread = serde_json::from_value(snapshot.clone())?;
                threads.push(snapshot);
            }
            Ok(Some(PersistedThreadSnapshotReport {
                threads,
                issue_count: 0,
            }))
        };
        match attempt() {
            Ok(report) => Ok(report),
            Err(error) => {
                tracing::debug!(%error, "tracked list unavailable; using authoritative list");
                Ok(None)
            }
        }
    }
}

#[derive(PartialEq, Eq)]
struct Scope {
    history: PathBuf,
    client: PathBuf,
    workspace: String,
    /// Enumeration roots: the authoritative history dir first, then Windows
    /// compat roots — the same roots the authoritative list scans, so the
    /// index covers compat-root sessions and refresh diagnostics see what
    /// thread/list sees.
    scan_roots: Vec<PathBuf>,
}

impl Scope {
    fn resolve(host: &dyn TrackedHistoryHost) -> Result<Self> {
        let path = host.history_path().context("session history is disabled")?;
        let history = dunce::canonicalize(path.parent().context("history source has no parent")?)?;
        let scan_roots = host.history_scan_roots(&history);
        Ok(Self {
            history,
            client: dunce::canonicalize(host.client_storage_root())?,
            workspace: host.canonical_workspace()?,
            scan_roots,
        })
    }
    fn open(&self, writable: bool) -> Result<Option<TrackedHistoryCatalog>> {
        TrackedHistoryCatalog::open(&self.client, &self.history, &self.workspace, writable)
    }
}

/// Upper bound on per-entry issue details carried in refresh responses.
const MAX_REFRESH_ISSUE_DETAILS: usize = 20;

const BUILDER_LOCK_RETRY_ATTEMPTS: u32 = 40;
const BUILDER_LOCK_RETRY_DELAY: Duration = Duration::from_millis(25);

fn lock_with_retry(
    attempts: u32,
    delay: Duration,
    mut lock: impl FnMut() -> std::io::Result<()>,
) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match lock() {
            Ok(()) => return Ok(()),
            Err(error) if attempt < attempts => {
                let _ = error;
                std::thread::sleep(delay);
            }
            Err(error) => return Err(error),
        }
    }
}

fn builder_guard(root: &Path) -> Result<File> {
    let directory = kcoder_config::PrivateDirectory::open_existing(root)?;
    let file = match directory.open_read_write_file(OsStr::new(BUILDER_LOCK), false) {
        Ok(file) => file,
        Err(error) if missing(&error) => {
            directory.open_read_write_file(OsStr::new(BUILDER_LOCK), true)?
        }
        Err(error) => return Err(error),
    };
    // A builder belonging to another process — or the one this connection just cancelled —
    // can hold the lock for a few more milliseconds. Wait briefly, then report the conflict.
    lock_with_retry(
        BUILDER_LOCK_RETRY_ATTEMPTS,
        BUILDER_LOCK_RETRY_DELAY,
        || FileExt::try_lock_exclusive(&file),
    )
    .context("another tracked list builder is active")?;
    Ok(file)
}

fn ensure_root(path: &Path) -> Result<()> {
    match kcoder_config::PrivateDirectory::open_existing(path) {
        Ok(_) => Ok(()),
        Err(error) if missing(&error) => {
            kcoder_config::PrivateDirectory::open_or_create(path)?;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

impl StepBudget {
    fn validate(self) -> Result<()> {
        ensure!(
            (1..=128).contains(&self.entries),
            "invalid tracked list entry budget"
        );
        ensure!(
            (1..=32 * 1024 * 1024).contains(&self.body_bytes),
            "invalid tracked list body budget"
        );
        ensure!(
            (1..=4 * 1024 * 1024).contains(&self.line_bytes),
            "invalid tracked list line budget"
        );
        ensure!(
            (1..=2 * 1024 * 1024).contains(&self.row_bytes),
            "invalid tracked list row budget"
        );
        Ok(())
    }
}

struct Meter {
    limits: StepBudget,
    body_left: u64,
    rows_left: usize,
}
impl Meter {
    fn new(limits: StepBudget) -> Self {
        Self {
            limits,
            body_left: limits.body_bytes,
            rows_left: limits.row_bytes,
        }
    }
}

enum Projection {
    Row(ListCatalogSession),
    Absent,
    Deferred,
}

fn project(
    host: &dyn TrackedHistoryHost,
    scope: &Scope,
    id: &str,
    path: &Path,
    meter: &mut Meter,
) -> Result<Projection> {
    validate_thread_id(id)?;
    let file = match std::fs::symlink_metadata(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Projection::Absent);
        }
        Err(error) => return Err(error.into()),
    };
    ensure!(
        file.file_type().is_file(),
        "history source is not a regular file"
    );
    if file.len() == 0 && !host.has_creation_record(id)? {
        return Ok(Projection::Absent);
    }
    let metadata = kcoder_state::prepare_session_metadata_bounded(path, MAX_SIDECAR_BYTES)?;
    let owner = metadata
        .base_cwd()
        .context("history workspace metadata is missing")?;
    if dunce::canonicalize(owner)? != Path::new(&scope.workspace) {
        return Ok(Projection::Absent);
    }
    // Reserve the legacy overflow probe as well, including on failed observations.
    let charge = file
        .len()
        .checked_add(1)
        .context("history source length overflow")?;
    ensure!(
        charge <= meter.limits.body_bytes,
        "history source needs a larger/chunked build budget"
    );
    if charge > meter.body_left {
        return Ok(Projection::Deferred);
    }
    meter.body_left -= charge;
    let (title, created, updated, mode, workflow_id, cwd) =
        if HistorySourceObservation::has_commit_boundary_hint(path)? {
            let projection =
                CommittedListProjection::read(path, file.len(), meter.limits.line_bytes)?;
            let cwd = projection
                .base_cwd()
                .context("history workspace metadata is missing")?;
            ensure!(
                dunce::canonicalize(cwd)? == Path::new(&scope.workspace),
                "history ownership changed during projection"
            );
            let (created, updated) = projection.timestamps_ms();
            (
                projection.first_prompt().map(str::to_owned),
                created,
                updated,
                projection.session_mode(),
                projection.workflow_definition_id().map(str::to_owned),
                cwd.to_path_buf(),
            )
        } else {
            // Explicit rebuild/dirty consumption scans legacy sources once; no hash cache is queried.
            let projection =
                HistoryListProjection::read(path, file.len(), meter.limits.line_bytes)?;
            ensure!(
                projection.observation().observed_complete_line_bytes()
                    == projection.observation().byte_count(),
                "history source has an incomplete trailing record"
            );
            let (created, updated) = projection.timestamps_ms(&metadata);
            (
                projection.first_prompt().map(str::to_owned),
                created,
                updated,
                metadata.session_mode(),
                metadata.workflow_definition_id().map(str::to_owned),
                owner.to_path_buf(),
            )
        };
    let cwd = dunce::simplified(&cwd).to_string_lossy().into_owned();
    let snapshot = serde_json::json!({
        "id": id, "cwd": cwd, "sessionMode": mode, "studioWorkMode": metadata.studio_work_mode(), "workflowDefinitionId": workflow_id,
        "agentDefinition": metadata.agent_definition(), "channelTaskSource": metadata.channel_task_source(), "title": title,
        "modelSelectionMode": metadata.model_selection_mode(), "selectedModel": metadata.selected_model(),
        "status": "idle", "createdAt": created.to_string(), "updatedAt": updated.to_string(),
    });
    project_row(host, id, snapshot, meter)
}

fn project_row(
    host: &dyn TrackedHistoryHost,
    id: &str,
    mut snapshot: serde_json::Value,
    meter: &mut Meter,
) -> Result<Projection> {
    host.decorate_snapshot(id, &mut snapshot)?;
    let _: Thread = serde_json::from_value(snapshot.clone())?;
    let bytes = serde_json::to_vec(&snapshot)?.len();
    ensure!(
        bytes <= MAX_ROW_BYTES,
        "tracked list row exceeds storage budget"
    );
    let charge = bytes.saturating_add(id.len()).saturating_add(64);
    ensure!(
        charge <= meter.limits.row_bytes,
        "tracked list row exceeds step budget"
    );
    if charge > meter.rows_left {
        return Ok(Projection::Deferred);
    }
    meter.rows_left -= charge;
    let updated_at_ms = snapshot["updatedAt"]
        .as_str()
        .context("missing thread update time")?
        .parse()?;
    Ok(Projection::Row(ListCatalogSession {
        session_id: id.to_owned(),
        updated_at_ms,
        archived: snapshot
            .get("archivedAt")
            .and_then(serde_json::Value::as_str)
            .is_some(),
        metadata: snapshot,
    }))
}

fn project_dirty(
    host: &dyn TrackedHistoryHost,
    scope: &Scope,
    ids: &[String],
    budget: StepBudget,
) -> Result<(Vec<ListCatalogSession>, Vec<String>)> {
    let mut meter = Meter::new(budget);
    let mut rows = Vec::new();
    let mut deleted = Vec::new();
    for id in ids {
        let path = candidate_thread_history_path(&scope.history, id)?;
        match project(host, scope, id, &path, &mut meter)? {
            Projection::Row(row) => rows.push(row),
            Projection::Absent => deleted.push(id.clone()),
            Projection::Deferred => anyhow::bail!("dirty list sources exceed this bounded update"),
        }
    }
    Ok((rows, deleted))
}

struct BuildSession {
    scope: Scope,
    catalog: TrackedHistoryCatalog,
    checkpoint: ListCatalogCheckpoint,
    scanners: std::collections::VecDeque<kcoder_state::SessionCandidateScanner>,
    seen_candidate_ids: std::collections::HashSet<String>,
    pending: VecDeque<(String, PathBuf)>,
    reading: Option<BuildSource>,
    dirty: Option<ListCatalogDelta>,
    dirty_rows: Vec<ListCatalogSession>,
    dirty_deleted: Vec<String>,
    enumeration_done: bool,
    progress: BuildProgress,
    _guard: File,
}

struct BuildSource {
    id: String,
    path: PathBuf,
    metadata: kcoder_state::PreparedSessionMetadata,
    reader: HistoryListProjectionReader,
    projection: Option<HistoryListProjection>,
}

impl BuildSource {
    fn open(
        host: &dyn TrackedHistoryHost,
        scope: &Scope,
        id: String,
        path: &Path,
        line_bytes: usize,
    ) -> Result<Option<Self>> {
        validate_thread_id(&id)?;
        let file = match std::fs::symlink_metadata(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            file.file_type().is_file(),
            "history source is not a regular file"
        );
        if file.len() == 0 && !host.has_creation_record(&id)? {
            return Ok(None);
        }
        let metadata = kcoder_state::prepare_session_metadata_bounded(path, MAX_SIDECAR_BYTES)?;
        let owner = metadata
            .base_cwd()
            .context("history workspace metadata is missing")?;
        // A session whose recorded workspace directory no longer exists (deleted
        // project, removed worktree, cleaned temp dir) belongs to no workspace
        // list; skip it silently — the same treatment as a session owned by
        // another directory. Counting it as a build issue left the index
        // permanently incomplete ("N issues") with no transport-side remedy.
        let Ok(owner) = dunce::canonicalize(owner) else {
            return Ok(None);
        };
        if owner != Path::new(&scope.workspace) {
            return Ok(None);
        }
        let reader = HistoryListProjection::reader(path, line_bytes)?;
        Ok(Some(Self {
            id,
            path: path.to_owned(),
            metadata,
            reader,
            projection: None,
        }))
    }

    fn advance(
        &mut self,
        host: &dyn TrackedHistoryHost,
        scope: &Scope,
        meter: &mut Meter,
    ) -> Result<Projection> {
        if self.projection.is_some() {
            self.reader.validate_completed()?;
        } else {
            if meter.body_left == 0 {
                return Ok(Projection::Deferred);
            }
            let before = self.reader.bytes_read();
            let result = self.reader.step(meter.body_left);
            meter.body_left = meter
                .body_left
                .checked_sub(self.reader.bytes_read() - before)
                .context("projection exceeded its step byte budget")?;
            self.projection = result?;
        }
        let Some(projection) = self.projection.as_ref() else {
            return Ok(Projection::Deferred);
        };
        ensure!(
            projection.observation().observed_complete_line_bytes()
                == projection.observation().byte_count(),
            "history source has an incomplete trailing record"
        );
        // This key contains prepared scalar/path metadata only; it never rereads the body.
        let current =
            kcoder_state::prepare_session_metadata_bounded(&self.path, MAX_SIDECAR_BYTES)?;
        ensure!(
            current.list_input_key()? == self.metadata.list_input_key()?,
            "history metadata changed during projection"
        );
        let owner = self
            .metadata
            .base_cwd()
            .context("history workspace metadata is missing")?;
        ensure!(
            dunce::canonicalize(owner)? == Path::new(&scope.workspace),
            "history ownership changed during projection"
        );
        let (created, updated) = projection.timestamps_ms(&self.metadata);
        let cwd = dunce::simplified(owner).to_string_lossy().into_owned();
        let snapshot = serde_json::json!({
            "id": self.id, "cwd": cwd, "sessionMode": self.metadata.session_mode(), "studioWorkMode": self.metadata.studio_work_mode(), "workflowDefinitionId": self.metadata.workflow_definition_id(),
            "agentDefinition": self.metadata.agent_definition(), "channelTaskSource": self.metadata.channel_task_source(),
            "modelSelectionMode": self.metadata.model_selection_mode(), "selectedModel": self.metadata.selected_model(),
            "title": projection.first_prompt(), "status": "idle",
            "createdAt": created.to_string(), "updatedAt": updated.to_string(),
        });
        project_row(host, &self.id, snapshot, meter)
    }
}

impl BuildSession {
    fn advance(&mut self, host: &dyn TrackedHistoryHost, budget: StepBudget) -> Result<()> {
        if self.enumeration_done && self.pending.is_empty() && self.reading.is_none() {
            if self.progress.issue_count != 0 {
                self.progress.phase = BuildPhase::Incomplete;
                return Ok(());
            }
            if self.dirty.is_none() {
                let delta = self.catalog.prepare_refresh_update(budget.entries)?;
                for id in delta.session_ids() {
                    self.pending.push_back((
                        id.clone(),
                        candidate_thread_history_path(&self.scope.history, id)?,
                    ));
                }
                self.dirty = Some(delta);
            }
            if self.pending.is_empty() {
                let delta = self.dirty.take().context("missing final dirty batch")?;
                let deleted: Vec<_> = self.dirty_deleted.iter().map(String::as_str).collect();
                self.checkpoint =
                    self.catalog
                        .finish_baseline(delta, &self.dirty_rows, &deleted)?;
                self.progress.indexed_sessions = self.checkpoint.row_count() as u64;
                self.progress.phase = BuildPhase::Ready;
                return Ok(());
            }
        }
        if !self.enumeration_done && self.pending.is_empty() && self.reading.is_none() {
            // Enumerate every scan root in order; a session id found in an
            // earlier root wins, matching the authoritative list's dedup.
            let mut examined = 0u64;
            let mut issue_count = 0u64;
            let mut candidates: Vec<(String, PathBuf)> = Vec::new();
            let mut complete = false;
            while let Some(scanner) = self.scanners.front_mut() {
                let batch = scanner.next_batch(budget.entries)?;
                examined += batch.examined_entries as u64;
                issue_count = issue_count.saturating_add(batch.scan.issue_count);
                for issue in &batch.scan.issues {
                    if self.progress.issues.len() >= MAX_REFRESH_ISSUE_DETAILS {
                        break;
                    }
                    self.progress
                        .issues
                        .push(kcoder_app_protocol::ThreadHistoryRefreshIssue {
                            session_id: None,
                            reason: format!("{}: {}", issue.name, issue.reason),
                        });
                }
                candidates.extend(
                    batch
                        .scan
                        .candidates
                        .into_iter()
                        .map(|(id, path, _)| (id, path)),
                );
                if batch.complete {
                    self.scanners.pop_front();
                    if self.scanners.is_empty() {
                        complete = true;
                        break;
                    }
                } else {
                    break;
                }
            }
            self.progress.examined_entries =
                self.progress.examined_entries.saturating_add(examined);
            self.progress.issue_count = self.progress.issue_count.saturating_add(issue_count);
            self.enumeration_done = complete;
            self.pending
                .extend(candidates.into_iter().filter(|(id, _)| {
                    if self.dirty.is_some() {
                        return true;
                    }
                    self.seen_candidate_ids.insert(id.clone())
                }));
        }
        let mut meter = Meter::new(budget);
        let mut rows = Vec::new();
        for _ in 0..budget.entries {
            if self.reading.is_none() {
                let Some((id, path)) = self.pending.pop_front() else {
                    break;
                };
                match BuildSource::open(host, &self.scope, id.clone(), &path, budget.line_bytes) {
                    Ok(Some(source)) => self.reading = Some(source),
                    Ok(None) => {
                        if self.dirty.is_some() {
                            self.dirty_deleted.push(id);
                        }
                        continue;
                    }
                    Err(error) => {
                        tracing::debug!(%error, session_id = %id, "tracked list source could not be opened");
                        self.progress.issue_count = self.progress.issue_count.saturating_add(1);
                        if self.progress.issues.len() < MAX_REFRESH_ISSUE_DETAILS {
                            self.progress.issues.push(
                                kcoder_app_protocol::ThreadHistoryRefreshIssue {
                                    session_id: Some(id.clone()),
                                    reason: error.to_string(),
                                },
                            );
                        }
                        continue;
                    }
                }
            }
            let source = self
                .reading
                .as_mut()
                .context("missing current build source")?;
            match source.advance(host, &self.scope, &mut meter) {
                Ok(Projection::Row(row)) => {
                    if self.dirty.is_some() {
                        self.dirty_rows.push(row);
                    } else {
                        rows.push(row);
                    }
                    self.reading = None;
                }
                Ok(Projection::Absent) => {
                    unreachable!("an open build source produces a row or defers")
                }
                Ok(Projection::Deferred) => break,
                Err(error) => {
                    tracing::debug!(%error, session_id = %source.id, "tracked list source could not be projected");
                    self.progress.issue_count = self.progress.issue_count.saturating_add(1);
                    if self.progress.issues.len() < MAX_REFRESH_ISSUE_DETAILS {
                        self.progress
                            .issues
                            .push(kcoder_app_protocol::ThreadHistoryRefreshIssue {
                                session_id: Some(source.id.clone()),
                                reason: error.to_string(),
                            });
                    }
                    self.reading = None;
                }
            }
        }
        if !rows.is_empty() {
            self.checkpoint = self
                .catalog
                .stage_baseline(&self.checkpoint.revision, &rows)?;
            self.progress.indexed_sessions = self.checkpoint.row_count() as u64;
        }
        Ok(())
    }
}

#[cfg(test)]
mod builder_lock_retry_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn lock_retry_waits_for_a_transient_holder_and_then_succeeds() {
        let calls = Cell::new(0);
        lock_with_retry(5, Duration::ZERO, || {
            calls.set(calls.get() + 1);
            if calls.get() < 4 {
                return Err(std::io::Error::other("locked"));
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(calls.get(), 4);
    }

    #[test]
    fn lock_retry_reports_the_conflict_after_the_bounded_wait() {
        let calls = Cell::new(0);
        let error = lock_with_retry(3, Duration::ZERO, || {
            calls.set(calls.get() + 1);
            Err(std::io::Error::other("locked"))
        })
        .unwrap_err();
        assert_eq!(calls.get(), 3);
        assert_eq!(error.to_string(), "locked");
    }
}

#[cfg(test)]
mod source_recheck_tests {
    use super::*;

    struct TestHost<'a> {
        history: &'a Path,
        workspace: &'a Path,
        client: &'a Path,
    }

    impl TrackedHistoryHost for TestHost<'_> {
        fn history_path(&self) -> Option<PathBuf> {
            Some(self.history.join("bootstrap.jsonl"))
        }

        fn client_storage_root(&self) -> PathBuf {
            self.client.to_owned()
        }

        fn history_scan_roots(&self, history: &Path) -> Vec<PathBuf> {
            vec![history.to_owned()]
        }

        fn canonical_workspace(&self) -> Result<String> {
            Ok(dunce::canonicalize(self.workspace)?
                .to_string_lossy()
                .into_owned())
        }

        fn has_creation_record(&self, _id: &str) -> Result<bool> {
            Ok(false)
        }

        fn decorate_snapshot(&self, _id: &str, _snapshot: &mut Value) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn tracked_list_completed_projection_deferred_by_rows_rechecks_source() {
        use sha2::{Digest, Sha256};
        for pending in [false, true] {
            let workspace = tempfile::tempdir().unwrap();
            let history = tempfile::tempdir().unwrap();
            let client = tempfile::tempdir().unwrap();
            let host = TestHost {
                history: history.path(),
                workspace: workspace.path(),
                client: client.path(),
            };
            let body = b"{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"row\"}],\"timestamp_ms\":1}\n";
            for id in ["first", "other"] {
                std::fs::write(history.path().join(format!("{id}.jsonl")), body).unwrap();
                let path = kcoder_state::session_state_path(history.path(), id);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                let metadata =
                    serde_json::json!({"schema_version": 1, "base_cwd": workspace.path()});
                std::fs::write(path, serde_json::to_vec(&metadata).unwrap()).unwrap();
            }
            let scope = Scope::resolve(&host).unwrap();
            let mut probe = BuildSource::open(
                &host,
                &scope,
                "first".into(),
                &history.path().join("first.jsonl"),
                StepBudget::default().line_bytes,
            )
            .unwrap()
            .unwrap();
            let row = match probe
                .advance(&host, &scope, &mut Meter::new(StepBudget::default()))
                .unwrap()
            {
                Projection::Row(row) => row,
                _ => panic!("fixture row must complete"),
            };
            let budget = StepBudget {
                row_bytes: serde_json::to_vec(&row.metadata).unwrap().len()
                    + row.session_id.len()
                    + 64,
                ..Default::default()
            };
            let mut service = TrackedHistoryList::default();
            service.begin(&host, true).unwrap();
            let progress = service.step(&host, budget).unwrap();
            assert_eq!(progress.indexed_sessions, 1);
            let held = service.build.as_ref().unwrap().reading.as_ref().unwrap();
            assert!(
                held.projection.is_some(),
                "second source must already have reached EOF"
            );
            let path = held.path.clone();
            assert_eq!(held.reader.bytes_read(), body.len() as u64);
            if pending {
                let root =
                    kcoder_config::PrivateDirectory::open_or_create(&path.with_extension("hctl"))
                        .unwrap();
                let id = "00000000-0000-4000-8000-000000000001";
                let record = serde_json::json!({"schema_version":2,"incarnation":id,"deleted":false,"commit":{
                    "revision":0,"generation":id,"committed_bytes":null,
                    "pending":{"next_revision":1,"operation":{"kind":"append","start":0,"end":body.len(),"sha256":format!("{:x}", Sha256::digest(body))}},"last_operation":null
                }});
                root.atomic_replace(
                    OsStr::new("source.json"),
                    &serde_json::to_vec(&record).unwrap(),
                )
                .unwrap();
                let error = HistorySourceObservation::has_commit_boundary_hint(&path).unwrap_err();
                assert!(format!("{error:#}").contains("pending commit"), "{error:#}");
            } else {
                kcoder_config::PrivateDirectory::open_existing(history.path())
                    .unwrap()
                    .atomic_replace(path.file_name().unwrap(), body)
                    .unwrap();
            }
            let mut progress = service.step(&host, budget).unwrap();
            for _ in 0..100 {
                if progress.phase != BuildPhase::Building {
                    break;
                }
                progress = service.step(&host, budget).unwrap();
            }
            assert_eq!(progress.phase, BuildPhase::Incomplete, "pending={pending}");
            assert!(progress.issue_count > 0);
            assert!(
                TrackedHistoryList::try_list(
                    &host,
                    &HashSet::new(),
                    &HashSet::new(),
                    ListBudget::default()
                )
                .unwrap()
                .is_none()
            );
        }
    }
}
