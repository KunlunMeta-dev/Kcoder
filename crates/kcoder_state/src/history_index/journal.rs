//! Durable invalidation for source writers; catalog consumers are integrated separately.
//!
//! A tracking token never certifies catalog completeness. Consumers must additionally validate
//! their own instance/watermark and completed baseline. Authority writes belong to the caller.

use super::files;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_config::PrivateDirectory;
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_TOKEN_BYTES: u64 = 1024;
const MAX_CHANGES: usize = 4096;
const MAX_TRACKED_SOURCES: i64 = 100_000;
const SCHEMA: [(&str, &str, &str); 3] = [
    (
        "table",
        "journal_changes",
        "CREATE TABLE journal_changes(session_id TEXT PRIMARY KEY NOT NULL CHECK(length(session_id)<=256), sequence INTEGER NOT NULL CHECK(sequence>0), pending INTEGER NOT NULL CHECK(pending IN (0,1)))",
    ),
    (
        "table",
        "journal_header",
        "CREATE TABLE journal_header(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, instance TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=0), pending_count INTEGER NOT NULL CHECK(pending_count IN (0,1)), source_count INTEGER NOT NULL CHECK(source_count>=0))",
    ),
    (
        "index",
        "journal_order",
        "CREATE INDEX journal_order ON journal_changes(sequence)",
    ),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalDomain {
    History,
    ClientMetadata,
}

impl JournalDomain {
    fn names(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::History => (
                "history-journal",
                ".kcoder-history-tracking.json",
                ".kcoder-history.lock",
            ),
            Self::ClientMetadata => (
                "client-metadata-journal",
                ".kcoder-client-metadata-tracking.json",
                ".kcoder-client-metadata.lock",
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    version: u32,
    domain: JournalDomain,
    instance: uuid::Uuid,
    enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JournalWatermark {
    instance: uuid::Uuid,
    sequence: i64,
}

pub struct JournalChanges {
    pub watermark: JournalWatermark,
    pub session_ids: Vec<String>,
}

/// An actual cross-process mutation fence. Activation and untracked writes share this lock.
/// Source writers transfer their already-held lock rather than acquiring it a second time.
pub struct JournalFence {
    root: PrivateDirectory,
    path: PathBuf,
    domain: JournalDomain,
    lock: File,
    #[cfg(test)]
    fail_after_row: bool,
}

impl Drop for JournalFence {
    fn drop(&mut self) {
        // Close alone can retain flock ownership in a concurrently forked child
        // until exec. The guard, not those inherited descriptors, owns the lock.
        if let Err(error) = FileExt::unlock(&self.lock) {
            tracing::warn!(%error, "failed to release journal mutation fence");
        }
    }
}

impl JournalFence {
    /// The caller must already hold the history mutation lock exclusively. Ownership transfer
    /// preserves the existing binding-mutex -> source-lock order without a second flock call.
    pub(crate) fn from_locked_history(root: &Path, lock: File) -> Result<Self> {
        let root = if root.as_os_str().is_empty() {
            Path::new(".")
        } else {
            root
        };
        let path = dunce::canonicalize(root)?;
        let fence = Self {
            root: PrivateDirectory::open_existing(&path)?,
            path,
            domain: JournalDomain::History,
            lock,
            #[cfg(test)]
            fail_after_row: false,
        };
        fence.verify_fence()?;
        Ok(fence)
    }

    /// Legacy history filenames need not be representable by the derived journal's UTF-8 IDs.
    /// Preserve authority writes by disabling tracking; never merge identities through lossy text.
    pub(crate) fn begin_history_source(&mut self, path: &Path) -> Result<JournalMutation<'_>> {
        match crate::session_persistence::session_id_from_history_path(path) {
            Ok(id) if valid_session_id(&id) => self.begin(&id),
            _ => {
                self.verify_fence()?;
                self.revoke()
                    .context("cannot disable tracking for an unrepresentable history source")?;
                Ok(JournalMutation {
                    fence: self,
                    tracked: None,
                    session_id: String::new(),
                })
            }
        }
    }

    /// Never create the root or wait for another writer/builder.
    pub fn try_acquire(root: &Path, domain: JournalDomain) -> Result<Self> {
        let directory = PrivateDirectory::open_existing(root)?;
        let name = OsStr::new(domain.names().2);
        let lock = match directory.open_read_write_file(name, false) {
            Ok(file) => file,
            Err(error) if missing(&error) => directory.open_read_write_file(name, true)?,
            Err(error) => return Err(error),
        };
        FileExt::try_lock_exclusive(&lock).context("journal mutation fence is busy")?;
        let fence = Self {
            root: directory,
            path: dunce::canonicalize(root)?,
            domain,
            lock,
            #[cfg(test)]
            fail_after_row: false,
        };
        fence.verify_fence()?;
        Ok(fence)
    }

    fn verify_fence(&self) -> Result<()> {
        let name = OsStr::new(self.domain.names().2);
        let pinned = self.root.open_regular_file(name)?;
        let current = PrivateDirectory::open_existing(&self.path)?.open_regular_file(name)?;
        ensure!(
            files::file_identity(&pinned)? == files::file_identity(&self.lock)?
                && files::file_identity(&current)? == files::file_identity(&self.lock)?,
            "journal fence identity changed"
        );
        Ok(())
    }

    /// Explicitly start a new tracking epoch. This does not build or publish a ready catalog.
    /// Unsupported/corrupt database schemas are not replaced automatically.
    pub fn activate(&mut self) -> Result<JournalWatermark> {
        self.verify_fence()?;
        self.revoke()?;
        let mut database = open_retrying(&self.path, self.domain, true)?
            .context("journal database unavailable")?;
        initialize(&mut database.connection)?;
        let token = Token {
            version: 1,
            domain: self.domain,
            instance: uuid::Uuid::new_v4(),
            enabled: true,
        };
        let transaction = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("DELETE FROM journal_changes", [])?;
        transaction.execute("UPDATE journal_header SET instance=?1, sequence=0, pending_count=0, source_count=0 WHERE id=1", [token.instance.to_string()])?;
        transaction.commit()?;
        self.verify_fence()?;
        self.root.atomic_replace(
            OsStr::new(self.domain.names().1),
            &serde_json::to_vec(&token)?,
        )?;
        Ok(JournalWatermark {
            instance: token.instance,
            sequence: 0,
        })
    }

    /// Return a guard before authority is changed. A disabled guard still retains this fence.
    /// Database failure permits untracked authority only after durable token revocation succeeds.
    pub fn begin(&mut self, session_id: &str) -> Result<JournalMutation<'_>> {
        // One retry layer only: `retry_transient_journal_setup` below owns the backoff.
        self.begin_with(session_id, |path, domain| open(path, domain, true))
    }

    fn begin_with(
        &mut self,
        session_id: &str,
        mut open_database: impl FnMut(&Path, JournalDomain) -> Result<Option<Database>>,
    ) -> Result<JournalMutation<'_>> {
        ensure!(valid_session_id(session_id), "invalid journal session id");
        self.verify_fence()?;
        let tracked = retry_transient_journal_setup(|| {
            (|| -> Result<Option<(Database, Token, i64)>> {
                let Some(token) = read_token(&self.root, self.domain)? else {
                    return Ok(None);
                };
                let mut database =
                    open_database(&self.path, self.domain)?.context("journal database missing")?;
                let transaction = database
                    .connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)?;
                let (sequence, pending) = header(&transaction, &token)?;
                ensure!(
                    pending == 0,
                    "journal has an unfinished mutation; rebuild tracking explicitly"
                );
                let count: i64 = transaction.query_row(
                    "SELECT source_count FROM journal_header WHERE id=1",
                    [],
                    |row| row.get(0),
                )?;
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM journal_changes WHERE session_id=?1)",
                    [session_id],
                    |row| row.get(0),
                )?;
                ensure!(
                    (0..=MAX_TRACKED_SOURCES).contains(&count)
                        && (exists || count < MAX_TRACKED_SOURCES),
                    "journal source budget exhausted"
                );
                let next = sequence
                    .checked_add(1)
                    .context("journal sequence exhausted")?;
                transaction.execute(
                    "INSERT INTO journal_changes(session_id, sequence, pending) VALUES(?1, ?2, 1)
                ON CONFLICT(session_id) DO UPDATE SET sequence=excluded.sequence, pending=1",
                    params![session_id, next],
                )?;
                #[cfg(test)]
                ensure!(!self.fail_after_row, "injected failure after row write");
                transaction.execute("UPDATE journal_header SET sequence=?1, pending_count=1, source_count=?2 WHERE id=1", params![next, count + i64::from(!exists)])?;
                transaction.commit()?;
                Ok(Some((database, token, next)))
            })()
        });
        let tracked = match tracked {
            Ok(tracked) => tracked,
            Err(error) => {
                self.revoke()
                    .context("cannot durably disable failed journal before authority write")?;
                tracing::debug!(%error, "journal disabled; authority may proceed under its fence");
                None
            }
        };
        Ok(JournalMutation {
            fence: self,
            tracked,
            session_id: session_id.to_owned(),
        })
    }

    fn revoke(&self) -> Result<()> {
        let name = OsStr::new(self.domain.names().1);
        match self.root.open_regular_file(name) {
            Ok(_) => {}
            Err(error) if missing(&error) => return Ok(()),
            Err(error) => return Err(error),
        }
        // Use the same atomic-replacement durability contract as source-control receipts.
        // A disabled tombstone does not depend on directory-unlink durability on each platform.
        let disabled = Token {
            version: 1,
            domain: self.domain,
            instance: uuid::Uuid::nil(),
            enabled: false,
        };
        self.root
            .atomic_replace(name, &serde_json::to_vec(&disabled)?)
    }
}

