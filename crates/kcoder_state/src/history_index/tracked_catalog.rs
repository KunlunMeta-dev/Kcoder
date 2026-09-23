//! Journal-watermarked list storage, independent of the legacy full-hash parsing cache.
//! A CLI builder still owns complete candidate enumeration, workspace validation and issue counts.
//! Checksums detect accidental derived-row/header corruption, not deliberate same-user tampering.

use super::journal::{self, JournalDomain, JournalWatermark};
use super::{
    CatalogRevision, MAX_ENTRIES, MAX_FIELD_BYTES, MAX_SNAPSHOT_BYTES, encode_metadata, files,
    validate_id,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const MAX_BATCH_ROWS: usize = 4096;
const MAX_BATCH_BYTES: usize = 16 * 1024 * 1024;
const ROW_FIXED_BYTES: usize = 20 + 1 + 32;
const SCHEMA: [(&str, &str); 3] = [
    (
        "list_header",
        "CREATE TABLE list_header(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, instance TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), phase INTEGER NOT NULL CHECK(phase IN (0,1,2)), source_mark TEXT, client_mark TEXT, row_count INTEGER NOT NULL CHECK(row_count>=0), checkpoint_sha256 BLOB NOT NULL CHECK(length(checkpoint_sha256)=32))",
    ),
    (
        "list_order",
        "CREATE INDEX list_order ON list_sessions(updated_key DESC, session_id ASC)",
    ),
    (
        "list_sessions",
        "CREATE TABLE list_sessions(session_id TEXT PRIMARY KEY NOT NULL, updated_key TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)), metadata TEXT NOT NULL, row_sha256 BLOB NOT NULL CHECK(length(row_sha256)=32))",
    ),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BaselineState {
    Uninitialized,
    Building,
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Watermarks {
    source: JournalWatermark,
    client: JournalWatermark,
}

#[derive(Clone, Debug)]
pub struct ListCatalogCheckpoint {
    pub revision: CatalogRevision,
    pub state: BaselineState,
    marks: Option<Watermarks>,
    row_count: usize,
}

impl ListCatalogCheckpoint {
    pub fn source_watermark(&self) -> Option<&JournalWatermark> {
        self.marks.as_ref().map(|marks| &marks.source)
    }

    pub fn client_watermark(&self) -> Option<&JournalWatermark> {
        self.marks.as_ref().map(|marks| &marks.client)
    }

    pub fn row_count(&self) -> usize {
        self.row_count
    }
}

/// A bounded dirty set captured from both journals against one catalog revision.
/// Rows for every ID must be rebuilt or explicitly deleted before these watermarks advance.
pub struct ListCatalogDelta {
    checkpoint: ListCatalogCheckpoint,
    marks: Watermarks,
    session_ids: Vec<String>,
}

impl ListCatalogDelta {
    pub fn session_ids(&self) -> &[String] {
        &self.session_ids
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ListCatalogSession {
    pub session_id: String,
    pub updated_at_ms: u64,
    pub archived: bool,
    pub metadata: serde_json::Value,
}

pub struct ListCatalogSnapshot {
    pub checkpoint: ListCatalogCheckpoint,
    pub sessions: Vec<ListCatalogSession>,
}

pub struct TrackedHistoryCatalog {
    connection: Connection,
    instance: uuid::Uuid,
    history_root: PathBuf,
    client_root: PathBuf,
    writable: bool,
    _lease: files::Lease,
}

impl TrackedHistoryCatalog {
    /// Open existing roots only. Read-only opening never creates, migrates or activates journals.
    pub fn open(
        client_root: &Path,
        history_root: &Path,
        workspace: &str,
        writable: bool,
    ) -> Result<Option<Self>> {
        ensure!(
            !workspace.is_empty() && workspace.len() <= 16 * 1024,
            "invalid list catalog workspace"
        );
        let client_root = match dunce::canonicalize(client_root) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let history_root = dunce::canonicalize(history_root)?;
        let scope = tracked_list_scope(workspace, &history_root, &client_root)?;
        let Some(opened) =
            files::open_database(&client_root, "history-list-index", &scope, writable)?
        else {
            return Ok(None);
        };
        let mut connection = opened.connection;
        connection.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            (4 * MAX_FIELD_BYTES) as i32,
        );
        connection.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024);
        connection.busy_timeout(std::time::Duration::from_millis(50))?;
        connection.execute_batch("PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;")?;
        if !writable {
            connection.pragma_update(None, "query_only", true)?;
        }
        let transaction = connection.transaction_with_behavior(if writable {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })?;
        let objects: i64 = transaction.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
            [],
            |row| row.get(0),
        )?;
        if objects == 0 {
            ensure!(writable, "list catalog is uninitialized");
            for index in [0, 2, 1] {
                transaction.execute_batch(SCHEMA[index].1)?;
            }
            let instance = uuid::Uuid::new_v4().to_string();
            let digest = checkpoint_digest(&instance, 0, 0, None, None, 0)?;
            transaction.execute(
                "INSERT INTO list_header VALUES(1,1,?1,0,0,NULL,NULL,0,?2)",
                params![instance, digest.as_slice()],
            )?;
        }
        validate_schema(&transaction)?;
        let instance: String =
            transaction.query_row("SELECT instance FROM list_header WHERE id=1", [], |row| {
                row.get(0)
            })?;
        let instance = uuid::Uuid::parse_str(&instance)?;
        read_checkpoint(&transaction, instance)?;
        transaction.commit()?;
        Ok(Some(Self {
            connection,
            instance,
            history_root,
            client_root,
            writable,
            _lease: opened.lease,
        }))
    }

    pub fn checkpoint(&self) -> Result<ListCatalogCheckpoint> {
        read_checkpoint(&self.connection, self.instance)
    }

    /// Start a new baseline. Full source enumeration and its completeness remain caller duties.
    pub fn begin_baseline(&mut self, expected: &CatalogRevision) -> Result<ListCatalogCheckpoint> {
        ensure!(self.writable, "list catalog is read-only");
        let marks = observe(&self.history_root, &self.client_root)?
            .context("both journals must be tracking")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = check_cas(&transaction, self.instance, expected)?;
        transaction.execute("DELETE FROM list_sessions", [])?;
        write_checkpoint(&transaction, &current, BaselineState::Building, &marks, 0)?;
        let committed = read_checkpoint(&transaction, self.instance)?;
        transaction.commit()?;
        Ok(committed)
    }

    /// Bounded baseline staging never declares enumeration complete or advances journal marks.
    pub fn stage_baseline(
        &mut self,
        expected: &CatalogRevision,
        rows: &[ListCatalogSession],
    ) -> Result<ListCatalogCheckpoint> {
        ensure!(self.writable, "list catalog is read-only");
        let encoded = encode_rows(rows, &[])?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = check_cas(&transaction, self.instance, expected)?;
        ensure!(
            current.state == BaselineState::Building,
            "baseline is not building"
        );
        let count = apply_rows(&transaction, &encoded, &[], current.row_count)?;
        write_checkpoint(
            &transaction,
            &current,
            BaselineState::Building,
            current.marks.as_ref().context("baseline marks missing")?,
            count,
        )?;
        let committed = read_checkpoint(&transaction, self.instance)?;
        transaction.commit()?;
        Ok(committed)
    }

    /// Read only bounded invalidations. Restarted consumers may rebuild individual dirty sources;
    /// this API does not persist or restore a committed projection's suffix-reader state.
    pub fn prepare_update(&self, maximum: usize) -> Result<ListCatalogDelta> {
        ensure!(
            (1..=MAX_BATCH_ROWS).contains(&maximum),
            "invalid list delta budget"
        );
        let checkpoint = self.checkpoint()?;
        let marks = checkpoint
            .marks
            .as_ref()
            .context("baseline has not started")?;
        let source = journal::changes_since(
            &self.history_root,
            JournalDomain::History,
            &marks.source,
            maximum,
        )?
        .context("source journal tracking is disabled")?;
        let client = journal::changes_since(
            &self.client_root,
            JournalDomain::ClientMetadata,
            &marks.client,
            maximum,
        )?
        .context("client journal tracking is disabled")?;
        let ids: std::collections::BTreeSet<_> = source
            .session_ids
            .into_iter()
            .chain(client.session_ids)
            .collect();
        ensure!(
            ids.len() <= maximum,
            "combined list delta exceeds row budget"
        );
        Ok(ListCatalogDelta {
            checkpoint,
            marks: Watermarks {
                source: source.watermark,
                client: client.watermark,
            },
            session_ids: ids.into_iter().collect(),
        })
    }

    /// Caller assertion: candidate enumeration finished successfully, including workspace checks
    /// and issue-count policy. Storage cannot prove scan completeness. Missing/partial scans must
    /// remain Building. The final delta accounts for writes during that completed enumeration.
    pub fn finish_baseline(
        &mut self,
        delta: ListCatalogDelta,
        rows: &[ListCatalogSession],
        deleted: &[&str],
    ) -> Result<ListCatalogCheckpoint> {
        self.commit_delta_with(delta, rows, deleted, true, || Ok(()))
    }

    /// Advance rows and both watermarks in the same CAS transaction, only for a Ready baseline.
    pub fn commit_update(
        &mut self,
        delta: ListCatalogDelta,
        rows: &[ListCatalogSession],
        deleted: &[&str],
    ) -> Result<ListCatalogCheckpoint> {
        self.commit_delta_with(delta, rows, deleted, false, || Ok(()))
    }

    fn commit_delta_with(
        &mut self,
        delta: ListCatalogDelta,
        rows: &[ListCatalogSession],
        deleted: &[&str],
        finishing: bool,
        before_final_check: impl FnOnce() -> Result<()>,
    ) -> Result<ListCatalogCheckpoint> {
        ensure!(self.writable, "list catalog is read-only");
        let encoded = encode_rows(rows, deleted)?;
        let supplied: std::collections::BTreeSet<_> = rows
            .iter()
            .map(|row| row.session_id.as_str())
            .chain(deleted.iter().copied())
            .collect();
        ensure!(
            supplied
                .iter()
                .copied()
                .eq(delta.session_ids.iter().map(String::as_str)),
            "list delta requires exactly one upsert or deletion for every dirty source"
        );
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = check_cas(&transaction, self.instance, &delta.checkpoint.revision)?;
        ensure!(
            current.marks == delta.checkpoint.marks,
            "list delta checkpoint changed"
        );
        ensure!(
            current.state
                == if finishing {
                    BaselineState::Building
                } else {
                    BaselineState::Ready
                },
            "invalid baseline publication transition"
        );
        ensure!(
            observe(&self.history_root, &self.client_root)?.as_ref() == Some(&delta.marks),
            "journals changed after delta preparation"
        );
        let count = apply_rows(&transaction, &encoded, deleted, current.row_count)?;
        before_final_check()?;
        ensure!(
            observe(&self.history_root, &self.client_root)?.as_ref() == Some(&delta.marks),
            "journals changed while publishing list rows"
        );
        write_checkpoint(
            &transaction,
            &current,
            BaselineState::Ready,
            &delta.marks,
            count,
        )?;
        let committed = read_checkpoint(&transaction, self.instance)?;
        transaction.commit()?;
        Ok(committed)
    }

    /// A bounded full snapshot, not keyset pagination. Overflow is an error, never truncation.
    pub fn read_ready(&mut self, maximum: usize) -> Result<Option<ListCatalogSnapshot>> {
        self.read_ready_with(maximum, || Ok(()))
    }

    fn read_ready_with(
        &mut self,
        maximum: usize,
        after_rows: impl FnOnce() -> Result<()>,
    ) -> Result<Option<ListCatalogSnapshot>> {
        ensure!(
            (1..=MAX_ENTRIES).contains(&maximum),
            "invalid list snapshot budget"
        );
        let transaction = self.connection.transaction()?;
        let checkpoint = read_checkpoint(&transaction, self.instance)?;
        if checkpoint.state != BaselineState::Ready {
            return Ok(None);
        }
        ensure!(
            checkpoint.row_count <= maximum,
            "list snapshot exceeds row budget"
        );
        let Some(marks) = checkpoint.marks.as_ref() else {
            return Ok(None);
        };
        if observe(&self.history_root, &self.client_root)?.as_ref() != Some(marks) {
            return Ok(None);
        }
        let mut sessions = Vec::new();
        let mut bytes = 0;
        {
            let mut statement = transaction.prepare("SELECT session_id, updated_key, archived, metadata, row_sha256 FROM list_sessions ORDER BY updated_key DESC, session_id ASC LIMIT ?1")?;
            let mut rows = statement.query([maximum as i64 + 1])?;
            while let Some(row) = rows.next()? {
                ensure!(sessions.len() < maximum, "list snapshot exceeds row budget");
                let session_id: String = row.get(0)?;
                validate_id(&session_id)?;
                let key: String = row.get(1)?;
                ensure!(
                    key.len() == 20 && key.bytes().all(|byte| byte.is_ascii_digit()),
                    "invalid list timestamp"
                );
                let archived: i64 = row.get(2)?;
                ensure!(matches!(archived, 0 | 1), "invalid list archive state");
                let metadata: String = row.get(3)?;
                ensure!(
                    metadata.len() <= MAX_FIELD_BYTES,
                    "list row exceeds byte budget"
                );
                ensure!(
                    row.get_ref(4)?.as_blob()?
                        == row_digest(&session_id, &key, archived == 1, &metadata)?,
                    "list row checksum mismatch"
                );
                bytes += session_id.len() + metadata.len() + ROW_FIXED_BYTES;
                ensure!(
                    bytes <= MAX_SNAPSHOT_BYTES,
                    "list snapshot exceeds byte budget"
                );
                let metadata: serde_json::Value = serde_json::from_str(&metadata)?;
                ensure!(metadata.is_object(), "invalid list metadata");
                sessions.push(ListCatalogSession {
                    session_id,
                    updated_at_ms: key.parse()?,
                    archived: archived == 1,
                    metadata,
                });
            }
        }
        ensure!(
            sessions.len() == checkpoint.row_count,
            "list snapshot row count mismatch"
        );
        after_rows()?;
        if observe(&self.history_root, &self.client_root)?.as_ref() != Some(marks) {
            return Ok(None);
        }
        transaction.commit()?;
        Ok(Some(ListCatalogSnapshot {
            checkpoint,
            sessions,
        }))
    }
}

/// The scope string is a persistent identity key, so path components always
/// enter it in their simplified (namespace-free) form.
fn tracked_list_scope(workspace: &str, history_root: &Path, client_root: &Path) -> Result<String> {
    Ok(serde_json::to_string(&(
        "kcoder.tracked-list.v1",
        workspace,
        files::scope_path_component(history_root),
        files::scope_path_component(client_root),
    ))?)
}

fn observe(history: &Path, client: &Path) -> Result<Option<Watermarks>> {
    let Some(source) = journal::current_watermark(history, JournalDomain::History)? else {
        return Ok(None);
    };
    let Some(client) = journal::current_watermark(client, JournalDomain::ClientMetadata)? else {
        return Ok(None);
    };
    Ok(Some(Watermarks { source, client }))
}

fn validate_schema(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 4",
    )?;
    let mut rows = statement.query([])?;
    for (name, sql) in SCHEMA {
        let row = rows.next()?.context("incomplete list catalog schema")?;
        ensure!(
            row.get::<_, String>(0)? == name && row.get::<_, String>(1)? == sql,
            "unsupported list catalog schema"
        );
    }
    ensure!(
        rows.next()?.is_none(),
        "unexpected list catalog schema objects"
    );
    Ok(())
}

fn read_checkpoint(connection: &Connection, instance: uuid::Uuid) -> Result<ListCatalogCheckpoint> {
    validate_schema(connection)?;
    let (version, stored, revision, phase, source, client, count, digest): (i64, String, i64, i64, Option<String>, Option<String>, i64, Vec<u8>) = connection.query_row("SELECT version,instance,revision,phase,source_mark,client_mark,row_count,checkpoint_sha256 FROM list_header WHERE id=1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)))?;
    ensure!(
        version == 1
            && stored == instance.to_string()
            && revision >= 0
            && (0..=MAX_ENTRIES as i64).contains(&count),
        "invalid list catalog checkpoint"
    );
    let state = match phase {
        0 => BaselineState::Uninitialized,
        1 => BaselineState::Building,
        2 => BaselineState::Ready,
        _ => anyhow::bail!("invalid baseline state"),
    };
    ensure!(
        source.as_ref().is_none_or(|value| value.len() <= 1024)
            && client.as_ref().is_none_or(|value| value.len() <= 1024),
        "journal watermark exceeds byte budget"
    );
    ensure!(
        digest
            == checkpoint_digest(
                &stored,
                revision,
                phase,
                source.as_deref(),
                client.as_deref(),
                count
            )?,
        "list checkpoint checksum mismatch"
    );
    let marks = match (source, client) {
        (None, None) if state == BaselineState::Uninitialized && count == 0 => None,
        (Some(source), Some(client)) if state != BaselineState::Uninitialized => {
            ensure!(
                source.len() <= 1024 && client.len() <= 1024,
                "journal watermark exceeds byte budget"
            );
            Some(Watermarks {
                source: serde_json::from_str(&source)?,
                client: serde_json::from_str(&client)?,
            })
        }
        _ => anyhow::bail!("inconsistent baseline watermarks"),
    };
    Ok(ListCatalogCheckpoint {
        revision: CatalogRevision {
            instance,
            sequence: revision as u64,
        },
        state,
        marks,
        row_count: count as usize,
    })
}

fn check_cas(
    connection: &Connection,
    instance: uuid::Uuid,
    expected: &CatalogRevision,
) -> Result<ListCatalogCheckpoint> {
    let checkpoint = read_checkpoint(connection, instance)?;
    ensure!(
        &checkpoint.revision == expected,
        "stale list catalog publication"
    );
    Ok(checkpoint)
}

fn write_checkpoint(
    connection: &Connection,
    old: &ListCatalogCheckpoint,
    state: BaselineState,
    marks: &Watermarks,
    count: usize,
) -> Result<()> {
    let next = old
        .revision
        .sequence
        .checked_add(1)
        .and_then(|value| i64::try_from(value).ok())
        .context("list catalog revision exhausted")?;
    let phase = match state {
        BaselineState::Building => 1,
        BaselineState::Ready => 2,
        BaselineState::Uninitialized => anyhow::bail!("cannot publish uninitialized state"),
    };
    let source = serde_json::to_string(&marks.source)?;
    let client = serde_json::to_string(&marks.client)?;
    let digest = checkpoint_digest(
        &old.revision.instance.to_string(),
        next,
        phase,
        Some(&source),
        Some(&client),
        count as i64,
    )?;
    connection.execute("UPDATE list_header SET revision=?1,phase=?2,source_mark=?3,client_mark=?4,row_count=?5,checkpoint_sha256=?6 WHERE id=1", params![next, phase, source, client, count as i64, digest.as_slice()])?;
    Ok(())
}

fn encode_rows<'a>(
    rows: &'a [ListCatalogSession],
    deleted: &[&str],
) -> Result<Vec<(&'a ListCatalogSession, String)>> {
    ensure!(
        rows.len().saturating_add(deleted.len()) <= MAX_BATCH_ROWS,
        "list mutation exceeds row budget"
    );
    let mut ids = std::collections::HashSet::new();
    let mut bytes = 0usize;
    let mut encoded = Vec::new();
    for row in rows {
        validate_id(&row.session_id)?;
        ensure!(
            ids.insert(row.session_id.as_str()) && row.metadata.is_object(),
            "duplicate or invalid list mutation"
        );
        let metadata = encode_metadata(&row.metadata)?;
        bytes += row.session_id.len() + metadata.len() + ROW_FIXED_BYTES;
        ensure!(
            bytes <= MAX_BATCH_BYTES,
            "list mutation exceeds byte budget"
        );
        encoded.push((row, metadata));
    }
    for id in deleted {
        validate_id(id)?;
        ensure!(ids.insert(id), "duplicate list mutation");
        bytes += id.len();
    }
    ensure!(
        bytes <= MAX_BATCH_BYTES,
        "list mutation exceeds byte budget"
    );
    Ok(encoded)
}

fn apply_rows(
    connection: &Connection,
    rows: &[(&ListCatalogSession, String)],
    deleted: &[&str],
    mut count: usize,
) -> Result<usize> {
    for id in deleted {
        let removed = connection.execute("DELETE FROM list_sessions WHERE session_id=?1", [id])?;
        count = count
            .checked_sub(removed)
            .context("invalid list row count")?;
    }
    for (row, metadata) in rows {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM list_sessions WHERE session_id=?1)",
            [&row.session_id],
            |value| value.get(0),
        )?;
        count += usize::from(!exists);
        ensure!(count <= MAX_ENTRIES, "list catalog exceeds entry budget");
        let key = format!("{:020}", row.updated_at_ms);
        let digest = row_digest(&row.session_id, &key, row.archived, metadata)?;
        connection.execute("INSERT INTO list_sessions VALUES(?1,?2,?3,?4,?5) ON CONFLICT(session_id) DO UPDATE SET updated_key=excluded.updated_key,archived=excluded.archived,metadata=excluded.metadata,row_sha256=excluded.row_sha256", params![row.session_id, key, row.archived, metadata, digest.as_slice()])?;
    }
    Ok(count)
}

