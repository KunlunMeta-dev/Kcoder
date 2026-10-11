//! A reservation is durable before any mkdir/registry mutation; uncertainty
//! never authorizes dispatching the same operation again.
use super::*;
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, io::Read};

#[derive(Serialize, Deserialize)]
struct Record {
    version: u8,
    workspace: String,
    request_id: String,
    method: String,
    params_hash: String,
    result: Option<Value>,
}
const MAX_WORKSPACE_OPERATION_RECEIPTS: usize = 4096;

fn canonical_params(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let ordered: std::collections::BTreeMap<_, _> = object
                .iter()
                .map(|(key, value)| (key.clone(), canonical_params(value)))
                .collect();
            serde_json::to_value(ordered).expect("JSON values serialize")
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical_params).collect()),
        other => other.clone(),
    }
}

fn reserve_quota(handle: &PrivateDirectory, workspace: &str) -> Result<()> {
    #[derive(Serialize, Deserialize)]
    struct Quota {
        version: u8,
        workspace: String,
        reserved: usize,
    }
    let prior = match handle.open_regular_file(OsStr::new("quota")) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(8193).read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 8192, "invalid workspace receipt quota");
            let value: Quota = serde_json::from_slice(&bytes)?;
            ensure!(
                value.version == 1
                    && value.workspace == workspace
                    && value.reserved <= MAX_WORKSPACE_OPERATION_RECEIPTS,
                "invalid workspace receipt quota"
            );
            value.reserved
        }
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            handle.count_regular_files_bounded(
                |name| {
                    name.to_str()
                        .is_some_and(|s| s.len() == 69 && s.ends_with(".json"))
                },
                MAX_WORKSPACE_OPERATION_RECEIPTS,
            )?
        }
        Err(error) => return Err(error),
    };
    ensure!(
        prior < MAX_WORKSPACE_OPERATION_RECEIPTS,
        "workspace receipt capacity reached; existing receipts remain readable and operations are not replayed"
    );
    // Reserve capacity before publishing an intent. A crash may conservatively
    // consume a slot, but cannot lose an unknown identity or exceed the budget.
    handle.atomic_replace(
        OsStr::new("quota"),
        &serde_json::to_vec(&Quota {
            version: 1,
            workspace: workspace.into(),
            reserved: prior + 1,
        })?,
    )
}