/// Drop leaves a durable pending entry. Call `finish` only after authority is committed or
/// proven unchanged. An uncertain source write must not be reported as a completed mutation.
pub struct JournalMutation<'a> {
    fence: &'a mut JournalFence,
    tracked: Option<(Database, Token, i64)>,
    session_id: String,
}

impl JournalMutation<'_> {
    pub fn is_tracking(&self) -> bool {
        self.tracked.is_some()
    }

    /// False means tracking was durably disabled; authority must never be replayed on this result.
    /// Even an error here does not mean the caller's authority write was rolled back.
    pub fn finish(mut self) -> Result<bool> {
        let Some((mut database, token, started)) = self.tracked.take() else {
            return Ok(false);
        };
        let result = (|| -> Result<()> {
            self.fence.verify_fence()?;
            ensure!(
                read_token(&self.fence.root, self.fence.domain)?.as_ref() == Some(&token),
                "journal token changed during mutation"
            );
            let transaction = database
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (sequence, pending) = header(&transaction, &token)?;
            ensure!(
                sequence == started && pending == 1,
                "journal pending receipt changed"
            );
            let next = sequence
                .checked_add(1)
                .context("journal sequence exhausted")?;
            ensure!(transaction.execute("UPDATE journal_changes SET sequence=?1, pending=0 WHERE session_id=?2 AND sequence=?3 AND pending=1", params![next, self.session_id, started])? == 1, "journal pending row missing");
            transaction.execute(
                "UPDATE journal_header SET sequence=?1, pending_count=0 WHERE id=1",
                [next],
            )?;
            transaction.commit()?;
            Ok(())
        })();
        if let Err(error) = result {
            self.fence
                .revoke()
                .context("authority outcome is unchanged, but journal revocation failed")?;
            tracing::debug!(%error, "journal disabled after authority write");
            return Ok(false);
        }
        Ok(true)
    }
}

