use super::{PersistedThreadSnapshotReport, QueryEngine};
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
use kcoder_state::history_index::{
    BaselineState, CommittedListProjection, HistoryListProjection, HistoryListProjectionReader,
    HistorySourceObservation, ListCatalogCheckpoint, ListCatalogDelta, ListCatalogSession,
    TrackedHistoryCatalog,
};
use std::collections::{HashSet, VecDeque};
use std::ffi::OsStr;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_SIDECAR_BYTES: u64 = 1024 * 1024;
const MAX_ROW_BYTES: usize = 64 * 1024;
const BUILDER_LOCK: &str = ".kcoder-tracked-list-builder.lock";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BuildPhase {
    Building,
    Ready,
    Incomplete,
}

#[derive(Clone, Debug)]
pub(super) struct BuildProgress {
    pub phase: BuildPhase,
    pub examined_entries: u64,
    pub indexed_sessions: u64,
    pub issue_count: u64,
    pub issues: Vec<kcoder_app_protocol::ThreadHistoryRefreshIssue>,
}

#[derive(Clone, Copy)]
pub(super) struct StepBudget {
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

pub(super) struct ListBudget {
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
pub(super) struct TrackedHistoryList {
    build: Option<BuildSession>,
}
impl TrackedHistoryList {
    pub fn begin(
        &mut self,
        engine: &QueryEngine,
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
        let history_path = engine
            .state
            .history_path()
            .context("session history is disabled")?;
        let history_root = history_path
            .parent()
            .context("history source has no parent")?;
        // Explicit opt-in may initialize deferred storage, but never creates a ghost session.
        ensure_root(history_root)?;
        ensure_root(&engine.client_storage_root())?;
        let scope = Scope::resolve(engine)?;
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

    pub fn step(&mut self, engine: &QueryEngine, budget: StepBudget) -> Result<BuildProgress> {
        budget.validate()?;
        let build = self
            .build
            .as_mut()
            .context("no active tracked list build")?;
        ensure!(
            build.scope == Scope::resolve(engine)?,
            "tracked list build belongs to another workspace"
        );
        if let Err(error) = build.advance(engine, budget) {
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

    pub fn try_list(
        engine: &QueryEngine,
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
            let scope = Scope::resolve(engine)?;
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
                        project_dirty(engine, &scope, delta.session_ids(), budget.dirty)?;
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
                let mut snapshot = row.metadata;
                snapshot["status"] = serde_json::json!(if running.contains(&row.session_id) {
                    "running"
                } else {
                    "idle"
                });
                let _: super::Thread = serde_json::from_value(snapshot.clone())?;
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
    fn resolve(engine: &QueryEngine) -> Result<Self> {
        let path = engine
            .state
            .history_path()
            .context("session history is disabled")?;
        let history = dunce::canonicalize(path.parent().context("history source has no parent")?)?;
        let scan_roots =
            match kcoder_config::Settings::project_data_dirs_for_read(engine.state.cwd()) {
                Ok(project_dirs) if !project_dirs.is_empty() => {
                    super::history_scan_roots(&history, &project_dirs[0], &project_dirs)
                }
                _ => vec![history.clone()],
            };
        Ok(Self {
            history,
            client: dunce::canonicalize(engine.client_storage_root())?,
            workspace: super::canonical_workspace(engine)?,
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
    engine: &QueryEngine,
    scope: &Scope,
    id: &str,
    path: &Path,
    meter: &mut Meter,
) -> Result<Projection> {
    super::validate_thread_id(id)?;
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
    if file.len() == 0 {
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
        "id": id, "cwd": cwd, "sessionMode": mode, "workflowDefinitionId": workflow_id, "title": title,
        "status": "idle", "createdAt": created.to_string(), "updatedAt": updated.to_string(),
    });
    project_row(engine, id, snapshot, meter)
}

fn project_row(
    engine: &QueryEngine,
    id: &str,
    mut snapshot: serde_json::Value,
    meter: &mut Meter,
) -> Result<Projection> {
    let stored = super::read_thread_metadata(engine, id)?;
    super::decorate_thread_snapshot_with_metadata(&mut snapshot, stored.as_ref(), true)?;
    let _: super::Thread = serde_json::from_value(snapshot.clone())?;
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
    engine: &QueryEngine,
    scope: &Scope,
    ids: &[String],
    budget: StepBudget,
) -> Result<(Vec<ListCatalogSession>, Vec<String>)> {
    let mut meter = Meter::new(budget);
    let mut rows = Vec::new();
    let mut deleted = Vec::new();
    for id in ids {
        let path = super::candidate_thread_history_path(&scope.history, id)?;
        match project(engine, scope, id, &path, &mut meter)? {
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
    fn open(scope: &Scope, id: String, path: &Path, line_bytes: usize) -> Result<Option<Self>> {
        super::validate_thread_id(&id)?;
        let file = match std::fs::symlink_metadata(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            file.file_type().is_file(),
            "history source is not a regular file"
        );
        if file.len() == 0 {
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
        engine: &QueryEngine,
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
            "id": self.id, "cwd": cwd, "sessionMode": self.metadata.session_mode(), "workflowDefinitionId": self.metadata.workflow_definition_id(),
            "title": projection.first_prompt(), "status": "idle",
            "createdAt": created.to_string(), "updatedAt": updated.to_string(),
        });
        project_row(engine, &self.id, snapshot, meter)
    }
}

impl BuildSession {
    fn advance(&mut self, engine: &QueryEngine, budget: StepBudget) -> Result<()> {
        if self.enumeration_done && self.pending.is_empty() && self.reading.is_none() {
            if self.progress.issue_count != 0 {
                self.progress.phase = BuildPhase::Incomplete;
                return Ok(());
            }
            if self.dirty.is_none() {
                let delta = self.catalog.prepare_update(budget.entries)?;
                for id in delta.session_ids() {
                    self.pending.push_back((
                        id.clone(),
                        super::candidate_thread_history_path(&self.scope.history, id)?,
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
                match BuildSource::open(&self.scope, id.clone(), &path, budget.line_bytes) {
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
            match source.advance(engine, &self.scope, &mut meter) {
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
mod tests {
    use super::*;
    use kcoder_state::AppState;
    use kcoder_types::Message;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    struct Fixture {
        workspace: tempfile::TempDir,
        history: tempfile::TempDir,
        engine: QueryEngine,
    }

    impl Fixture {
        fn new() -> Self {
            let workspace = tempfile::tempdir().unwrap();
            let history = tempfile::tempdir().unwrap();
            let settings = kcoder_config::Settings::default();
            let owner =
                Arc::new(kcoder_config::create_private_temp_dir("tracked-list-test").unwrap());
            let services =
                kcoder_engine::WorkspaceRuntimeServices::new(workspace.path(), "tracked-list-test")
                    .with_private_client_storage(owner);
            let engine = QueryEngine::try_new_for_client_with_services(
                Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
                    crate::tui_dev_mock::TuiDevScenario::FullTurn,
                )),
                AppState::new(workspace.path()),
                kcoder_tools::ToolRegistry::new(),
                kcoder_permissions::PermissionEngine::from_settings(&settings),
                settings,
                kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
                kcoder_skills::SkillRegistry::empty(),
                Arc::new(kcoder_tools::DenyAllUserQuestioner),
                workspace.path().to_owned(),
                Some(true),
                services,
            )
            .unwrap();
            engine.state.with_history_path(
                history
                    .path()
                    .join(format!("{}.jsonl", engine.session_id())),
            );
            Self {
                workspace,
                history,
                engine,
            }
        }

        fn seed(&self) {
            self.engine
                .state
                .add_message(Message::user_text("known prompt"));
            self.engine.state.save_history().unwrap();
        }

        fn legacy(&self, id: &str, body: &[u8], workspace: &Path) {
            std::fs::write(self.history.path().join(format!("{id}.jsonl")), body).unwrap();
            let path = kcoder_state::session_state_path(self.history.path(), id);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let metadata = serde_json::json!({"schema_version": 1, "base_cwd": workspace});
            std::fs::write(path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        }
    }

    fn tree(root: &Path) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                paths.extend(tree(&path));
            }
            paths.push(path);
        }
        paths.sort();
        paths
    }

    fn finish(
        service: &mut TrackedHistoryList,
        engine: &QueryEngine,
        budget: StepBudget,
    ) -> BuildProgress {
        for _ in 0..100 {
            let progress = service.step(engine, budget).unwrap();
            if progress.phase != BuildPhase::Building {
                return progress;
            }
        }
        panic!("bounded fixture build did not terminate")
    }

    #[test]
    fn tracked_list_opt_in_and_hot_missing_catalog_never_create_files() {
        let fixture = Fixture::new();
        let root = fixture.engine.client_storage_root();
        let before = (tree(&root), tree(fixture.history.path()));
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        assert!(
            TrackedHistoryList::default()
                .begin(&fixture.engine, false)
                .is_err()
        );
        assert_eq!((tree(&root), tree(fixture.history.path())), before);
    }

    #[test]
    fn tracked_list_completed_projection_deferred_by_rows_rechecks_source() {
        use sha2::{Digest, Sha256};
        for pending in [false, true] {
            let fixture = Fixture::new();
            let body = b"{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"row\"}],\"timestamp_ms\":1}\n";
            for id in ["first", "other"] {
                fixture.legacy(id, body, fixture.workspace.path());
            }
            let scope = Scope::resolve(&fixture.engine).unwrap();
            let mut probe = BuildSource::open(
                &scope,
                "first".into(),
                &fixture.history.path().join("first.jsonl"),
                StepBudget::default().line_bytes,
            )
            .unwrap()
            .unwrap();
            let row = match probe
                .advance(
                    &fixture.engine,
                    &scope,
                    &mut Meter::new(StepBudget::default()),
                )
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
            service.begin(&fixture.engine, true).unwrap();
            let progress = service.step(&fixture.engine, budget).unwrap();
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
                kcoder_config::PrivateDirectory::open_existing(fixture.history.path())
                    .unwrap()
                    .atomic_replace(path.file_name().unwrap(), body)
                    .unwrap();
            }
            let progress = finish(&mut service, &fixture.engine, budget);
            assert_eq!(progress.phase, BuildPhase::Incomplete, "pending={pending}");
            assert!(progress.issue_count > 0);
            assert!(
                TrackedHistoryList::try_list(
                    &fixture.engine,
                    &HashSet::new(),
                    &HashSet::new(),
                    ListBudget::default()
                )
                .unwrap()
                .is_none()
            );
        }
    }

    #[test]
    fn tracked_list_acknowledged_empty_deferred_history_becomes_ready() {
        let fixture = Fixture::new();
        let directory = fixture.history.path().join("deferred");
        fixture.engine.state.with_deferred_history_path(
            directory.join(format!("{}.jsonl", fixture.engine.session_id())),
        );
        assert!(!directory.exists());
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        let mut service = TrackedHistoryList::default();
        assert!(service.begin(&fixture.engine, false).is_err());
        assert!(!directory.exists());
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!((progress.indexed_sessions, progress.issue_count), (0, 0));
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(report.threads.is_empty());
        assert!(!fixture.engine.state.history_path().unwrap().exists());
    }

    #[test]
    fn tracked_list_chunked_rebuild_exceeds_step_budget_without_rewriting_source() {
        let fixture = Fixture::new();
        fixture.seed();
        let source = fixture.engine.state.history_path().unwrap();
        let control = source.with_extension("hctl").join("source.json");
        let before_control = std::fs::read(&control).unwrap();
        let mut body = std::fs::read(&source).unwrap();
        let line = format!(
            "{}\n",
            serde_json::json!({"timestamp_ms": 9999999999999u64, "padding": "x".repeat(4000)})
        );
        while body.len() <= StepBudget::default().body_bytes as usize {
            body.extend_from_slice(line.as_bytes());
        }
        std::fs::write(&source, &body).unwrap();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let first = service
            .step(&fixture.engine, StepBudget::default())
            .unwrap();
        assert_eq!(first.phase, BuildPhase::Building);
        assert_eq!(first.indexed_sessions, 0);
        assert_eq!(
            service
                .build
                .as_ref()
                .unwrap()
                .reading
                .as_ref()
                .unwrap()
                .reader
                .bytes_read(),
            StepBudget::default().body_bytes
        );
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!(progress.indexed_sessions, 1);
        assert!(
            std::fs::read(&source).unwrap() == body,
            "refresh must not rewrite source bytes"
        );
        assert_eq!(std::fs::read(&control).unwrap(), before_control);
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        let oracle = super::super::persisted_thread_value(
            &fixture.engine,
            &fixture.engine.session_id(),
            &source,
            false,
        )
        .unwrap();
        assert_eq!(report.threads, vec![oracle]);
    }

    #[test]
    fn tracked_list_chunked_external_shrink_and_half_line_keep_authority_unchanged() {
        let fixture = Fixture::new();
        fixture.seed();
        let source = fixture.engine.state.history_path().unwrap();
        let control = source.with_extension("hctl").join("source.json");
        let original_control = std::fs::read(&control).unwrap();
        let body = b"{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"shrunk\"}],\"timestamp_ms\":2}\n";
        assert!(body.len() < std::fs::metadata(&source).unwrap().len() as usize);
        std::fs::write(&source, body).unwrap();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(
            &mut service,
            &fixture.engine,
            StepBudget {
                body_bytes: 7,
                ..Default::default()
            },
        );
        assert_eq!(progress.phase, BuildPhase::Ready);
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        let oracle = super::super::persisted_thread_value(
            &fixture.engine,
            &fixture.engine.session_id(),
            &source,
            false,
        )
        .unwrap();
        assert_eq!(report.threads, vec![oracle]);
        assert_eq!(std::fs::read(&source).unwrap(), body);
        assert_eq!(std::fs::read(&control).unwrap(), original_control);
        std::fs::write(&source, &body[..body.len() - 1]).unwrap();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert_eq!(progress.issue_count, 1);
        assert_eq!(std::fs::read(&source).unwrap(), &body[..body.len() - 1]);
        assert_eq!(std::fs::read(&control).unwrap(), original_control);
    }

    #[test]
    fn tracked_list_chunked_finish_reconciles_a_large_late_managed_rewrite() {
        let fixture = Fixture::new();
        fixture.seed();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        for _ in 0..100 {
            service
                .step(&fixture.engine, StepBudget::default())
                .unwrap();
            let build = service.build.as_ref().unwrap();
            if build.enumeration_done && build.pending.is_empty() && build.reading.is_none() {
                break;
            }
        }
        let mut messages = vec![Message::user_text("late managed rewrite")];
        for _ in 0..8500 {
            messages.push(Message::assistant_text("x".repeat(4000)));
        }
        fixture.engine.state.set_messages(messages);
        fixture.engine.state.save_history().unwrap();
        assert!(
            std::fs::metadata(fixture.engine.state.history_path().unwrap())
                .unwrap()
                .len()
                > StepBudget::default().body_bytes
        );
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!(progress.indexed_sessions, 1);
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads[0]["title"], "late managed rewrite");
    }

    #[test]
    fn tracked_list_chunked_sidecar_change_during_read_never_publishes_old_ownership() {
        let fixture = Fixture::new();
        fixture.seed();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let budget = StepBudget {
            body_bytes: 13,
            ..Default::default()
        };
        assert_eq!(
            service.step(&fixture.engine, budget).unwrap().phase,
            BuildPhase::Building
        );
        assert!(service.build.as_ref().unwrap().reading.is_some());
        let sidecar =
            kcoder_state::session_state_path(fixture.history.path(), &fixture.engine.session_id());
        let mut metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        let foreign = tempfile::tempdir().unwrap();
        metadata["base_cwd"] = serde_json::json!(foreign.path());
        std::fs::write(&sidecar, serde_json::to_vec(&metadata).unwrap()).unwrap();
        let progress = finish(&mut service, &fixture.engine, budget);
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert!(progress.issue_count > 0);
    }

    #[test]
    fn tracked_list_builds_known_and_legacy_sources_and_consumes_dirty() {
        let fixture = Fixture::new();
        fixture.seed();
        let body = format!(
            "{}\n",
            serde_json::to_string(&kcoder_state::HistoryEntry {
                session_id: "legacy".into(),
                timestamp_ms: 7,
                uuid: None,
                parent_uuid: None,
                message: Message::user_text("legacy prompt")
            })
            .unwrap()
        );
        fixture.legacy("legacy", body.as_bytes(), fixture.workspace.path());
        let mut service = TrackedHistoryList::default();
        assert_eq!(
            service.begin(&fixture.engine, true).unwrap().phase,
            BuildPhase::Building
        );
        assert!(
            TrackedHistoryList::default()
                .begin(&fixture.engine, true)
                .is_err()
        );
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        let progress = finish(
            &mut service,
            &fixture.engine,
            StepBudget {
                entries: 2,
                ..Default::default()
            },
        );
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!((progress.indexed_sessions, progress.issue_count), (2, 0));
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads.len(), 2);
        assert!(
            report
                .threads
                .iter()
                .any(|row| row["title"] == "legacy prompt")
        );
        let params = serde_json::from_value(serde_json::json!({"threadId": fixture.engine.session_id(), "title":"renamed", "archivedAt":"100"})).unwrap();
        super::super::update_thread_metadata(&fixture.engine, params, &HashSet::new(), true)
            .unwrap();
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert!(
            report
                .threads
                .iter()
                .any(|row| row["title"] == "renamed" && row["archivedAt"] == "100")
        );
    }

    #[test]
    fn tracked_list_dirty_over_budget_never_serves_stale_rows_and_refresh_recovers() {
        let fixture = Fixture::new();
        let ids: Vec<_> = (0..129).map(|index| format!("dirty{index:04}")).collect();
        for id in &ids {
            let entry = kcoder_state::HistoryEntry {
                session_id: id.clone(),
                timestamp_ms: 7,
                uuid: None,
                parent_uuid: None,
                message: Message::user_text("original"),
            };
            let body = format!("{}\n", serde_json::to_string(&entry).unwrap());
            fixture.legacy(id, body.as_bytes(), fixture.workspace.path());
        }
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).phase,
            BuildPhase::Ready
        );
        for id in &ids {
            let params = serde_json::from_value(serde_json::json!({
                "threadId": id, "title": format!("updated-{id}")
            }))
            .unwrap();
            super::super::update_thread_metadata(&fixture.engine, params, &HashSet::new(), true)
                .unwrap();
        }
        // A dirty set larger than the hot-read budget must never publish a partial update.
        for _ in 0..2 {
            assert!(
                TrackedHistoryList::try_list(
                    &fixture.engine,
                    &HashSet::new(),
                    &HashSet::new(),
                    ListBudget::default()
                )
                .unwrap()
                .is_none()
            );
        }
        service.begin(&fixture.engine, true).unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).phase,
            BuildPhase::Ready
        );
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads.len(), ids.len());
        for id in ids {
            let row = report.threads.iter().find(|row| row["id"] == id).unwrap();
            assert_eq!(row["title"], format!("updated-{id}"));
        }
    }

    #[test]
    fn tracked_list_issues_never_publish_a_partial_ready_baseline() {
        let fixture = Fixture::new();
        fixture.seed();
        fixture.legacy("broken", b"\xff\n", fixture.workspace.path());
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert!(progress.issue_count > 0);
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn tracked_list_finish_reconciles_writes_after_enumeration_and_later_deletion() {
        let fixture = Fixture::new();
        fixture.seed();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        for _ in 0..100 {
            let progress = service
                .step(
                    &fixture.engine,
                    StepBudget {
                        entries: 1,
                        ..Default::default()
                    },
                )
                .unwrap();
            assert_eq!(progress.phase, BuildPhase::Building);
            let build = service.build.as_ref().unwrap();
            if build.enumeration_done && build.pending.is_empty() {
                break;
            }
        }
        let state = AppState::new(fixture.workspace.path());
        let path = fixture
            .history
            .path()
            .join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(Message::user_text("late birth"));
        state.save_history().unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).indexed_sessions,
            2
        );
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads.len(), 2);
        kcoder_state::delete_session_history_files(&path).unwrap();
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads.len(), 1);
        assert_eq!(report.threads[0]["id"], fixture.engine.session_id());
    }

    #[test]
    fn tracked_list_hot_read_uses_journals_and_explicit_refresh_observes_manual_metadata() {
        let fixture = Fixture::new();
        fixture.seed();
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).phase,
            BuildPhase::Ready
        );
        let directory = super::super::ensure_thread_metadata_directory(
            &fixture.engine,
            &fixture.engine.session_id(),
        )
        .unwrap();
        let metadata = serde_json::json!({"version":1,"revision":1,"thread_id":fixture.engine.session_id(),"workspace":super::super::canonical_workspace(&fixture.engine).unwrap(),"fields":{"title":"manual title"},"updated_at":"1"});
        std::fs::write(
            directory.join(super::super::THREAD_METADATA_FILE),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        let source = fixture.engine.state.history_path().unwrap();
        let original = std::fs::read(&source).unwrap();
        // External edits are outside the journal contract until an explicit refresh.
        std::fs::write(&source, vec![0xff; original.len()]).unwrap();
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads[0]["title"], "known prompt");
        std::fs::write(&source, original).unwrap();
        let mut fence =
            JournalFence::try_acquire(fixture.history.path(), JournalDomain::History).unwrap();
        let mutation = fence.begin(&fixture.engine.session_id()).unwrap();
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        mutation.finish().unwrap();
        drop(fence);
        service.begin(&fixture.engine, true).unwrap();
        assert_eq!(
            finish(&mut service, &fixture.engine, StepBudget::default()).phase,
            BuildPhase::Ready
        );
        let report = TrackedHistoryList::try_list(
            &fixture.engine,
            &HashSet::new(),
            &HashSet::new(),
            ListBudget::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(report.threads[0]["title"], "manual title");
    }

