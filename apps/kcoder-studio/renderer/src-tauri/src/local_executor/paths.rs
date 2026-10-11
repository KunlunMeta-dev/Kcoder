//! Private runtime/home/log paths and configured sidecar resolution.

use super::*;

pub(super) fn local_executor_instance_name() -> &'static str {
    static INSTANCE_NAME: OnceLock<String> = OnceLock::new();
    INSTANCE_NAME.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        format!("wework-{}-{nanos}", std::process::id())
    })
}

pub(super) fn local_executor_runtime_dir_path() -> Result<PathBuf, String> {
    let home = local_executor_home_path()?;
    if local_executor_isolation_enabled()? {
        return Ok(home
            .join(LOCAL_EXECUTOR_RUNTIME_DIR_NAME)
            .join(local_executor_instance_name()));
    }

    Ok(home)
}

pub(super) fn local_executor_runtime_home_path() -> Result<PathBuf, String> {
    local_executor_runtime_dir_path()
}

pub(super) fn local_executor_isolation_enabled() -> Result<bool, String> {
    if let Ok(value) = std::env::var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV) {
        return match value.trim() {
            "" => Ok(cfg!(debug_assertions)),
            "true" => Ok(true),
            "false" => Ok(false),
            value => Err(format!(
                "{LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV} must be true or false, got {value:?}"
            )),
        };
    }

    Ok(cfg!(debug_assertions)
        && std::env::var(LOCAL_EXECUTOR_SHARED_HOME_ENV)
            .map(|value| value.trim() != "1")
            .unwrap_or(true))
}

pub(super) fn local_executor_home_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(LOCAL_EXECUTOR_HOME_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    Ok(default_local_executor_home_path(
        &home,
        LOCAL_EXECUTOR_NAMESPACE,
    ))
}

pub(super) fn default_local_executor_home_path(home: &Path, namespace: Option<&str>) -> PathBuf {
    let root = home.join(".wegent-executor");
    namespace
        .filter(|value| !value.is_empty())
        .map_or(root.clone(), |value| root.join("apps").join(value))
}

pub(super) fn local_executor_log_path() -> Result<PathBuf, String> {
    let log_dir = local_executor_log_dir_path()?;
    let log_file = std::env::var(LOCAL_EXECUTOR_LOG_FILE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| LOCAL_EXECUTOR_LOG_FILE_NAME.to_string());

    Ok(log_dir.join(log_file))
}

pub(crate) fn local_executor_log_dir_path() -> Result<PathBuf, String> {
    std::env::var(LOCAL_EXECUTOR_LOG_DIR_ENV)
        .ok()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| local_executor_runtime_dir_path().map(|path| path.join("logs")))
}

pub(super) fn sidecar_source_and_path() -> (String, String) {
    if let Some(path) = configured_sidecar_path() {
        return ("configured".to_string(), path.display().to_string());
    }

    ("bundled".to_string(), LOCAL_EXECUTOR_SIDECAR.to_string())
}

pub(super) fn path_or_error(result: Result<PathBuf, String>) -> String {
    result
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("unavailable: {error}"))
}

pub(super) fn configured_sidecar_path() -> Option<PathBuf> {
    std::env::var_os(LOCAL_EXECUTOR_SIDECAR_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}