/// A bounded invalidation batch, not a complete session listing. Read-only, no fence acquisition.
/// None means tracking is disabled; errors (including pending) require authoritative fallback.
pub fn changes_since(
    root: &Path,
    domain: JournalDomain,
    after: &JournalWatermark,
    maximum: usize,
) -> Result<Option<JournalChanges>> {
    ensure!(
        (1..=MAX_CHANGES).contains(&maximum),
        "invalid journal batch budget"
    );
    read_snapshot(root, domain, |transaction, watermark| {
        ensure!(
            watermark.instance == after.instance,
            "journal epoch changed; rebuild baseline"
        );
        ensure!(
            after.sequence >= 0 && after.sequence <= watermark.sequence,
            "journal checkpoint is ahead of source"
        );
        let mut session_ids = Vec::new();
        let mut statement = transaction.prepare(
            "SELECT session_id FROM journal_changes WHERE sequence>?1 ORDER BY sequence LIMIT ?2",
        )?;
        let mut rows = statement.query(params![after.sequence, maximum as i64 + 1])?;
        while let Some(row) = rows.next()? {
            ensure!(session_ids.len() < maximum, "journal batch exceeds budget");
            let id: String = row.get(0)?;
            ensure!(valid_session_id(&id), "invalid journal source id");
            session_ids.push(id);
        }
        Ok(JournalChanges {
            watermark: watermark.clone(),
            session_ids,
        })
    })
}

/// Read only token/schema/header state; never enumerate journal changes or initialize storage.
pub fn current_watermark(root: &Path, domain: JournalDomain) -> Result<Option<JournalWatermark>> {
    read_snapshot(root, domain, |_, watermark| Ok(watermark.clone()))
}

fn read_snapshot<T>(
    root: &Path,
    domain: JournalDomain,
    read: impl FnOnce(&Connection, &JournalWatermark) -> Result<T>,
) -> Result<Option<T>> {
    let root_path = dunce::canonicalize(root)?;
    let directory = PrivateDirectory::open_existing(root)?;
    let Some(token) = read_token(&directory, domain)? else {
        return Ok(None);
    };
    let mut database =
        open_retrying(&root_path, domain, false)?.context("tracked journal is missing")?;
    let transaction = database.connection.transaction()?;
    let (sequence, pending) = header(&transaction, &token)?;
    ensure!(
        pending == 0,
        "journal mutation is pending; authoritative fallback is required"
    );
    let result = read(
        &transaction,
        &JournalWatermark {
            instance: token.instance,
            sequence,
        },
    )?;
    transaction.commit()?;
    ensure!(
        read_token(&directory, domain)?.as_ref() == Some(&token)
            && read_token(&PrivateDirectory::open_existing(root)?, domain)?.as_ref()
                == Some(&token),
        "journal token changed during read"
    );
    Ok(Some(result))
}

struct Database {
    connection: Connection,
    _lease: files::Lease,
}