    #[test]
    fn tracked_list_budget_defers_candidates_and_oversize_lines_never_look_complete() {
        let fixture = Fixture::new();
        fixture.seed();
        let source = fixture.engine.state.history_path().unwrap();
        let body = std::fs::read(&source).unwrap();
        fixture.legacy("legacy", &body, fixture.workspace.path());
        let foreign = tempfile::tempdir().unwrap();
        fixture.legacy("foreign", b"\xff\n", foreign.path());
        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(
            &mut service,
            &fixture.engine,
            StepBudget {
                body_bytes: body.len() as u64 + 1,
                ..Default::default()
            },
        );
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!(progress.indexed_sessions, 2);
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget {
                    max_rows: 1,
                    ..Default::default()
                }
            )
            .unwrap()
            .is_none()
        );
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(
            &mut service,
            &fixture.engine,
            StepBudget {
                line_bytes: 1,
                ..Default::default()
            },
        );
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert_eq!(progress.issue_count, 2);
        assert!(
            TrackedHistoryList::try_list(
                &fixture.engine,
                &HashSet::new(),
                &HashSet::new(),
                ListBudget::default()
            )
            .unwrap()
            .is_none()
        );
        service.begin(&fixture.engine, true).unwrap();
        service.cancel();
        assert!(
            TrackedHistoryList::default()
                .begin(&fixture.engine, true)
                .is_ok()
        );
    }

