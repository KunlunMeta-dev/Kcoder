//! Durable authority for UI operations. A missing reply never permits replay.
use super::hex_sha256;
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{
    McpAppOperationStatus as Status, McpAppReadParams, McpAppToolCallResult,
};
use kcoder_fs::PrivateDirectory;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::{ffi::OsStr, io::Read};

const LIMIT: usize = 256;
/// Upper bound on waiting for a transient holder of the store lock.
pub(super) const SHORT_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(1);
const RESULT_BYTES: usize = 768 * 1024;
const TOTAL_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    binding: McpAppReadParams,
    request_sha256: String,
    receipt: McpAppToolCallResult,
}
pub struct OperationStore {
    directory: PrivateDirectory,
}
impl OperationStore {
    pub fn open(session: &Path) -> Result<Self> {
        Ok(Self {
            directory: PrivateDirectory::open_or_create(&session.join("mcp-app-operations"))?,
        })
    }
    /// Take the store's lease for one short critical section (see
    /// `PrivateDirectory::exclusive_lock_within`).
    fn lock(&self) -> Result<std::fs::File> {
        self.directory
            .exclusive_lock_within(OsStr::new("operations.lock"), SHORT_LOCK_WAIT)?
            .context("mcp_app_operation_busy")
    }

    pub fn prepare(
        &self,
        binding: &McpAppReadParams,
        operation: &str,
        digest: &str,
    ) -> Result<Option<McpAppToolCallResult>> {
        check_operation(operation)?;
        let _lock = self.lock()?;
        if let Some(row) = self.read_record(operation)? {
            ensure!(
                same_binding(&row.binding, binding) && row.request_sha256 == digest,
                "mcp_app_operation_conflict: operation identity already names another request"
            );
            return Ok(Some(row.receipt));
        }
        let mut count = 0;
        let mut total = 0u64;
        self.directory.visit_regular_files(|name|name.to_string_lossy().starts_with("o-")&&name.to_string_lossy().ends_with(".json"),|_,file|{
            count+=1; total=total.saturating_add(file.metadata()?.len());
            ensure!(count<=LIMIT && total<=TOTAL_BYTES,"mcp_app_operation_quota");
            let mut bytes=Vec::new();file.take(RESULT_BYTES as u64+8193).read_to_end(&mut bytes)?;
            ensure!(bytes.len()<=RESULT_BYTES+8192,"invalid MCP operation record size");
            let row:Record=serde_json::from_slice(&bytes)?;
            validate_record(&row)?;
            // An unfinished operation remains an unresolved side effect even after a
            // connection reconnects. Only an authoritative terminal receipt clears it.
            ensure!(!matches!(row.receipt.status,Status::Prepared|Status::Executing|Status::OutcomeUnknown),"mcp_app_operation_unresolved: reconcile the previous operation before starting another");
            Ok(())
        })?;
        ensure!(
            count < LIMIT && total < TOTAL_BYTES,
            "mcp_app_operation_quota"
        );
        self.write(&Record {
            version: 1,
            binding: binding.clone(),
            request_sha256: digest.into(),
            receipt: McpAppToolCallResult {
                operation_id: operation.into(),
                status: Status::Prepared,
                result: None,
                error_code: None,
                result_sha256: None,
            },
        })?;
        Ok(None)
    }
    pub fn read(
        &self,
        binding: &McpAppReadParams,
        operation: &str,
    ) -> Result<McpAppToolCallResult> {
        check_operation(operation)?;
        let row = self
            .read_record(operation)?
            .context("mcp_app_operation_not_found")?;
        ensure!(
            same_binding(&row.binding, binding),
            "MCP operation belongs to another view or revision"
        );
        Ok(row.receipt)
    }
    pub fn transition(
        &self,
        binding: &McpAppReadParams,
        operation: &str,
        status: Status,
        result: Option<Value>,
        code: Option<&str>,
    ) -> Result<McpAppToolCallResult> {
        let _lock = self.lock()?;
        let mut row = self
            .read_record(operation)?
            .context("mcp_app_operation_not_found")?;
        ensure!(
            same_binding(&row.binding, binding),
            "MCP operation belongs to another view or revision"
        );
        if !matches!(row.receipt.status, Status::Prepared | Status::Executing) {
            return Ok(row.receipt);
        }
        ensure!(
            matches!(
                (row.receipt.status, status),
                (
                    Status::Prepared,
                    Status::Executing | Status::Denied | Status::NotSent
                ) | (
                    Status::Executing,
                    Status::Completed | Status::OutcomeUnknown
                )
            ),
            "invalid MCP operation transition"
        );
        let mut code = code.map(str::to_owned);
        let (result, sha) = if let Some(result) = result {
            let encoded = serde_json::to_vec(&result)?;
            if encoded.len() > RESULT_BYTES {
                code = Some("mcp_app_result_oversize".into());
                (None, Some(hex_sha256(&encoded)))
            } else {
                (Some(result), Some(hex_sha256(&encoded)))
            }
        } else {
            (None, None)
        };
        row.receipt = McpAppToolCallResult {
            operation_id: operation.into(),
            status,
            result,
            error_code: code,
            result_sha256: sha,
        };
        // A successful remote receipt remains authoritative even when its UI
        // payload cannot fit. Retain the outcome and hash without growing storage.
        if row.receipt.result.is_some() && !self.fits(&row)? {
            row.receipt.result = None;
            row.receipt.error_code = Some("mcp_app_result_quota".into());
        }
        self.write(&row)?;
        Ok(row.receipt)
    }
    fn read_record(&self, operation: &str) -> Result<Option<Record>> {
        check_operation(operation)?;
        let name = format!("o-{}.json", hex_sha256(operation.as_bytes()));
        let file = match self.directory.open_regular_file(OsStr::new(&name)) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(RESULT_BYTES as u64 + 8193)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= RESULT_BYTES + 8192,
            "invalid MCP operation record size"
        );
        let row: Record = serde_json::from_slice(&bytes)?;
        ensure!(
            row.version == 1 && row.receipt.operation_id == operation,
            "invalid MCP operation record"
        );
        validate_record(&row)?;
        Ok(Some(row))
    }
    fn fits(&self, row: &Record) -> Result<bool> {
        let name = format!("o-{}.json", hex_sha256(row.receipt.operation_id.as_bytes()));
        let mut total = serde_json::to_vec(row)?.len() as u64;
        self.directory.visit_regular_files(
            |entry| {
                entry != OsStr::new(&name)
                    && entry.to_string_lossy().starts_with("o-")
                    && entry.to_string_lossy().ends_with(".json")
            },
            |_, file| {
                total = total.saturating_add(file.metadata()?.len());
                Ok(())
            },
        )?;
        // Nonterminal rows reserve enough room for a fixed-size terminal receipt.
        let reserve = if matches!(row.receipt.status, Status::Prepared | Status::Executing) {
            8192
        } else {
            0
        };
        Ok(total.saturating_add(reserve) <= TOTAL_BYTES)
    }
    fn write(&self, row: &Record) -> Result<()> {
        validate_record(row)?;
        ensure!(self.fits(row)?, "mcp_app_operation_quota");
        let name = format!("o-{}.json", hex_sha256(row.receipt.operation_id.as_bytes()));
        self.directory
            .atomic_replace(OsStr::new(&name), &serde_json::to_vec(row)?)
    }
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn validate_record(row: &Record) -> Result<()> {
    ensure!(row.version == 1, "invalid MCP operation record version");
    check_operation(&row.receipt.operation_id)?;
    let receipt = &row.receipt;
    match receipt.status {
        Status::Prepared | Status::Executing => ensure!(
            receipt.result.is_none()
                && receipt.result_sha256.is_none()
                && receipt.error_code.is_none(),
            "invalid nonterminal MCP operation receipt"
        ),
        Status::Denied | Status::NotSent | Status::OutcomeUnknown => ensure!(
            receipt.result.is_none()
                && receipt.result_sha256.is_none()
                && receipt
                    .error_code
                    .as_ref()
                    .is_some_and(|code| code.starts_with("mcp_app_") && code.len() <= 128),
            "invalid terminal MCP operation receipt"
        ),
        Status::Completed => {
            let hash = receipt
                .result_sha256
                .as_deref()
                .context("completed MCP receipt is missing its result hash")?;
            ensure!(valid_hash(hash), "invalid MCP result hash");
            if let Some(result) = &receipt.result {
                let encoded = serde_json::to_vec(result)?;
                ensure!(
                    encoded.len() <= RESULT_BYTES && hex_sha256(&encoded) == hash,
                    "MCP operation result failed integrity verification"
                );
            } else {
                ensure!(
                    matches!(
                        receipt.error_code.as_deref(),
                        Some("mcp_app_result_oversize" | "mcp_app_result_quota")
                    ),
                    "completed MCP operation is missing its result"
                );
            }
        }
    }
    Ok(())
}
pub(super) fn same_binding(a: &McpAppReadParams, b: &McpAppReadParams) -> bool {
    a.thread_id == b.thread_id
        && a.widget_id == b.widget_id
        && a.revision == b.revision
        && a.connection_id == b.connection_id
}
pub fn check_operation(operation: &str) -> Result<()> {
    ensure!(
        !operation.is_empty()
            && operation.len() <= 128
            && operation
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "invalid MCP operation identity"
    );
    Ok(())
}

