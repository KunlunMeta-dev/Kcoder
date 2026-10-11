//! Scoped, bounded workspace receipts. V1 storage is never consulted.
use super::*;
use kcoder_app_protocol::*;
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, io::Read};

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

pub(super) fn error_code(error: &anyhow::Error) -> i64 {
    if error.downcast_ref::<CapacityReached>().is_some() {
        -32032
    } else if error.downcast_ref::<IdentityConflict>().is_some() {
        -32001
    } else {
        -32031
    }
}

fn atom(value: &str, max: usize) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control),
        "Invalid workspace operation input"
    );
    Ok(())
}
fn digest(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid workspace scope"
    );
    Ok(())
}
fn path(value: &str) -> Result<()> {
    atom(value, 4096)?;
    ensure!(
        Path::new(value).is_absolute(),
        "Invalid workspace operation path"
    );
    Ok(())
}

/// Pure validation precedes root verification and all storage access.
pub(super) fn validate_request(request: &PrivateRetentionRequestV1) -> Result<Option<String>> {
    atom(
        request
            .private_retention
            .workspace_target_id
            .as_deref()
            .context("Missing trusted target")?,
        256,
    )?;
    match (
        &request.private_retention.context.principal,
        &request.private_retention.workspace_account,
    ) {
        (RetentionPrincipalV1::LocalOs, None) => {}
        (RetentionPrincipalV1::VerifiedAccount { .. }, Some(account)) => {
            atom(&account.role, 64)?;
            let generation = account.authorization_generation.parse::<u64>()?;
            ensure!(
                generation.to_string() == account.authorization_generation,
                "Invalid account generation"
            );
        }
        _ => anyhow::bail!("Invalid workspace parent account"),
    }
    let (id, expected) = match request.method.as_str() {
        METHOD_WORKSPACE_OPERATION_SCOPE_V2 => {
            let _: WorkspaceOperationScopeParamsV2 =
                serde_json::from_value(request.params.clone())?;
            return Ok(None);
        }
        METHOD_WORKSPACE_OPERATION_READ_V2 => {
            let input: WorkspaceOperationReadParamsV2 =
                serde_json::from_value(request.params.clone())?;
            (input.client_request_id, input.scope_id)
        }
        METHOD_WORKSPACE_OPEN_V2 | METHOD_WORKSPACE_PREPARE_V2 => {
            let input: WorkspaceOperationMutationParamsV2 =
                serde_json::from_value(request.params.clone())?;
            path(&input.workspace_path)?;
            for value in [&input.label, &input.name] {
                if let Some(value) = value {
                    atom(value, 256)?;
                }
            }
            if let Some(value) = &input.project_key {
                atom(value, 512)?;
            }
            if let Some(runtime) = &input.runtime {
                ensure!(
                    matches!(runtime.as_str(), "kcoder" | "codex"),
                    "Invalid runtime"
                );
            }
            (input.client_request_id, input.scope_id)
        }
        METHOD_WORKTREE_PREPARE_V2 => {
            let input: WorktreeOperationMutationParamsV2 =
                serde_json::from_value(request.params.clone())?;
            path(&input.source_path)?;
            validate_worktree_id(&input.worktree_id)?;
            if let Some(value) = &input.git_ref {
                atom(value, 512)?;
            }
            (input.client_request_id, input.scope_id)
        }
        _ => anyhow::bail!("Invalid workspace receipt method"),
    };
    atom(&id, 128)?;
    digest(&expected)?;
    Ok(Some(expected))
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
    digest(&record.params_hash)?;
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
fn registered(engine: &QueryEngine, record: &Record) -> Result<bool> {
    let Some(path) = record.result.as_ref().and_then(result_path) else {
        return Ok(false);
    };
    if record.method == METHOD_WORKTREE_PREPARE_V2 {
        Ok(ClientWorktreeStore::new(engine)
            .load()?
            .records
            .get(path)
            .is_some_and(|r| r.state == "active"))
    } else {
        Ok(ClientWorkspaceStore::new(engine)
            .load()
            .records
            .contains_key(path))
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

pub(super) async fn dispatch(
    authority: &retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    request: &PrivateRetentionRequestV1,
) -> Result<Value> {
    dispatch_with_budget(authority, engine, request, MAX_RECEIPTS).await
}

#[cfg(test)]
pub(super) async fn dispatch_with_receipt_limit(
    authority: &retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    request: &PrivateRetentionRequestV1,
    limit: usize,
) -> Result<Value> {
    ensure!(
        limit > 0 && limit <= MAX_RECEIPTS,
        "Invalid test receipt limit"
    );
    dispatch_with_budget(authority, engine, request, limit).await
}

async fn dispatch_with_budget(
    authority: &retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
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
            .map(|r| registered(engine, r).map(|ready| projection(r, ready)))
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
                record.result.is_some() && registered(engine, &record)?,
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
            workspace_requests::workspace_request_without_receipt(
                engine,
                "runtime.workspaces.open",
                &params,
            )
            .await?
        }
        METHOD_WORKSPACE_PREPARE_V2 => {
            workspace_requests::workspace_request_without_receipt(
                engine,
                "runtime.workspaces.prepare",
                &params,
            )
            .await?
        }
        METHOD_WORKTREE_PREPARE_V2 => {
            worktree_request(engine, "runtime.worktrees.prepare", &params).await?
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
