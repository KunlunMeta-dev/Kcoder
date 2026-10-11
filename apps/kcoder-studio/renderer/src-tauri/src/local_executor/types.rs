//! Unchanged serialized local-executor command and event contracts.

use super::*;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ExecutorLine {
    #[serde(rename = "response")]
    Response(ExecutorResponse),
    #[serde(rename = "event")]
    Event(ExecutorEvent),
}

#[derive(Debug, Deserialize)]
pub struct ExecutorResponse {
    pub id: String,
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<ExecutorError>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExecutorEvent {
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExecutorError {
    pub code: String,
    pub message: String,
}

#[derive(Deserialize)]
pub struct LocalExecutorRequest {
    pub(super) method: String,
    pub(super) params: Value,
}

#[derive(Serialize)]
pub struct LocalExecutorStatus {
    pub(super) running: bool,
    pub(super) ready: bool,
    #[serde(rename = "deviceId")]
    pub(super) device_id: Option<String>,
    #[serde(rename = "runtimeInstanceId")]
    pub(super) runtime_instance_id: Option<String>,
    pub(super) version: Option<String>,
    pub(super) error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExecutorLog {
    pub(super) path: String,
    pub(super) content: String,
    pub(super) truncated: bool,
    pub(super) line_count: usize,
    pub(super) transport: String,
    pub(super) transport_connected: bool,
    pub(super) process_pids: Vec<u32>,
    pub(super) process_paths: Vec<String>,
    pub(super) sidecar_source: String,
    pub(super) sidecar_path: String,
    pub(super) current_dir: String,
    pub(super) executor_home: String,
    pub(super) backend_url: Option<String>,
    pub(super) has_backend_auth_token: bool,
    pub(super) pending_request_count: usize,
    pub(super) status: LocalExecutorStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHomeMigrationStatus {
    pub(super) wework_codex_home: String,
    pub(super) native_codex_home: String,
    pub(super) wework_codex_home_exists: bool,
    pub(super) native_codex_home_exists: bool,
    pub(super) should_prompt_migration: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHomeInitializeOptions {
    pub(super) migrate_native_home: bool,
    #[serde(default = "default_remote_apps_enabled")]
    pub(super) remote_apps_enabled: bool,
}

pub(super) fn default_remote_apps_enabled() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContentImportOptions {
    pub(super) source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContentImportResult {
    pub(super) source: String,
    pub(super) source_path: String,
    pub(super) destination_path: String,
    pub(super) imported_entries: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLocalConfigPatch {
    pub(super) remote_apps_enabled: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLocalConfig {
    pub(super) codex_home: String,
    pub(super) config_path: String,
    pub(super) remote_apps_enabled: bool,
}

pub(super) struct LocalExecutorLogTail {
    pub(super) path: String,
    pub(super) content: String,
    pub(super) truncated: bool,
    pub(super) line_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocalExecutorProcessInfo {
    pub(super) pid: u32,
    pub(super) path: String,
}
