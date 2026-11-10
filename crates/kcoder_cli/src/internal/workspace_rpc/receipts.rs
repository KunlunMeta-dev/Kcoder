//! Scoped, bounded workspace receipts. V1 storage is never consulted.
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_app_protocol::*;
use kcoder_attachment_retention::retention_context::VerifiedRetentionAuthority;
use kcoder_attachment_retention::workspace_receipt_request::validate_digest;
use kcoder_config::PrivateDirectory;
use kcoder_state::AppState;
use kcoder_workspace_resources::managed_worktrees::{
    ClientWorkspaceStore, ClientWorktreeStore, worktree_request,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsStr, io::Read};

const MAX_RECEIPTS: usize = 4096;

#[derive(Debug)]
struct IdentityConflict;
impl std::fmt::Display for IdentityConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Workspace receipt scope or identity conflict")
    }
}
impl std::error::Error for IdentityConflict {}

#[derive(Debug)]
struct CapacityReached;
impl std::fmt::Display for CapacityReached {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Workspace receipt capacity reached; existing IDs remain reserved")
    }
}
impl std::error::Error for CapacityReached {}

pub fn error_code(error: &anyhow::Error) -> i64 {
    if error.downcast_ref::<CapacityReached>().is_some() {
        -32032
    } else if error.downcast_ref::<IdentityConflict>().is_some() {
        -32001
    } else {
        -32031
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    scope: WorkspaceOperationScopeV2,
    request_id: String,
    method: String,
    params_hash: String,
    result: Option<Value>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Quota {
    version: u8,
    reserved: usize,
}
fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn leaf(id: &str) -> String {
    format!("{}.json", hex_sha256(id.as_bytes()))
}
fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}
fn bytes(handle: &PrivateDirectory, name: &str) -> Result<Option<Vec<u8>>> {
    let file = match handle.open_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(65537).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "Workspace receipt exceeds limit");
    Ok(Some(bytes))
}
fn read(
    handle: &PrivateDirectory,
    scope: &WorkspaceOperationScopeV2,
    id: &str,
) -> Result<Option<Record>> {
    let Some(bytes) = bytes(handle, &leaf(id))? else {
        return Ok(None);
    };
    let record: Record = serde_json::from_slice(&bytes)?;
    if record.version != 2 || record.scope != *scope || record.request_id != id {
        return Err(IdentityConflict.into());
    }
    ensure!(
        matches!(
            record.method.as_str(),
            METHOD_WORKSPACE_OPEN_V2 | METHOD_WORKSPACE_PREPARE_V2 | METHOD_WORKTREE_PREPARE_V2
        ),
        "Invalid receipt method"
    );
    validate_digest(&record.params_hash)?;
    if let Some(result) = &record.result {
        ensure!(result_path(result).is_some(), "Invalid receipt result");
    }
    Ok(Some(record))
}
fn write(handle: &PrivateDirectory, record: &Record) -> Result<()> {
    let data = serde_json::to_vec(record)?;
    ensure!(data.len() <= 65536, "Workspace receipt exceeds limit");
    handle.atomic_replace(OsStr::new(&leaf(&record.request_id)), &data)
}
fn lock(handle: &PrivateDirectory) -> Result<std::fs::File> {
    handle.append(OsStr::new("operations.lock"), b"")?;
    let lock = handle.open_regular_file(OsStr::new("operations.lock"))?;
    lock.lock_exclusive()?;
    Ok(lock)
}
fn reserve_quota(handle: &PrivateDirectory, max: usize) -> Result<()> {
    // Crashed atomic-write temporaries are never deleted without proof. Count
    // every leaf before accepting a new ID so even those bytes remain bounded.
    let leaf_limit = max * 2 + 8;
    if handle.count_regular_files_bounded(|_| true, leaf_limit)? >= leaf_limit {
        return Err(CapacityReached.into());
    }
    let prior = match bytes(handle, "quota")? {
        Some(bytes) => {
            let value: Quota = serde_json::from_slice(&bytes)?;
            ensure!(
                value.version == 2 && value.reserved <= max,
                "Invalid receipt quota"
            );
            value.reserved
        }
        None => handle.count_regular_files_bounded(
            |name| {
                name.to_str()
                    .is_some_and(|s| s.len() == 69 && s.ends_with(".json"))
            },
            max,
        )?,
    };
    if prior >= max {
        return Err(CapacityReached.into());
    }
    handle.atomic_replace(
        OsStr::new("quota"),
        &serde_json::to_vec(&Quota {
            version: 2,
            reserved: prior + 1,
        })?,
    )
}
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => serde_json::to_value(
            map.iter()
                .map(|(k, v)| (k.clone(), canonical(v)))
                .collect::<BTreeMap<_, _>>(),
        )
        .expect("JSON serializes"),
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        value => value.clone(),
    }
}
fn result_path(result: &Value) -> Option<&str> {
    result
        .get("workspacePath")
        .or_else(|| result.get("path"))
        .or_else(|| result.get("mapping")?.get("workspacePath"))?
        .as_str()
        .filter(|p| !p.trim().is_empty() && p.len() <= 4096)
}
fn registered(
    workspace_store: &ClientWorkspaceStore,
    worktree_store: &ClientWorktreeStore,
    record: &Record,
) -> Result<bool> {
    let Some(path) = record.result.as_ref().and_then(result_path) else {
        return Ok(false);
    };
    if record.method == METHOD_WORKTREE_PREPARE_V2 {
        Ok(worktree_store
            .load()?
            .records
            .get(path)
            .is_some_and(|r| r.state == "active"))
    } else {
        Ok(workspace_store.load().records.contains_key(path))
    }
}
fn projection(record: &Record, ready: bool) -> WorkspaceOperationReceiptV2 {
    WorkspaceOperationReceiptV2 {
        client_request_id: record.request_id.clone(),
        method: record.method.clone(),
        params_digest: record.params_hash.clone(),
        status: if ready {
            WorkspaceOperationStatus::Ready
        } else {
            WorkspaceOperationStatus::Unknown
        },
        workspace_path: if ready {
            record
                .result
                .as_ref()
                .and_then(result_path)
                .map(str::to_owned)
        } else {
            None
        },
    }
}

