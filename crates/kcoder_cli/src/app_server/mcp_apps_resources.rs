//! Bounded private cache for MCP resource results. URI text never addresses host files.
use super::{
    hex_sha256,
    ledger::{SHORT_LOCK_WAIT, same_binding},
};
use anyhow::{Context, Result, ensure};
use base64::Engine as _;
use kcoder_app_protocol::{McpAppReadParams, McpAppResourceContentReadResult, McpAppResourceRef};
use kcoder_fs::PrivateDirectory;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{ffi::OsStr, io::Read};

const CONTENT_LIMIT: usize = 768 * 1024;
const CACHE_LIMIT: u64 = 16 * 1024 * 1024;
const RECORD_LIMIT: usize = 256;
const CHUNK: usize = 32 * 1024;
const IDLE_TTL_MS: u64 = 15 * 60 * 1000;
const MIN_RETENTION_MS: u64 = 60 * 1000;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    binding: McpAppReadParams,
    reference: McpAppResourceRef,
    created_at_ms: u64,
    #[serde(default)]
    last_access_ms: u64,
}
pub struct ResourceStore {
    directory: PrivateDirectory,
}
impl ResourceStore {
    pub fn open(session: &Path) -> Result<Self> {
        Ok(Self {
            directory: PrivateDirectory::open_or_create(&session.join("mcp-app-resources"))?,
        })
    }
    pub fn open_existing(session: &Path) -> Result<Self> {
        Ok(Self {
            directory: PrivateDirectory::open_existing(&session.join("mcp-app-resources"))?,
        })
    }
    pub fn commit(
        &self,
        binding: McpAppReadParams,
        uri: String,
        value: Value,
    ) -> Result<McpAppResourceRef> {
        let body = serde_json::to_vec(&value)?;
        ensure!(
            body.len() <= CONTENT_LIMIT,
            "mcp_app_resource_quota: result exceeds the 768 KiB encoded budget"
        );
        let contents = value
            .get("contents")
            .and_then(Value::as_array)
            .context("invalid MCP resource result")?;
        let sha256 = hex_sha256(&body);
        let id = hex_sha256(&serde_json::to_vec(
            &json!({"binding":binding,"uri":uri,"sha256":sha256}),
        )?);
        let _lock = self
            .directory
            .exclusive_lock_within(OsStr::new("resources.lock"), SHORT_LOCK_WAIT)?
            .context("mcp_app_resource_busy")?;
        let mut rows = self.rows()?;
        let now = unix_timestamp_ms();
        rows.sort_by_key(|row| row.last_access_ms.max(row.created_at_ms));
        for row in &rows {
            if now.saturating_sub(row.last_access_ms.max(row.created_at_ms)) > IDLE_TTL_MS {
                self.remove(row)?;
            }
        }
        rows.retain(|row| {
            now.saturating_sub(row.last_access_ms.max(row.created_at_ms)) <= IDLE_TTL_MS
        });
        // A crash between the body and metadata publication may leave an owned
        // cache body. With the writer lock held, no unpublished body is in use.
        let published = rows
            .iter()
            .map(|row| format!("r-{}.data", row.reference.resource_id))
            .collect::<HashSet<_>>();
        let mut orphans = Vec::new();
        self.directory.visit_regular_files(
            |name| {
                name.to_string_lossy().starts_with("r-")
                    && name.to_string_lossy().ends_with(".data")
            },
            |name, _| {
                let name = name
                    .to_str()
                    .context("invalid MCP resource body filename")?;
                check_id(&name[2..name.len() - 5])?;
                if !published.contains(name) {
                    ensure!(
                        orphans.len() < RECORD_LIMIT,
                        "MCP resource orphan cache exceeds cleanup budget"
                    );
                    orphans.push(name.to_owned());
                }
                Ok(())
            },
        )?;
        for name in orphans {
            self.directory.remove_regular_file(OsStr::new(&name))?;
        }
        if let Some(row) = rows.iter_mut().find(|row| row.reference.resource_id == id) {
            self.verify_body(&row.reference)?;
            row.last_access_ms = now;
            self.write_record(row)?;
            return Ok(row.reference.clone());
        }
        let mut total = 0u64;
        self.directory.visit_regular_files(
            |name| name.to_string_lossy().ends_with(".data"),
            |_, file| {
                total = total.saturating_add(file.metadata()?.len());
                Ok(())
            },
        )?;
        while (rows.len() >= RECORD_LIMIT || total.saturating_add(body.len() as u64) > CACHE_LIMIT)
            && rows.first().is_some_and(|row| {
                now.saturating_sub(row.last_access_ms.max(row.created_at_ms)) >= MIN_RETENTION_MS
            })
        {
            let removed = rows.remove(0);
            self.remove(&removed)?;
            total = total.saturating_sub(removed.reference.bytes);
        }
        ensure!(
            rows.len() < RECORD_LIMIT && total.saturating_add(body.len() as u64) <= CACHE_LIMIT,
            "mcp_app_resource_quota: bounded resource cache is full"
        );
        let reference = McpAppResourceRef {
            resource_id: id.clone(),
            sha256,
            bytes: body.len() as u64,
            uri,
            content_count: contents.len() as u64,
            mime_type: contents
                .first()
                .and_then(|value| value.get("mimeType"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            encoding: "json".into(),
        };
        // Publish the immutable metadata only after all result bytes are durable.
        self.directory
            .atomic_replace(OsStr::new(&format!("r-{id}.data")), &body)?;
        self.directory.atomic_replace(
            OsStr::new(&format!("r-{id}.json")),
            &serde_json::to_vec(&Record {
                version: 1,
                binding,
                reference: reference.clone(),
                created_at_ms: now,
                last_access_ms: now,
            })?,
        )?;
        Ok(reference)
    }
    pub fn reference(
        &self,
        binding: &McpAppReadParams,
        id: &str,
        sha: &str,
    ) -> Result<McpAppResourceRef> {
        check_id(id)?;
        let row = self.read_record(id)?;
        ensure!(
            same_binding(&row.binding, binding) && row.reference.sha256 == sha,
            "MCP resource reference belongs to another view or revision"
        );
        Ok(row.reference)
    }
    pub fn chunk(
        &self,
        binding: &McpAppReadParams,
        id: &str,
        sha: &str,
        offset: u64,
    ) -> Result<McpAppResourceContentReadResult> {
        check_id(id)?;
        let _lock = self
            .directory
            .exclusive_lock_within(OsStr::new("resources.lock"), SHORT_LOCK_WAIT)?
            .context("mcp_app_resource_busy")?;
        let mut row = self.read_record(id)?;
        ensure!(
            same_binding(&row.binding, binding) && row.reference.sha256 == sha,
            "MCP resource reference belongs to another view or revision"
        );
        let bytes = self.verify_body(&row.reference)?;
        row.last_access_ms = unix_timestamp_ms();
        self.write_record(&row)?;
        ensure!(
            offset <= bytes.len() as u64,
            "MCP resource chunk offset exceeds result bytes"
        );
        let end = (offset as usize).saturating_add(CHUNK).min(bytes.len());
        Ok(McpAppResourceContentReadResult {
            resource_id: id.into(),
            sha256: sha.into(),
            bytes: bytes.len() as u64,
            offset,
            next_offset: end as u64,
            data_base64: base64::engine::general_purpose::STANDARD
                .encode(&bytes[offset as usize..end]),
        })
    }
    /// Only disposable resource cache entries are released. Business receipts and
    /// retained UI artifacts have independent durable lifetimes.
    pub fn release_connection(&self, connection: &str) -> Result<()> {
        let _lock = self
            .directory
            .exclusive_lock_within(OsStr::new("resources.lock"), SHORT_LOCK_WAIT)?
            .context("mcp_app_resource_busy")?;
        for row in self
            .rows()?
            .iter()
            .filter(|row| row.binding.connection_id == connection)
        {
            self.remove(row)?;
        }
        Ok(())
    }
    fn write_record(&self, row: &Record) -> Result<()> {
        check_id(&row.reference.resource_id)?;
        self.directory.atomic_replace(
            OsStr::new(&format!("r-{}.json", row.reference.resource_id)),
            &serde_json::to_vec(row)?,
        )
    }
    fn remove(&self, row: &Record) -> Result<()> {
        check_id(&row.reference.resource_id)?;
        // Unpublish metadata first, so a late chunk cannot observe missing bytes
        // as an authoritative resource. Owned cache bytes are safe to re-read.
        self.directory
            .remove_regular_file(OsStr::new(&format!("r-{}.json", row.reference.resource_id)))?;
        self.directory
            .remove_regular_file(OsStr::new(&format!("r-{}.data", row.reference.resource_id)))
    }
    fn verify_body(&self, reference: &McpAppResourceRef) -> Result<Vec<u8>> {
        check_id(&reference.resource_id)?;
        let mut body = Vec::new();
        self.directory
            .open_regular_file(OsStr::new(&format!("r-{}.data", reference.resource_id)))?
            .take(CONTENT_LIMIT as u64 + 1)
            .read_to_end(&mut body)?;
        ensure!(
            body.len() <= CONTENT_LIMIT
                && body.len() as u64 == reference.bytes
                && hex_sha256(&body) == reference.sha256,
            "MCP resource bytes failed integrity verification"
        );
        Ok(body)
    }
    fn read_record(&self, id: &str) -> Result<Record> {
        check_id(id)?;
        let mut bytes = Vec::new();
        self.directory
            .open_regular_file(OsStr::new(&format!("r-{id}.json")))?
            .take(8193)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 8192, "MCP resource metadata exceeds budget");
        let row: Record = serde_json::from_slice(&bytes)?;
        ensure!(
            row.version == 1 && row.reference.resource_id == id && row.reference.encoding == "json",
            "invalid MCP resource record"
        );
        Ok(row)
    }
    fn rows(&self) -> Result<Vec<Record>> {
        let mut rows = Vec::new();
        self.directory.visit_regular_files(
            |name| {
                name.to_string_lossy().starts_with("r-")
                    && name.to_string_lossy().ends_with(".json")
            },
            |name, file| {
                ensure!(
                    rows.len() < RECORD_LIMIT,
                    "MCP resource cache metadata exceeds count budget"
                );
                let name = name.to_str().context("invalid resource record filename")?;
                let id = &name[2..name.len() - 5];
                check_id(id)?;
                let mut bytes = Vec::new();
                file.take(8193).read_to_end(&mut bytes)?;
                ensure!(bytes.len() <= 8192, "MCP resource metadata exceeds budget");
                let row: Record = serde_json::from_slice(&bytes)?;
                ensure!(
                    row.version == 1 && row.reference.resource_id == id,
                    "invalid MCP resource record"
                );
                rows.push(row);
                Ok(())
            },
        )?;
        Ok(rows)
    }
}
fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn check_id(id: &str) -> Result<()> {
    ensure!(
        id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid MCP resource identity"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> McpAppReadParams {
        McpAppReadParams {
            thread_id: "thread".into(),
            widget_id: "widget".into(),
            revision: 1,
            connection_id: "connection".into(),
        }
    }
    #[test]
    fn bounded_resource_chunks_preserve_full_core_result_and_reject_tampering() {
        let temp = tempfile::tempdir().unwrap();
        let store = ResourceStore::open(temp.path()).unwrap();
        let bound = binding();
        let value = json!({"contents":[{"uri":"fixture://source/report","mimeType":"text/plain","text":"x".repeat(CHUNK+19),"_meta":{"revision":4}}]});
        let reference = store
            .commit(
                bound.clone(),
                "fixture://source/report".into(),
                value.clone(),
            )
            .unwrap();
        let mut bytes = Vec::new();
        let mut offset = 0;
        while offset < reference.bytes {
            let chunk = store
                .chunk(&bound, &reference.resource_id, &reference.sha256, offset)
                .unwrap();
            bytes.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(chunk.data_base64)
                    .unwrap(),
            );
            offset = chunk.next_offset;
        }
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), value);
        let mut peer = bound.clone();
        peer.connection_id = "peer".into();
        assert!(
            store
                .chunk(&peer, &reference.resource_id, &reference.sha256, 0)
                .is_err()
        );
        assert!(
            store
                .chunk(&bound, "../escape", &reference.sha256, 0)
                .is_err()
        );
        assert!(
            store
                .chunk(
                    &bound,
                    &reference.resource_id,
                    &reference.sha256,
                    reference.bytes + 1
                )
                .is_err()
        );
        std::fs::write(
            temp.path()
                .join("mcp-app-resources")
                .join(format!("r-{}.data", reference.resource_id)),
            b"tampered",
        )
        .unwrap();
        assert!(
            store
                .chunk(&bound, &reference.resource_id, &reference.sha256, 0)
                .is_err()
        );
    }
    #[test]
    fn oversize_resource_is_rejected_before_publication() {
        let temp = tempfile::tempdir().unwrap();
        let store = ResourceStore::open(temp.path()).unwrap();
        assert!(store.commit(binding(),"fixture://source/report".into(),json!({"contents":[{"uri":"fixture://source/report","text":"x".repeat(CONTENT_LIMIT)}]})).is_err());
        assert!(store.rows().unwrap().is_empty());
    }
    #[test]
    fn idle_and_pressure_eviction_release_only_disposable_owner_cache() {
        let temp = tempfile::tempdir().unwrap();
        let store = ResourceStore::open(temp.path()).unwrap();
        let bound = binding();
        let mut first = None;
        for index in 0..RECORD_LIMIT {
            let reference=store.commit(bound.clone(),format!("fixture://source/{index}"),json!({"contents":[{"uri":format!("fixture://source/{index}"),"text":"cache"}]})).unwrap();
            let mut row = store.read_record(&reference.resource_id).unwrap();
            row.created_at_ms = 1;
            row.last_access_ms = unix_timestamp_ms().saturating_sub(MIN_RETENTION_MS + 1000);
            store.write_record(&row).unwrap();
            if first.is_none() {
                first = Some(reference);
            }
        }
        let reference = store
            .commit(
                bound.clone(),
                "fixture://new".into(),
                json!({"contents":[{"uri":"fixture://new","text":"new"}]}),
            )
            .unwrap();
        assert_eq!(store.rows().unwrap().len(), RECORD_LIMIT);
        let first = first.unwrap();
        assert!(
            store
                .chunk(&bound, &first.resource_id, &first.sha256, 0)
                .is_err()
        );
        let mut expired = store.read_record(&reference.resource_id).unwrap();
        expired.created_at_ms = 1;
        expired.last_access_ms = 1;
        store.write_record(&expired).unwrap();
        store
            .commit(
                bound.clone(),
                "fixture://after-expiry".into(),
                json!({"contents":[]}),
            )
            .unwrap();
        assert!(
            store
                .chunk(&bound, &reference.resource_id, &reference.sha256, 0)
                .is_err()
        );
        let mut peer = bound.clone();
        peer.connection_id = "peer".into();
        let kept = store
            .commit(
                peer.clone(),
                "fixture://peer".into(),
                json!({"contents":[]}),
            )
            .unwrap();
        store.release_connection(&bound.connection_id).unwrap();
        assert_eq!(store.rows().unwrap().len(), 1);
        assert!(
            store
                .chunk(&peer, &kept.resource_id, &kept.sha256, 0)
                .is_ok()
        );
    }
}
