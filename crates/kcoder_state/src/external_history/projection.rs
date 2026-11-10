//! Rebuildable, source/revision-bound normalized records. Completion does not authorize a turn.
use super::*;
use crate::history_index::files;
use kcoder_types::imported_transcript::*;
use rusqlite::{Connection, TransactionBehavior, params};
use std::io::Write;

mod relations;

const DATABASE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const ROW_BYTES: usize = 8 * 1024 * 1024;
const PAGE_BYTES: usize = 1024 * 1024;
const PAGE_ENVELOPE_BYTES: usize = 16 * 1024;
const SCHEMA_INTENT: &str = "schema-intent.json";
const SCHEMA_READY: &str = "schema-ready.json";
#[cfg(test)]
mod initialization_tests;
const LEGACY_SCHEMA: [&str; 2] = [
    "CREATE TABLE projection_header(id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL, sha BLOB NOT NULL)",
    "CREATE TABLE projection_rows(ordinal INTEGER PRIMARY KEY, body BLOB NOT NULL, sha BLOB NOT NULL)",
];
const SCHEMA: [&str; 4] = [
    LEGACY_SCHEMA[0],
    LEGACY_SCHEMA[1],
    "CREATE INDEX projection_rows_parent ON projection_rows(json_extract(CAST(body AS TEXT),'$.parentId'))",
    "CREATE INDEX projection_rows_source ON projection_rows(json_extract(CAST(body AS TEXT),'$.sourceId'),ordinal DESC)",
];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    version: u32,
    source_sha256: String,
    adapter_revision: String,
    progress: HistoricalProjectionProgress,
}

pub struct HistoricalProjectionStore {
    _lifecycle: lifecycle::ArchiveReadGuard,
    connection: Connection,
    _file_lease: files::Lease,
    _writer: Option<File>,
    writable: bool,
    source_kind: kcoder_types::migration::MigrationSourceKind,
    source_sha256: String,
    adapter_revision: String,
    source_records: u64,
    archive_id: String,
    relations_indexed: bool,
    cache_name: String,
}

struct BoundedEncoding {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for BoundedEncoding {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        if input.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other(
                "history_projection_encoding_budget_exceeded",
            ));
        }
        self.bytes.extend_from_slice(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode(value: &impl Serialize, limit: usize) -> Result<Vec<u8>> {
    let mut output = BoundedEncoding {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut output, value)
        .map_err(|_| anyhow::anyhow!("history_projection_encoding_budget_exceeded"))?;
    Ok(output.bytes)
}

fn header(connection: &Connection) -> Result<Header> {
    let (bytes, sha): (Vec<u8>, Vec<u8>) = connection.query_row(
        "SELECT body,sha FROM projection_header WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    ensure!(
        bytes.len() <= METADATA_BYTES as usize && Sha256::digest(&bytes).as_slice() == sha,
        "history_projection_invalid_header"
    );
    let header: Header = decode(&bytes)?;
    ensure!(
        header.version == 1
            && header.progress.normalized_records <= header.progress.source_records
            && header.progress.records_with_diagnostics <= header.progress.normalized_records
            && header.progress.source_records <= EXTERNAL_HISTORY_MAX_RECORDS
            && (!header.progress.normalization_complete
                || header.progress.normalized_records == header.progress.source_records),
        "history_projection_invalid_header"
    );
    Ok(header)
}

fn write_header(connection: &Connection, header: &Header) -> Result<()> {
    let bytes = encode(header, METADATA_BYTES as usize)?;
    connection.execute("INSERT INTO projection_header(id,body,sha) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body,sha=excluded.sha",
        params![&bytes,Sha256::digest(&bytes).as_slice()])?;
    Ok(())
}

pub(super) fn schema_binding(directory: &PrivateDirectory, scope: &str) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&(
        1u32,
        scope,
        directory.directory_identity()?,
    ))?)
}
pub(super) fn schema_marker(
    directory: &PrivateDirectory,
    name: &str,
    binding: &[u8],
) -> Result<bool> {
    let Some(bytes) = read_optional(directory, name, METADATA_BYTES)? else {
        return Ok(false);
    };
    ensure!(
        bytes == binding,
        "history_projection_schema_binding_changed"
    );
    Ok(true)
}
pub(super) fn publish_schema_marker(
    directory: &PrivateDirectory,
    name: &str,
    binding: &[u8],
) -> Result<()> {
    if !schema_marker(directory, name, binding)? {
        // The projection writer lease serializes publication. Rename avoids the
        // transient hard-link alias of an immutable hard-link publication.
        directory.atomic_replace(OsStr::new(name), binding)?;
    }
    Ok(())
}