fn row_digest(id: &str, key: &str, archived: bool, metadata: &str) -> Result<[u8; 32]> {
    Ok(Sha256::digest(serde_json::to_vec(&(
        "kcoder.tracked-list-row.v1",
        id,
        key,
        archived,
        metadata,
    ))?)
    .into())
}

fn checkpoint_digest(
    instance: &str,
    revision: i64,
    phase: i64,
    source: Option<&str>,
    client: Option<&str>,
    count: i64,
) -> Result<[u8; 32]> {
    Ok(Sha256::digest(serde_json::to_vec(&(
        "kcoder.tracked-list-checkpoint.v1",
        instance,
        revision,
        phase,
        source,
        client,
        count,
    ))?)
    .into())
}

#[cfg(test)]
mod tests {
    use super::journal::JournalFence;
    use super::*;

    // Each catalog keeps a VFS slot; serialize this module's fixtures rather than saturating it.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, TrackedHistoryCatalog) {
        let history = tempfile::tempdir().unwrap();
        let client = tempfile::tempdir().unwrap();
        JournalFence::try_acquire(history.path(), JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
        JournalFence::try_acquire(client.path(), JournalDomain::ClientMetadata)
            .unwrap()
            .activate()
            .unwrap();
        let catalog = TrackedHistoryCatalog::open(client.path(), history.path(), "workspace", true)
            .unwrap()
            .unwrap();
        (history, client, catalog)
    }