    #[test]
    fn workspace_identity_comparison_uses_simplified_forms() {
        // Both sides of the workspace ownership comparison must be produced
        // through the same normalization. On Linux the helpers are the
        // identity, so this pins the helper choice and the comparison contract:
        // the scope workspace string and a fresh canonicalization agree.
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let canonical = dunce::canonicalize(&workspace).unwrap();
        let scope_workspace = canonical.to_string_lossy().into_owned();
        assert_eq!(
            dunce::canonicalize(&workspace).unwrap(),
            Path::new(&scope_workspace)
        );
        assert_eq!(
            dunce::simplified(&canonical).to_string_lossy(),
            dunce::simplified(Path::new(&scope_workspace)).to_string_lossy()
        );
    }

    #[test]
    fn tracked_list_skips_sessions_from_deleted_directories_without_counting_issues() {
        let fixture = Fixture::new();
        fixture.seed();
        let gone = tempfile::tempdir().unwrap();
        let body = format!(
            "{}\n",
            serde_json::to_string(&kcoder_state::HistoryEntry {
                session_id: "gone01".into(),
                timestamp_ms: 7,
                uuid: None,
                parent_uuid: None,
                message: Message::user_text("orphaned prompt")
            })
            .unwrap()
        );
        fixture.legacy("gone01", body.as_bytes(), gone.path());
        drop(gone);

        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Ready);
        assert_eq!(
            progress.issue_count, 0,
            "a session from a deleted directory must not block the index build"
        );
        assert_eq!(progress.indexed_sessions, 1);
    }

    #[test]
    fn tracked_list_reports_issue_details_for_broken_sources() {
        let fixture = Fixture::new();
        fixture.seed();
        // A session whose .hctl control record has an unsupported schema version
        // fails source validation at scan level; the refresh response must
        // carry the per-entry reason instead of an opaque count.
        let id = "broken1";
        std::fs::write(
            fixture.history.path().join(format!("{id}.jsonl")),
            b"{\"schema_version\":1}
",
        )
        .unwrap();
        let control = fixture.history.path().join(format!("{id}.hctl"));
        std::fs::create_dir_all(&control).unwrap();
        std::fs::write(
            control.join("source.json"),
            br#"{"schema_version":3,"incarnation":"00000000-0000-0000-0000-000000000000","deleted":false}"#,
        )
        .unwrap();

        let mut service = TrackedHistoryList::default();
        service.begin(&fixture.engine, true).unwrap();
        let progress = finish(&mut service, &fixture.engine, StepBudget::default());
        assert_eq!(progress.phase, BuildPhase::Incomplete);
        assert_eq!(progress.issue_count, 1);
        assert_eq!(progress.issues.len(), 1);
        assert!(
            progress.issues[0].reason.contains(id),
            "reason names the entry: {}",
            progress.issues[0].reason
        );
        assert!(
            progress.issues[0]
                .reason
                .contains("unsupported history source version"),
            "reason carries the validation error: {}",
            progress.issues[0].reason
        );
    }
}