impl ExternalHistoryReader {
    pub fn projection(
        &self,
        adapter_revision: &str,
        writable: bool,
    ) -> Result<Option<HistoricalProjectionStore>> {
        ensure!(
            !adapter_revision.is_empty() && adapter_revision.len() <= 4096,
            "history_projection_invalid_adapter"
        );
        let receipt = self.receipt()?.context("external_history_not_committed")?;
        let name = format!("normalized-{}", hash(adapter_revision.as_bytes()));
        let Some(directory) = self.cache_directory(&name, writable)? else {
            return Ok(None);
        };
        directory.verify_private_directory()?;
        let writer = if writable {
            Some(
                directory
                    .try_exclusive_lock(OsStr::new("build.lock"))?
                    .context("history_projection_busy")?,
            )
        } else {
            None
        };
        let scope = serde_json::to_string(&(
            "external-history-projection/v1",
            &receipt.archive_id,
            &receipt.source_sha256,
            adapter_revision,
        ))?;
        let binding = schema_binding(&directory, &scope)?;
        if writable {
            let absent =
                match directory.open_single_link_regular_file(OsStr::new("catalog.sqlite3")) {
                    Ok(_) => false,
                    Err(error) if missing(&error) => true,
                    Err(error) => return Err(error),
                };
            if absent {
                ensure!(
                    !schema_marker(&directory, SCHEMA_READY, &binding)?,
                    "history_projection_missing_schema"
                );
                publish_schema_marker(&directory, SCHEMA_INTENT, &binding)?;
            }
        }
        let resource = files::resource_for_database(
            &self.lifecycle,
            &directory,
            &scope,
            writable,
            DATABASE_BYTES,
        )?;
        let recovery = if writable && resource.as_ref().is_some_and(|value| value.is_committed()) {
            self.lifecycle.sealed_cache_recovery(&name, &directory)?
        } else {
            None
        };
        let recovering_sealed = recovery.is_some();
        let Some(opened) = files::open_database_in_with_recovery(
            directory,
            &scope,
            writable,
            DATABASE_BYTES,
            resource,
            recovery,
        )?
        else {
            return Ok(None);
        };
        // A completed checkpoint is reopened only for its verified rollback.
        // The resulting projection remains read-only; its quota stays sealed.
        let writable = writable && !recovering_sealed;
        let mut connection = opened.connection;
        connection.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            (ROW_BYTES + 4096) as i32,
        );
        connection.busy_timeout(std::time::Duration::from_millis(50))?;
        connection.execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192;",
        )?;
        if !writable {
            connection.pragma_update(None, "query_only", true)?;
        }
        // A later ready marker must not reinterpret an older SQLite read snapshot.
        let (ready_before, pending_before) = opened.lease.with_directory(|directory| {
            let ready = schema_marker(directory, SCHEMA_READY, &binding)?;
            Ok((
                ready,
                !ready && schema_marker(directory, SCHEMA_INTENT, &binding)?,
            ))
        })?;
        let transaction = connection.transaction_with_behavior(if writable {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })?;
        let schema:Vec<String>=transaction.prepare("SELECT CASE WHEN length(sql)<=4096 THEN sql ELSE NULL END FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 5")?
            .query_map([],|row|row.get(0))?.collect::<rusqlite::Result<_>>()?;
        let relations_indexed = schema.is_empty() || schema == SCHEMA;
        if schema.is_empty() {
            if !writable && pending_before {
                return Ok(None);
            }
            ensure!(
                writable && !ready_before,
                "history_projection_missing_schema"
            );
            for statement in SCHEMA {
                transaction.execute_batch(statement)?;
            }
            write_header(
                &transaction,
                &Header {
                    version: 1,
                    source_sha256: receipt.source_sha256.clone(),
                    adapter_revision: adapter_revision.into(),
                    progress: HistoricalProjectionProgress {
                        source_records: receipt.record_count,
                        normalized_records: 0,
                        records_with_diagnostics: 0,
                        normalization_complete: false,
                    },
                },
            )?;
        } else {
            ensure!(
                schema == SCHEMA || schema == LEGACY_SCHEMA,
                "history_projection_schema_changed"
            );
        }
        let observed = header(&transaction)?;
        ensure!(
            observed.source_sha256 == receipt.source_sha256
                && observed.adapter_revision == adapter_revision
                && observed.progress.source_records == receipt.record_count,
            "history_projection_source_changed"
        );
        transaction.commit()?;
        if writable {
            opened.lease.with_directory(|directory| {
                publish_schema_marker(directory, SCHEMA_READY, &binding)
            })?;
        }
        Ok(Some(HistoricalProjectionStore {
            _lifecycle: self.lifecycle.clone(),
            connection,
            _file_lease: opened.lease,
            _writer: writer,
            writable,
            source_kind: self.origin().source,
            source_sha256: receipt.source_sha256,
            adapter_revision: adapter_revision.into(),
            source_records: receipt.record_count,
            archive_id: receipt.archive_id,
            relations_indexed,
            cache_name: name,
        }))
    }
}

