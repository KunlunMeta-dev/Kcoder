//! SQLite storage for derived session metadata; callers still verify authoritative sources.

use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, TransactionBehavior, limits::Limit, params};

mod committed_projection;
mod files;
pub mod journal;
mod list_projection;
mod observation;
mod tracked_catalog;
mod transcript_pages;
mod transcript_receipt;
pub use transcript_pages::{TranscriptPageStore, TranscriptRowLimitExceeded, TranscriptStoredPage};
pub use transcript_receipt::TranscriptReadFence;

pub use committed_projection::{CommittedHistoryStamp, CommittedListProjection};
pub use list_projection::{HistoryListProjection, HistoryListProjectionReader};
pub use observation::HistorySourceObservation;
pub use tracked_catalog::{
    BaselineState, ListCatalogCheckpoint, ListCatalogDelta, ListCatalogSession,
    ListCatalogSnapshot, TrackedHistoryCatalog,
};

const SCHEMA_VERSION: i64 = 1;
const MAX_FIELD_BYTES: usize = 64 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_BATCH_BYTES: usize = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogRevision {
    instance: uuid::Uuid,
    sequence: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndexedSession {
    pub session_id: String,
    pub updated_at_ms: u64,
    pub archived: bool,
    pub metadata: serde_json::Value,
    pub source_proof: Vec<u8>,
    pub metadata_proof: Vec<u8>,
}

pub struct CatalogSnapshot {
    pub revision: CatalogRevision,
    pub sessions: Vec<IndexedSession>,
}

pub struct HistoryCatalog {
    connection: Connection,
    scope: String,
    instance: uuid::Uuid,
    writable: bool,
    // SQLite must close its file handles before the VFS slot can be reused.
    file_lease: Option<files::Lease>,
}

impl HistoryCatalog {
    /// Open this project's derived catalog below an existing validated storage root.
    pub fn open(root: &std::path::Path, scope: &str, writable: bool) -> Result<Option<Self>> {
        files::open(root, scope, writable)
    }
    /// Attach a read-only catalog without initializing or migrating it.
    pub(crate) fn attach_read_only(connection: Connection, scope: &str) -> Result<Self> {
        Self::attach_inner(connection, scope, false)
    }
    pub fn revision(&self) -> Result<CatalogRevision> {
        read_revision(&self.connection, &self.scope, self.instance)
    }

    /// A validated existence hint only; callers must still observe sources and match both proofs.
    pub fn has_entry(&self, id: &str) -> Result<bool> {
        validate_id(id)?;
        let transaction = self.connection.unchecked_transaction()?;
        read_revision(&transaction, &self.scope, self.instance)?;
        Ok(transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM main.catalog_sessions WHERE session_id=?1)",
            [id],
            |row| row.get(0),
        )?)
    }

    /// Publish derived rows only after the caller has validated their authoritative sources.
    pub fn publish(
        &mut self,
        expected: &CatalogRevision,
        upserts: &[IndexedSession],
        deleted: &[&str],
    ) -> Result<CatalogRevision> {
        ensure!(self.writable, "history catalog is read-only");
        ensure!(
            upserts.len().saturating_add(deleted.len()) <= MAX_ENTRIES,
            "catalog batch exceeds entry budget"
        );
        let mut identifiers = std::collections::HashSet::new();
        let mut bytes = 0usize;
        let mut encoded = Vec::with_capacity(upserts.len());
        for entry in upserts {
            let metadata = validate_entry(entry)?;
            ensure!(
                identifiers.insert(entry.session_id.as_str()),
                "duplicate catalog mutation"
            );
            bytes = bytes.saturating_add(entry_size(entry, metadata.len()));
            ensure!(
                bytes <= MAX_BATCH_BYTES,
                "catalog batch exceeds byte budget"
            );
            encoded.push((entry, metadata));
        }
        for id in deleted {
            validate_id(id)?;
            ensure!(identifiers.insert(id), "duplicate catalog mutation");
            bytes = bytes.saturating_add(id.len());
            ensure!(
                bytes <= MAX_BATCH_BYTES,
                "catalog batch exceeds byte budget"
            );
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_revision(&transaction, &self.scope, self.instance)?;
        ensure!(
            &current == expected,
            "stale catalog publication; rebuild against the current revision"
        );
        if upserts.is_empty() && deleted.is_empty() {
            return Ok(current);
        }
        let next = current
            .sequence
            .checked_add(1)
            .and_then(|v| i64::try_from(v).ok())
            .context("catalog revision exhausted")?;
        for id in deleted {
            transaction.execute(
                "DELETE FROM main.catalog_sessions WHERE session_id=?1",
                [id],
            )?;
        }
        for (entry, metadata) in encoded {
            transaction.execute(
                "INSERT INTO main.catalog_sessions(session_id, updated_key, archived, metadata, source_proof, metadata_proof)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(session_id) DO UPDATE SET
                 updated_key=excluded.updated_key, archived=excluded.archived, metadata=excluded.metadata,
                 source_proof=excluded.source_proof, metadata_proof=excluded.metadata_proof",
                params![entry.session_id, format!("{:020}", entry.updated_at_ms), entry.archived, metadata, entry.source_proof, entry.metadata_proof],
            )?;
        }
        transaction.execute(
            "UPDATE main.catalog_header SET revision=?1 WHERE id=1",
            [next],
        )?;
        transaction.commit()?;
        Ok(CatalogRevision {
            instance: current.instance,
            sequence: next as u64,
        })
    }

    /// Exact cache-key matching; it does not establish that external source files are unchanged.
    pub fn lookup(
        &self,
        id: &str,
        source_proof: &[u8],
        metadata_proof: &[u8],
    ) -> Result<Option<IndexedSession>> {
        validate_id(id)?;
        validate_proof(source_proof)?;
        validate_proof(metadata_proof)?;
        let transaction = self.connection.unchecked_transaction()?;
        read_revision(&transaction, &self.scope, self.instance)?;
        let mut statement = transaction.prepare(
            "SELECT session_id, updated_key, archived, metadata, source_proof, metadata_proof
             FROM main.catalog_sessions WHERE session_id=?1 AND source_proof=?2 AND metadata_proof=?3",
        )?;
        let mut rows = statement.query(params![id, source_proof, metadata_proof])?;
        rows.next()?.map(decode_entry).transpose()
    }

    /// A bounded immutable snapshot. Overflow is an error, never a complete truncated listing.
    pub fn snapshot(&mut self, archived: Option<bool>, maximum: usize) -> Result<CatalogSnapshot> {
        ensure!(
            (1..=MAX_ENTRIES).contains(&maximum),
            "invalid catalog snapshot budget"
        );
        let transaction = self.connection.transaction()?;
        let revision = read_revision(&transaction, &self.scope, self.instance)?;
        let mut sessions = Vec::new();
        let mut bytes = 0usize;
        {
            let mut statement = transaction.prepare(
                "SELECT session_id, updated_key, archived, metadata, source_proof, metadata_proof
                 FROM main.catalog_sessions WHERE (?1 IS NULL OR archived=?1)
                 ORDER BY updated_key DESC, session_id ASC LIMIT ?2",
            )?;
            let mut rows = statement.query(params![archived, (maximum + 1) as i64])?;
            while let Some(row) = rows.next()? {
                ensure!(
                    sessions.len() < maximum,
                    "catalog snapshot exceeds entry budget"
                );
                let entry = decode_entry(row)?;
                bytes = bytes.saturating_add(entry_size(&entry, row.get_ref(3)?.as_str()?.len()));
                ensure!(
                    bytes <= MAX_SNAPSHOT_BYTES,
                    "catalog snapshot exceeds byte budget"
                );
                sessions.push(entry);
            }
        }
        transaction.commit()?;
        Ok(CatalogSnapshot { revision, sessions })
    }

    /// Attach an explicitly owned connection. This does not discover or open user paths.
    pub(crate) fn attach(connection: Connection, scope: &str) -> Result<Self> {
        Self::attach_inner(connection, scope, true)
    }

    fn attach_inner(mut connection: Connection, scope: &str, writable: bool) -> Result<Self> {
        ensure!(
            !scope.is_empty() && scope.len() <= 16 * 1024,
            "invalid catalog scope"
        );
        connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, (4 * MAX_FIELD_BYTES) as i32);
        connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024);
        connection.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
        connection.set_limit(Limit::SQLITE_LIMIT_WORKER_THREADS, 0);
        connection.busy_timeout(std::time::Duration::from_millis(50))?;
        if !writable {
            connection.pragma_update(None, "query_only", true)?;
        }
        let transaction = connection.transaction_with_behavior(if writable {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })?;
        let objects: i64 = transaction.query_row(
            "SELECT count(*) FROM main.sqlite_master WHERE name NOT GLOB 'sqlite_*'",
            [],
            |row| row.get(0),
        )?;
        if objects == 0 {
            ensure!(writable, "history catalog is not initialized");
            transaction.execute_batch(
                "CREATE TABLE main.catalog_header (
                    id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL,
                    scope TEXT NOT NULL, instance TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0)
                 );
                 CREATE TABLE main.catalog_sessions (
                    session_id TEXT PRIMARY KEY NOT NULL, updated_key TEXT NOT NULL,
                    archived INTEGER NOT NULL CHECK(archived IN (0,1)), metadata TEXT NOT NULL,
                    source_proof BLOB NOT NULL, metadata_proof BLOB NOT NULL
                 );
                 CREATE INDEX main.catalog_order ON catalog_sessions(updated_key DESC, session_id ASC);"
            )?;
            transaction.execute(
                "INSERT INTO main.catalog_header VALUES(1, ?1, ?2, ?3, 0)",
                params![SCHEMA_VERSION, scope, uuid::Uuid::new_v4().to_string()],
            )?;
        }
        let (version, stored_scope, instance, revision): (i64, String, String, i64) = transaction
            .query_row(
                "SELECT schema_version, scope, instance, revision FROM main.catalog_header WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .context("unrecognized history catalog schema")?;
        ensure!(
            version == SCHEMA_VERSION,
            "unsupported history catalog version"
        );
        // Same legacy acceptance as the owner record: a stored scope that
        // differs only by path namespace prefixes (verbatim vs simplified)
        // stays usable; a writable open migrates the persisted header so
        // later opens take the exact-equality fast path.
        ensure!(
            stored_scope == scope || files::scopes_match_after_normalization(&stored_scope, scope),
            "history catalog belongs to another scope"
        );
        if stored_scope != scope && writable {
            transaction.execute(
                "UPDATE main.catalog_header SET scope = ?1 WHERE id = 1",
                params![scope],
            )?;
        }
        let instance = uuid::Uuid::parse_str(&instance).context("invalid catalog instance")?;
        ensure!(revision >= 0, "invalid catalog revision");
        transaction.prepare("SELECT session_id, updated_key, archived, metadata, source_proof, metadata_proof FROM main.catalog_sessions LIMIT 0")?;
        transaction.commit()?;
        Ok(Self {
            connection,
            scope: scope.to_owned(),
            instance,
            writable,
            file_lease: None,
        })
    }
}

