use super::files;
use anyhow::{Result, ensure};
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

const INLINE_ROW: usize = 1024 * 1024;
const CHUNK_BYTES: usize = 256 * 1024;
const MAX_ROW: usize = 4 * 1024 * 1024;
const MAX_BATCH: usize = 8 * 1024 * 1024;
const MAX_PAGE: usize = 8 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;
const MAX_TOTAL: usize = 256 * 1024 * 1024;
const LEGACY_SCHEMA: [&str; 2] = [
    "CREATE TABLE page_header(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, sha BLOB NOT NULL)",
    "CREATE TABLE page_rows(ordinal INTEGER PRIMARY KEY, body BLOB NOT NULL, sha BLOB NOT NULL)",
];
const CHUNK_SCHEMA: &str = "CREATE TABLE page_chunks(ordinal INTEGER NOT NULL, chunk_no INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(ordinal,chunk_no))";
const SCHEMA: [&str; 3] = [CHUNK_SCHEMA, LEGACY_SCHEMA[0], LEGACY_SCHEMA[1]];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    generation: String,
    count: usize,
    bytes: usize,
    ready: bool,
    proof: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    declined_row_limit: Option<usize>,
}

#[derive(Debug)]
pub struct TranscriptRowLimitExceeded;
impl std::fmt::Display for TranscriptRowLimitExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("transcript row exceeds page limit")
    }
}
impl std::error::Error for TranscriptRowLimitExceeded {}

#[derive(Debug)]
struct SerializationBudgetExceeded;
impl std::fmt::Display for SerializationBudgetExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("transcript serialization exceeds budget")
    }
}
impl std::error::Error for SerializationBudgetExceeded {}

pub struct TranscriptPageStore {
    connection: Connection,
    writable: bool,
    chunked: bool,
    _lease: files::Lease,
}

pub struct TranscriptStoredPage {
    pub start: usize,
    pub end: usize,
    pub total: usize,
    pub rows: Vec<Value>,
}

impl TranscriptPageStore {
    pub fn declined_generation(&self, proof: &[u8], row_limit: usize) -> Result<Option<String>> {
        let header = read_header(&self.connection)?;
        Ok(
            (header.declined_row_limit == Some(row_limit) && header.proof == proof)
                .then_some(header.generation),
        )
    }