impl HistoricalProjectionStore {
    pub fn seal_for_collection(&self, check: impl FnMut() -> bool) -> Result<()> {
        ensure!(self.writable, "history_projection_read_only");
        ensure!(
            self.progress()?.normalization_complete,
            "history_projection_incomplete"
        );
        self._file_lease.finish_resource_usage()?;
        self._file_lease.with_directory(|directory| {
            self._lifecycle
                .seal_cache(&self.cache_name, directory, check)
        })
    }
    fn header(&self, connection: &Connection) -> Result<Header> {
        let observed = header(connection)?;
        ensure!(
            observed.source_sha256 == self.source_sha256
                && observed.adapter_revision == self.adapter_revision
                && observed.progress.source_records == self.source_records,
            "history_projection_source_changed"
        );
        Ok(observed)
    }

    pub fn progress(&self) -> Result<HistoricalProjectionProgress> {
        Ok(self.header(&self.connection)?.progress)
    }

    /// A durable cursor advances in the same SQLite transaction as its rows. Repeated
    /// bytes reconcile a lost receipt; changed bytes or gaps never overwrite earlier rows.
    pub fn append(
        &mut self,
        expected_cursor: u64,
        records: &[HistoricalRecord],
    ) -> Result<HistoricalProjectionProgress> {
        ensure!(
            self.writable && !records.is_empty() && records.len() <= 10,
            "history_projection_invalid_append"
        );
        let next = expected_cursor
            .checked_add(records.len() as u64)
            .context("history_projection_cursor_overflow")?;
        ensure!(
            next <= self.source_records,
            "history_projection_cursor_out_of_range"
        );
        let mut encoded = Vec::with_capacity(records.len());
        let mut total = 0usize;
        for (index, record) in records.iter().enumerate() {
            ensure!(
                record.record == expected_cursor + index as u64
                    && record.source == self.source_kind,
                "history_projection_record_scope_mismatch"
            );
            let bytes = encode(record, ROW_BYTES.saturating_sub(total))?;
            total = total.saturating_add(bytes.len());
            ensure!(
                total <= ROW_BYTES,
                "history_projection_batch_budget_exceeded"
            );
            let sha = Sha256::digest(&bytes).to_vec();
            encoded.push((bytes, sha));
        }
        let mut observed = self.header(&self.connection)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // The writer lease excludes other builders. Still recheck the durable header
        // inside the transaction before reconciling a receipt or advancing its cursor.
        let transaction_header = header(&transaction)?;
        ensure!(
            transaction_header.source_sha256 == observed.source_sha256
                && transaction_header.adapter_revision == observed.adapter_revision
                && transaction_header.progress == observed.progress,
            "history_projection_source_changed"
        );
        observed = transaction_header;
        ensure!(
            next <= observed.progress.source_records,
            "history_projection_cursor_out_of_range"
        );
        if observed.progress.normalized_records >= next {
            for (index, (bytes, sha)) in encoded.iter().enumerate() {
                let (existing, existing_sha): (Vec<u8>, Vec<u8>) = transaction.query_row(
                    "SELECT body,sha FROM projection_rows WHERE ordinal=?1",
                    [expected_cursor + index as u64],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                ensure!(
                    existing == *bytes && existing_sha == *sha,
                    "history_projection_replay_conflict"
                );
            }
        } else {
            ensure!(
                !observed.progress.normalization_complete
                    && observed.progress.normalized_records == expected_cursor,
                "history_projection_cursor_conflict"
            );
            for (index, (bytes, sha)) in encoded.iter().enumerate() {
                transaction.execute(
                    "INSERT INTO projection_rows(ordinal,body,sha) VALUES(?1,?2,?3)",
                    params![expected_cursor + index as u64, bytes, sha],
                )?;
            }
            observed.progress.normalized_records = next;
            observed.progress.records_with_diagnostics += records
                .iter()
                .filter(|record| !record.diagnostics.is_empty())
                .count() as u64;
            write_header(&transaction, &observed)?;
        }
        transaction.commit()?;
        Ok(observed.progress)
    }

    pub fn finish(&mut self) -> Result<HistoricalProjectionProgress> {
        ensure!(self.writable, "history_projection_read_only");
        let expected = self.header(&self.connection)?;
        if expected.progress.normalization_complete {
            self._file_lease.finish_resource_usage()?;
            return Ok(expected.progress);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut observed = header(&transaction)?;
        ensure!(
            observed.source_sha256 == expected.source_sha256
                && observed.adapter_revision == expected.adapter_revision
                && observed.progress == expected.progress,
            "history_projection_source_changed"
        );
        ensure!(
            observed.progress.normalized_records == observed.progress.source_records,
            "history_projection_incomplete"
        );
        let (count, first, last): (u64, Option<u64>, Option<u64>) = transaction.query_row(
            "SELECT count(*),min(ordinal),max(ordinal) FROM projection_rows",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        ensure!(
            count == observed.progress.normalized_records
                && if count == 0 {
                    first.is_none() && last.is_none()
                } else {
                    first == Some(0) && last == Some(count - 1)
                },
            "history_projection_cursor_gap"
        );
        observed.progress.normalization_complete = true;
        write_header(&transaction, &observed)?;
        transaction.commit()?;
        self._file_lease.finish_resource_usage()?;
        Ok(observed.progress)
    }

    pub fn record(&self, ordinal: u64) -> Result<HistoricalRecord> {
        let transaction = self.connection.unchecked_transaction()?;
        let progress = self.header(&transaction)?.progress;
        let record = self.read_record(&transaction, ordinal, progress.normalized_records)?;
        transaction.commit()?;
        Ok(record)
    }

    fn read_record(
        &self,
        connection: &Connection,
        ordinal: u64,
        count: u64,
    ) -> Result<HistoricalRecord> {
        ensure!(ordinal < count, "history_projection_record_not_found");
        let (bytes, sha): (Vec<u8>, Vec<u8>) = connection.query_row(
            "SELECT body,sha FROM projection_rows WHERE ordinal=?1",
            [ordinal],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        ensure!(
            bytes.len() <= ROW_BYTES && Sha256::digest(&bytes).as_slice() == sha,
            "history_projection_record_changed"
        );
        let record: HistoricalRecord = decode(&bytes)?;
        ensure!(
            record.record == ordinal && record.source == self.source_kind,
            "history_projection_record_scope_mismatch"
        );
        Ok(record)
    }

    pub fn page(&self, cursor: u64, limit: u32) -> Result<HistoricalProjectionPage> {
        ensure!(
            (1..=10).contains(&limit),
            "history_projection_invalid_page_limit"
        );
        let transaction = self.connection.unchecked_transaction()?;
        let progress = self.header(&transaction)?.progress;
        ensure!(
            cursor <= progress.normalized_records,
            "history_projection_invalid_cursor"
        );
        let mut statement=transaction.prepare("SELECT ordinal,length(body),sha FROM projection_rows WHERE ordinal>=?1 AND ordinal<?2 ORDER BY ordinal LIMIT ?3")?;
        let rows: Vec<(u64, u64, Vec<u8>)> = statement
            .query_map(params![cursor, progress.normalized_records, limit], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);
        ensure!(
            rows.len() as u64 == (progress.normalized_records - cursor).min(u64::from(limit)),
            "history_projection_cursor_gap"
        );
        let mut items = Vec::new();
        let mut remaining = PAGE_BYTES - PAGE_ENVELOPE_BYTES;
        for (index, (ordinal, bytes, sha)) in rows.into_iter().enumerate() {
            ensure!(
                ordinal == cursor + index as u64,
                "history_projection_cursor_gap"
            );
            ensure!(
                bytes <= ROW_BYTES as u64 && sha.len() == 32,
                "history_projection_invalid_record_size"
            );
            let value = if bytes <= remaining as u64 {
                remaining -= bytes as usize;
                Some(self.read_record(&transaction, ordinal, progress.normalized_records)?)
            } else {
                None
            };
            items.push(HistoricalProjectionItem {
                record: ordinal,
                bytes,
                sha256: sha.iter().map(|byte| format!("{byte:02x}")).collect(),
                value,
            });
        }
        let end = items.last().map_or(cursor, |item| item.record + 1);
        ensure!(
            end <= progress.normalized_records && (end == cursor || items[0].record == cursor),
            "history_projection_cursor_gap"
        );
        transaction.commit()?;
        Ok(HistoricalProjectionPage {
            items,
            next_cursor: (end < progress.normalized_records).then_some(end),
            progress,
        })
    }

    pub fn read_entry_chunk(&self, ordinal: u64, offset: u64, limit: usize) -> Result<Vec<u8>> {
        ensure!(
            (1..=EXTERNAL_HISTORY_CHUNK_BYTES).contains(&limit),
            "history_projection_invalid_chunk_limit"
        );
        let transaction = self.connection.unchecked_transaction()?;
        let progress = self.header(&transaction)?.progress;
        ensure!(
            ordinal < progress.normalized_records,
            "history_projection_record_not_found"
        );
        let (bytes, sha): (Vec<u8>, Vec<u8>) = transaction.query_row(
            "SELECT body,sha FROM projection_rows WHERE ordinal=?1",
            [ordinal],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        ensure!(
            bytes.len() <= ROW_BYTES && Sha256::digest(&bytes).as_slice() == sha,
            "history_projection_record_changed"
        );
        ensure!(
            offset <= bytes.len() as u64,
            "history_projection_invalid_offset"
        );
        let start = offset as usize;
        transaction.commit()?;
        Ok(bytes[start..bytes.len().min(start + limit)].to_vec())
    }
}
