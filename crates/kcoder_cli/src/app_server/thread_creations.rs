//! Durable creation reservations: uncertainty never authorizes another startup lifecycle.
use crate::thread_history::thread_history_path;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_app_protocol::{Thread, ThreadStartParams};
use kcoder_cli_storage::private_files::hex_sha256;
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_workspace_resources::managed_worktrees::validate_thread_id;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{ffi::OsStr, io::Read};

#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    version: u8,
    workspace: String,
    request_id: String,
    params_hash: String,
    pub thread_id: String,
    pub thread: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    initial_creation_sha256: Option<String>,
}
fn check_id(id: &str) -> Result<()> {
    ensure!(
        !id.trim().is_empty() && id.len() <= 1024,
        "invalid thread creation identity"
    );
    Ok(())
}
fn directory(engine: &QueryEngine) -> Result<(std::path::PathBuf, String)> {
    let workspace = kcoder_thread_metadata::canonical_workspace(&engine.state.cwd())?;
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
    ensure!(
        record
            .initial_creation_sha256
            .as_ref()
            .is_none_or(|sha| sha.len() == 64
                && sha
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
        "invalid original creation history digest"
    );
    Ok(Some(record))
}
pub fn lookup(engine: &QueryEngine, id: &str) -> Result<Option<Record>> {
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
pub fn reserve(engine: &QueryEngine, params: &ThreadStartParams, thread_id: &str) -> Result<bool> {
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
            initial_creation_sha256: None,
        },
    )?;
    Ok(true)
}
pub fn complete(engine: &QueryEngine, id: &str, thread: Value) -> Result<()> {
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
        let history = thread_history_path(engine, &record.thread_id)?;
        record.initial_creation_sha256 =
            kcoder_state::prepare_session_resume(&history)?.initial_creation_history_digest()?;
        record.thread = Some(thread);
        write(&handle, &record)?;
    }
    Ok(())
}
pub fn query(engine: &QueryEngine, id: &str) -> Result<Value> {
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

pub fn replay(engine: &QueryEngine, params: &ThreadStartParams) -> Result<Option<Value>> {
    let Some(record) = exact_original(engine, params)? else {
        return Ok(None);
    };
    let result = query(engine, &record.request_id)?;
    ensure!(
        result["receipt"]["status"] == "ready",
        "Thread creation was reserved but completion is unknown; inspect its receipt instead of creating it again"
    );
    Ok(Some(json!({"thread": result["receipt"]["thread"]})))
}

fn exact_original(engine: &QueryEngine, params: &ThreadStartParams) -> Result<Option<Record>> {
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
    Ok(Some(record))
}

/// Native successor handoff consumes the original reservation and completion,
/// never a thread-shaped reply supplied by an SDK or public client.
#[cfg_attr(not(test), allow(dead_code))]
pub fn completed_original(
    engine: &QueryEngine,
    params: &ThreadStartParams,
) -> Result<(Thread, String, Option<String>)> {
    ensure!(
        params.client_request_id.is_some(),
        "CHAT_TASK_NEW_CREATION_ID_REQUIRED"
    );
    let record = exact_original(engine, params)?.context("CHAT_TASK_NEW_CREATION_NOT_OBSERVED")?;
    let thread: Thread = serde_json::from_value(
        record
            .thread
            .clone()
            .context("CHAT_TASK_NEW_CREATION_UNCONFIRMED")?,
    )?;
    ensure!(
        thread.id == record.thread_id && thread_history_path(engine, &thread.id).is_ok(),
        "CHAT_TASK_NEW_CREATION_UNCONFIRMED"
    );
    let sha256 = hex_sha256(&serde_json::to_vec(&record)?);
    Ok((thread, sha256, record.initial_creation_sha256))
}