fn open(root: &Path, domain: JournalDomain, writable: bool) -> Result<Option<Database>> {
    // The root enters the persistent scope in its simplified form so every
    // writer and reader derives the same identity string.
    let scope = serde_json::to_string(&(
        "kcoder.invalidation-journal.v1",
        domain,
        files::scope_path_component(root),
    ))?;
    let Some(opened) = files::open_database(root, domain.names().0, &scope, writable)? else {
        return Ok(None);
    };
    opened
        .connection
        .busy_timeout(std::time::Duration::from_millis(50))?;
    opened
        .connection
        .set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH, 64 * 1024);
    opened
        .connection
        .execute_batch("PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;")?;
    if !writable {
        opened.connection.pragma_update(None, "query_only", true)?;
    }
    Ok(Some(Database {
        connection: opened.connection,
        _lease: opened.lease,
    }))
}

/// The catalog VFS pool is process-global; a budget error means another connection holds a
/// slot and releases it shortly. Tracking receipts and snapshot reads wait briefly instead of
/// being dropped, because a dropped receipt silently degrades to "journal not initialized".
fn open_retrying(root: &Path, domain: JournalDomain, writable: bool) -> Result<Option<Database>> {
    open_retrying_with(
        OPEN_RETRY_ATTEMPTS,
        OPEN_RETRY_DELAY,
        |root, domain, writable| open(root, domain, writable),
        root,
        domain,
        writable,
    )
}

const OPEN_RETRY_ATTEMPTS: u32 = 40;
const OPEN_RETRY_DELAY: Duration = Duration::from_millis(25);

fn open_retrying_with(
    attempts: u32,
    delay: Duration,
    open: impl Fn(&Path, JournalDomain, bool) -> Result<Option<Database>>,
    root: &Path,
    domain: JournalDomain,
    writable: bool,
) -> Result<Option<Database>> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match open(root, domain, writable) {
            Err(error) if attempt < attempts && transient_connection_budget(&error) => {
                std::thread::sleep(delay);
            }
            result => return result,
        }
    }
}

const JOURNAL_SETUP_RETRY_ATTEMPTS: u32 = 40;
const JOURNAL_SETUP_RETRY_DELAY: Duration = Duration::from_millis(25);

/// Revocation is the safe outcome when the journal genuinely cannot be maintained, but it is a
/// one-way switch: a momentary shortage (global connection budget, SQLite busy with its 50 ms
/// timeout, or an interrupted syscall) must be retried first, because revoking on a transient
/// failure stops every reader reporting the journal until an explicit re-activation.
fn retry_transient_journal_setup<T>(mut attempt: impl FnMut() -> Result<T>) -> Result<T> {
    let mut attempts = 0;
    loop {
        attempts += 1;
        match attempt() {
            Err(error)
                if attempts < JOURNAL_SETUP_RETRY_ATTEMPTS
                    && transient_journal_setup_error(&error) =>
            {
                std::thread::sleep(JOURNAL_SETUP_RETRY_DELAY);
            }
            result => return result,
        }
    }
}

/// Failures that clear on their own: retry them before falling back to revocation.
fn transient_journal_setup_error(error: &anyhow::Error) -> bool {
    if error.chain().any(|cause| {
        let message = cause.to_string();
        message.contains("connection budget exhausted")
            || message.contains("catalog initialization is busy")
    }) {
        return true;
    }
    if let Some(io) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<std::io::Error>())
        && matches!(
            io.kind(),
            std::io::ErrorKind::Interrupted
                | std::io::ErrorKind::WouldBlock
                | std::io::ErrorKind::TimedOut
        )
    {
        return true;
    }
    error.chain().any(|cause| {
        cause
            .downcast_ref::<rusqlite::Error>()
            .is_some_and(|error| {
                matches!(
                    error,
                    rusqlite::Error::SqliteFailure(failure, _)
                        if matches!(
                            failure.code,
                            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                        )
                )
            })
    })
}

fn transient_connection_budget(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains("connection budget exhausted"))
}

