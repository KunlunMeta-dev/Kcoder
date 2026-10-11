use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{async_runtime::Mutex as AsyncMutex, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::process_environment;

const LOCAL_EXECUTOR_EVENT: &str = "local-executor:event";
const LOCAL_EXECUTOR_SIDECAR: &str = "wegent-executor";
const LOCAL_EXECUTOR_SIDECAR_ENV: &str = "KCODER_STUDIO_EXECUTOR_SIDECAR";
const LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV: &str = "KCODER_STUDIO_EXECUTOR_ISOLATION_OVERRIDE";
const LOCAL_EXECUTOR_HOME_ENV: &str = "WEGENT_EXECUTOR_HOME";
const LOCAL_EXECUTOR_NAMESPACE: Option<&str> = option_env!("KCODER_STUDIO_EXECUTOR_NAMESPACE");
const LOCAL_EXECUTOR_SHARED_HOME_ENV: &str = "KCODER_STUDIO_SHARED_EXECUTOR_HOME";
const LOCAL_EXECUTOR_LOG_DIR_ENV: &str = "WEGENT_EXECUTOR_LOG_DIR";
const LOCAL_EXECUTOR_LOG_FILE_ENV: &str = "WEGENT_EXECUTOR_LOG_FILE";
const CODEX_HOME_ENV: &str = "CODEX_HOME";
const WEGENT_CODEX_HOME_ENV: &str = "WEGENT_CODEX_HOME";
const KCODER_STUDIO_E2E_NATIVE_CODEX_HOME_ENV: &str = "KCODER_STUDIO_E2E_NATIVE_CODEX_HOME";
const FILE_EDIT_HOOK_COMMAND_ENV: &str = "WEGENT_FILE_EDIT_HOOK_COMMAND";
const FILE_EDIT_LOG_ENDPOINT_ENV: &str = "KCODER_STUDIO_FILE_EDIT_LOG_ENDPOINT";
const CODEX_BINARY_PATH_ENV: &str = "CODEX_BINARY_PATH";
const CODEX_BIN_ENV: &str = "CODEX_BIN";
const BUNDLED_HOOKS_DIR_ENV: &str = "WEGENT_BUNDLED_HOOKS_DIR";
const MANAGED_HOOKS_DIR_ENV: &str = "WEGENT_MANAGED_HOOKS_DIR";
const APP_IPC_DEVICE_ID_ENV: &str = "WEGENT_APP_IPC_DEVICE_ID";
const SESSION_GATEWAY_HOST_ENV: &str = "DEVICE_SESSION_GATEWAY_HOST";
const SESSION_GATEWAY_PORT_ENV: &str = "DEVICE_SESSION_GATEWAY_PORT";
const SESSION_GATEWAY_PUBLIC_BASE_URL_ENV: &str = "DEVICE_PUBLIC_BASE_URL";
const DEFAULT_FILE_EDIT_LOG_ENDPOINT: &str = "http://127.0.0.1:3456/api/file-edit-log";
const LOCAL_EXECUTOR_DEVICE_ID: &str = "local-device";
const LOCAL_EXECUTOR_LOG_FILE_NAME: &str = "executor.log";
const LOCAL_EXECUTOR_SIGNAL_AUDIT_FILE_NAME: &str = "kcoder-executor-signal-audit.log";
const LOCAL_EXECUTOR_RUNTIME_DIR_NAME: &str = "app-runtime";
const LOCAL_EXECUTOR_LOG_TAIL_BYTES: u64 = 200 * 1024;
const LOCAL_EXECUTOR_LOG_TAIL_LINES: usize = 20;
const LOCAL_EXECUTOR_READY_TIMEOUT_SECS: u64 = if cfg!(debug_assertions) { 60 } else { 10 };
const LOCAL_EXECUTOR_PROCESS_GROUP_GRACE_MS: u64 = 500;
const LOCAL_EXECUTOR_PROCESS_GROUP_POLL_MS: u64 = 20;
const LOCAL_EXECUTOR_REQUEST_TIMEOUT_SECONDS: u64 = 60;

mod registry;
use registry::*;
mod process;
use process::*;
mod types;
use types::*;
mod paths;
pub(crate) use paths::local_executor_log_dir_path;
use paths::*;
mod diagnostics;
use diagnostics::*;
mod environment;
use environment::*;
mod codex_home;
use codex_home::*;
mod transport;
use transport::*;
mod lifecycle;
pub use lifecycle::shutdown_local_executor;
use lifecycle::*;
pub use registry::LocalExecutorState;
// Preserve the original parser entry point for protocol consumers and tests.
#[allow(unused_imports)]
pub use transport::parse_executor_line;
// Keep the original module-visible wire type path, even when only sibling types use it.
#[allow(unused_imports)]
pub use types::ExecutorError;
pub use types::{
    CodexHomeInitializeOptions, CodexHomeMigrationStatus, CodexLocalConfig, CodexLocalConfigPatch,
    ExecutorEvent, ExecutorLine, ExecutorResponse, ExternalContentImportOptions,
    ExternalContentImportResult, LocalExecutorLog, LocalExecutorRequest, LocalExecutorStatus,
};

#[tauri::command]
pub async fn local_executor_status(
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_read_log(
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorLog, String> {
    let path = local_executor_log_path()?;
    let path_for_read = path.clone();
    let tail_result = tauri::async_runtime::spawn_blocking(move || {
        read_local_executor_log_tail(&path_for_read, LOCAL_EXECUTOR_LOG_TAIL_BYTES)
    })
    .await
    .map_err(|error| error.to_string())?;
    let tail = tail_result.unwrap_or_else(|error| LocalExecutorLogTail {
        path: path.display().to_string(),
        content: format!("Executor log unavailable: {error}"),
        truncated: false,
        line_count: 0,
    });
    let processes = local_executor_processes();
    let process_pids = processes
        .iter()
        .map(|process| process.pid)
        .collect::<Vec<_>>();
    let process_paths = processes
        .iter()
        .map(|process| process.path.clone())
        .collect::<Vec<_>>();
    let (sidecar_source, sidecar_path) = sidecar_source_and_path();
    let current_dir = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("unavailable: {error}"));
    let executor_home = path_or_error(local_executor_home_path());
    let (status, backend_url, has_backend_auth_token, pending_request_count, transport_connected) = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        let backend_url = inner
            .backend_connection
            .as_ref()
            .map(|connection| connection.backend_url.clone());
        let has_backend_auth_token = inner
            .backend_connection
            .as_ref()
            .map(|connection| !connection.auth_token.trim().is_empty())
            .unwrap_or(false);
        (
            status_from_inner(&inner),
            backend_url,
            has_backend_auth_token,
            inner.pending.len(),
            inner.child.is_some() && inner.running && inner.ready,
        )
    };

    Ok(LocalExecutorLog {
        path: tail.path,
        content: tail.content,
        truncated: tail.truncated,
        line_count: tail.line_count,
        transport: "stdio".to_string(),
        transport_connected,
        process_pids,
        process_paths,
        sidecar_source,
        sidecar_path,
        current_dir,
        executor_home,
        backend_url,
        has_backend_auth_token,
        pending_request_count,
        status,
    })
}

#[tauri::command]
pub async fn local_executor_codex_home_migration_status() -> Result<CodexHomeMigrationStatus, String>
{
    codex_home_migration_status()
}

#[tauri::command]
pub async fn local_executor_read_codex_local_config() -> Result<CodexLocalConfig, String> {
    read_codex_local_config()
}

#[tauri::command]
pub async fn local_executor_update_codex_local_config(
    patch: CodexLocalConfigPatch,
) -> Result<CodexLocalConfig, String> {
    if let Some(enabled) = patch.remote_apps_enabled {
        return write_codex_remote_apps_enabled(enabled);
    }
    read_codex_local_config()
}

#[tauri::command]
pub async fn local_executor_initialize_codex_home(
    options: CodexHomeInitializeOptions,
) -> Result<CodexHomeMigrationStatus, String> {
    let status = codex_home_migration_status()?;
    log::info!(
        "Codex home initialization started: migrate_native_home={}, remote_apps_enabled={}, should_prompt_migration={}, native={}, wework={}",
        options.migrate_native_home,
        options.remote_apps_enabled,
        status.should_prompt_migration,
        status.native_codex_home,
        status.wework_codex_home
    );
    if options.migrate_native_home && status.should_prompt_migration {
        let source = PathBuf::from(&status.native_codex_home);
        let destination = PathBuf::from(&status.wework_codex_home);
        copy_codex_initialization_files(&source, &destination)?;
    } else {
        let destination = PathBuf::from(&status.wework_codex_home);
        fs::create_dir_all(&destination)
            .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    }
    write_codex_remote_apps_enabled(options.remote_apps_enabled)?;
    let next_status = codex_home_migration_status()?;
    log::info!(
        "Codex home initialization finished: should_prompt_migration={}, wework={}",
        next_status.should_prompt_migration,
        next_status.wework_codex_home
    );
    Ok(next_status)
}

#[tauri::command]
pub async fn local_executor_migrate_native_codex_home() -> Result<CodexHomeMigrationStatus, String>
{
    local_executor_initialize_codex_home(CodexHomeInitializeOptions {
        migrate_native_home: true,
        remote_apps_enabled: true,
    })
    .await
}

#[tauri::command]
pub async fn local_executor_import_external_content(
    options: ExternalContentImportOptions,
) -> Result<ExternalContentImportResult, String> {
    import_external_content(&options.source)
}

#[tauri::command]
pub async fn local_executor_copy_debug_info(text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Debug info must not be empty".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || write_text_to_native_clipboard(&text))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_executor_ensure_started(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    start_executor_if_needed(app, &state).await?;
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_connect_backend(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
    backend_url: String,
    auth_token: String,
) -> Result<LocalExecutorStatus, String> {
    let backend_url = normalize_command_arg(backend_url, "backend_url")?;
    let auth_token = normalize_command_arg(auth_token, "auth_token")?;
    let _guard = state.backend_connection_lock.lock().await;
    log::info!(
        "Local executor backend connection update requested: connected=true, backend_url={backend_url}"
    );
    send_executor_request(
        app.clone(),
        &state,
        LocalExecutorRequest {
            method: "executor.backend.configure".to_string(),
            params: json!({
                "backend_url": backend_url.clone(),
                "auth_token": auth_token.clone(),
            }),
        },
    )
    .await?;
    let changed = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        replace_backend_connection(
            &mut inner,
            Some(LocalExecutorBackendConnection {
                backend_url,
                auth_token,
            }),
        )
    };
    log::info!(
        "Local executor backend connection updated in process: connected=true, changed={changed}"
    );
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_disconnect_backend(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    let _guard = state.backend_connection_lock.lock().await;
    log::info!("Local executor backend connection update requested: connected=false");
    send_executor_request(
        app.clone(),
        &state,
        LocalExecutorRequest {
            method: "executor.backend.configure".to_string(),
            params: json!({
                "backend_url": Value::Null,
                "auth_token": Value::Null,
            }),
        },
    )
    .await?;
    let changed = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        replace_backend_connection(&mut inner, None)
    };
    log::info!(
        "Local executor backend connection updated in process: connected=false, changed={changed}"
    );
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_request(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    send_executor_request(app, &state, LocalExecutorRequest { method, params }).await
}

#[cfg(test)]
mod tests;