fn validate_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty() && id.len() <= 256 && !id.contains('\0'),
        "invalid catalog session id"
    );
    Ok(())
}

fn validate_proof(proof: &[u8]) -> Result<()> {
    ensure!(
        !proof.is_empty() && proof.len() <= MAX_FIELD_BYTES,
        "invalid catalog source proof"
    );
    Ok(())
}

fn validate_entry(entry: &IndexedSession) -> Result<String> {
    validate_entry_fields(entry)?;
    encode_metadata(&entry.metadata)
}

fn validate_entry_fields(entry: &IndexedSession) -> Result<()> {
    validate_id(&entry.session_id)?;
    validate_proof(&entry.source_proof)?;
    validate_proof(&entry.metadata_proof)?;
    ensure!(
        entry.metadata.is_object(),
        "catalog metadata must be an object"
    );
    Ok(())
}

fn encode_metadata(metadata: &impl serde::Serialize) -> Result<String> {
    struct BoundedJson(Vec<u8>);
    impl std::io::Write for BoundedJson {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_FIELD_BYTES.saturating_sub(self.0.len()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "catalog metadata exceeds byte budget",
                ));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut encoded = BoundedJson(Vec::new());
    serde_json::to_writer(&mut encoded, metadata)?;
    Ok(String::from_utf8(encoded.0)?)
}