/// Synchronous drop reconciles even an aborted task before its owner releases data.
pub struct OperationGuard {
    pub session: PathBuf,
    pub binding: McpAppReadParams,
    pub operation: String,
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        let reconcile = || -> Result<()> {
            let store = OperationStore::open(&self.session)?;
            let row = store.read(&self.binding, &self.operation)?;
            match row.status {
                Status::Prepared => {
                    store.transition(
                        &self.binding,
                        &self.operation,
                        Status::NotSent,
                        None,
                        Some("mcp_app_cancelled_before_dispatch"),
                    )?;
                }
                Status::Executing => {
                    store.transition(
                        &self.binding,
                        &self.operation,
                        Status::OutcomeUnknown,
                        None,
                        Some("mcp_app_receipt_unavailable"),
                    )?;
                }
                _ => {}
            }
            Ok(())
        };
        if let Err(error) = reconcile() {
            tracing::warn!(%error,"MCP operation could not be reconciled; durable nonterminal status still forbids replay");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn binding() -> McpAppReadParams {
        McpAppReadParams {
            thread_id: "thread".into(),
            widget_id: "widget".into(),
            revision: 1,
            connection_id: "connection".into(),
        }
    }
    #[test]
    fn concurrent_subprocess_spawns_do_not_make_a_sequential_operation_busy() {
        // A child between fork and exec shares the lock file description, so
        // it briefly keeps the advisory lease after the store released it.
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let spawners: Vec<_> = (0..4)
            .map(|_| {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        let _ = std::process::Command::new("true").status();
                    }
                })
            })
            .collect();
        let temp = tempfile::tempdir().unwrap();
        let store = OperationStore::open(temp.path()).unwrap();
        let bound = binding();
        let outcome = (0..60).try_for_each(|index| {
            let operation = format!("op-{index}");
            store.prepare(&bound, &operation, "digest")?;
            store.transition(&bound, &operation, Status::Executing, None, None)?;
            store.transition(
                &bound,
                &operation,
                Status::Completed,
                Some(serde_json::json!({"content":[]})),
                None,
            )?;
            anyhow::Ok(())
        });
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        spawners
            .into_iter()
            .for_each(|spawner| spawner.join().unwrap());
        outcome.unwrap();
    }

    #[test]
    fn authoritative_receipt_deduplicates_and_rejects_conflicting_or_foreign_requests() {
        let temp = tempfile::tempdir().unwrap();
        let store = OperationStore::open(temp.path()).unwrap();
        let bound = binding();
        assert!(store.prepare(&bound, "op-1", "digest").unwrap().is_none());
        store
            .transition(&bound, "op-1", Status::Executing, None, None)
            .unwrap();
        let receipt = store
            .transition(
                &bound,
                "op-1",
                Status::Completed,
                Some(json!({"content":[]})),
                None,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(store.prepare(&bound, "op-1", "digest").unwrap().unwrap())
                .unwrap(),
            serde_json::to_value(receipt).unwrap()
        );
        assert!(store.prepare(&bound, "op-1", "changed").is_err());
        let mut peer = bound.clone();
        peer.thread_id = "peer".into();
        assert!(store.read(&peer, "op-1").is_err());
        assert!(
            store
                .transition(&bound, "op-1", Status::Executing, None, None)
                .unwrap()
                .status
                == Status::Completed
        );
    }
    #[test]
    fn lost_receipt_is_unknown_and_blocks_new_identity_replay() {
        let temp = tempfile::tempdir().unwrap();
        let store = OperationStore::open(temp.path()).unwrap();
        let bound = binding();
        store.prepare(&bound, "op-1", "digest").unwrap();
        store
            .transition(&bound, "op-1", Status::Executing, None, None)
            .unwrap();
        drop(OperationGuard {
            session: temp.path().into(),
            binding: bound.clone(),
            operation: "op-1".into(),
        });
        assert_eq!(
            store.read(&bound, "op-1").unwrap().status,
            Status::OutcomeUnknown
        );
        assert!(store.prepare(&bound, "op-2", "same-effect-new-id").is_err());
        assert_eq!(
            store
                .prepare(&bound, "op-1", "digest")
                .unwrap()
                .unwrap()
                .status,
            Status::OutcomeUnknown
        );
    }
    #[test]
    fn aborted_before_dispatch_is_not_sent_and_never_automatically_replayed() {
        let temp = tempfile::tempdir().unwrap();
        let store = OperationStore::open(temp.path()).unwrap();
        let bound = binding();
        store.prepare(&bound, "op-1", "digest").unwrap();
        drop(OperationGuard {
            session: temp.path().into(),
            binding: bound.clone(),
            operation: "op-1".into(),
        });
        assert_eq!(
            store
                .prepare(&bound, "op-1", "digest")
                .unwrap()
                .unwrap()
                .status,
            Status::NotSent
        );
        assert!(
            store
                .prepare(&bound, "op-2", "new-user-action")
                .unwrap()
                .is_none()
        );
        assert!(store.prepare(&bound, "../../escape", "digest").is_err());
    }
    #[test]
    fn corrupt_receipt_or_illegal_status_cannot_authorize_replay() {
        let temp = tempfile::tempdir().unwrap();
        let store = OperationStore::open(temp.path()).unwrap();
        let bound = binding();
        store.prepare(&bound, "op-1", "digest").unwrap();
        store
            .transition(&bound, "op-1", Status::Executing, None, None)
            .unwrap();
        store
            .transition(
                &bound,
                "op-1",
                Status::Completed,
                Some(json!({"content":[]})),
                None,
            )
            .unwrap();
        let path = temp
            .path()
            .join("mcp-app-operations")
            .join(format!("o-{}.json", hex_sha256(b"op-1")));
        let original = std::fs::read(&path).unwrap();
        let mut corrupt: Value = serde_json::from_slice(&original).unwrap();
        corrupt["receipt"]["result"] = json!({"tampered":true});
        std::fs::write(&path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
        assert!(store.read(&bound, "op-1").is_err());
        assert!(store.prepare(&bound, "op-2", "digest").is_err());
        let mut corrupt: Value = serde_json::from_slice(&original).unwrap();
        corrupt["receipt"]["status"] = json!("prepared");
        std::fs::write(path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
        assert!(store.read(&bound, "op-1").is_err());
    }
    #[test]
    fn oversized_and_quota_limited_results_keep_authoritative_outcomes_without_exceeding_total() {
        let temp = tempfile::tempdir().unwrap();
        let store = OperationStore::open(temp.path()).unwrap();
        let bound = binding();
        store.prepare(&bound, "large", "digest").unwrap();
        store
            .transition(&bound, "large", Status::Executing, None, None)
            .unwrap();
        let result = store
            .transition(
                &bound,
                "large",
                Status::Completed,
                Some(json!({"text":"x".repeat(RESULT_BYTES)})),
                None,
            )
            .unwrap();
        assert_eq!(result.status, Status::Completed);
        assert!(result.result.is_none());
        assert_eq!(
            result.error_code.as_deref(),
            Some("mcp_app_result_oversize")
        );
        assert!(store.read(&bound, "large").unwrap().result_sha256.is_some());
        let mut quota = false;
        for index in 0..24 {
            let id = format!("op-{index}");
            store.prepare(&bound, &id, "digest").unwrap();
            store
                .transition(&bound, &id, Status::Executing, None, None)
                .unwrap();
            let result = store
                .transition(
                    &bound,
                    &id,
                    Status::Completed,
                    Some(json!({"text":"x".repeat(RESULT_BYTES-256)})),
                    None,
                )
                .unwrap();
            if result.error_code.as_deref() == Some("mcp_app_result_quota") {
                quota = true;
                assert!(result.result.is_none());
                break;
            }
        }
        assert!(quota);
        let mut total = 0u64;
        store
            .directory
            .visit_regular_files(
                |name| name.to_string_lossy().ends_with(".json"),
                |_, file| {
                    total += file.metadata()?.len();
                    Ok(())
                },
            )
            .unwrap();
        assert!(total <= TOTAL_BYTES);
    }
}