fn check_id(id: &str) -> Result<()> {
    ensure!(
        !id.trim().is_empty() && id.len() <= 128,
        "invalid workspace operation identity"
    );
    Ok(())
}
fn directory(engine: &QueryEngine) -> Result<(PathBuf, String)> {
    let workspace = canonical_workspace(engine)?;
    Ok((
        engine
            .client_storage_root()
            .join("workspace-operations")
            .join(hex_sha256(workspace.as_bytes())),
        workspace,
    ))
}
fn leaf(id: &str) -> String {
    format!("{}.json", hex_sha256(id.as_bytes()))
}
fn read(handle: &PrivateDirectory, workspace: &str, id: &str) -> Result<Option<Record>> {
    let file = match handle.open_regular_file(OsStr::new(&leaf(id))) {
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
    file.take(65537).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "workspace receipt exceeds limit");
    let record: Record = serde_json::from_slice(&bytes)?;
    ensure!(
        record.version == 1
            && record.workspace == workspace
            && record.request_id == id
            && matches!(
                record.method.as_str(),
                "runtime.workspaces.open" | "runtime.workspaces.prepare"
            ),
        "workspace receipt identity mismatch"
    );
    ensure!(
        record.params_hash.len() == 64 && record.params_hash.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid workspace receipt digest"
    );
    if let Some(result) = &record.result {
        ensure!(
            result_path(result).is_some(),
            "invalid workspace receipt result"
        );
    }
    Ok(Some(record))
}
fn result_path(result: &Value) -> Option<&str> {
    result
        .get("workspacePath")
        .or_else(|| result.get("mapping")?.get("workspacePath"))?
        .as_str()
        .filter(|p| !p.trim().is_empty() && p.len() <= 4096)
}
fn write(handle: &PrivateDirectory, record: &Record) -> Result<()> {
    let bytes = serde_json::to_vec(record)?;
    ensure!(bytes.len() <= 65536, "workspace receipt exceeds limit");
    handle.atomic_replace(OsStr::new(&leaf(&record.request_id)), &bytes)
}
pub(super) fn reserve(
    engine: &QueryEngine,
    id: &str,
    method: &str,
    params: &Value,
) -> Result<Option<Value>> {
    check_id(id)?;
    let (path, workspace) = directory(engine)?;
    let handle = PrivateDirectory::open_or_create(&path)?;
    handle.append(OsStr::new("operations.lock"), b"")?;
    let lock = handle.open_regular_file(OsStr::new("operations.lock"))?;
    lock.lock_exclusive()?;
    let params_hash = hex_sha256(&serde_json::to_vec(&(method, canonical_params(params)))?);
    if let Some(record) = read(&handle, &workspace, id)? {
        ensure!(
            record.params_hash == params_hash && record.method == method,
            "workspace operation identity reused with different parameters"
        );
        let result=record.result.context("Workspace operation was reserved but completion is unknown; inspect its receipt instead of repeating it")?;
        let path = result_path(&result).context("invalid workspace receipt path")?;
        ensure!(
            ClientWorkspaceStore::new(engine)
                .load()
                .records
                .contains_key(path),
            "workspace operation result is no longer registered; do not replay it"
        );
        return Ok(Some(result));
    }
    // All reservations, including unknown outcomes, occupy a slot permanently.
    // Expiring unknown IDs would authorize a duplicate mutation after restart.
    reserve_quota(&handle, &workspace)?;
    write(
        &handle,
        &Record {
            version: 1,
            workspace,
            request_id: id.into(),
            method: method.into(),
            params_hash,
            result: None,
        },
    )?;
    Ok(None)
}
pub(super) fn complete(engine: &QueryEngine, id: &str, result: &Value) -> Result<()> {
    ensure!(
        result_path(result).is_some(),
        "workspace operation result missing path"
    );
    let (path, workspace) = directory(engine)?;
    let handle = PrivateDirectory::open_existing(&path)?;
    handle.append(OsStr::new("operations.lock"), b"")?;
    let lock = handle.open_regular_file(OsStr::new("operations.lock"))?;
    lock.lock_exclusive()?;
    let mut record =
        read(&handle, &workspace, id)?.context("workspace operation was not reserved")?;
    if let Some(previous) = &record.result {
        ensure!(
            previous == result,
            "workspace receipt result cannot be replaced"
        );
    } else {
        record.result = Some(result.clone());
        write(&handle, &record)?;
    }
    Ok(())
}
pub(super) fn query(engine: &QueryEngine, id: &str) -> Result<Value> {
    check_id(id)?;
    let (path, workspace) = directory(engine)?;
    let handle = match PrivateDirectory::open_existing(&path) {
        Ok(handle) => handle,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(json!({"receipt":null}));
        }
        Err(error) => return Err(error),
    };
    let Some(record) = read(&handle, &workspace, id)? else {
        return Ok(json!({"receipt":null}));
    };
    let registered = record.result.as_ref().and_then(result_path).filter(|path| {
        ClientWorkspaceStore::new(engine)
            .load()
            .records
            .contains_key(*path)
    });
    Ok(serde_json::to_value(
        kcoder_app_protocol::WorkspaceOperationReadResult {
            receipt: Some(kcoder_app_protocol::WorkspaceOperationReceipt {
                client_request_id: id.into(),
                method: record.method.clone(),
                status: if registered.is_some() {
                    kcoder_app_protocol::WorkspaceOperationStatus::Ready
                } else {
                    kcoder_app_protocol::WorkspaceOperationStatus::Unknown
                },
                workspace_path: registered.map(str::to_owned),
            }),
        },
    )?)
}