fn entry_size(entry: &IndexedSession, metadata_bytes: usize) -> usize {
    entry.session_id.len() + entry.source_proof.len() + entry.metadata_proof.len() + metadata_bytes
}

fn decode_entry(row: &rusqlite::Row<'_>) -> Result<IndexedSession> {
    let key: String = row.get(1)?;
    ensure!(
        key.len() == 20 && key.bytes().all(|byte| byte.is_ascii_digit()),
        "invalid catalog timestamp key"
    );
    let archived: i64 = row.get(2)?;
    ensure!(matches!(archived, 0 | 1), "invalid catalog archive flag");
    let metadata: String = row.get(3)?;
    ensure!(
        metadata.len() <= MAX_FIELD_BYTES,
        "catalog metadata exceeds byte budget"
    );
    let entry = IndexedSession {
        session_id: row.get(0)?,
        updated_at_ms: key.parse()?,
        archived: archived == 1,
        metadata: serde_json::from_str(&metadata)?,
        source_proof: row.get(4)?,
        metadata_proof: row.get(5)?,
    };
    validate_entry_fields(&entry)?;
    Ok(entry)
}

fn read_revision(
    connection: &Connection,
    expected_scope: &str,
    expected_instance: uuid::Uuid,
) -> Result<CatalogRevision> {
    let (schema, scope, instance, sequence): (i64, String, String, i64) = connection.query_row(
        "SELECT schema_version, scope, instance, revision FROM main.catalog_header WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let instance = uuid::Uuid::parse_str(&instance)?;
    ensure!(
        schema == SCHEMA_VERSION,
        "unsupported history catalog version"
    );
    ensure!(
        scope == expected_scope && instance == expected_instance,
        "history catalog identity changed"
    );
    Ok(CatalogRevision {
        instance,
        sequence: u64::try_from(sequence).context("invalid catalog revision")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_read_only_attachment_never_creates_or_initializes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("catalog.sqlite3");
        let mut writer =
            HistoryCatalog::attach(Connection::open(&path).unwrap(), "project").unwrap();
        let seed = entry("seed", 1, false);
        writer
            .publish(&writer.revision().unwrap(), &[seed.clone()], &[])
            .unwrap();
        drop(writer);
        let before = std::fs::read(&path).unwrap();
        let connection =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut reader = HistoryCatalog::attach_read_only(connection, "project").unwrap();
        assert_eq!(reader.snapshot(None, 10).unwrap().sessions, vec![seed]);
        assert!(
            reader
                .publish(&reader.revision().unwrap(), &[], &["seed"])
                .is_err()
        );
        drop(reader);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let empty = Connection::open_in_memory().unwrap();
        assert!(HistoryCatalog::attach_read_only(empty, "project").is_err());
    }

    fn entry(id: &str, time: u64, archived: bool) -> IndexedSession {
        IndexedSession {
            session_id: id.into(),
            updated_at_ms: time,
            archived,
            metadata: serde_json::json!({"title": format!("中文-{id}"), "mode": "default"}),
            source_proof: b"exact source stamp".to_vec(),
            metadata_proof: b"exact independent metadata".to_vec(),
        }
    }

    #[test]
    fn catalog_metadata_serialization_stops_at_its_byte_budget() {
        use serde::ser::SerializeMap;
        struct Probe(std::cell::Cell<usize>);
        impl serde::Serialize for Probe {
            fn serialize<S: serde::Serializer>(
                &self,
                serializer: S,
            ) -> std::result::Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(10_000))?;
                for index in 0..10_000 {
                    self.0.set(self.0.get() + 1);
                    map.serialize_entry(&index, &"x".repeat(128))?;
                }
                map.end()
            }
        }
        let probe = Probe(std::cell::Cell::new(0));
        assert!(encode_metadata(&probe).is_err());
        assert!(
            probe.0.get() < 10_000,
            "serialized the entire oversized object before enforcing the limit"
        );
    }

    #[test]
    fn catalog_live_handle_rejects_changed_schema_scope_or_instance() {
        for sql in [
            "UPDATE catalog_header SET schema_version=999",
            "UPDATE catalog_header SET scope='another project'",
            "UPDATE catalog_header SET instance='00000000-0000-4000-8000-000000000001'",
        ] {
            let mut catalog =
                HistoryCatalog::attach(Connection::open_in_memory().unwrap(), "project").unwrap();
            let row = entry("seed", 1, false);
            let revision = catalog
                .publish(&catalog.revision().unwrap(), &[row.clone()], &[])
                .unwrap();
            catalog.connection.execute_batch(sql).unwrap();
            assert!(
                catalog.revision().is_err(),
                "existing handle accepted {sql}"
            );
            assert!(catalog.has_entry("seed").is_err());
            assert!(
                catalog
                    .lookup("seed", &row.source_proof, &row.metadata_proof)
                    .is_err()
            );
            assert!(catalog.snapshot(None, 10).is_err());
            assert!(catalog.publish(&revision, &[], &["seed"]).is_err());
            let count: i64 = catalog
                .connection
                .query_row("SELECT count(*) FROM catalog_sessions", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 1);
        }
    }

    #[test]
    fn catalog_invalid_rows_and_mutations_fail_without_advancing_revision() {
        let mut catalog =
            HistoryCatalog::attach(Connection::open_in_memory().unwrap(), "project").unwrap();
        let revision = catalog.revision().unwrap();
        let seed = entry("seed", 1, false);
        let mut invalid = Vec::new();
        let mut row = seed.clone();
        row.source_proof.clear();
        invalid.push(row);
        let mut row = seed.clone();
        row.metadata_proof = vec![0; MAX_FIELD_BYTES + 1];
        invalid.push(row);
        let mut row = seed.clone();
        row.metadata = serde_json::Value::Null;
        invalid.push(row);
        let mut row = seed.clone();
        row.metadata = serde_json::json!({"title": "x".repeat(MAX_FIELD_BYTES)});
        invalid.push(row);
        for row in invalid {
            assert!(catalog.publish(&revision, &[row], &[]).is_err());
            assert_eq!(catalog.revision().unwrap(), revision);
        }
        assert!(
            catalog
                .publish(&revision, &[seed.clone(), seed.clone()], &[])
                .is_err()
        );
        assert!(
            catalog
                .publish(&revision, &[seed.clone()], &["seed"])
                .is_err()
        );
        catalog.publish(&revision, &[seed.clone()], &[]).unwrap();
        catalog
            .connection
            .execute("UPDATE catalog_sessions SET metadata='[]'", [])
            .unwrap();
        assert!(
            catalog
                .lookup("seed", &seed.source_proof, &seed.metadata_proof)
                .is_err()
        );
        assert!(catalog.snapshot(None, 10).is_err());
    }

    #[test]
    fn catalog_rejects_stale_writer_and_recreated_instance() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("catalog.sqlite3");
        let mut first =
            HistoryCatalog::attach(Connection::open(&path).unwrap(), "project").unwrap();
        let mut second =
            HistoryCatalog::attach(Connection::open(&path).unwrap(), "project").unwrap();
        let before = first.revision().unwrap();
        assert_eq!(second.revision().unwrap(), before);
        let row = entry("one", 1, false);
        let after = first.publish(&before, &[row.clone()], &[]).unwrap();
        assert!(
            second
                .publish(&before, &[entry("stale", 2, false)], &[])
                .is_err()
        );
        assert_eq!(second.snapshot(None, 10).unwrap().sessions, vec![row]);
        second.publish(&after, &[], &["one"]).unwrap();
        assert!(first.snapshot(None, 10).unwrap().sessions.is_empty());
        let mut recreated =
            HistoryCatalog::attach(Connection::open_in_memory().unwrap(), "project").unwrap();
        assert!(
            recreated
                .publish(&before, &[entry("stale", 1, false)], &[])
                .is_err()
        );
    }

    #[test]
    fn catalog_failed_batch_rolls_back_rows_and_revision() {
        let mut catalog =
            HistoryCatalog::attach(Connection::open_in_memory().unwrap(), "project").unwrap();
        let seed = entry("seed", 1, false);
        let revision = catalog
            .publish(&catalog.revision().unwrap(), &[seed.clone()], &[])
            .unwrap();
        catalog.connection.execute_batch("CREATE TRIGGER fail_fixture BEFORE INSERT ON catalog_sessions WHEN NEW.session_id='bad' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
        let error = catalog
            .publish(
                &revision,
                &[entry("good", 2, false), entry("bad", 3, false)],
                &["seed"],
            )
            .unwrap_err();
        assert!(error.to_string().contains("fixture failure"));
        let snapshot = catalog.snapshot(None, 10).unwrap();
        assert_eq!(snapshot.revision, revision);
        assert_eq!(snapshot.sessions, vec![seed]);
    }

    #[test]
    fn catalog_rejects_temp_header_for_another_main_scope() {
        let mut catalog =
            HistoryCatalog::attach(Connection::open_in_memory().unwrap(), "project-a").unwrap();
        catalog
            .publish(
                &catalog.revision().unwrap(),
                &[entry("private-a", 1, false)],
                &[],
            )
            .unwrap();
        let connection = catalog.connection;
        connection.execute_batch("CREATE TEMP TABLE catalog_header(id INTEGER, schema_version INTEGER, scope TEXT, instance TEXT, revision INTEGER);
            INSERT INTO temp.catalog_header VALUES(1, 1, 'project-b', '00000000-0000-4000-8000-000000000001', 0);").unwrap();
        assert!(
            HistoryCatalog::attach(connection, "project-b").is_err(),
            "TEMP scope authorized access to another project's main rows"
        );
    }

    #[test]
    fn catalog_rejects_foreign_schema_without_modifying_it() {
        for kind in ["foreign", "foreign_near_prefix", "future", "corrupt"] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("catalog.sqlite3");
            match kind {
                "foreign" => Connection::open(&path)
                    .unwrap()
                    .execute_batch(
                        "CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES('keep');",
                    )
                    .unwrap(),
                "foreign_near_prefix" => Connection::open(&path).unwrap().execute_batch(
                    "CREATE TABLE sqliteXprecious(value TEXT); INSERT INTO sqliteXprecious VALUES('keep');"
                ).unwrap(),
                "future" => {
                    let catalog =
                        HistoryCatalog::attach(Connection::open(&path).unwrap(), "project")
                            .unwrap();
                    catalog
                        .connection
                        .execute("UPDATE catalog_header SET schema_version=999", [])
                        .unwrap();
                }
                _ => std::fs::write(&path, b"not a database").unwrap(),
            }
            let before = std::fs::read(&path).unwrap();
            let connection = Connection::open(&path).unwrap();
            assert!(HistoryCatalog::attach(connection, "project").is_err());
            assert_eq!(std::fs::read(&path).unwrap(), before, "modified {kind}");
        }
    }

    #[test]
    fn catalog_publish_persists_exact_proofs_and_sorted_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("catalog.sqlite3");
        let mut catalog =
            HistoryCatalog::attach(Connection::open(&path).unwrap(), "project").unwrap();
        let initial = catalog.revision().unwrap();
        let rows = [
            entry("b", 1, false),
            entry("a", 1, false),
            entry("archived", u64::MAX, true),
        ];
        let committed = catalog.publish(&initial, &rows, &[]).unwrap();
        assert_ne!(initial, committed);
        drop(catalog);
        let mut catalog =
            HistoryCatalog::attach(Connection::open(&path).unwrap(), "project").unwrap();
        let found = catalog
            .lookup("a", &rows[1].source_proof, &rows[1].metadata_proof)
            .unwrap();
        assert_eq!(found, Some(rows[1].clone()));
        assert!(catalog.has_entry("a").unwrap());
        assert!(!catalog.has_entry("' OR 1=1 --").unwrap());
        assert!(!catalog.has_entry("missing").unwrap());
        assert!(catalog.has_entry("").is_err());
        assert!(
            catalog
                .lookup("a", b"changed source", &rows[1].metadata_proof)
                .unwrap()
                .is_none()
        );
        assert!(
            catalog
                .lookup("a", &rows[1].source_proof, b"changed metadata")
                .unwrap()
                .is_none()
        );
        let snapshot = catalog.snapshot(None, 3).unwrap();
        assert_eq!(snapshot.revision, committed);
        assert_eq!(
            snapshot.sessions,
            vec![rows[2].clone(), rows[1].clone(), rows[0].clone()]
        );
        assert_eq!(
            catalog.snapshot(Some(false), 2).unwrap().sessions,
            vec![rows[1].clone(), rows[0].clone()]
        );
        assert_eq!(
            catalog.snapshot(Some(true), 1).unwrap().sessions,
            vec![rows[2].clone()]
        );
        assert!(catalog.snapshot(None, 2).is_err());
        assert!(catalog.snapshot(None, 0).is_err());
    }

    #[test]
    fn catalog_initialization_is_persistent_and_scope_bound() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("catalog.sqlite3");
        let first = HistoryCatalog::attach(Connection::open(&path).unwrap(), "project-a").unwrap();
        let original: (String, i64) = first
            .connection
            .query_row(
                "SELECT instance, revision FROM catalog_header WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(original.1, 0);
        uuid::Uuid::parse_str(&original.0).unwrap();
        drop(first);
        let reopened =
            HistoryCatalog::attach(Connection::open(&path).unwrap(), "project-a").unwrap();
        let current: (String, i64) = reopened
            .connection
            .query_row(
                "SELECT instance, revision FROM catalog_header WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(current, original);
        assert!(HistoryCatalog::attach(Connection::open(&path).unwrap(), "project-b").is_err());
    }
}