pub async fn dispatch(
    authority: &VerifiedRetentionAuthority,
    workspace: &AppState,
    workspace_store: &ClientWorkspaceStore,
    worktree_store: &ClientWorktreeStore,
    request: &PrivateRetentionRequestV1,
) -> Result<Value> {
    dispatch_with_budget(
        authority,
        workspace,
        workspace_store,
        worktree_store,
        request,
        MAX_RECEIPTS,
    )
    .await
}

#[cfg(any(test, feature = "test-oracle"))]
pub async fn dispatch_with_receipt_limit(
    authority: &VerifiedRetentionAuthority,
    workspace: &AppState,
    workspace_store: &ClientWorkspaceStore,
    worktree_store: &ClientWorktreeStore,
    request: &PrivateRetentionRequestV1,
    limit: usize,
) -> Result<Value> {
    ensure!(
        limit > 0 && limit <= MAX_RECEIPTS,
        "Invalid test receipt limit"
    );
    dispatch_with_budget(
        authority,
        workspace,
        workspace_store,
        worktree_store,
        request,
        limit,
    )
    .await
}

async fn dispatch_with_budget(
    authority: &VerifiedRetentionAuthority,
    workspace: &AppState,
    workspace_store: &ClientWorkspaceStore,
    worktree_store: &ClientWorktreeStore,
    request: &PrivateRetentionRequestV1,
    limit: usize,
) -> Result<Value> {
    let scope = authority.workspace_scope(request)?;
    if request.method == METHOD_WORKSPACE_OPERATION_SCOPE_V2 {
        return Ok(serde_json::to_value(scope)?);
    }
    let expected = request.params["scopeId"]
        .as_str()
        .context("Missing scope fence")?;
    if expected != scope.scope_id {
        return Err(IdentityConflict.into());
    }
    let id = request.params["clientRequestId"]
        .as_str()
        .context("Missing operation identity")?;
    if request.method == METHOD_WORKSPACE_OPERATION_READ_V2 {
        let handle = match authority.workspace_receipts_directory(false) {
            Ok(handle) => Some(handle),
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
        let record = match handle {
            Some(handle) => {
                let _lock = lock(&handle)?;
                // Repair a prior visible rename whose directory fsync failed
                // before reporting that receipt as durable readiness.
                handle.sync()?;
                read(&handle, &scope, id)?
            }
            None => None,
        };
        let receipt = record
            .as_ref()
            .map(|r| {
                registered(workspace_store, worktree_store, r).map(|ready| projection(r, ready))
            })
            .transpose()?;
        return Ok(serde_json::to_value(WorkspaceOperationReadResultV2 {
            scope,
            receipt,
        })?);
    }
    let params_hash = hex_sha256(&serde_json::to_vec(&(
        &request.method,
        canonical(&request.params),
    ))?);
    let handle = authority.workspace_receipts_directory(true)?;
    let mut record = {
        let _lock = lock(&handle)?;
        handle.sync()?;
        if let Some(record) = read(&handle, &scope, id)? {
            if record.method != request.method || record.params_hash != params_hash {
                return Err(IdentityConflict.into());
            }
            ensure!(
                record.result.is_some() && registered(workspace_store, worktree_store, &record)?,
                "Workspace completion is unknown; never replay this identity"
            );
            return Ok(serde_json::to_value(WorkspaceOperationMutationResultV2 {
                scope,
                receipt: projection(&record, true),
                result: record
                    .result
                    .clone()
                    .context("Missing completed workspace result")?,
            })?);
        }
        reserve_quota(&handle, limit)?;
        let record = Record {
            version: 2,
            scope: scope.clone(),
            request_id: id.into(),
            method: request.method.clone(),
            params_hash,
            result: None,
        };
        write(&handle, &record)?;
        record
    };
    let mut params = request.params.clone();
    let object = params
        .as_object_mut()
        .context("Invalid mutation parameters")?;
    object.remove("scopeId");
    object.remove("clientRequestId");
    object.insert(
        "deviceId".into(),
        request
            .private_retention
            .workspace_target_id
            .clone()
            .context("Missing trusted target")?
            .into(),
    );
    let result = match request.method.as_str() {
        METHOD_WORKSPACE_OPEN_V2 => {
            crate::workspace_request_without_receipt(
                workspace_store,
                workspace,
                "runtime.workspaces.open",
                &params,
            )
            .await?
        }
        METHOD_WORKSPACE_PREPARE_V2 => {
            crate::workspace_request_without_receipt(
                workspace_store,
                workspace,
                "runtime.workspaces.prepare",
                &params,
            )
            .await?
        }
        METHOD_WORKTREE_PREPARE_V2 => {
            worktree_request(
                worktree_store,
                workspace_store,
                &workspace.cwd(),
                "runtime.worktrees.prepare",
                &params,
            )
            .await?
        }
        _ => anyhow::bail!("Invalid workspace mutation"),
    };
    ensure!(
        result_path(&result).is_some()
            && (request.method != METHOD_WORKTREE_PREPARE_V2 || result["success"] == true),
        "Workspace completion is unknown"
    );
    // Revalidate held roots before a late completion can publish readiness.
    authority.workspace_scope(request)?;
    let _lock = lock(&handle)?;
    let current = read(&handle, &scope, id)?.context("Missing reserved workspace receipt")?;
    ensure!(
        current.method == record.method
            && current.params_hash == record.params_hash
            && current.result.is_none(),
        "Workspace receipt cannot be replaced"
    );
    record.result = Some(result.clone());
    write(&handle, &record)?;
    Ok(serde_json::to_value(WorkspaceOperationMutationResultV2 {
        scope,
        receipt: projection(&record, true),
        result,
    })?)
}
