//! Ordered, immutable-source tool correlation. No source operation is re-executed.
use super::*;
use crate::history_index::files;
use kcoder_types::{historical_tool_links::*, imported_transcript::*};
use rusqlite::{Connection, TransactionBehavior, params};

mod correlation;
#[cfg(test)]
mod initialization_tests;
mod resolved;

const BUDGET: u64 = 4 * 1024 * 1024 * 1024;
const ENCODED_ROW: usize = 64 * 1024;
const SCHEMA: [&str; 5] = [
    "CREATE TABLE link_header(id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL, sha BLOB NOT NULL)",
    "CREATE TABLE link_records(sequence INTEGER PRIMARY KEY, ordinal INTEGER NOT NULL, sha BLOB NOT NULL)",
    "CREATE TABLE links(id TEXT PRIMARY KEY, call_id TEXT NOT NULL, turn_id TEXT, has_call INTEGER NOT NULL, open INTEGER NOT NULL, status TEXT NOT NULL, body BLOB NOT NULL, sha BLOB NOT NULL)",
    "CREATE INDEX links_lookup ON links(call_id,open)",
    "CREATE INDEX links_turn ON links(call_id,turn_id)",
];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    version: u32,
    source_sha256: String,
    normalization_revision: String,
    selection_sha256: String,
    progress: HistoricalToolLinkProgress,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    run: Option<HistoricalToolLinkRun>,
}

pub struct HistoricalToolLinks {
    _source_leases: Vec<lifecycle::ArchiveReadGuard>,
    _branch_lifecycle: Option<std::sync::Arc<kcoder_config::VerifiedPrivateLease>>,
    connection: Connection,
    _lease: files::Lease,
    _writer: Option<File>,
    projection: Option<projection::HistoricalProjectionStore>,
    writable: bool,
    source_sha256: String,
    normalization_revision: String,
    selection_sha256: String,
    cache: Option<(lifecycle::ArchiveReadGuard, String)>,
}
pub(super) struct ToolLinkBinding<'a> {
    pub source: &'a str,
    pub normalization: &'a str,
    pub selection: &'a str,
    pub resource_guard: Option<&'a lifecycle::ArchiveReadGuard>,
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() <= ENCODED_ROW,
        "history_tool_links_row_budget_exceeded"
    );
    Ok(bytes)
}