    /// Record only a verified deterministic row-limit failure for the caller's current proof.
    pub fn decline_row_limit(
        &mut self,
        generation: &str,
        proof: &[u8],
        row_limit: usize,
    ) -> Result<()> {
        ensure!(
            self.writable
                && !proof.is_empty()
                && proof.len() <= 8192
                && (1..=MAX_ROW).contains(&row_limit),
            "invalid transcript decline"
        );
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut header = read_header(&tx)?;
        ensure!(
            header.generation == generation
                && !header.ready
                && header.count == 0
                && header.bytes == 0,
            "transcript decline requires an empty unpublished generation"
        );
        header.proof = proof.to_vec();
        header.declined_row_limit = Some(row_limit);
        write_header(&tx, &header)?;
        tx.commit()?;
        Ok(())
    }
    /// Open an existing derived index for reading, recovering interrupted writes when necessary.
    pub fn open_existing_recoverable(root: &Path, scope: &str) -> Result<Option<Self>> {
        match Self::open(root, scope, false) {
            Err(error)
                if matches!(
                    error.downcast_ref::<rusqlite::Error>(),
                    Some(rusqlite::Error::SqliteFailure(code, _))
                        if code.extended_code == rusqlite::ffi::SQLITE_READONLY_ROLLBACK
                ) =>
            {
                Self::open(root, scope, true)
            }
            result => result,
        }
    }
    pub fn current_generation(&self, proof: &[u8]) -> Result<Option<String>> {
        let header = read_header(&self.connection)?;
        Ok((header.ready && header.proof == proof).then_some(header.generation))
    }
    /// The caller supplies the thread/workspace scope and validates current source receipts.
    /// This derived store never reads or writes authoritative conversation files.
    pub fn open(root: &Path, scope: &str, writable: bool) -> Result<Option<Self>> {
        ensure!(
            !scope.is_empty() && scope.len() <= 8192,
            "invalid transcript scope"
        );
        let scope = serde_json::to_string(&("kcoder.transcript-pages.v1", scope))?;
        let Some(opened) = files::open_database(root, "transcript-pages", &scope, writable)? else {
            return Ok(None);
        };
        let mut connection = opened.connection;
        connection.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            (INLINE_ROW * 2) as i32,
        );
        connection.busy_timeout(std::time::Duration::from_millis(50))?;
        connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;")?;
        if !writable {
            connection.pragma_update(None, "query_only", true)?;
        }
        let tx = connection.transaction_with_behavior(if writable {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })?;
        let objects: Vec<String> = tx
            .prepare("SELECT CASE WHEN length(sql)<=4096 THEN sql ELSE NULL END FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 4")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let chunked;
        if objects.is_empty() {
            chunked = true;
            ensure!(writable, "transcript store is uninitialized");
            for sql in SCHEMA {
                tx.execute_batch(sql)?;
            }
            write_header(
                &tx,
                &Header {
                    generation: uuid::Uuid::new_v4().to_string(),
                    count: 0,
                    bytes: 0,
                    ready: false,
                    proof: vec![],
                    declined_row_limit: None,
                },
            )?;
        } else if objects == LEGACY_SCHEMA {
            read_header(&tx)?;
            chunked = writable;
            if writable {
                tx.execute_batch(CHUNK_SCHEMA)?;
            }
        } else {
            chunked = true;
            ensure!(objects == SCHEMA, "unsupported transcript store schema");
            read_header(&tx)?;
        }
        tx.commit()?;
        Ok(Some(Self {
            connection,
            writable,
            chunked,
            _lease: opened.lease,
        }))
    }

    pub fn begin(&mut self) -> Result<String> {
        self.begin_checked(None)
    }

    pub fn restart_unpublished(&mut self, generation: &str) -> Result<String> {
        self.begin_checked(Some(generation))
    }

    fn begin_checked(&mut self, expected: Option<&str>) -> Result<String> {
        ensure!(self.writable, "transcript store is read-only");
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_header(&tx)?;
        if let Some(expected) = expected {
            ensure!(
                previous.generation == expected && !previous.ready,
                "stale transcript builder"
            );
        }
        let generation = uuid::Uuid::new_v4().to_string();
        tx.execute("DELETE FROM page_rows", [])?;
        if self.chunked {
            tx.execute("DELETE FROM page_chunks", [])?;
        }
        write_header(
            &tx,
            &Header {
                generation: generation.clone(),
                count: 0,
                bytes: 0,
                ready: false,
                proof: vec![],
                declined_row_limit: None,
            },
        )?;
        tx.commit()?;
        Ok(generation)
    }

    pub fn append(&mut self, generation: &str, rows: &[Value]) -> Result<()> {
        self.append_with_row_limit(generation, rows, MAX_ROW)
    }

    /// Reject unpageable rows before publication; callers may impose a stricter wire budget.
    pub fn append_with_row_limit(
        &mut self,
        generation: &str,
        rows: &[Value],
        row_limit: usize,
    ) -> Result<()> {
        ensure!(
            self.writable && rows.len() <= 1000 && (1..=MAX_ROW).contains(&row_limit),
            "invalid transcript append"
        );
        let mut bodies = Vec::new();
        let mut bytes = 0usize;
        for row in rows {
            let bound = row_limit.min(MAX_BATCH - bytes);
            let body = bounded_json(row, bound).map_err(|error| {
                if bound == row_limit && error.is::<SerializationBudgetExceeded>() {
                    anyhow::Error::new(TranscriptRowLimitExceeded)
                } else {
                    error
                }
            })?;
            bytes = bytes
                .checked_add(body.len())
                .ok_or_else(|| anyhow::anyhow!("transcript batch overflow"))?;
            ensure!(bytes <= MAX_BATCH, "transcript batch exceeds budget");
            bodies.push(body);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut header = read_header(&tx)?;
        ensure!(
            header.generation == generation && !header.ready && header.declined_row_limit.is_none(),
            "stale transcript builder"
        );
        ensure!(
            header.count + bodies.len() <= MAX_ROWS && header.bytes + bytes <= MAX_TOTAL,
            "transcript index exceeds budget"
        );
        for body in bodies {
            let digest = row_digest(generation, header.count, &body);
            let chunked = body.len() > INLINE_ROW;
            ensure!(
                !chunked || self.chunked,
                "transcript chunk storage is unavailable"
            );
            tx.execute(
                "INSERT INTO page_rows VALUES(?1,?2,?3)",
                params![
                    header.count,
                    if chunked { &[][..] } else { body.as_slice() },
                    digest.as_slice()
                ],
            )?;
            if chunked {
                for (number, chunk) in body.chunks(CHUNK_BYTES).enumerate() {
                    tx.execute(
                        "INSERT INTO page_chunks VALUES(?1,?2,?3)",
                        params![header.count, number, chunk],
                    )?;
                }
            }
            header.count += 1;
        }
        header.bytes += bytes;
        write_header(&tx, &header)?;
        tx.commit()?;
        Ok(())
    }

    /// Publish only after the caller has finished all rows and revalidated sources.
    pub fn publish(&mut self, generation: &str, proof: &[u8]) -> Result<()> {
        ensure!(
            self.writable && !proof.is_empty() && proof.len() <= 8192,
            "invalid transcript publication"
        );
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut header = read_header(&tx)?;
        ensure!(
            header.generation == generation && !header.ready && header.declined_row_limit.is_none(),
            "stale transcript builder"
        );
        header.ready = true;
        header.proof = proof.to_vec();
        write_header(&tx, &header)?;
        tx.commit()?;
        Ok(())
    }

    pub fn page(
        &self,
        generation: &str,
        proof: &[u8],
        before: Option<usize>,
        limit: usize,
        byte_limit: usize,
    ) -> Result<TranscriptStoredPage> {
        ensure!(
            (1..=100).contains(&limit) && (1..=MAX_PAGE).contains(&byte_limit),
            "invalid transcript page budget"
        );
        let tx = self.connection.unchecked_transaction()?;
        let header = read_header(&tx)?;
        ensure!(
            header.ready && header.generation == generation && header.proof == proof,
            "stale transcript page"
        );
        let end = before.unwrap_or(header.count);
        ensure!(end <= header.count, "invalid transcript page cursor");
        let mut query = tx.prepare("SELECT ordinal,body,sha FROM page_rows WHERE ordinal < ?1 ORDER BY ordinal DESC LIMIT ?2")?;
        let mut records = query.query(params![end, limit])?;
        let mut rows = Vec::new();
        let mut bytes = 0usize;
        let mut expected = end;
        let mut budget_stop = false;
        while let Some(row) = records.next()? {
            let ordinal: usize = row.get(0)?;
            let mut body: Vec<u8> = row.get(1)?;
            let digest: Vec<u8> = row.get(2)?;
            ensure!(
                expected > 0 && ordinal == expected - 1,
                "transcript row gap"
            );
            if body.is_empty() {
                ensure!(self.chunked, "transcript chunk storage is missing");
                let sizes = chunk_sizes(&tx, ordinal)?;
                let total: usize = sizes.iter().sum();
                if bytes + total > byte_limit {
                    ensure!(!rows.is_empty(), "transcript row exceeds page budget");
                    budget_stop = true;
                    break;
                }
                body = read_chunks(&tx, ordinal, &sizes)?;
            }
            ensure!(
                body.len() <= MAX_ROW && digest == row_digest(generation, ordinal, &body),
                "corrupt transcript row"
            );
            if bytes + body.len() > byte_limit {
                ensure!(!rows.is_empty(), "transcript row exceeds page budget");
                budget_stop = true;
                break;
            }
            rows.push(serde_json::from_slice(&body)?);
            bytes += body.len();
            expected -= 1;
        }
        ensure!(
            rows.len() == limit.min(end) || budget_stop,
            "missing transcript rows"
        );
        rows.reverse();
        Ok(TranscriptStoredPage {
            start: end - rows.len(),
            end,
            total: header.count,
            rows,
        })
    }
}

