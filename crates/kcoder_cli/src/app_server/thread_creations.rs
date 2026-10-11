//! Durable creation reservations: uncertainty never authorizes another startup lifecycle.
use super::*;
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, io::Read};

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Record {
    version: u8,
    workspace: String,
    request_id: String,
    params_hash: String,
    pub thread_id: String,
    pub thread: Option<Value>,
}
fn check_id(id: &str) -> Result<()> {
    ensure!(
        !id.trim().is_empty() && id.len() <= 1024,
        "invalid thread creation identity"
    );
    Ok(())
}
fn directory(engine: &QueryEngine) -> Result<(std::path::PathBuf, String)> {
    let workspace = canonical_workspace(engine)?;
    let path = engine
        .client_storage_root()
        .join("thread-creations")
        .join(hex_sha256(workspace.as_bytes()));
    Ok((path, workspace))
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
    ensure!(
        bytes.len() <= 65536,
        "thread creation receipt exceeds limit"
    );
    let record: Record = serde_json::from_slice(&bytes)?;
    ensure!(
        record.version == 1 && record.workspace == workspace && record.request_id == id,
        "thread creation receipt identity mismatch"
    );
    validate_thread_id(&record.thread_id)?;
    ensure!(
        record.params_hash.len() == 64
            && record
                .params_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "invalid thread creation parameter digest"
    );
    if let Some(thread) = &record.thread {
        serde_json::from_value::<kcoder_app_protocol::Thread>(thread.clone())
            .context("invalid stored thread creation result")?;
        ensure!(
            thread["id"].as_str() == Some(record.thread_id.as_str()),
            "thread creation result mismatch"
        );
    }
    Ok(Some(record))
}
pub(super) fn lookup(engine: &QueryEngine, id: &str) -> Result<Option<Record>> {
    check_id(id)?;
    let (path, workspace) = directory(engine)?;
    let handle = match PrivateDirectory::open_existing(&path) {
        Ok(handle) => handle,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    read(&handle, &workspace, id)
}
fn write(handle: &PrivateDirectory, record: &Record) -> Result<()> {
    let bytes = serde_json::to_vec(record)?;
    ensure!(
        bytes.len() <= 65536,
        "thread creation receipt exceeds limit"
    );
    handle.atomic_replace(OsStr::new(&leaf(&record.request_id)), &bytes)
}
/// False means an earlier request owns creation, even if its completion is unknown.
pub(super) fn reserve(
    engine: &QueryEngine,
    params: &ThreadStartParams,
    thread_id: &str,
) -> Result<bool> {
    let Some(id) = params.client_request_id.as_deref() else {
        return Ok(true);
    };
    check_id(id)?;
    let (path, workspace) = directory(engine)?;
    let handle = PrivateDirectory::open_or_create(&path)?;
    handle.append(OsStr::new("creation.lock"), b"")?;
    let lock = handle.open_regular_file(OsStr::new("creation.lock"))?;
    lock.lock_exclusive()?;
    let params_hash = hex_sha256(&serde_json::to_vec(params)?);
    if let Some(record) = read(&handle, &workspace, id)? {
        ensure!(
            record.params_hash == params_hash,
            "thread creation identity reused with different parameters"
        );
        return Ok(false);
    }
    validate_thread_id(thread_id)?;
    write(
        &handle,
        &Record {
            version: 1,
            workspace,
            request_id: id.into(),
            params_hash,
            thread_id: thread_id.into(),
            thread: None,
        },
    )?;
    Ok(true)
}
pub(super) fn complete(engine: &QueryEngine, id: &str, thread: Value) -> Result<()> {
    let (path, workspace) = directory(engine)?;
    let handle = PrivateDirectory::open_existing(&path)?;
    handle.append(OsStr::new("creation.lock"), b"")?;
    let lock = handle.open_regular_file(OsStr::new("creation.lock"))?;
    lock.lock_exclusive()?;
    let mut record = read(&handle, &workspace, id)?.context("thread creation was not reserved")?;
    ensure!(
        thread["id"].as_str() == Some(record.thread_id.as_str()),
        "thread creation completion identity mismatch"
    );
    if let Some(previous) = &record.thread {
        ensure!(
            previous == &thread,
            "thread creation result cannot be replaced"
        );
    } else {
        record.thread = Some(thread);
        write(&handle, &record)?;
    }
    Ok(())
}
pub(super) fn query(engine: &QueryEngine, id: &str) -> Result<Value> {
    let Some(record) = lookup(engine, id)? else {
        return Ok(json!({"receipt": null}));
    };
    // A deleted thread never becomes permission to repeat its startup Hooks.
    let exists = thread_history_path(engine, &record.thread_id).is_ok();
    let status = if record.thread.is_some() && exists {
        "ready"
    } else {
        "unknown"
    };
    Ok(
        json!({"receipt": {"threadId": record.thread_id, "status": status,
        "thread": if status == "ready" { record.thread } else { None }}}),
    )
}

pub(super) fn replay(engine: &QueryEngine, params: &ThreadStartParams) -> Result<Option<Value>> {
    let Some(id) = params.client_request_id.as_deref() else {
        return Ok(None);
    };
    let Some(record) = lookup(engine, id)? else {
        return Ok(None);
    };
    ensure!(
        record.params_hash == hex_sha256(&serde_json::to_vec(params)?),
        "thread creation identity reused with different parameters"
    );
    let result = query(engine, id)?;
    ensure!(
        result["receipt"]["status"] == "ready",
        "Thread creation was reserved but completion is unknown; inspect its receipt instead of creating it again"
    );
    Ok(Some(json!({"thread": result["receipt"]["thread"]})))
}