    fn row(id: &str, updated: u64) -> ListCatalogSession {
        ListCatalogSession {
            session_id: id.into(),
            updated_at_ms: updated,
            archived: false,
            metadata: serde_json::json!({"title":id,"updated":updated}),
        }
    }

    fn ready(
        catalog: &mut TrackedHistoryCatalog,
        rows: &[ListCatalogSession],
    ) -> ListCatalogCheckpoint {
        let initial = catalog.checkpoint().unwrap();
        let building = catalog.begin_baseline(&initial.revision).unwrap();
        catalog.stage_baseline(&building.revision, rows).unwrap();
        let delta = catalog.prepare_update(10).unwrap();
        catalog.finish_baseline(delta, &[], &[]).unwrap()
    }

    fn change(root: &Path, domain: JournalDomain, id: &str) {
        let mut fence = JournalFence::try_acquire(root, domain).unwrap();
        assert!(fence.begin(id).unwrap().finish().unwrap());
    }

    #[test]
    fn tracked_catalog_building_rows_are_never_a_ready_snapshot() {
        let _serial = serial();
        let history = tempfile::tempdir().unwrap();
        let client = tempfile::tempdir().unwrap();
        JournalFence::try_acquire(history.path(), JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
        JournalFence::try_acquire(client.path(), JournalDomain::ClientMetadata)
            .unwrap()
            .activate()
            .unwrap();
        let mut catalog =
            TrackedHistoryCatalog::open(client.path(), history.path(), "workspace", true)
                .unwrap()
                .unwrap();
        let initial = catalog.checkpoint().unwrap();
        let building = catalog.begin_baseline(&initial.revision).unwrap();
        catalog
            .stage_baseline(
                &building.revision,
                &[ListCatalogSession {
                    session_id: "session".into(),
                    updated_at_ms: 1,
                    archived: false,
                    metadata: serde_json::json!({"title":"one"}),
                }],
            )
            .unwrap();
        assert!(catalog.read_ready(10).unwrap().is_none());
    }

    #[test]
    fn tracked_catalog_readonly_restart_restores_rows_and_both_marks_without_sources() {
        let _serial = serial();
        let (history, client, mut catalog) = fixture();
        let completed = ready(&mut catalog, &[row("a", 1), row("b", 2)]);
        drop(catalog);
        let mut cold =
            TrackedHistoryCatalog::open(client.path(), history.path(), "workspace", false)
                .unwrap()
                .unwrap();
        let snapshot = cold.read_ready(10).unwrap().unwrap();
        assert_eq!(snapshot.sessions, [row("b", 2), row("a", 1)]);
        assert_eq!(snapshot.checkpoint.revision, completed.revision);
        assert_eq!(
            snapshot.checkpoint.source_watermark(),
            completed.source_watermark()
        );
        assert_eq!(
            snapshot.checkpoint.client_watermark(),
            completed.client_watermark()
        );
        assert_eq!(snapshot.checkpoint.row_count(), 2);
        assert!(cold.begin_baseline(&completed.revision).is_err());
        assert!(!history.path().join("a.jsonl").exists());
        assert!(!history.path().join("b.jsonl").exists());
        assert!(
            TrackedHistoryCatalog::open(
                client.path(),
                history.path(),
                "different workspace",
                false
            )
            .is_err()
        );
    }

    #[test]
    fn tracked_catalog_requires_all_dirty_ids_before_atomically_advancing_both_marks() {
        let _serial = serial();
        let (history, client, mut catalog) = fixture();
        let old = ready(&mut catalog, &[row("a", 1), row("b", 2)]);
        change(history.path(), JournalDomain::History, "a");
        change(client.path(), JournalDomain::ClientMetadata, "b");
        let delta = catalog.prepare_update(10).unwrap();
        assert_eq!(delta.session_ids(), ["a", "b"]);
        assert!(catalog.commit_update(delta, &[row("a", 3)], &[]).is_err());
        assert_eq!(catalog.checkpoint().unwrap().revision, old.revision);
        assert!(catalog.read_ready(10).unwrap().is_none());
        let delta = catalog.prepare_update(10).unwrap();
        let new = catalog
            .commit_update(delta, &[row("a", 3)], &["b"])
            .unwrap();
        assert_ne!(new.source_watermark(), old.source_watermark());
        assert_ne!(new.client_watermark(), old.client_watermark());
        assert_eq!(
            catalog.read_ready(10).unwrap().unwrap().sessions,
            [row("a", 3)]
        );
    }

    #[test]
    fn tracked_catalog_cas_and_failure_after_rows_leave_checkpoint_and_rows_unchanged() {
        let _serial = serial();
        let (history, client, mut catalog) = fixture();
        let old = ready(&mut catalog, &[row("a", 1)]);
        change(history.path(), JournalDomain::History, "a");
        let delta = catalog.prepare_update(10).unwrap();
        assert!(
            catalog
                .commit_delta_with(delta, &[row("a", 2)], &[], false, || anyhow::bail!(
                    "injected after row changes"
                ))
                .is_err()
        );
        let after = catalog.checkpoint().unwrap();
        assert_eq!(after.revision, old.revision);
        assert_eq!(after.marks, old.marks);
        let stored: String = catalog
            .connection
            .query_row(
                "SELECT metadata FROM list_sessions WHERE session_id='a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stored).unwrap(),
            row("a", 1).metadata
        );
        let delta = catalog.prepare_update(10).unwrap();
        assert!(
            catalog
                .commit_delta_with(delta, &[row("a", 2)], &[], false, || {
                    change(client.path(), JournalDomain::ClientMetadata, "a");
                    Ok(())
                })
                .is_err()
        );
        assert_eq!(catalog.checkpoint().unwrap().revision, old.revision);
        let stale = catalog.prepare_update(10).unwrap();
        let mut other =
            TrackedHistoryCatalog::open(client.path(), history.path(), "workspace", true)
                .unwrap()
                .unwrap();
        other.begin_baseline(&old.revision).unwrap();
        assert!(catalog.commit_update(stale, &[row("a", 2)], &[]).is_err());
        assert_eq!(catalog.checkpoint().unwrap().state, BaselineState::Building);
        assert_eq!(catalog.checkpoint().unwrap().row_count(), 0);
    }

    #[test]
    fn tracked_catalog_rechecks_each_watermark_after_reading_rows() {
        let _serial = serial();
        for domain in [JournalDomain::History, JournalDomain::ClientMetadata] {
            let (history, client, mut catalog) = fixture();
            ready(&mut catalog, &[row("a", 1)]);
            let root = if domain == JournalDomain::History {
                history.path()
            } else {
                client.path()
            };
            assert!(
                catalog
                    .read_ready_with(10, || {
                        change(root, domain, "a");
                        Ok(())
                    })
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn tracked_catalog_missing_rotated_and_pending_journals_cannot_hit() {
        let _serial = serial();
        for domain in [JournalDomain::History, JournalDomain::ClientMetadata] {
            for failure in 0..3 {
                let (history, client, mut catalog) = fixture();
                ready(&mut catalog, &[row("a", 1)]);
                let root = if domain == JournalDomain::History {
                    history.path()
                } else {
                    client.path()
                };
                match failure {
                    0 => {
                        let token = if domain == JournalDomain::History {
                            ".kcoder-history-tracking.json"
                        } else {
                            ".kcoder-client-metadata-tracking.json"
                        };
                        std::fs::remove_file(root.join(token)).unwrap();
                        assert!(catalog.read_ready(10).unwrap().is_none());
                        assert!(catalog.prepare_update(10).is_err());
                    }
                    1 => {
                        JournalFence::try_acquire(root, domain)
                            .unwrap()
                            .activate()
                            .unwrap();
                        assert!(catalog.read_ready(10).unwrap().is_none());
                        assert!(catalog.prepare_update(10).is_err());
                    }
                    _ => {
                        let mut fence = JournalFence::try_acquire(root, domain).unwrap();
                        let _pending = fence.begin("a").unwrap();
                        assert!(catalog.read_ready(10).is_err());
                        assert!(catalog.prepare_update(10).is_err());
                    }
                }
            }
        }
    }

    #[test]
    fn tracked_catalog_baseline_completion_catches_writes_during_enumeration() {
        let _serial = serial();
        let (history, _client, mut catalog) = fixture();
        let initial = catalog.checkpoint().unwrap();
        let building = catalog.begin_baseline(&initial.revision).unwrap();
        catalog
            .stage_baseline(&building.revision, &[row("a", 1)])
            .unwrap();
        change(history.path(), JournalDomain::History, "a");
        let delta = catalog.prepare_update(10).unwrap();
        assert!(catalog.commit_update(delta, &[row("a", 2)], &[]).is_err());
        let delta = catalog.prepare_update(10).unwrap();
        let complete = catalog.finish_baseline(delta, &[row("a", 2)], &[]).unwrap();
        assert_eq!(complete.state, BaselineState::Ready);
        assert_eq!(
            catalog.read_ready(10).unwrap().unwrap().sessions,
            [row("a", 2)]
        );
        assert!(
            catalog
                .stage_baseline(&complete.revision, &[row("a", 1)])
                .is_err()
        );
    }

    #[test]
    fn tracked_catalog_budgets_and_unknown_schema_fail_without_partial_success() {
        let _serial = serial();
        let (history, client, mut catalog) = fixture();
        let old = ready(&mut catalog, &[row("a", 1), row("b", 2)]);
        assert!(catalog.read_ready(1).is_err());
        change(history.path(), JournalDomain::History, "a");
        change(client.path(), JournalDomain::ClientMetadata, "b");
        assert!(catalog.prepare_update(1).is_err());
        let delta = catalog.prepare_update(10).unwrap();
        let mut large = row("a", 3);
        large.metadata = serde_json::json!({"large":"x".repeat(MAX_FIELD_BYTES)});
        assert!(catalog.commit_update(delta, &[large], &["b"]).is_err());
        assert_eq!(catalog.checkpoint().unwrap().revision, old.revision);
        catalog
            .connection
            .execute_batch("CREATE VIEW extra AS SELECT session_id FROM list_sessions")
            .unwrap();
        assert!(catalog.read_ready(10).is_err());
        drop(catalog);
        let database = client.path().join("history-list-index/catalog.sqlite3");
        let before = std::fs::read(&database).unwrap();
        assert!(
            TrackedHistoryCatalog::open(client.path(), history.path(), "workspace", true).is_err()
        );
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }

    #[test]
    fn tracked_catalog_readonly_absence_never_creates_storage() {
        let _serial = serial();
        let history = tempfile::tempdir().unwrap();
        let client = tempfile::tempdir().unwrap();
        assert!(
            TrackedHistoryCatalog::open(client.path(), history.path(), "workspace", false)
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_dir(client.path()).unwrap().count(), 0);
        let missing = client.path().join("missing");
        assert!(
            TrackedHistoryCatalog::open(&missing, history.path(), "workspace", false)
                .unwrap()
                .is_none()
        );
        assert!(!missing.exists());
    }

    #[test]
    fn tracked_catalog_detects_valid_json_row_corruption() {
        let _serial = serial();
        let (_history, _client, mut catalog) = fixture();
        ready(&mut catalog, &[row("a", 1)]);
        catalog
            .connection
            .execute(
                "UPDATE list_sessions SET metadata=?1 WHERE session_id='a'",
                [r#"{"title":"b","updated":1}"#],
            )
            .unwrap();
        assert!(catalog.read_ready(10).is_err());
    }

    #[test]
    fn tracked_catalog_detects_building_to_ready_header_corruption() {
        let _serial = serial();
        let (_history, _client, mut catalog) = fixture();
        let initial = catalog.checkpoint().unwrap();
        let building = catalog.begin_baseline(&initial.revision).unwrap();
        catalog
            .stage_baseline(&building.revision, &[row("a", 1)])
            .unwrap();
        catalog
            .connection
            .execute("UPDATE list_header SET phase=2", [])
            .unwrap();
        assert!(catalog.read_ready(10).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn tracked_catalog_scope_has_no_verbatim_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let client = temp.path().join("client");
        let history = temp.path().join("history");
        std::fs::create_dir_all(&client).unwrap();
        std::fs::create_dir_all(&history).unwrap();
        let scope = super::tracked_list_scope("workspace", &history, &client).unwrap();
        assert!(
            !scope.contains(r"\\?\"),
            "scope must not embed a verbatim path: {scope}"
        );
    }
}