fn chunk_sizes(tx: &rusqlite::Transaction<'_>, ordinal: usize) -> Result<Vec<usize>> {
    let mut query = tx.prepare(
        "SELECT chunk_no,length(body) FROM page_chunks WHERE ordinal=?1 ORDER BY chunk_no LIMIT ?2",
    )?;
    let mut records = query.query(params![ordinal, MAX_ROW / CHUNK_BYTES + 1])?;
    let mut sizes = Vec::new();
    while let Some(row) = records.next()? {
        let number: usize = row.get(0)?;
        let bytes: usize = row.get(1)?;
        ensure!(
            number == sizes.len() && sizes.len() < MAX_ROW / CHUNK_BYTES,
            "transcript chunk gap or overflow"
        );
        ensure!(
            (1..=CHUNK_BYTES).contains(&bytes)
                && sizes.last().is_none_or(|size| *size == CHUNK_BYTES),
            "invalid transcript chunk size"
        );
        sizes.push(bytes);
    }
    ensure!(
        sizes.iter().sum::<usize>() > INLINE_ROW,
        "missing transcript chunks"
    );
    Ok(sizes)
}

fn read_chunks(tx: &rusqlite::Transaction<'_>, ordinal: usize, sizes: &[usize]) -> Result<Vec<u8>> {
    let mut query = tx.prepare(
        "SELECT chunk_no,body FROM page_chunks WHERE ordinal=?1 ORDER BY chunk_no LIMIT ?2",
    )?;
    let mut records = query.query(params![ordinal, MAX_ROW / CHUNK_BYTES + 1])?;
    let mut body = Vec::with_capacity(sizes.iter().sum());
    let mut seen = 0usize;
    while let Some(row) = records.next()? {
        let number: usize = row.get(0)?;
        let chunk: Vec<u8> = row.get(1)?;
        ensure!(
            number == seen && sizes.get(seen) == Some(&chunk.len()),
            "changed transcript chunks"
        );
        body.extend_from_slice(&chunk);
        seen += 1;
    }
    ensure!(seen == sizes.len(), "missing transcript chunks");
    Ok(body)
}