fn read_header(connection: &Connection) -> Result<Header> {
    let (bytes, sha): (Vec<u8>, Vec<u8>) =
        connection.query_row("SELECT body,sha FROM link_header WHERE id=1", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    ensure!(
        bytes.len() <= ENCODED_ROW && Sha256::digest(&bytes).as_slice() == sha,
        "history_tool_links_header_changed"
    );
    let header: Header = decode(&bytes)?;
    ensure!(
        header.version == 1
            && header.progress.processed_records <= EXTERNAL_HISTORY_MAX_RECORDS
            && header.progress.recorded_links <= 4_000_000
            && header.progress.unresolved_links <= header.progress.recorded_links
            && header.run.as_ref().is_none_or(
                |run| run.stage != HistoricalToolLinkStage::Ready || header.progress.sealed
            ),
        "history_tool_links_invalid_progress"
    );
    Ok(header)
}

fn write_header(connection: &Connection, header: &Header) -> Result<()> {
    let bytes = encode(header)?;
    connection.execute("INSERT INTO link_header(id,body,sha) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body,sha=excluded.sha",params![&bytes,Sha256::digest(&bytes).as_slice()])?;
    Ok(())
}

impl ExternalHistoryReader {
    /// Selection identity belongs to the host's branch recipe. Reusing it with a different
    /// ordered source stream is a conflict, including after a lost append receipt.
    pub fn tool_links(
        &self,
        normalization_revision: &str,
        selection_sha256: &str,
        writable: bool,
    ) -> Result<Option<HistoricalToolLinks>> {
        ensure!(
            valid_hash(selection_sha256)
                && !normalization_revision.is_empty()
                && normalization_revision.len() <= 4096,
            "history_tool_links_invalid_scope"
        );
        let receipt = self.receipt()?.context("external_history_not_committed")?;
        let Some(projection) = self.projection(normalization_revision, false)? else {
            return Ok(None);
        };
        ensure!(
            projection.progress()?.normalization_complete,
            "history_tool_links_normalization_incomplete"
        );
        let identity = serde_json::to_string(&(normalization_revision, selection_sha256))?;
        let name = format!("tool-links-{}", hash(identity.as_bytes()));
        let Some(directory) = self.cache_directory(&name, writable)? else {
            return Ok(None);
        };
        directory.verify_private_directory()?;
        let writer = if writable {
            Some(
                directory
                    .try_exclusive_lock(OsStr::new("build.lock"))?
                    .context("history_tool_links_busy")?,
            )
        } else {
            None
        };
        let scope = serde_json::to_string(&(
            "external-history-tool-links/v1",
            &receipt.archive_id,
            &receipt.source_sha256,
            &identity,
        ))?;
        let mut links = open(
            directory,
            &scope,
            Some(projection),
            ToolLinkBinding {
                source: &receipt.source_sha256,
                normalization: normalization_revision,
                selection: selection_sha256,
                resource_guard: Some(&self.lifecycle),
            },
            writer,
            writable,
        )?;
        if let Some(links) = &mut links {
            links.cache = Some((self.lifecycle.clone(), name));
        }
        Ok(links)
    }
}

pub(super) fn open(
    directory: PrivateDirectory,
    scope: &str,
    projection: Option<projection::HistoricalProjectionStore>,
    binding: ToolLinkBinding<'_>,
    writer: Option<File>,
    writable: bool,
) -> Result<Option<HistoricalToolLinks>> {
    let ToolLinkBinding {
        source: source_sha256,
        normalization: normalization_revision,
        selection: selection_sha256,
        resource_guard,
    } = binding;
    let schema_binding = projection::schema_binding(&directory, scope)?;
    let ready = projection::schema_marker(&directory, "schema-ready.json", &schema_binding)?;
    let absent = match directory.open_single_link_regular_file(OsStr::new("catalog.sqlite3")) {
        Ok(_) => false,
        Err(error) if missing(&error) => true,
        Err(error) => return Err(error),
    };
    if absent {
        ensure!(!ready, "history_tool_links_schema_missing");
        if writable {
            projection::publish_schema_marker(&directory, "schema-intent.json", &schema_binding)?;
        }
    }
    let resource = resource_guard
        .map(|guard| files::resource_for_database(guard, &directory, scope, writable, BUDGET))
        .transpose()?
        .flatten();
    let Some(opened) =
        files::open_database_in_with_resource(directory, scope, writable, BUDGET, resource)?
    else {
        return Ok(None);
    };
    let mut connection = opened.connection;
    connection.set_limit(
        rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
        8 * 1024 * 1024,
    );
    connection.busy_timeout(std::time::Duration::from_millis(50))?;
    connection.execute_batch(
        "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048;",
    )?;
    if !writable {
        connection.pragma_update(None, "query_only", true)?;
    }
    let (ready_before, pending_before) = opened.lease.with_directory(|directory| {
        let ready = projection::schema_marker(directory, "schema-ready.json", &schema_binding)?;
        Ok((
            ready,
            !ready && projection::schema_marker(directory, "schema-intent.json", &schema_binding)?,
        ))
    })?;
    let transaction = connection.transaction_with_behavior(if writable {
        TransactionBehavior::Immediate
    } else {
        TransactionBehavior::Deferred
    })?;
    let schema:Vec<String> = transaction.prepare("SELECT CASE WHEN length(sql)<=4096 THEN sql ELSE NULL END FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 6")?.query_map([],|row|row.get(0))?.collect::<rusqlite::Result<_>>()?;
    if schema.is_empty() {
        if !writable && pending_before {
            return Ok(None);
        }
        ensure!(
            writable && !ready_before && pending_before,
            "history_tool_links_schema_missing"
        );
        for sql in SCHEMA {
            transaction.execute_batch(sql)?;
        }
        write_header(
            &transaction,
            &Header {
                version: 1,
                source_sha256: source_sha256.into(),
                normalization_revision: normalization_revision.into(),
                selection_sha256: selection_sha256.into(),
                progress: HistoricalToolLinkProgress {
                    processed_records: 0,
                    recorded_links: 0,
                    unresolved_links: 0,
                    sealed: false,
                },
                run: None,
            },
        )?;
    } else {
        ensure!(schema == SCHEMA, "history_tool_links_schema_changed");
    }
    let header = read_header(&transaction)?;
    ensure!(
        header.source_sha256 == source_sha256
            && header.normalization_revision == normalization_revision
            && header.selection_sha256 == selection_sha256,
        "history_tool_links_scope_changed"
    );
    transaction.commit()?;
    if writable {
        opened.lease.with_directory(|directory| {
            projection::publish_schema_marker(directory, "schema-ready.json", &schema_binding)
        })?;
    }
    Ok(Some(HistoricalToolLinks {
        _source_leases: Vec::new(),
        _branch_lifecycle: None,
        connection,
        _lease: opened.lease,
        _writer: writer,
        projection,
        writable,
        source_sha256: source_sha256.into(),
        normalization_revision: normalization_revision.into(),
        selection_sha256: selection_sha256.into(),
        cache: None,
    }))
}

impl HistoricalToolLinks {
    pub(super) fn retain_sources(
        &mut self,
        leases: Vec<lifecycle::ArchiveReadGuard>,
        branch: Option<std::sync::Arc<kcoder_config::VerifiedPrivateLease>>,
    ) {
        self._source_leases = leases;
        self._branch_lifecycle = branch;
    }
    fn header(&self, connection: &Connection) -> Result<Header> {
        let header = read_header(connection)?;
        ensure!(
            header.source_sha256 == self.source_sha256
                && header.normalization_revision == self.normalization_revision
                && header.selection_sha256 == self.selection_sha256,
            "history_tool_links_scope_changed"
        );
        Ok(header)
    }

    pub fn seal_for_collection(&self, check: impl FnMut() -> bool) -> Result<()> {
        ensure!(
            self.writable && self.progress()?.sealed,
            "history_tool_links_incomplete"
        );
        self._lease.finish_resource_usage()?;
        if let Some((guard, name)) = &self.cache {
            self._lease
                .with_directory(|directory| guard.seal_cache(name, directory, check))?;
        }
        Ok(())
    }
    pub fn progress(&self) -> Result<HistoricalToolLinkProgress> {
        Ok(self.header(&self.connection)?.progress)
    }

    pub fn append(
        &mut self,
        expected_sequence: u64,
        ordinal: u64,
    ) -> Result<HistoricalToolLinkProgress> {
        ensure!(self.writable, "history_tool_links_read_only");
        let record = self
            .projection
            .as_ref()
            .context("history_tool_links_resolved_item_required")?
            .record(ordinal)?;
        let expected = self.header(&self.connection)?;
        let bytes = serde_json::to_vec(&record)?;
        let digest = Sha256::digest(&bytes);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut header = read_header(&transaction)?;
        ensure!(
            header.progress == expected.progress
                && header.source_sha256 == expected.source_sha256
                && header.normalization_revision == expected.normalization_revision
                && header.selection_sha256 == expected.selection_sha256,
            "history_tool_links_scope_changed"
        );
        if expected_sequence < header.progress.processed_records {
            let (actual, sha): (u64, Vec<u8>) = transaction.query_row(
                "SELECT ordinal,sha FROM link_records WHERE sequence=?1",
                [expected_sequence],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            ensure!(
                actual == ordinal && sha == digest.as_slice(),
                "history_tool_links_replay_conflict"
            );
        } else {
            ensure!(
                !header.progress.sealed
                    && expected_sequence == header.progress.processed_records
                    && expected_sequence < EXTERNAL_HISTORY_MAX_RECORDS,
                "history_tool_links_cursor_conflict"
            );
            correlation::append(
                &transaction,
                expected_sequence,
                &record,
                &mut header.progress,
            )?;
            transaction.execute(
                "INSERT INTO link_records(sequence,ordinal,sha) VALUES(?1,?2,?3)",
                params![expected_sequence, ordinal, digest.as_slice()],
            )?;
            header.progress.processed_records += 1;
            ensure!(
                header.progress.recorded_links <= 4_000_000,
                "history_tool_links_budget_exceeded"
            );
            write_header(&transaction, &header)?;
        }
        transaction.commit()?;
        Ok(header.progress)
    }

    pub fn seal(&mut self, expected_records: u64) -> Result<HistoricalToolLinkProgress> {
        ensure!(self.writable, "history_tool_links_read_only");
        let expected = self.header(&self.connection)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut header = read_header(&transaction)?;
        ensure!(
            header.progress == expected.progress
                && header.source_sha256 == expected.source_sha256
                && header.normalization_revision == expected.normalization_revision
                && header.selection_sha256 == expected.selection_sha256,
            "history_tool_links_scope_changed"
        );
        let (count, first, last): (u64, Option<u64>, Option<u64>) = transaction.query_row(
            "SELECT count(*),min(sequence),max(sequence) FROM link_records",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        ensure!(
            count == expected_records
                && count == header.progress.processed_records
                && (count == 0 || first == Some(0) && last == Some(count - 1)),
            "history_tool_links_incomplete_selection"
        );
        if header.progress.sealed {
            transaction.commit()?;
            if self.projection.is_some() {
                self._lease.finish_resource_usage()?;
            }
            return Ok(header.progress);
        }
        header.progress.sealed = true;
        refresh_counts(&transaction, &mut header.progress)?;
        write_header(&transaction, &header)?;
        transaction.commit()?;
        if self.projection.is_some() {
            self._lease.finish_resource_usage()?;
        }
        Ok(header.progress)
    }

    pub fn page(&self, cursor: Option<&str>, limit: u32) -> Result<HistoricalToolLinkPage> {
        ensure!(
            (1..=10).contains(&limit) && cursor.is_none_or(|value| value.len() <= 128),
            "history_tool_links_invalid_page"
        );
        let transaction = self.connection.unchecked_transaction()?;
        let progress = self.header(&transaction)?.progress;
        let mut statement = transaction.prepare(
            "SELECT id,body,sha FROM links WHERE ?1 IS NULL OR id>?1 ORDER BY id LIMIT ?2",
        )?;
        let rows: Vec<(String, Vec<u8>, Vec<u8>)> = statement
            .query_map(params![cursor, limit + 1], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);
        let has_more = rows.len() > limit as usize;
        let mut links = Vec::new();
        for (id, bytes, sha) in rows.into_iter().take(limit as usize) {
            ensure!(
                bytes.len() <= ENCODED_ROW && Sha256::digest(&bytes).as_slice() == sha,
                "history_tool_links_record_changed"
            );
            let value: HistoricalToolLink = decode(&bytes)?;
            ensure!(value.id == id, "history_tool_links_record_changed");
            links.push(value);
        }
        let next_cursor = has_more.then(|| links.last().unwrap().id.clone());
        transaction.commit()?;
        Ok(HistoricalToolLinkPage {
            links,
            next_cursor,
            progress,
        })
    }
}

fn refresh_counts(
    connection: &Connection,
    progress: &mut HistoricalToolLinkProgress,
) -> Result<()> {
    progress.recorded_links =
        connection.query_row("SELECT count(*) FROM links", [], |row| row.get(0))?;
    progress.unresolved_links = connection.query_row(
        "SELECT count(*) FROM links WHERE status!='linked'",
        [],
        |row| row.get(0),
    )?;
    ensure!(
        progress.recorded_links <= 4_000_000,
        "history_tool_links_budget_exceeded"
    );
    Ok(())
}
