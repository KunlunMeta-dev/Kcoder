//! Bound, authoritative receipt checkpoints and immutable point-looked-up tombstones.
//! The binding is storage identity only; callers retain their own authorization and lease.
use crate::history_index::files;
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fs::File};
mod anchor;
mod source_lookup;

const DATABASE: &str = "catalog.sqlite3";
const OWNER: &str = "owner.json";
const SETUP: &str = "setup.lock";
const MAX_DATABASE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RETAINED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ROWS: u64 = 1_000_000;
pub const MAX_RECEIPT_ARCHIVE_CHECKPOINT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_RECEIPT_ARCHIVE_ROW_BYTES: usize = 64 * 1024;
const SCHEMA: [&str; 5] = [
    "CREATE TABLE receipt_archive_header(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, instance TEXT NOT NULL, scope TEXT NOT NULL, seed_sha BLOB NOT NULL, row_count INTEGER NOT NULL CHECK(row_count>=0), retained_bytes INTEGER NOT NULL CHECK(retained_bytes>=0), payload_bytes INTEGER NOT NULL CHECK(payload_bytes>=0))",
    "CREATE TABLE receipt_archive_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL, sha BLOB NOT NULL)",
    "CREATE TABLE receipt_archive_rows(request_key TEXT PRIMARY KEY NOT NULL CHECK(length(request_key)<=256), message_id TEXT NOT NULL UNIQUE CHECK(length(message_id)<=256), body BLOB NOT NULL, sha BLOB NOT NULL)",
    "CREATE TABLE receipt_archive_payloads(request_key TEXT PRIMARY KEY NOT NULL CHECK(length(request_key)<=256), expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>0), body BLOB NOT NULL, sha BLOB NOT NULL)",
    "CREATE INDEX receipt_archive_payload_deadline ON receipt_archive_payloads(expires_at_ms,request_key)",
];

/// Persist this binding in the original owner's checkpoint before initialization.
/// Losing or replacing a bound file never means an empty receipt ledger.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableReceiptArchiveBinding {
    version: u32,
    instance: String,
    scope: String,
    child: String,
    parent: String,
    directory: String,
    database: PortableLeaseIdentity,
    owner: PortableLeaseIdentity,
    setup: PortableLeaseIdentity,
    seed_sha: Vec<u8>,
}