fn bounded_json(value: &Value, limit: usize) -> Result<Vec<u8>> {
    struct BoundedWriter {
        bytes: Vec<u8>,
        limit: usize,
        exceeded: bool,
    }
    impl std::io::Write for BoundedWriter {
        fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
            if input.len() > self.limit.saturating_sub(self.bytes.len()) {
                self.exceeded = true;
                return Err(std::io::Error::other(
                    "transcript serialization exceeds budget",
                ));
            }
            self.bytes.extend_from_slice(input);
            Ok(input.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = BoundedWriter {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    let result = serde_json::to_writer(&mut writer, value);
    if writer.exceeded {
        return Err(SerializationBudgetExceeded.into());
    }
    result?;
    Ok(writer.bytes)
}

fn row_digest(generation: &str, ordinal: usize, body: &[u8]) -> Vec<u8> {
    let mut digest = Sha256::new();
    digest.update(generation.as_bytes());
    digest.update((ordinal as u64).to_le_bytes());
    digest.update(body);
    digest.finalize().to_vec()
}

fn read_header(connection: &Connection) -> Result<Header> {
    let (body, digest): (String, Vec<u8>) =
        connection.query_row("SELECT body,sha FROM page_header WHERE id=1", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    ensure!(
        body.len() <= 65536 && digest == Sha256::digest(body.as_bytes()).as_slice(),
        "corrupt transcript header"
    );
    let header: Header = serde_json::from_str(&body)?;
    uuid::Uuid::parse_str(&header.generation)?;
    ensure!(
        header.count <= MAX_ROWS && header.bytes <= MAX_TOTAL && header.proof.len() <= 8192,
        "invalid transcript header"
    );
    ensure!(
        header
            .declined_row_limit
            .is_none_or(|limit| (1..=MAX_ROW).contains(&limit)
                && !header.ready
                && header.count == 0
                && header.bytes == 0
                && !header.proof.is_empty()),
        "invalid transcript decline"
    );
    Ok(header)
}

fn write_header(connection: &Connection, header: &Header) -> Result<()> {
    let body = serde_json::to_string(header)?;
    let digest = Sha256::digest(body.as_bytes());
    connection.execute(
        "INSERT OR REPLACE INTO page_header VALUES(1,?1,?2)",
        params![body, digest.as_slice()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transcript_row_decline_is_proof_and_policy_bound_and_not_publishable() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "decline", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        store
            .append(&generation, &[json!({"partial":true})])
            .unwrap();
        let error = store
            .append_with_row_limit(&generation, &[json!("x".repeat(1000))], 100)
            .unwrap_err();
        assert!(error.is::<TranscriptRowLimitExceeded>());
        assert!(store.decline_row_limit(&generation, b"proof", 100).is_err());
        let generation = store.restart_unpublished(&generation).unwrap();
        store.decline_row_limit(&generation, b"proof", 100).unwrap();
        assert_eq!(
            store.declined_generation(b"proof", 100).unwrap(),
            Some(generation.clone())
        );
        assert!(
            store
                .declined_generation(b"changed", 100)
                .unwrap()
                .is_none()
        );
        assert!(store.declined_generation(b"proof", 101).unwrap().is_none());
        assert!(store.current_generation(b"proof").unwrap().is_none());
        assert!(
            store
                .append(&generation, &[json!({"unexpected":true})])
                .is_err()
        );
        assert!(store.publish(&generation, b"proof").is_err());
        let count: usize = store
            .connection
            .query_row("SELECT count(*) FROM page_rows", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(store);
        let mut store = TranscriptPageStore::open(root.path(), "decline", true)
            .unwrap()
            .unwrap();
        assert_eq!(
            store.declined_generation(b"proof", 100).unwrap(),
            Some(generation.clone())
        );
        let next = store.begin().unwrap();
        assert!(store.declined_generation(b"proof", 100).unwrap().is_none());
        store.append(&next, &[json!({"new":true})]).unwrap();
        store.publish(&next, b"changed").unwrap();
        assert!(store.restart_unpublished(&generation).is_err());
        assert!(store.restart_unpublished(&next).is_err());
    }

    #[test]
    fn transcript_batch_budget_failure_is_not_a_row_decline() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "batch", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        let row = json!("x".repeat(3 * 1024 * 1024));
        let error = store
            .append(&generation, &[row.clone(), row.clone(), row])
            .unwrap_err();
        assert!(!error.is::<TranscriptRowLimitExceeded>());
        assert!(
            store
                .declined_generation(b"proof", MAX_ROW)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn transcript_page_budget_reads_chunk_metadata_without_loading_excluded_payload() {
        for kib in [1100usize, 3500] {
            let root = tempfile::tempdir().unwrap();
            let mut store = TranscriptPageStore::open(root.path(), "metadata-only", true)
                .unwrap()
                .unwrap();
            let generation = store.begin().unwrap();
            store
                .append(
                    &generation,
                    &[
                        json!({"payload":"x".repeat(kib * 1024)}),
                        json!({"small":true}),
                    ],
                )
                .unwrap();
            store.publish(&generation, b"proof").unwrap();
            // Preserve chunk lengths but make the excluded body's full-row hash invalid.
            store
                .connection
                .execute(
                    "UPDATE page_chunks SET body=zeroblob(length(body)) WHERE ordinal=0",
                    [],
                )
                .unwrap();
            drop(store);
            let store = TranscriptPageStore::open(root.path(), "metadata-only", false)
                .unwrap()
                .unwrap();
            files::READ_BYTES.with(|bytes| bytes.set(0));
            let page = store.page(&generation, b"proof", None, 100, 64).unwrap();
            let reads = files::READ_BYTES.with(|bytes| bytes.get());
            assert_eq!((page.start, page.end, page.total), (1, 2, 2));
            assert_eq!(page.rows, vec![json!({"small":true})]);
            assert!(
                reads > 0 && reads < 256 * 1024,
                "excluded chunk payload consumed {reads} VFS bytes"
            );
            assert!(
                store
                    .page(&generation, b"proof", Some(1), 1, MAX_PAGE)
                    .is_err()
            );
            eprintln!("chunked row {kib} KiB: excluded-row page read {reads} VFS bytes");
        }
    }

    #[test]
    fn transcript_chunked_rows_preserve_payload_and_page_budget() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "chunks", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        let large = json!({"payload":"x".repeat(1100 * 1024)});
        let rows = vec![json!({"small":0}), large.clone(), json!({"small":2})];
        store.append(&generation, &rows).unwrap();
        store.publish(&generation, b"proof").unwrap();
        let (inline, chunks, largest): (usize, usize, usize) = store.connection.query_row(
            "SELECT length(body),(SELECT count(*) FROM page_chunks WHERE ordinal=1),(SELECT max(length(body)) FROM page_chunks WHERE ordinal=1) FROM page_rows WHERE ordinal=1", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert_eq!(inline, 0);
        assert_eq!(chunks, 5);
        assert_eq!(largest, CHUNK_BYTES);
        let page = store
            .page(&generation, b"proof", None, 100, MAX_PAGE)
            .unwrap();
        assert_eq!(page.rows, rows);
        let limited = store.page(&generation, b"proof", None, 100, 100).unwrap();
        assert_eq!((limited.start, limited.end), (2, 3));
        assert!(
            store
                .page(&generation, b"proof", Some(2), 100, 100)
                .is_err()
        );
        drop(store);
        let store = TranscriptPageStore::open(root.path(), "chunks", false)
            .unwrap()
            .unwrap();
        assert_eq!(
            store
                .page(&generation, b"proof", Some(2), 1, MAX_PAGE)
                .unwrap()
                .rows,
            vec![large]
        );
    }

    #[test]
    fn transcript_chunk_corruption_and_missing_parts_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "chunks", true)
            .unwrap()
            .unwrap();
        let row = json!({"payload":"x".repeat(1100 * 1024)});
        for corruption in [
            "UPDATE page_chunks SET body=zeroblob(length(body)) WHERE chunk_no=0",
            "DELETE FROM page_chunks WHERE chunk_no=1",
            "UPDATE page_chunks SET chunk_no=20 WHERE chunk_no=4",
        ] {
            let generation = store.begin().unwrap();
            store.append(&generation, &[row.clone()]).unwrap();
            store.publish(&generation, b"proof").unwrap();
            store.connection.execute(corruption, []).unwrap();
            assert!(
                store
                    .page(&generation, b"proof", None, 1, MAX_PAGE)
                    .is_err()
            );
        }
    }

    #[test]
    fn transcript_chunk_batch_failure_rolls_back_rows_and_parts_together() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "chunks", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        store.connection.execute_batch("CREATE TRIGGER fail_chunk BEFORE INSERT ON page_chunks WHEN NEW.chunk_no=2 BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        let row = json!({"payload":"x".repeat(1100 * 1024)});
        assert!(store.append(&generation, &[row.clone()]).is_err());
        assert_eq!(read_header(&store.connection).unwrap().count, 0);
        for table in ["page_rows", "page_chunks"] {
            let count: usize = store
                .connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
        store
            .connection
            .execute_batch("DROP TRIGGER fail_chunk;")
            .unwrap();
        store.append(&generation, &[row.clone()]).unwrap();
        store.publish(&generation, b"proof").unwrap();
        assert_eq!(
            store
                .page(&generation, b"proof", None, 1, MAX_PAGE)
                .unwrap()
                .rows,
            vec![row]
        );
    }

    #[test]
    fn transcript_legacy_schema_reads_without_migration_then_upgrades_on_write() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "legacy", true)
            .unwrap()
            .unwrap();
        let original = store.begin().unwrap();
        store.append(&original, &[json!({"old":true})]).unwrap();
        store.publish(&original, b"proof").unwrap();
        store
            .connection
            .execute_batch("DROP TABLE page_chunks;")
            .unwrap();
        drop(store);
        let store = TranscriptPageStore::open(root.path(), "legacy", false)
            .unwrap()
            .unwrap();
        assert!(!store.chunked);
        assert_eq!(
            store.page(&original, b"proof", None, 1, 100).unwrap().rows,
            vec![json!({"old":true})]
        );
        drop(store);
        let mut store = TranscriptPageStore::open(root.path(), "legacy", true)
            .unwrap()
            .unwrap();
        assert!(store.chunked);
        assert_eq!(store.current_generation(b"proof").unwrap(), Some(original));
        let generation = store.begin().unwrap();
        let large = json!({"payload":"x".repeat(1100 * 1024)});
        store.append(&generation, &[large.clone()]).unwrap();
        store.publish(&generation, b"proof").unwrap();
        assert_eq!(
            store
                .page(&generation, b"proof", None, 1, MAX_PAGE)
                .unwrap()
                .rows,
            vec![large]
        );
    }
    #[test]
    fn transcript_interrupted_transaction_child() {
        let Some(root) = std::env::var_os("KCODER_TEST_TRANSCRIPT_CRASH_ROOT") else {
            return;
        };
        let mut store = TranscriptPageStore::open(Path::new(&root), "crash-transcript", true)
            .unwrap()
            .unwrap();
        store
            .connection
            .execute_batch("PRAGMA main.cache_size=4; PRAGMA cache_spill=ON;")
            .unwrap();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        tx.execute("UPDATE page_header SET body='{}' WHERE id=1", [])
            .unwrap();
        for ordinal in 2..102 {
            tx.execute("INSERT INTO page_rows(ordinal, body, sha) VALUES(?1, zeroblob(4096), zeroblob(32))", [ordinal]).unwrap();
        }
        std::process::exit(73);
    }

    #[test]
    fn transcript_recoverable_open_does_not_create_or_repair_unknown_schema() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            TranscriptPageStore::open_existing_recoverable(root.path(), "scope")
                .unwrap()
                .is_none()
        );
        assert!(!root.path().join("transcript-pages").exists());
        let mut store = TranscriptPageStore::open(root.path(), "scope", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        store.append(&generation, &[json!({"id":1})]).unwrap();
        store.publish(&generation, b"proof").unwrap();
        drop(store);
        let store = TranscriptPageStore::open_existing_recoverable(root.path(), "scope")
            .unwrap()
            .unwrap();
        assert!(!store.writable);
        assert_eq!(
            store.current_generation(b"proof").unwrap(),
            Some(generation)
        );
        drop(store);
        let store = TranscriptPageStore::open(root.path(), "scope", true)
            .unwrap()
            .unwrap();
        store
            .connection
            .execute_batch("CREATE TABLE unsupported_schema(value TEXT);")
            .unwrap();
        drop(store);
        let path = root.path().join("transcript-pages/catalog.sqlite3");
        let before = std::fs::read(&path).unwrap();
        assert!(TranscriptPageStore::open_existing_recoverable(root.path(), "scope").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn transcript_interrupted_batch_recovers_without_publishing_partial_rows() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "crash-transcript", true)
            .unwrap()
            .unwrap();
        let abandoned = store.begin().unwrap();
        store
            .append(&abandoned, &[json!({"old":0}), json!({"old":1})])
            .unwrap();
        drop(store);
        let database = root.path().join("transcript-pages/catalog.sqlite3");
        let before = std::fs::read(&database).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "history_index::transcript_pages::tests::transcript_interrupted_transaction_child",
            ])
            .env("KCODER_TEST_TRANSCRIPT_CRASH_ROOT", root.path())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert_eq!(status.code(), Some(73));
                break;
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("crash fixture timed out");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let dirty = std::fs::read(&database).unwrap();
        assert_ne!(
            before, dirty,
            "fixture must spill uncommitted database pages"
        );
        assert!(TranscriptPageStore::open(root.path(), "crash-transcript", false).is_err());
        assert!(
            TranscriptPageStore::open_existing_recoverable(root.path(), "wrong-scope").is_err()
        );
        assert_eq!(
            std::fs::read(&database).unwrap(),
            dirty,
            "wrong-scope/read-only access repaired the database"
        );
        let mut restored =
            TranscriptPageStore::open_existing_recoverable(root.path(), "crash-transcript")
                .unwrap()
                .unwrap();
        let header = read_header(&restored.connection).unwrap();
        assert_eq!(header.generation, abandoned);
        assert_eq!(header.count, 2);
        assert!(!header.ready);
        assert!(restored.current_generation(b"proof").unwrap().is_none());
        assert!(
            restored
                .page(&abandoned, b"proof", None, 100, 4096)
                .is_err()
        );
        let rebuilt = restored.begin().unwrap();
        assert_ne!(rebuilt, abandoned);
        assert!(
            restored
                .append(&abandoned, &[json!({"stale":true})])
                .is_err()
        );
        let rows = vec![json!({"new":0}), json!({"new":1}), json!({"new":2})];
        restored.append(&rebuilt, &rows).unwrap();
        assert!(restored.publish(&abandoned, b"proof").is_err());
        restored.publish(&rebuilt, b"proof").unwrap();
        drop(restored);
        let readonly =
            TranscriptPageStore::open_existing_recoverable(root.path(), "crash-transcript")
                .unwrap()
                .unwrap();
        assert!(!readonly.writable);
        assert_eq!(
            readonly
                .page(&rebuilt, b"proof", None, 100, 4096)
                .unwrap()
                .rows,
            rows
        );
    }
    use serde_json::json;

    #[test]
    #[ignore = "opt-in 100/2000/20000-row VFS read measurement; no source or provider IO"]
    fn transcript_page_vfs_reads_remain_bounded_as_history_grows() {
        for count in [100usize, 2000, 20000] {
            let root = tempfile::tempdir().unwrap();
            let mut build = TranscriptPageStore::open(root.path(), "measurement", true)
                .unwrap()
                .unwrap();
            let generation = build.begin().unwrap();
            for start in (0..count).step_by(128) {
                let rows = (start..(start + 128).min(count))
                    .map(|id| json!({"id":id,"content":"x".repeat(512)}))
                    .collect::<Vec<_>>();
                build.append(&generation, &rows).unwrap();
            }
            build.publish(&generation, b"fixture-proof").unwrap();
            drop(build);
            let file_bytes =
                std::fs::metadata(root.path().join("transcript-pages/catalog.sqlite3"))
                    .unwrap()
                    .len();
            let mut open_reads = Vec::new();
            let mut page_reads = Vec::new();
            let mut page_micros = Vec::new();
            for sample in 0..23 {
                files::READ_BYTES.with(|bytes| bytes.set(0));
                let store = TranscriptPageStore::open(root.path(), "measurement", false)
                    .unwrap()
                    .unwrap();
                let open_bytes = files::READ_BYTES.with(|bytes| bytes.replace(0));
                let started = std::time::Instant::now();
                let page = store
                    .page(&generation, b"fixture-proof", None, 50, 1024 * 1024)
                    .unwrap();
                let elapsed = started.elapsed().as_micros() as u64;
                let read_bytes = files::READ_BYTES.with(|bytes| bytes.replace(0));
                assert_eq!(
                    (page.start, page.end, page.rows.len()),
                    (count - 50, count, 50)
                );
                assert_eq!(page.rows[0]["id"], count - 50);
                assert!(
                    read_bytes > 0 && read_bytes <= 512 * 1024,
                    "unexpected page IO: {read_bytes}"
                );
                if count >= 2000 {
                    assert!(read_bytes < file_bytes / 4);
                }
                if sample >= 2 {
                    open_reads.push(open_bytes);
                    page_reads.push(read_bytes);
                    page_micros.push(elapsed);
                }
            }
            let percentiles = |mut values: Vec<u64>| {
                values.sort_unstable();
                json!({"p50":values[10],"p95":values[19]})
            };
            eprintln!(
                "{}",
                json!({"rows":count,"samples":21,"page_rows":50,"database_bytes":file_bytes,
                "open_vfs_read_bytes":percentiles(open_reads),"page_vfs_read_bytes":percentiles(page_reads),
                "page_wall_microseconds":percentiles(page_micros),"scope":"fresh SQLite connection, warm OS cache; VFS returned bytes, not physical disk reads or complete RPC"})
            );
        }
    }

    #[test]
    fn transcript_serialization_bounds_encoded_not_raw_bytes() {
        assert_eq!(bounded_json(&json!("x"), 3).unwrap(), b"\"x\"");
        assert!(bounded_json(&json!("x"), 2).is_err());
        assert!(bounded_json(&json!("\n\n"), 4).is_err());
        assert!(bounded_json(&json!("x".repeat(MAX_ROW * 8)), 64).is_err());
    }

    #[test]
    fn transcript_pages_reopen_readonly_and_do_not_decode_off_page_rows() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "scope", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        store
            .append(
                &generation,
                &(0..250).map(|id| json!({"id":id})).collect::<Vec<_>>(),
            )
            .unwrap();
        store.publish(&generation, b"receipt").unwrap();
        store
            .connection
            .execute("UPDATE page_rows SET body=x'ff' WHERE ordinal=0", [])
            .unwrap();
        drop(store);
        assert!(TranscriptPageStore::open(root.path(), "other", false).is_err());
        let mut store = TranscriptPageStore::open(root.path(), "scope", false)
            .unwrap()
            .unwrap();
        assert_eq!(
            store.current_generation(b"receipt").unwrap(),
            Some(generation.clone())
        );
        assert_eq!(store.current_generation(b"changed").unwrap(), None);
        assert!(store.begin().is_err());
        let page = store.page(&generation, b"receipt", None, 2, 1024).unwrap();
        assert_eq!((page.start, page.end, page.total), (248, 250, 250));
        assert_eq!(page.rows, vec![json!({"id":248}), json!({"id":249})]);
        assert!(
            store
                .page(&generation, b"receipt", Some(1), 2, 1024)
                .is_err()
        );
    }

    #[test]
    fn transcript_pages_enforce_bytes_and_detect_missing_or_corrupt_rows() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "scope", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        assert!(
            store
                .append(&generation, &[json!("x".repeat(MAX_ROW))])
                .is_err()
        );
        store
            .append(&generation, &[json!("one"), json!("two"), json!("three")])
            .unwrap();
        store.publish(&generation, b"receipt").unwrap();
        let page = store.page(&generation, b"receipt", None, 3, 7).unwrap();
        assert_eq!((page.start, page.end), (2, 3));
        assert!(store.page(&generation, b"receipt", None, 3, 1).is_err());
        assert!(
            store
                .page(&generation, b"receipt", Some(4), 3, 1024)
                .is_err()
        );
        store
            .connection
            .execute("DELETE FROM page_rows WHERE ordinal=0", [])
            .unwrap();
        assert!(
            store
                .page(&generation, b"receipt", Some(2), 3, 1024)
                .is_err()
        );
        store
            .connection
            .execute("UPDATE page_header SET body='{}'", [])
            .unwrap();
        assert!(store.current_generation(b"receipt").is_err());
    }

    #[test]
    fn transcript_pages_require_publication_and_matching_generation_and_proof() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            TranscriptPageStore::open(root.path(), "thread-a", false)
                .unwrap()
                .is_none()
        );
        let mut store = TranscriptPageStore::open(root.path(), "thread-a", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        store
            .append(
                &generation,
                &[json!({"id":0}), json!({"id":1}), json!({"id":2})],
            )
            .unwrap();
        assert!(store.page(&generation, b"proof", None, 2, 1024).is_err());
        store.publish(&generation, b"proof").unwrap();
        assert_eq!(
            store
                .page(&generation, b"proof", None, 2, 1024)
                .unwrap()
                .rows,
            vec![json!({"id":1}), json!({"id":2})]
        );
        assert_eq!(
            store
                .page(&generation, b"proof", Some(1), 2, 1024)
                .unwrap()
                .rows,
            vec![json!({"id":0})]
        );
        assert!(store.page(&generation, b"changed", None, 2, 1024).is_err());
        let next = store.begin().unwrap();
        assert_ne!(generation, next);
        assert!(store.page(&generation, b"proof", None, 2, 1024).is_err());
    }
}
