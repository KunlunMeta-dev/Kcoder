//! Experimental list parsing reuse, disabled in production by the component performance gate.

#[cfg(test)]
use super::canonical_workspace;
use super::{
    QueryEngine, Thread, ThreadClientMetadata, decorate_thread_snapshot_with_metadata,
    read_thread_metadata,
};
use anyhow::{Result, ensure};
use kcoder_state::PreparedSessionMetadata;
use kcoder_state::history_index::{
    CatalogRevision, HistoryCatalog, HistoryListProjection, HistorySourceObservation,
    IndexedSession,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

const MAX_BODY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STAGED_ROWS: usize = 128;
const MAX_STAGED_BYTES: usize = 1024 * 1024;
const MAX_ROW_BYTES: usize = 64 * 1024;

#[derive(Default)]
pub(super) struct ListCatalog {
    cache: Option<Cache>,
}

struct Cache {
    catalog: HistoryCatalog,
    revision: CatalogRevision,
    staged: Vec<IndexedSession>,
    staged_bytes: usize,
    build_attempts: usize,
}

impl ListCatalog {
    #[cfg(test)]
    pub(super) fn open(engine: &QueryEngine) -> Self {
        let open = || -> Result<Option<Cache>> {
            // open_existing in HistoryCatalog must not materialize an unknown client root.
            let Some(catalog) = HistoryCatalog::open(
                &engine.client_storage_root(),
                &canonical_workspace(engine)?,
                true,
            )?
            else {
                return Ok(None);
            };
            let revision = catalog.revision()?;
            Ok(Some(Cache {
                catalog,
                revision,
                staged: Vec::new(),
                staged_bytes: 0,
                build_attempts: 0,
            }))
        };
        Self {
            cache: open().unwrap_or_else(|error| {
                tracing::debug!(%error, "list catalog unavailable; using authoritative reads");
                None
            }),
        }
    }

    /// Called only after current source enumeration, sidecar preparation and workspace validation.
    pub(super) fn snapshot(
        &mut self,
        engine: &QueryEngine,
        id: &str,
        path: &Path,
        prepared: &PreparedSessionMetadata,
        running: bool,
    ) -> Result<Value> {
        // Read and validate once; decoration must use these same actual inputs even on fallback.
        let stored = read_thread_metadata(engine, id)?;
        if let Some(cache) = self.cache.as_mut() {
            match cache.snapshot(id, path, prepared, stored.as_ref()) {
                Ok(Some(mut snapshot)) => {
                    snapshot["status"] = json!(if running { "running" } else { "idle" });
                    return Ok(snapshot);
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::debug!(%error, "disabling list catalog for this scan");
                    self.cache = None;
                }
            }
        }
        let (created, updated) = prepared.timestamps_ms()?;
        let mut snapshot = base_snapshot(id, prepared, prepared.first_prompt(80), created, updated);
        snapshot["status"] = json!(if running { "running" } else { "idle" });
        decorate_thread_snapshot_with_metadata(&mut snapshot, stored.as_ref(), true)?;
        Ok(snapshot)
    }

    pub(super) fn publish(self) {
        if let Some(mut cache) = self.cache
            && !cache.staged.is_empty()
        {
            // No source locks survive observations. A failed CAS cannot retract the response.
            if let Err(error) = cache.catalog.publish(&cache.revision, &cache.staged, &[]) {
                tracing::debug!(%error, "discarding derived list catalog updates");
            }
        }
    }
}

impl Cache {
    fn snapshot(
        &mut self,
        id: &str,
        path: &Path,
        prepared: &PreparedSessionMetadata,
        stored: Option<&ThreadClientMetadata>,
    ) -> Result<Option<Value>> {
        // An unknown boundary rejects the optimization before extra body I/O. This hint cannot
        // establish a hit; the full observation below still validates its own actual reads.
        if !HistorySourceObservation::has_commit_boundary_hint(path)? {
            return Ok(None);
        }
        let metadata_proof = Sha256::digest(serde_json::to_vec(&(
            "kcoder.app-server.list-snapshot.v1",
            prepared.list_input_key()?,
            stored,
        ))?)
        .to_vec();
        if self.catalog.has_entry(id)? {
            let observation = HistorySourceObservation::read(path, MAX_BODY_BYTES)?;
            if !observation.has_known_commit_boundary() {
                return Ok(None);
            }
            if let Some(entry) =
                self.catalog
                    .lookup(id, observation.cache_key(), &metadata_proof)?
            {
                return validated_snapshot(entry, id, prepared, stored).map(Some);
            }
        }
        if self.build_attempts >= MAX_STAGED_ROWS || self.staged_bytes >= MAX_STAGED_BYTES {
            return Ok(None);
        }
        self.build_attempts += 1;
        // A miss's projection consumes exactly its own hashed stream, never an earlier hash.
        let projection = {
            let _span = tracing::debug_span!("history.list_projection").entered();
            HistoryListProjection::read(path, MAX_BODY_BYTES, MAX_LINE_BYTES)?
        };
        if !projection.observation().has_known_commit_boundary() {
            return Ok(None);
        }
        let (created, updated) = projection.timestamps_ms(prepared);
        let mut snapshot = base_snapshot(
            id,
            prepared,
            projection.first_prompt().map(ToOwned::to_owned),
            created,
            updated,
        );
        decorate_thread_snapshot_with_metadata(&mut snapshot, stored, true)?;
        let entry = IndexedSession {
            session_id: id.to_owned(),
            updated_at_ms: snapshot["updatedAt"]
                .as_str()
                .unwrap_or_default()
                .parse()
                .unwrap_or_default(),
            archived: snapshot.get("archivedAt").is_some_and(Value::is_string),
            metadata: json!({ "version": 1, "snapshot": snapshot }),
            source_proof: projection.observation().cache_key().to_vec(),
            metadata_proof,
        };
        let bytes = serde_json::to_vec(&entry.metadata)?.len();
        let staged_bytes =
            bytes + entry.session_id.len() + entry.source_proof.len() + entry.metadata_proof.len();
        if bytes <= MAX_ROW_BYTES
            && self.staged.len() < MAX_STAGED_ROWS
            && staged_bytes <= MAX_STAGED_BYTES.saturating_sub(self.staged_bytes)
        {
            self.staged_bytes += staged_bytes;
            self.staged.push(entry);
        }
        Ok(Some(snapshot))
    }
}

fn base_snapshot(
    id: &str,
    prepared: &PreparedSessionMetadata,
    title: Option<String>,
    created: u64,
    updated: u64,
) -> Value {
    let cwd = prepared
        .base_cwd()
        .map(|base| dunce::simplified(base).to_string_lossy().into_owned());
    json!({
        "id": id, "cwd": cwd, "sessionMode": prepared.session_mode(),
        "title": title, "status": "idle", "createdAt": created.to_string(),
        "updatedAt": updated.to_string(),
    })
}

fn validated_snapshot(
    entry: IndexedSession,
    id: &str,
    prepared: &PreparedSessionMetadata,
    stored: Option<&ThreadClientMetadata>,
) -> Result<Value> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Payload {
        version: u32,
        snapshot: Value,
    }
    let payload: Payload = serde_json::from_value(entry.metadata)?;
    ensure!(payload.version == 1, "unsupported list catalog payload");
    ensure!(
        payload
            .snapshot
            .as_object()
            .is_some_and(|object| object.keys().all(|key| matches!(
                key.as_str(),
                "id" | "cwd"
                    | "sessionMode"
                    | "title"
                    | "status"
                    | "createdAt"
                    | "updatedAt"
                    | "model"
                    | "archivedAt"
                    | "parent"
                    | "metadata"
                    | "settingsTemplate"
            ))),
        "unexpected list catalog fields"
    );
    let thread: Thread = serde_json::from_value(payload.snapshot.clone())?;
    ensure!(
        thread.id == id && entry.session_id == id,
        "list catalog identity mismatch"
    );
    ensure!(
        payload.snapshot["cwd"] == json!(prepared.base_cwd())
            && payload.snapshot["sessionMode"] == json!(prepared.session_mode()),
        "list catalog input mismatch"
    );
    ensure!(
        payload.snapshot.get("metadata").is_some()
            && thread.metadata.schema == super::THREAD_METADATA_SCHEMA
            && thread.metadata.version == 1
            && thread.metadata.revision == stored.map_or(0, |value| value.revision)
            && thread.metadata.title == thread.title
            && thread.metadata.model == thread.model
            && thread.metadata.archived_at == thread.archived_at
            && thread.metadata.parent == thread.parent,
        "invalid list catalog metadata"
    );
    ensure!(
        thread.updated_at.parse::<u64>()? == entry.updated_at_ms
            && thread.created_at.parse::<u64>()? <= entry.updated_at_ms
            && thread.archived_at.is_some() == entry.archived,
        "invalid list catalog timestamp or archive state"
    );
    Ok(payload.snapshot)
}