fn initialize(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let objects: i64 = transaction.query_row(
        "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
        [],
        |row| row.get(0),
    )?;
    if objects == 0 {
        for (_, _, sql) in SCHEMA {
            transaction.execute_batch(sql)?;
        }
        transaction.execute(
            "INSERT INTO journal_header VALUES(1, 1, ?1, 0, 0, 0)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
    }
    validate_schema(&transaction)?;
    let version: i64 =
        transaction.query_row("SELECT version FROM journal_header WHERE id=1", [], |row| {
            row.get(0)
        })?;
    ensure!(version == 1, "unsupported journal schema");
    transaction.commit()?;
    Ok(())
}

fn header(connection: &Connection, token: &Token) -> Result<(i64, i64)> {
    validate_schema(connection)?;
    let (version, instance, sequence, pending): (i64, String, i64, i64) = connection.query_row(
        "SELECT version, instance, sequence, pending_count FROM journal_header WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    ensure!(
        version == 1
            && instance == token.instance.to_string()
            && sequence >= 0
            && (0..=1).contains(&pending),
        "invalid journal header or tracking epoch"
    );
    Ok((sequence, pending))
}

fn validate_schema(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 4")?;
    let mut rows = statement.query([])?;
    for (kind, name, sql) in SCHEMA {
        let row = rows.next()?.context("incomplete journal schema")?;
        ensure!(
            row.get::<_, String>(0)? == kind
                && row.get::<_, String>(1)? == name
                && row.get::<_, String>(2)? == sql,
            "unsupported journal schema shape"
        );
    }
    ensure!(rows.next()?.is_none(), "unexpected journal schema objects");
    Ok(())
}

fn read_token(root: &PrivateDirectory, domain: JournalDomain) -> Result<Option<Token>> {
    let file = match root.open_regular_file(OsStr::new(domain.names().1)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_TOKEN_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_TOKEN_BYTES,
        "journal tracking token exceeds budget"
    );
    let token: Token = serde_json::from_slice(&bytes)?;
    ensure!(
        token.version == 1 && token.domain == domain,
        "invalid journal tracking token"
    );
    Ok(token.enabled.then_some(token))
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.contains(['/', '\\', '\0'])
}

#[cfg(test)]
mod retry_tests {
    #[test]
    fn transient_failures_are_retried_but_durable_ones_are_not() {
        for message in [
            "catalog connection budget exhausted; retry later",
            "catalog initialization is busy; retry later",
        ] {
            assert!(
                transient_journal_setup_error(&anyhow::anyhow!(message)),
                "{message}"
            );
        }
        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            Some("database is locked".into()),
        );
        assert!(transient_journal_setup_error(&anyhow::Error::from(busy)));
        assert!(transient_journal_setup_error(&anyhow::Error::from(
            std::io::Error::from(std::io::ErrorKind::Interrupted)
        )));

        assert!(!transient_journal_setup_error(&anyhow::anyhow!(
            "journal source budget exhausted"
        )));
        assert!(!transient_journal_setup_error(&anyhow::anyhow!(
            "injected failure after row write"
        )));
        assert!(!transient_journal_setup_error(&anyhow::anyhow!(
            "journal has an unfinished mutation; rebuild tracking explicitly"
        )));
    }

    #[test]
    fn setup_retry_clears_a_transient_shortage_without_revoking_tracking() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        let first = fence.begin("session").unwrap();
        first.finish().unwrap();
        let changes = changes_since(temp.path(), JournalDomain::History, &baseline, 10)
            .unwrap()
            .unwrap();
        assert_eq!(changes.session_ids, vec!["session".to_string()]);

        // Two transient shortages, then the real database: the receipt must still be recorded.
        let mut shortages = 0;
        let mutation = fence
            .begin_with("session", |path, domain| {
                if shortages < 2 {
                    shortages += 1;
                    anyhow::bail!("catalog connection budget exhausted; retry later");
                }
                open_retrying(path, domain, true)
            })
            .unwrap();
        mutation.finish().unwrap();
        assert_eq!(shortages, 2);
        let changes = changes_since(temp.path(), JournalDomain::History, &changes.watermark, 10)
            .unwrap()
            .unwrap();
        assert_eq!(changes.session_ids, vec!["session".to_string()]);
        assert!(
            current_watermark(temp.path(), JournalDomain::History)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn an_exhausted_transient_shortage_still_revokes_tracking() {
        let (temp, mut fence, _baseline) = super::tests::fixture();
        let first = fence.begin("session").unwrap();
        first.finish().unwrap();
        let untracked = fence
            .begin_with("session", |_, _| -> Result<Option<Database>> {
                anyhow::bail!("catalog connection budget exhausted; retry later")
            })
            .unwrap();
        drop(untracked);
        assert!(
            current_watermark(temp.path(), JournalDomain::History)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_durable_setup_failure_still_revokes_tracking() {
        let (temp, mut fence, _baseline) = super::tests::fixture();
        let first = fence.begin("session").unwrap();
        first.finish().unwrap();
        let untracked = fence
            .begin_with("session", |_, _| -> Result<Option<Database>> {
                anyhow::bail!("journal database is corrupt")
            })
            .unwrap();
        drop(untracked);
        assert!(
            current_watermark(temp.path(), JournalDomain::History)
                .unwrap()
                .is_none()
        );
    }

    use super::*;
    use std::cell::Cell;

    #[test]
    fn transient_budget_error_is_retried_until_it_clears() {
        let calls = Cell::new(0);
        let result = open_retrying_with(
            5,
            Duration::ZERO,
            |_, _, _| {
                calls.set(calls.get() + 1);
                if calls.get() < 3 {
                    anyhow::bail!("catalog connection budget exhausted; retry later");
                }
                Ok(None)
            },
            Path::new("/unused"),
            JournalDomain::History,
            false,
        )
        .unwrap();
        assert!(result.is_none());
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn non_transient_errors_and_exhausted_attempts_are_not_retried() {
        let calls = Cell::new(0);
        let error = open_retrying_with(
            5,
            Duration::ZERO,
            |_, _, _| -> Result<Option<Database>> {
                calls.set(calls.get() + 1);
                anyhow::bail!("journal schema is invalid")
            },
            Path::new("/unused"),
            JournalDomain::History,
            false,
        )
        .err()
        .expect("invalid schema must not be retried");
        assert_eq!(calls.get(), 1);
        assert!(error.to_string().contains("schema is invalid"));

        let attempts = Cell::new(0);
        let error = open_retrying_with(
            3,
            Duration::ZERO,
            |_, _, _| -> Result<Option<Database>> {
                attempts.set(attempts.get() + 1);
                anyhow::bail!("catalog connection budget exhausted; retry later")
            },
            Path::new("/unused"),
            JournalDomain::History,
            false,
        )
        .err()
        .expect("exhausted attempts must surface the budget error");
        assert_eq!(attempts.get(), 3);
        assert!(transient_connection_budget(&error));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn fixture() -> (tempfile::TempDir, JournalFence, JournalWatermark) {
        let temp = tempfile::tempdir().unwrap();
        let mut fence = JournalFence::try_acquire(temp.path(), JournalDomain::History).unwrap();
        let baseline = fence.activate().unwrap();
        (temp, fence, baseline)
    }

    fn state(root: &Path) -> (i64, i64, i64, i64) {
        let database = open(root, JournalDomain::History, false).unwrap().unwrap();
        database.connection.query_row("SELECT sequence, pending_count, source_count, (SELECT count(*) FROM journal_changes) FROM journal_header WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap()
    }

    #[test]
    #[cfg(unix)]
    fn dropping_fence_releases_lock_while_an_inherited_description_remains_open() {
        let temp = tempfile::tempdir().unwrap();
        let fence = JournalFence::try_acquire(temp.path(), JournalDomain::ClientMetadata).unwrap();
        // A forked child retains this same open file description until exec closes CLOEXEC FDs.
        let inherited = fence.lock.try_clone().unwrap();
        drop(fence);
        let next = JournalFence::try_acquire(temp.path(), JournalDomain::ClientMetadata)
            .expect("completed mutation must not wait for a spawned child to exec");
        drop(next);
        drop(inherited);
    }

    #[test]
    fn journal_pending_is_durable_and_never_consumable_before_finish() {
        let temp = tempfile::tempdir().unwrap();
        let mut fence = JournalFence::try_acquire(temp.path(), JournalDomain::History).unwrap();
        let baseline = fence.activate().unwrap();
        let mutation = fence.begin("session").unwrap();
        assert!(mutation.is_tracking());
        drop(mutation);
        drop(fence);
        assert!(changes_since(temp.path(), JournalDomain::History, &baseline, 10).is_err());
        assert_eq!(state(temp.path()), (1, 1, 1, 1));
    }

    #[test]
    fn journal_current_watermark_does_not_read_an_over_budget_change_batch() {
        let (temp, _fence, baseline) = fixture();
        {
            let mut database = open(temp.path(), JournalDomain::History, true)
                .unwrap()
                .unwrap();
            let transaction = database.connection.transaction().unwrap();
            for index in 1..=MAX_CHANGES + 1 {
                transaction
                    .execute(
                        "INSERT INTO journal_changes VALUES(?1,?2,0)",
                        params![format!("source-{index}"), index as i64],
                    )
                    .unwrap();
            }
            transaction
                .execute(
                    "UPDATE journal_header SET sequence=?1,source_count=?1",
                    [MAX_CHANGES as i64 + 1],
                )
                .unwrap();
            transaction.commit().unwrap();
        }
        assert!(
            changes_since(temp.path(), JournalDomain::History, &baseline, MAX_CHANGES).is_err()
        );
        let current = current_watermark(temp.path(), JournalDomain::History)
            .unwrap()
            .unwrap();
        assert_eq!(current.sequence, MAX_CHANGES as i64 + 1);
        assert_eq!(current.instance, baseline.instance);
    }

    #[test]
    fn journal_finish_atomically_publishes_change_and_watermark_and_coalesces() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        for _ in 0..2 {
            let mutation = fence.begin("session").unwrap();
            assert!(mutation.is_tracking());
            assert!(mutation.finish().unwrap());
        }
        let changes = changes_since(temp.path(), JournalDomain::History, &baseline, 10)
            .unwrap()
            .unwrap();
        assert_eq!(changes.session_ids, ["session"]);
        assert_eq!(changes.watermark.sequence, 4);
        assert_eq!(state(temp.path()), (4, 0, 1, 1));
        assert!(
            changes_since(temp.path(), JournalDomain::History, &changes.watermark, 10)
                .unwrap()
                .unwrap()
                .session_ids
                .is_empty()
        );
    }

    #[test]
    fn journal_same_source_second_begin_cannot_clear_abandoned_pending() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        drop(fence.begin("session").unwrap());
        let second = fence.begin("session").unwrap();
        assert!(!second.is_tracking());
        assert!(!second.finish().unwrap());
        assert_eq!(state(temp.path()), (1, 1, 1, 1));
        assert!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn journal_begin_rollback_does_not_separate_row_from_watermark() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        fence.fail_after_row = true;
        let mutation = fence.begin("session").unwrap();
        assert!(!mutation.is_tracking());
        assert_eq!(state(temp.path()), (0, 0, 0, 0));
        assert!(!mutation.finish().unwrap());
        assert!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn journal_readonly_begin_disables_tracking_before_authority() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        let mutation = fence
            .begin_with("session", |path, domain| open(path, domain, false))
            .unwrap();
        assert!(!mutation.is_tracking());
        assert!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .is_none()
        );
        std::fs::write(temp.path().join("authority"), b"committed").unwrap();
        assert!(!mutation.finish().unwrap());
        assert_eq!(
            std::fs::read(temp.path().join("authority")).unwrap(),
            b"committed"
        );
    }

    #[test]
    fn journal_finish_failure_preserves_authority_and_revokes_tracking() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        let mutation = fence.begin("session").unwrap();
        std::fs::write(temp.path().join("authority"), b"committed once").unwrap();
        mutation
            .tracked
            .as_ref()
            .unwrap()
            .0
            .connection
            .pragma_update(None, "query_only", true)
            .unwrap();
        assert!(!mutation.finish().unwrap());
        assert_eq!(state(temp.path()), (1, 1, 1, 1));
        assert!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            std::fs::read(temp.path().join("authority")).unwrap(),
            b"committed once"
        );
    }

    #[test]
    fn journal_revocation_failure_does_not_grant_authority_permission() {
        let (temp, mut fence, _baseline) = super::tests::fixture();
        let token = temp.path().join(JournalDomain::History.names().1);
        std::fs::remove_file(&token).unwrap();
        std::fs::create_dir(&token).unwrap();
        assert!(fence.begin("session").is_err());
        assert!(!temp.path().join("authority").exists());
    }

    #[test]
    fn journal_corruption_disables_without_repair_and_reads_never_initialize() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        let database = temp
            .path()
            .join(JournalDomain::History.names().0)
            .join("catalog.sqlite3");
        std::fs::write(&database, b"corrupt database").unwrap();
        assert!(changes_since(temp.path(), JournalDomain::History, &baseline, 10).is_err());
        assert!(!fence.begin("session").unwrap().finish().unwrap());
        assert_eq!(std::fs::read(&database).unwrap(), b"corrupt database");
        assert!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .is_none()
        );
        let untouched = tempfile::tempdir().unwrap();
        assert!(
            changes_since(untouched.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_dir(untouched.path()).unwrap().count(), 0);
    }

    #[test]
    fn journal_epoch_and_domain_and_root_are_not_interchangeable() {
        let (temp, mut history, previous) = fixture();
        let current = history.activate().unwrap();
        assert_ne!(current, previous);
        assert!(changes_since(temp.path(), JournalDomain::History, &previous, 10).is_err());
        let mut metadata =
            JournalFence::try_acquire(temp.path(), JournalDomain::ClientMetadata).unwrap();
        let metadata_stamp = metadata.activate().unwrap();
        metadata.begin("session").unwrap().finish().unwrap();
        assert!(changes_since(temp.path(), JournalDomain::ClientMetadata, &current, 10).is_err());
        assert_eq!(
            changes_since(
                temp.path(),
                JournalDomain::ClientMetadata,
                &metadata_stamp,
                10
            )
            .unwrap()
            .unwrap()
            .session_ids,
            ["session"]
        );
        assert!(
            changes_since(temp.path(), JournalDomain::History, &current, 10)
                .unwrap()
                .unwrap()
                .session_ids
                .is_empty()
        );
        let (other, _fence, _stamp) = fixture();
        assert!(changes_since(other.path(), JournalDomain::History, &current, 10).is_err());
    }

    #[test]
    fn journal_bounded_batch_never_claims_truncated_success() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        for id in ["a", "b"] {
            fence.begin(id).unwrap().finish().unwrap();
        }
        assert!(changes_since(temp.path(), JournalDomain::History, &baseline, 1).is_err());
        assert_eq!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 2)
                .unwrap()
                .unwrap()
                .session_ids,
            ["a", "b"]
        );
    }

    #[test]
    fn journal_real_sqlite_full_revokes_tracking() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        let mut disabled = false;
        for index in 0..100 {
            let mutation = fence
                .begin_with(&format!("{index}-{}", "x".repeat(240)), |path, domain| {
                    let database = open(path, domain, true)?.unwrap();
                    let pages: i64 =
                        database
                            .connection
                            .pragma_query_value(None, "page_count", |row| row.get(0))?;
                    database
                        .connection
                        .pragma_update(None, "max_page_count", pages)?;
                    Ok(Some(database))
                })
                .unwrap();
            if !mutation.is_tracking() {
                disabled = true;
                break;
            }
            mutation.finish().unwrap();
        }
        assert!(
            disabled,
            "SQLite page quota must exercise a real SQLITE_FULL failure"
        );
        assert!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn journal_vfs_slot_exhaustion_can_still_revoke_tracking() {
        // The VFS pool is process-global; exhaust it only in an exact child-test process.
        if std::env::var_os("KCODER_JOURNAL_SLOT_CHILD_PROBE").is_none() {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "history_index::journal::tests::journal_vfs_slot_exhaustion_can_still_revoke_tracking",
                    "--nocapture",
                ])
                .env("KCODER_JOURNAL_SLOT_CHILD_PROBE", "1")
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success(), "isolated journal slot probe failed");
                    return;
                }
                if std::time::Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("isolated journal slot probe timed out");
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        let (temp, mut fence, baseline) = super::tests::fixture();
        let mut slots = Vec::new();
        while let Ok(Some(database)) = open(temp.path(), JournalDomain::History, false) {
            slots.push(database);
        }
        assert!(!slots.is_empty());
        assert!(!fence.begin("session").unwrap().finish().unwrap());
        drop(slots);
        assert!(
            changes_since(temp.path(), JournalDomain::History, &baseline, 10)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn journal_fence_child_probe() {
        let Ok(root) = std::env::var("KCODER_JOURNAL_FENCE_TEST_ROOT") else {
            return;
        };
        let watermark: JournalWatermark =
            serde_json::from_str(&std::env::var("KCODER_JOURNAL_FENCE_TEST_WATERMARK").unwrap())
                .unwrap();
        assert!(JournalFence::try_acquire(Path::new(&root), JournalDomain::History).is_err());
        assert!(changes_since(Path::new(&root), JournalDomain::History, &watermark, 10).is_err());
    }

    #[test]
    fn journal_activation_rejects_unknown_schema_without_erasing_changes() {
        let (temp, mut fence, _baseline) = super::tests::fixture();
        fence.begin("retained").unwrap().finish().unwrap();
        {
            let database = open(temp.path(), JournalDomain::History, true)
                .unwrap()
                .unwrap();
            database
                .connection
                .execute_batch(
                    "CREATE VIEW unexpected_view AS SELECT session_id FROM journal_changes;",
                )
                .unwrap();
        }
        assert!(fence.activate().is_err());
        assert_eq!(state(temp.path()), (2, 0, 1, 1));
    }

    #[test]
    fn journal_schema_and_owner_failures_never_repair_or_erase_existing_data() {
        for sql in [
            "ALTER TABLE journal_changes ADD COLUMN unexpected TEXT",
            "CREATE TRIGGER unexpected AFTER DELETE ON journal_changes BEGIN SELECT 1; END",
            "UPDATE journal_header SET version=2 WHERE id=1",
        ] {
            let (temp, mut fence, baseline) = super::tests::fixture();
            fence.begin("retained").unwrap().finish().unwrap();
            let database_path = temp
                .path()
                .join(JournalDomain::History.names().0)
                .join("catalog.sqlite3");
            {
                let database = open(temp.path(), JournalDomain::History, true)
                    .unwrap()
                    .unwrap();
                database.connection.execute_batch(sql).unwrap();
            }
            let before = std::fs::read(&database_path).unwrap();
            assert!(changes_since(temp.path(), JournalDomain::History, &baseline, 10).is_err());
            assert!(fence.activate().is_err());
            assert_eq!(std::fs::read(&database_path).unwrap(), before);
        }
        let (temp, mut fence, _baseline) = super::tests::fixture();
        let owner = temp
            .path()
            .join(JournalDomain::History.names().0)
            .join("owner.json");
        std::fs::write(&owner, b"unknown owner").unwrap();
        assert!(fence.activate().is_err());
        assert_eq!(std::fs::read(&owner).unwrap(), b"unknown owner");
    }

    #[test]
    fn journal_cross_process_fence_and_pending_are_observable_without_waiting() {
        let (temp, mut fence, baseline) = super::tests::fixture();
        let _mutation = fence.begin("session").unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "history_index::journal::tests::journal_fence_child_probe",
                "--nocapture",
            ])
            .env("KCODER_JOURNAL_FENCE_TEST_ROOT", temp.path())
            .env(
                "KCODER_JOURNAL_FENCE_TEST_WATERMARK",
                serde_json::to_string(&baseline).unwrap(),
            )
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("journal reader or fence waited for the parent mutation");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
