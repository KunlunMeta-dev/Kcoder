//! Managed sidecar environment and backend connection projection.

use super::*;

pub(super) fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn default_file_edit_hook_command() -> String {
    let endpoint = non_empty_env(FILE_EDIT_LOG_ENDPOINT_ENV)
        .unwrap_or_else(|| DEFAULT_FILE_EDIT_LOG_ENDPOINT.to_string());
    format!("curl -s -X POST {endpoint} -H \"Content-Type: application/json\" -d @-")
}

pub(super) fn configured_file_edit_hook_command() -> String {
    non_empty_env(FILE_EDIT_HOOK_COMMAND_ENV).unwrap_or_else(default_file_edit_hook_command)
}

pub(super) fn local_executor_backend_env(inner: &LocalExecutorInner) -> Vec<(String, String)> {
    let executor_home = path_or_error(local_executor_runtime_home_path());
    let codex_home = path_or_error(wework_codex_home_path(&executor_home));
    let log_dir = path_or_error(local_executor_log_dir_path());
    let app_ipc_device_id = inner
        .device_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(LOCAL_EXECUTOR_DEVICE_ID)
        .to_string();
    let mut envs = vec![
        (LOCAL_EXECUTOR_HOME_ENV.to_string(), executor_home),
        (CODEX_HOME_ENV.to_string(), codex_home),
        (LOCAL_EXECUTOR_LOG_DIR_ENV.to_string(), log_dir),
        (APP_IPC_DEVICE_ID_ENV.to_string(), app_ipc_device_id.clone()),
        ("DEVICE_ID".to_string(), app_ipc_device_id.clone()),
        (
            "DEVICE_NAME".to_string(),
            format!("{app_ipc_device_id} app"),
        ),
        ("DEVICE_TYPE".to_string(), "app".to_string()),
        ("BIND_SHELL".to_string(), "claudecode".to_string()),
        (
            SESSION_GATEWAY_HOST_ENV.to_string(),
            "127.0.0.1".to_string(),
        ),
        (SESSION_GATEWAY_PORT_ENV.to_string(), "0".to_string()),
        (
            SESSION_GATEWAY_PUBLIC_BASE_URL_ENV.to_string(),
            String::new(),
        ),
        (
            "PATH".to_string(),
            process_environment::normalized_current_path(),
        ),
        (
            FILE_EDIT_HOOK_COMMAND_ENV.to_string(),
            configured_file_edit_hook_command(),
        ),
    ];
    if let Some(log_file) = non_empty_env(LOCAL_EXECUTOR_LOG_FILE_ENV) {
        envs.push((LOCAL_EXECUTOR_LOG_FILE_ENV.to_string(), log_file));
    }
    let Some(connection) = &inner.backend_connection else {
        return envs;
    };

    envs.extend([
        (
            "WEGENT_BACKEND_URL".to_string(),
            connection.backend_url.clone(),
        ),
        (
            "WEGENT_AUTH_TOKEN".to_string(),
            connection.auth_token.clone(),
        ),
    ]);
    envs
}

pub(super) fn local_executor_sidecar_env(
    inner: &LocalExecutorInner,
    app: &tauri::AppHandle,
) -> Vec<(String, String)> {
    let mut envs = local_executor_backend_env(inner);
    if let Some(path) = non_empty_env(MANAGED_HOOKS_DIR_ENV) {
        envs.push((MANAGED_HOOKS_DIR_ENV.to_string(), path));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_hooks = resource_dir.join("bundled-hooks");
        if bundled_hooks.is_dir() {
            envs.push((
                BUNDLED_HOOKS_DIR_ENV.to_string(),
                bundled_hooks.display().to_string(),
            ));
        }
    }
    envs
}