impl DurableReceiptArchiveBinding {
    /// Validate the original complete bootstrap checkpoint without filesystem
    /// writes. This is never permission to create or replace an archive.
    pub fn verify_seed(&self, seed: &[u8]) -> Result<()> {
        self.validate()?;
        check_checkpoint(seed)?;
        ensure!(
            digest(seed) == self.seed_sha,
            "RECEIPT_ARCHIVE_BOOTSTRAP_CHANGED"
        );
        Ok(())
    }
    /// Reserve a new, empty private child. Unpublished reservations do not
    /// replace or modify an existing authoritative checkpoint.
    pub fn reserve(parent: &PrivateDirectory, scope: &str, seed: &[u8]) -> Result<Self> {
        ensure!(
            !scope.is_empty() && scope.len() <= 8192,
            "RECEIPT_ARCHIVE_SCOPE_INVALID"
        );
        check_checkpoint(seed)?;
        parent.verify_private_directory()?;
        // Failed pre-publication reservations are retained for explicit owner
        // inspection. Bound their number rather than retrying into unbounded
        // orphan directories when a checkpoint cannot be published.
        let entries = parent.entry_names_bounded(513)?;
        ensure!(
            entries.len() <= 512
                && entries
                    .iter()
                    .filter(|name| name.to_string_lossy().starts_with("receipt-archive-"))
                    .count()
                    < 8,
            "RECEIPT_ARCHIVE_RESERVATION_CAPACITY"
        );
        let instance = uuid::Uuid::new_v4().to_string();
        let child = format!("receipt-archive-{instance}");
        let directory = parent.create_private_child(OsStr::new(&child))?;
        let database = directory.open_read_write_file(OsStr::new(DATABASE), true)?;
        let setup = directory.open_read_write_file(OsStr::new(SETUP), true)?;
        directory.atomic_replace(
            OsStr::new(OWNER),
            &serde_json::to_vec(&serde_json::json!({"schema":1,"scope":scope}))?,
        )?;
        let binding = Self {
            version: 1,
            instance,
            scope: scope.into(),
            child,
            parent: parent.directory_identity()?,
            directory: directory.directory_identity()?,
            database: directory.portable_regular_handle_identity(&database)?,
            owner: directory.portable_regular_identity(OsStr::new(OWNER))?,
            setup: directory.portable_regular_handle_identity(&setup)?,
            seed_sha: digest(seed),
        };
        database.sync_all()?;
        setup.sync_all()?;
        directory.sync()?;
        parent.sync()?;
        binding.verify_bootstrap_storage(parent)?;
        Ok(binding)
    }

    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && uuid::Uuid::parse_str(&self.instance).is_ok()
                && self.child == format!("receipt-archive-{}", self.instance)
                && !self.scope.is_empty()
                && self.scope.len() <= 8192
                && self.seed_sha.len() == 32,
            "RECEIPT_ARCHIVE_BINDING_INVALID"
        );
        Ok(())
    }

    fn verify_bootstrap_storage(&self, parent: &PrivateDirectory) -> Result<PrivateDirectory> {
        self.validate()?;
        parent.verify_private_directory()?;
        ensure!(
            parent.directory_identity()? == self.parent,
            "RECEIPT_ARCHIVE_PARENT_CHANGED"
        );
        let directory = parent
            .open_entry_handle(OsStr::new(&self.child))?
            .open_child_directory()?;
        directory.verify_private_directory()?;
        ensure!(
            directory.directory_identity()? == self.directory,
            "RECEIPT_ARCHIVE_DIRECTORY_CHANGED"
        );
        for (name, expected) in [
            (DATABASE, &self.database),
            (OWNER, &self.owner),
            (SETUP, &self.setup),
        ] {
            let file = directory.open_single_link_regular_file(OsStr::new(name))?;
            ensure!(
                directory.portable_regular_handle_identity(&file)? == *expected,
                "RECEIPT_ARCHIVE_FILE_CHANGED"
            );
        }
        Ok(directory)
    }

    // Original FileIDs remain in the bootstrap/cutover bytes. A committed
    // archive is identified by its SQL instance/scope/seed, not its old location.
    fn observe_committed(&self, parent: &PrivateDirectory) -> Result<PrivateDirectory> {
        self.validate()?;
        parent.verify_private_directory()?;
        let directory = parent
            .open_entry_handle(OsStr::new(&self.child))?
            .open_child_directory()?;
        directory.verify_private_directory()?;
        for name in [DATABASE, OWNER, SETUP] {
            let file = directory.open_single_link_regular_file(OsStr::new(name))?;
            if name == SETUP {
                ensure!(
                    directory.portable_regular_handle_identity(&file)? == self.setup,
                    "RECEIPT_ARCHIVE_FILE_CHANGED"
                );
            }
        }
        Ok(directory)
    }

    /// A stat-only invalidation hint, never evidence of authorization or an
    /// intact transaction. Actual reads always verify the bound database.
    pub fn observation_stamp(
        &self,
        parent: &PrivateDirectory,
    ) -> Result<DurableReceiptArchiveStamp> {
        let directory = self.observe_committed(parent)?;
        let file = directory.open_single_link_regular_file(OsStr::new(DATABASE))?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.len() <= MAX_DATABASE_BYTES,
            "RECEIPT_ARCHIVE_QUOTA"
        );
        Ok(DurableReceiptArchiveStamp {
            file: directory.portable_regular_handle_identity(&file)?,
            bytes: metadata.len(),
            modified: metadata.modified()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableReceiptArchiveStamp {
    pub(crate) file: PortableLeaseIdentity,
    pub(crate) bytes: u64,
    pub(crate) modified: std::time::SystemTime,
}

/// The SQLite connection closes before the private VFS lease and held handles.
pub struct DurableReceiptArchive {
    opened: files::OpenedDatabase,
    parent: PrivateDirectory,
    binding: DurableReceiptArchiveBinding,
    directory_identity: String,
    anchors: Vec<File>,
    writable: bool,
}

impl DurableReceiptArchive {
    /// Explicit writer recovery for a previously published bootstrap binding.
    /// The complete original seed must match; a missing/replaced DB is rejected.
    pub fn initialize(
        parent: &PrivateDirectory,
        binding: &DurableReceiptArchiveBinding,
        seed: &[u8],
    ) -> Result<()> {
        check_checkpoint(seed)?;
        ensure!(
            digest(seed) == binding.seed_sha,
            "RECEIPT_ARCHIVE_BOOTSTRAP_CHANGED"
        );
        let mut archive = Self::open_inner(parent, binding, true, true)?;
        let tx = archive
            .opened
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let schema = read_schema(&tx)?;
        if schema.is_empty() {
            for sql in SCHEMA {
                tx.execute_batch(sql)?;
            }
            tx.execute(
                "INSERT INTO receipt_archive_header VALUES(1,1,?1,?2,?3,0,0,0)",
                params![binding.instance, binding.scope, binding.seed_sha],
            )?;
            tx.execute(
                "INSERT INTO receipt_archive_checkpoint VALUES(1,?1,?2)",
                params![seed, digest(seed)],
            )?;
        } else {
            ensure!(schema_matches(&schema), "RECEIPT_ARCHIVE_SCHEMA_INVALID");
            let (rows, _) = read_header(&tx, binding)?;
            ensure!(
                rows == 0 && read_checkpoint(&tx)? == seed,
                "RECEIPT_ARCHIVE_BOOTSTRAP_ALREADY_ADVANCED"
            );
        }
        tx.commit()?;
        archive.verify()?;
        Ok(())
    }

    pub fn open(
        parent: &PrivateDirectory,
        binding: &DurableReceiptArchiveBinding,
        writable: bool,
    ) -> Result<Self> {
        Self::open_inner(parent, binding, writable, false)
    }

    fn open_inner(
        parent: &PrivateDirectory,
        binding: &DurableReceiptArchiveBinding,
        writable: bool,
        bootstrap: bool,
    ) -> Result<Self> {
        let directory = if bootstrap {
            binding.verify_bootstrap_storage(parent)?
        } else {
            binding.observe_committed(parent)?
        };
        let directory_identity = directory.directory_identity()?;
        let anchors = [DATABASE, OWNER, SETUP]
            .into_iter()
            .map(|name| directory.open_single_link_regular_file(OsStr::new(name)))
            .collect::<Result<Vec<_>>>()?;
        let opened =
            files::open_database_in(directory, &binding.scope, writable, MAX_DATABASE_BYTES)?
                .context("RECEIPT_ARCHIVE_MISSING")?;
        opened.connection.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            (MAX_RECEIPT_ARCHIVE_CHECKPOINT_BYTES + 64 * 1024) as i32,
        );
        opened
            .connection
            .busy_timeout(std::time::Duration::from_millis(50))?;
        opened.connection.execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;",
        )?;
        if !writable {
            opened.connection.pragma_update(None, "query_only", true)?;
        }
        let archive = Self {
            opened,
            parent: parent.duplicate_handle()?,
            binding: binding.clone(),
            directory_identity,
            anchors,
            writable,
        };
        archive.verify()?;
        if !bootstrap {
            ensure!(
                schema_matches(&read_schema(&archive.opened.connection)?),
                "RECEIPT_ARCHIVE_SCHEMA_INVALID"
            );
            read_header(&archive.opened.connection, binding)?;
        }
        Ok(archive)
    }

    fn verify(&self) -> Result<()> {
        verify_current_anchors(
            &self.binding,
            &self.parent,
            &self.directory_identity,
            &self.anchors,
        )
    }

    /// Checkpoint changes and immutable rows commit in one native SQLite
    /// transaction. A dropped/failed action publishes neither half.
    pub fn access<R>(
        &mut self,
        action: impl FnOnce(&mut DurableReceiptArchiveTransaction<'_>) -> Result<R>,
    ) -> Result<R> {
        self.verify()?;
        let tx = self
            .opened
            .connection
            .transaction_with_behavior(if self.writable {
                TransactionBehavior::Immediate
            } else {
                TransactionBehavior::Deferred
            })?;
        read_header(&tx, &self.binding)?;
        let result = action(&mut DurableReceiptArchiveTransaction {
            connection: &tx,
            writable: self.writable,
        })?;
        // The original parent is held by the VFS; this additional verification
        // rejects replacement before a successful publication is reported.
        verify_current_anchors(
            &self.binding,
            &self.parent,
            &self.directory_identity,
            &self.anchors,
        )?;
        tx.commit()?;
        self.verify()?;
        Ok(result)
    }
}

fn verify_current_anchors(
    binding: &DurableReceiptArchiveBinding,
    parent: &PrivateDirectory,
    expected_directory: &str,
    anchors: &[File],
) -> Result<()> {
    let directory = binding.observe_committed(parent)?;
    ensure!(
        directory.directory_identity()? == expected_directory,
        "RECEIPT_ARCHIVE_DIRECTORY_CHANGED"
    );
    for (name, file) in [DATABASE, OWNER, SETUP].iter().zip(anchors) {
        ensure!(
            directory.portable_regular_identity(OsStr::new(name))?
                == directory.portable_regular_handle_identity(file)?,
            "RECEIPT_ARCHIVE_FILE_CHANGED"
        );
    }
    Ok(())
}

/// A bounded immutable tombstone. Its bytes contain consumer-specific facts,
/// never a cached permission decision. The secondary ID is globally unique.
pub struct DurableReceiptArchiveRow {
    pub request_key: String,
    pub message_id: String,
    pub body: Vec<u8>,
}

pub struct DurableReceiptArchiveTransaction<'a> {
    connection: &'a Connection,
    writable: bool,
}
impl DurableReceiptArchiveTransaction<'_> {
    pub fn insert_with_payload(
        &mut self,
        row: &DurableReceiptArchiveRow,
        expires_at_ms: u64,
        body: &[u8],
    ) -> Result<bool> {
        let inserted = self.insert(row)?;
        if inserted {
            self.retain_payload(&row.request_key, expires_at_ms, body)?;
        }
        Ok(inserted)
    }
    /// Retained content is separate from the permanent idempotency row. Its
    /// server deadline is immutable and retries cannot extend retention.
    fn retain_payload(&mut self, key: &str, expires_at_ms: u64, body: &[u8]) -> Result<()> {
        ensure!(self.writable, "RECEIPT_ARCHIVE_READ_ONLY");
        check_key(key)?;
        ensure!(
            expires_at_ms > 0
                && expires_at_ms <= i64::MAX as u64
                && body.len() <= MAX_RECEIPT_ARCHIVE_ROW_BYTES,
            "RECEIPT_ARCHIVE_PAYLOAD_INVALID"
        );
        ensure!(self.get(key)?.is_some(), "RECEIPT_ARCHIVE_ROW_MISSING");
        if let Some((deadline, old)) = self.payload(key)? {
            ensure!(
                deadline == expires_at_ms && old == body,
                "RECEIPT_ARCHIVE_PAYLOAD_CONFLICT"
            );
            return Ok(());
        }
        let (retained, payload): (u64, u64) = self.connection.query_row(
            "SELECT retained_bytes,payload_bytes FROM receipt_archive_header WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let next = payload
            .checked_add(body.len() as u64)
            .context("RECEIPT_ARCHIVE_QUOTA")?;
        ensure!(
            retained
                .checked_add(next)
                .is_some_and(|total| total <= MAX_RETAINED_BYTES),
            "RECEIPT_ARCHIVE_QUOTA"
        );
        self.connection.execute(
            "INSERT INTO receipt_archive_payloads VALUES(?1,?2,?3,?4)",
            params![key, expires_at_ms, body, digest(body)],
        )?;
        self.connection.execute(
            "UPDATE receipt_archive_header SET payload_bytes=?1 WHERE id=1",
            [next],
        )?;
        Ok(())
    }
    pub fn payload(&self, key: &str) -> Result<Option<(u64, Vec<u8>)>> {
        check_key(key)?;
        let row:Option<(u64,Vec<u8>,Vec<u8>)>=self.connection.query_row("SELECT expires_at_ms,CASE WHEN length(body)<=?2 AND length(sha)=32 THEN body ELSE NULL END,sha FROM receipt_archive_payloads WHERE request_key=?1",params![key,MAX_RECEIPT_ARCHIVE_ROW_BYTES],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        row.map(|(deadline, body, sha)| {
            ensure!(
                deadline > 0 && digest(&body) == sha,
                "RECEIPT_ARCHIVE_PAYLOAD_CORRUPT"
            );
            Ok((deadline, body))
        })
        .transpose()
    }
    pub fn next_payload_deadline(&self) -> Result<Option<u64>> {
        Ok(self.connection.query_row("SELECT expires_at_ms FROM receipt_archive_payloads ORDER BY expires_at_ms,request_key LIMIT 1",[],|row|row.get(0)).optional()?)
    }
    /// Only retained copies expire. Permanent request rows and IDs are never
    /// deleted for capacity, and a bounded maintenance batch scans no bodies.
    pub fn purge_payloads(&mut self, now_ms: u64, limit: usize) -> Result<usize> {
        ensure!(
            self.writable && (1..=128).contains(&limit),
            "RECEIPT_ARCHIVE_MAINTENANCE_INVALID"
        );
        let rows=self.connection.prepare("SELECT request_key,length(body) FROM receipt_archive_payloads WHERE expires_at_ms<=?1 ORDER BY expires_at_ms,request_key LIMIT ?2")?.query_map(params![now_ms,limit],|row|Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let bytes = rows.iter().try_fold(0u64, |total, (_, bytes)| {
            total.checked_add(*bytes).context("RECEIPT_ARCHIVE_QUOTA")
        })?;
        for (key, _) in &rows {
            self.connection.execute(
                "DELETE FROM receipt_archive_payloads WHERE request_key=?1",
                [key],
            )?;
        }
        ensure!(self.connection.execute("UPDATE receipt_archive_header SET payload_bytes=payload_bytes-?1 WHERE id=1 AND payload_bytes>=?1",[bytes])?==1,"RECEIPT_ARCHIVE_PAYLOAD_COUNTER_INVALID");
        Ok(rows.len())
    }
    pub fn checkpoint(&self) -> Result<Vec<u8>> {
        read_checkpoint(self.connection)
    }
    pub fn set_checkpoint(&mut self, body: &[u8]) -> Result<()> {
        ensure!(self.writable, "RECEIPT_ARCHIVE_READ_ONLY");
        check_checkpoint(body)?;
        ensure!(
            self.connection.execute(
                "UPDATE receipt_archive_checkpoint SET body=?1,sha=?2 WHERE id=1",
                params![body, digest(body)]
            )? == 1,
            "RECEIPT_ARCHIVE_CHECKPOINT_MISSING"
        );
        Ok(())
    }
    pub fn get(&self, request_key: &str) -> Result<Option<DurableReceiptArchiveRow>> {
        self.point("request_key", request_key)
    }
    pub fn get_by_message_id(&self, message_id: &str) -> Result<Option<DurableReceiptArchiveRow>> {
        self.point("message_id", message_id)
    }
    fn point(&self, column: &str, key: &str) -> Result<Option<DurableReceiptArchiveRow>> {
        check_key(key)?;
        let query = format!(
            "SELECT request_key,message_id,CASE WHEN length(body)<=?2 AND length(sha)=32 THEN body ELSE NULL END,sha FROM receipt_archive_rows WHERE {column}=?1"
        );
        let row: Option<(String, String, Vec<u8>, Vec<u8>)> = self
            .connection
            .query_row(&query, params![key, MAX_RECEIPT_ARCHIVE_ROW_BYTES], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .optional()?;
        row.map(|(request_key, message_id, body, sha)| {
            check_key(&request_key)?;
            check_key(&message_id)?;
            ensure!(digest(&body) == sha, "RECEIPT_ARCHIVE_ROW_CORRUPT");
            Ok(DurableReceiptArchiveRow {
                request_key,
                message_id,
                body,
            })
        })
        .transpose()
    }
    pub fn insert(&mut self, row: &DurableReceiptArchiveRow) -> Result<bool> {
        ensure!(self.writable, "RECEIPT_ARCHIVE_READ_ONLY");
        check_key(&row.request_key)?;
        check_key(&row.message_id)?;
        ensure!(
            !row.body.is_empty() && row.body.len() <= MAX_RECEIPT_ARCHIVE_ROW_BYTES,
            "RECEIPT_ARCHIVE_ROW_LIMIT"
        );
        if let Some(old) = self.get(&row.request_key)? {
            ensure!(
                old.message_id == row.message_id && old.body == row.body,
                "RECEIPT_ARCHIVE_REQUEST_CONFLICT"
            );
            return Ok(false);
        }
        ensure!(
            self.get_by_message_id(&row.message_id)?.is_none(),
            "RECEIPT_ARCHIVE_MESSAGE_CONFLICT"
        );
        let (count, bytes, payload): (u64, u64, u64) = self.connection.query_row(
            "SELECT row_count,retained_bytes,payload_bytes FROM receipt_archive_header WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let next = bytes
            .checked_add(row.body.len() as u64)
            .context("RECEIPT_ARCHIVE_QUOTA")?;
        ensure!(
            count < MAX_ROWS
                && next
                    .checked_add(payload)
                    .is_some_and(|total| total <= MAX_RETAINED_BYTES),
            "RECEIPT_ARCHIVE_QUOTA"
        );
        self.connection.execute(
            "INSERT INTO receipt_archive_rows VALUES(?1,?2,?3,?4)",
            params![row.request_key, row.message_id, row.body, digest(&row.body)],
        )?;
        self.connection.execute(
            "UPDATE receipt_archive_header SET row_count=?1,retained_bytes=?2 WHERE id=1",
            params![count + 1, next],
        )?;
        Ok(true)
    }
}

fn digest(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}
fn check_key(key: &str) -> Result<()> {
    ensure!(
        !key.is_empty() && key.len() <= 256 && !key.chars().any(char::is_control),
        "RECEIPT_ARCHIVE_KEY_INVALID"
    );
    Ok(())
}
fn check_checkpoint(bytes: &[u8]) -> Result<()> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_RECEIPT_ARCHIVE_CHECKPOINT_BYTES,
        "RECEIPT_ARCHIVE_CHECKPOINT_LIMIT"
    );
    Ok(())
}
fn read_schema(connection: &Connection) -> Result<Vec<String>> {
    Ok(connection.prepare("SELECT CASE WHEN length(sql)<=4096 THEN sql ELSE NULL END FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 6")?.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?)
}
fn schema_matches(observed: &[String]) -> bool {
    let mut expected = SCHEMA.to_vec();
    expected.sort();
    let mut actual = observed.iter().map(String::as_str).collect::<Vec<_>>();
    actual.sort();
    actual == expected
}
fn read_header(
    connection: &Connection,
    binding: &DurableReceiptArchiveBinding,
) -> Result<(u64, u64)> {
    let (version,instance,scope,seed,count,bytes,payload): (u32,String,String,Vec<u8>,u64,u64,u64) = connection.query_row("SELECT version,CASE WHEN length(instance)<=64 THEN instance ELSE NULL END,CASE WHEN length(scope)<=8192 THEN scope ELSE NULL END,CASE WHEN length(seed_sha)=32 THEN seed_sha ELSE NULL END,row_count,retained_bytes,payload_bytes FROM receipt_archive_header WHERE id=1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)))?;
    ensure!(
        version == 1
            && instance == binding.instance
            && scope == binding.scope
            && seed == binding.seed_sha
            && count <= MAX_ROWS
            && bytes
                .checked_add(payload)
                .is_some_and(|total| total <= MAX_RETAINED_BYTES),
        "RECEIPT_ARCHIVE_HEADER_INVALID"
    );
    Ok((count, bytes))
}
fn read_checkpoint(connection: &Connection) -> Result<Vec<u8>> {
    let (body,sha): (Vec<u8>,Vec<u8>) = connection.query_row("SELECT CASE WHEN length(body)<=?1 AND length(sha)=32 THEN body ELSE NULL END,sha FROM receipt_archive_checkpoint WHERE id=1", [MAX_RECEIPT_ARCHIVE_CHECKPOINT_BYTES], |row| Ok((row.get(0)?,row.get(1)?)))?;
    check_checkpoint(&body)?;
    ensure!(digest(&body) == sha, "RECEIPT_ARCHIVE_CHECKPOINT_CORRUPT");
    Ok(body)
}

#[cfg(test)]
#[path = "durable_receipt_archive/tests.rs"]
mod tests;
