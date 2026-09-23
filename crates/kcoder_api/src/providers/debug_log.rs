use chrono::{Local, NaiveDate};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

const DEV_DEBUG_ENV: &str = "DEV_DEBUG";
/// `DEV_DEBUG` request logs are a debugging aid, not an archive: keep one week.
pub const DEBUG_LOG_RETENTION_DAYS: i64 = 7;

#[derive(Debug)]
pub(crate) struct LlmDebugRecorder {
    path: Option<PathBuf>,
    snapshot: Option<LlmDebugSnapshot>,
    _lease: Option<std::fs::File>,
}

#[derive(Debug, Serialize)]
struct LlmDebugSnapshot {
    schema_version: u32,
    provider: String,
    session_id: String,
    created_at: String,
    request: LlmDebugRequest,
    response: LlmDebugResponse,
}

#[derive(Debug, Serialize)]
struct LlmDebugRequest {
    method: &'static str,
    url: String,
    body_raw: String,
    body_json: Value,
}

#[derive(Debug, Default, Serialize)]
struct LlmDebugResponse {
    status: Option<u16>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    diagnostic_headers: BTreeMap<String, String>,
    sse_events: Vec<LlmDebugSseEvent>,
    error: Option<String>,
    body_raw: Option<String>,
    body_json: Option<Value>,
}

#[derive(Debug, Serialize)]
struct LlmDebugSseEvent {
    event: String,
    data_raw: String,
    data_json: Value,
}

impl LlmDebugRecorder {
    pub(crate) fn new(provider: &str, session_id: Option<&str>, url: &str, body: &str) -> Self {
        if !dev_debug_enabled() {
            return Self {
                path: None,
                snapshot: None,
                _lease: None,
            };
        }

        let Some(root) = user_config_root().map(|dir| dir.join("logs").join("llm-request")) else {
            warn!("DEV_DEBUG is enabled but config directory could not be determined");
            return Self {
                path: None,
                snapshot: None,
                _lease: None,
            };
        };

        Self::at_root(root, provider, session_id, url, body)
    }

    fn at_root(root: PathBuf, provider: &str, session_id: Option<&str>, url: &str, body: &str) -> Self {
        let now = Local::now();
        let session_id = sanitize_path_segment(session_id.unwrap_or("unknown-session"));
        let date = now.format("%Y%m%d").to_string();
        let time = now.format("%H%M%S").to_string();
        let timestamp = now.format("%Y%m%d%H%M%S").to_string();
        // A busy request defers pruning until a later request; never prune a
        // directory still owned by an active recorder, including at date rollover.
        let removed = prune_debug_log_directories(&root, now.date_naive(), DEBUG_LOG_RETENTION_DAYS);
        if removed > 0 { warn!(removed, "pruned expired DEV_DEBUG request logs"); }
        let lease = match root.parent()
            .and_then(|parent| kcoder_config::PrivateDirectory::open_or_create(parent).ok())
            .and_then(|directory| directory.try_shared_lock(std::ffi::OsStr::new(".llm-request.lock")).ok().flatten()) {
            Some(lease) => lease,
            None => {
                warn!("LLM debug storage is busy or unavailable; skipping this recorder");
                return Self { path: None, snapshot: None, _lease: None };
            }
        };
        let dir = root.join(date).join(format!("{time}_{session_id}"));
        if let Err(error) = fs::create_dir_all(&dir) {
            warn!(?dir, ?error, "failed to create LLM debug log directory");
            return Self {
                path: None,
                snapshot: None,
                _lease: None,
            };
        }

        let path = match unique_log_path(&dir, &timestamp) {
            Ok(path) => path,
            Err(error) => {
                warn!(?error, "failed to reserve LLM debug log file");
                return Self { path: None, snapshot: None, _lease: None };
            }
        };
        let snapshot = LlmDebugSnapshot {
            schema_version: 1,
            provider: provider.to_string(),
            session_id,
            created_at: now.to_rfc3339(),
            request: LlmDebugRequest {
                method: "POST",
                url: url.to_string(),
                body_raw: body.to_string(),
                body_json: parse_json_or_raw(body),
            },
            response: LlmDebugResponse::default(),
        };

        let mut recorder = Self {
            path: Some(path),
            snapshot: Some(snapshot),
            _lease: Some(lease),
        };
        recorder.write_snapshot();
        recorder
    }

    pub(crate) fn record_status(&mut self, status: u16) {
        let Some(snapshot) = self.snapshot.as_mut() else {
            return;
        };
        snapshot.response.status = Some(status);
    }

    pub(crate) fn record_headers(&mut self, headers: &reqwest::header::HeaderMap) {
        let Some(snapshot) = self.snapshot.as_mut() else {
            return;
        };
        for (name, value) in headers {
            let name = name.as_str().to_ascii_lowercase();
            if !is_diagnostic_response_header(&name) {
                continue;
            }
            if let Ok(value) = value.to_str() {
                snapshot
                    .response
                    .diagnostic_headers
                    .insert(name, value.to_string());
            }
        }
    }

    pub(crate) fn record_sse_event(&mut self, event: &str, data: &str) {
        if self.snapshot.is_none() {
            return;
        }
        if data.trim() != "[DONE]" {
            let value = serde_json::from_str::<Value>(data);
            if value.as_ref().map_or(true, |value| {
                value.get("error").is_some()
                    || matches!(
                        value.get("type").and_then(Value::as_str),
                        Some("error" | "response.failed")
                    )
            }) || matches!(event, "error" | "response.failed")
            {
                self.record_failed_sse_event();
                return;
            }
        }
        let Some(snapshot) = self.snapshot.as_mut() else {
            return;
        };
        snapshot.response.sse_events.push(LlmDebugSseEvent {
            event: event.to_string(),
            data_raw: data.to_string(),
            data_json: parse_json_or_raw(data),
        });
    }

    pub(crate) fn record_failed_sse_event(&mut self) {
        let Some(snapshot) = self.snapshot.as_mut() else {
            return;
        };
        let summary = kcoder_types::provider_error_summary("sse_stream_error", None);
        snapshot.response.sse_events.push(LlmDebugSseEvent {
            event: "error".into(),
            data_raw: summary.clone(),
            data_json: Value::String(summary),
        });
    }

    pub(crate) fn record_error(&mut self, _error: impl Into<String>) {
        let Some(snapshot) = self.snapshot.as_mut() else {
            return;
        };
        snapshot.response.error = Some(kcoder_types::provider_error_summary(
            "unknown_error",
            snapshot.response.status,
        ));
    }

    pub(crate) fn record_body(&mut self, body: &str) {
        let Some(snapshot) = self.snapshot.as_mut() else {
            return;
        };
        if snapshot
            .response
            .status
            .is_some_and(|status| !(200..300).contains(&status))
        {
            let summary =
                kcoder_types::provider_error_summary("unknown_error", snapshot.response.status);
            snapshot.response.body_raw = Some(summary.clone());
            snapshot.response.body_json = Some(Value::String(summary));
        } else {
            snapshot.response.body_raw = Some(body.to_string());
            snapshot.response.body_json = Some(parse_json_or_raw(body));
        }
    }

    pub(crate) fn finish(&mut self) {
        self.write_snapshot();
    }

    fn write_snapshot(&mut self) {
        let (Some(path), Some(snapshot)) = (&self.path, &self.snapshot) else {
            return;
        };
        let Ok(bytes) = serde_json::to_vec_pretty(snapshot) else {
            warn!("failed to serialize LLM debug log snapshot");
            return;
        };
        let written = path.parent().zip(path.file_name())
            .ok_or_else(|| anyhow::anyhow!("debug log path is invalid"))
            .and_then(|(parent, name)| kcoder_config::PrivateDirectory::open_existing(parent)?.atomic_replace(name, &bytes));
        if let Err(error) = written {
            warn!(?path, ?error, "failed to write LLM debug log snapshot");
        }
    }
}

impl Drop for LlmDebugRecorder {
    fn drop(&mut self) {
        self.write_snapshot();
    }
}

/// Aggregated on-disk footprint of the `DEV_DEBUG` request logs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DebugLogUsage {
    pub root: PathBuf,
    pub bytes: u64,
    pub files: usize,
    /// Oldest `yyyymmdd` directory that is still present, if any.
    pub oldest_day: Option<String>,
}

/// `<config>/logs/llm-request`, the root the recorder writes into.
pub fn debug_log_root() -> Option<PathBuf> {
    user_config_root().map(|dir| dir.join("logs").join("llm-request"))
}

/// Footprint of the debug logs for the active configuration directory.
pub fn debug_log_usage() -> Option<DebugLogUsage> {
    debug_log_root().map(|root| debug_log_usage_at(&root))
}

/// Footprint of the debug logs under an explicit root (used by diagnostics and tests).
pub fn debug_log_usage_at(root: &Path) -> DebugLogUsage {
    let mut bytes = 0u64;
    let mut files = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => stack.push(entry.path()),
                Ok(file_type) if file_type.is_file() => {
                    files += 1;
                    if let Ok(metadata) = entry.metadata() {
                        bytes += metadata.len();
                    }
                }
                _ => {}
            }
        }
    }
    let mut oldest_day: Option<String> = None;
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if NaiveDate::parse_from_str(&name, "%Y%m%d").is_ok()
                && oldest_day
                    .as_deref()
                    .is_none_or(|current| name.as_str() < current)
            {
                oldest_day = Some(name);
            }
        }
    }
    DebugLogUsage {
        root: root.to_path_buf(),
        bytes,
        files,
        oldest_day,
    }
}

/// Removes `logs/llm-request/<yyyymmdd>` directories outside the retention window.
///
/// Days at or after `today - (retention_days - 1)` are kept, so a seven-day
/// window on 2026-09-18 keeps 20260912 through 20260918. Names that are not
/// date directories are left untouched.
/// Holds the exclusion lease while the caller removes log directories.
/// The lease file lives beside the log root and must not be deleted with it.
pub fn try_debug_log_cleanup_at(root: &Path) -> anyhow::Result<Option<std::fs::File>> {
    let parent = root.parent().ok_or_else(|| anyhow::anyhow!("debug log root has no parent"))?;
    kcoder_config::PrivateDirectory::open_existing(parent)?
        .try_exclusive_lock(std::ffi::OsStr::new(".llm-request.lock"))
}

fn prune_debug_log_directories(root: &Path, today: NaiveDate, retention_days: i64) -> usize {
    let Ok(Some(_lease)) = try_debug_log_cleanup_at(root) else { return 0; };
    let cutoff = today - chrono::Duration::days(retention_days.clamp(1, 3650) - 1);
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(day) = NaiveDate::parse_from_str(&name, "%Y%m%d") else {
            continue;
        };
        if day >= cutoff {
            continue;
        }
        if fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Whether `DEV_DEBUG` currently enables request/response recording.
pub fn dev_debug_enabled() -> bool {
    let Ok(value) = std::env::var(DEV_DEBUG_ENV) else {
        return false;
    };
    dev_debug_value_enabled(&value)
}

fn dev_debug_value_enabled(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value != "0"
        && !value.eq_ignore_ascii_case("false")
        && !value.eq_ignore_ascii_case("off")
        && !value.eq_ignore_ascii_case("no")
}

fn is_diagnostic_response_header(name: &str) -> bool {
    name == "age"
        || name == "server-timing"
        || name.contains("cache")
        || name.contains("request-id")
        || name.starts_with("ratelimit-")
        || name.starts_with("x-ratelimit-")
        || name.starts_with("anthropic-ratelimit-")
        || name.starts_with("openai-")
}

fn parse_json_or_raw(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn sanitize_path_segment(raw: &str) -> String {
    let sanitized = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.trim_matches('_').is_empty() {
        "unknown-session".to_string()
    } else {
        sanitized
    }
}

fn unique_log_path(dir: &Path, timestamp: &str) -> anyhow::Result<PathBuf> {
    let directory = kcoder_config::PrivateDirectory::open_existing(dir)?;
    for index in 1..=100_000 {
        let name = if index == 1 { format!("{timestamp}.json") } else { format!("{timestamp}-{index}.json") };
        match directory.open_read_write_file(std::ffi::OsStr::new(&name), true) {
            Ok(_) => return Ok(dir.join(name)),
            Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) => continue,
            Err(error) => return Err(error),
        }
    }
    anyhow::bail!("debug log file limit reached for one timestamp")
}

/// User-level config root, honouring `KCODER_CONFIG_DIR` so isolated
/// runs keep debug logs inside the isolated directory.
fn user_config_root() -> Option<PathBuf> {
    kcoder_config::user_config_dir().ok()
}

#[cfg(test)]
fn user_config_root_with_override(override_dir: Option<std::ffi::OsString>) -> Option<PathBuf> {
    override_dir
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_error_summary_debug_recording_excludes_failed_body_and_frame() {
        let mut recorder = LlmDebugRecorder {
            _lease: None,
            path: None,
            snapshot: Some(LlmDebugSnapshot {
                schema_version: 1,
                provider: "test".into(),
                session_id: "test".into(),
                created_at: String::new(),
                request: LlmDebugRequest {
                    method: "POST",
                    url: "http://test".into(),
                    body_raw: "successful request content".into(),
                    body_json: Value::Null,
                },
                response: LlmDebugResponse::default(),
            }),
        };
        recorder.record_status(401);
        recorder.record_body(&"SENTINEL_PRIVATE Bearer multiple words".repeat(1000));
        recorder.record_error("SENTINEL_PRIVATE https://host/?key=secret");
        recorder.record_sse_event(
            "error",
            r#"{"error":{"type":"SENTINEL_PRIVATE","message":"SENTINEL_PRIVATE"}}"#,
        );
        let response = &recorder.snapshot.as_ref().unwrap().response;
        let encoded = serde_json::to_string(response).unwrap();
        assert!(!encoded.contains("SENTINEL_PRIVATE"));
        assert!(response.body_raw.as_ref().unwrap().len() <= 512);
        recorder.record_sse_event("message", r#"{"content":"SUCCESS_PRIVATE"}"#);
        assert!(
            serde_json::to_string(&recorder.snapshot)
                .unwrap()
                .contains("SUCCESS_PRIVATE")
        );
    }

    #[test]
    fn debug_log_usage_counts_files_and_reports_the_oldest_day() {
        let root = std::env::temp_dir().join(format!(
            "kcoder-debug-log-usage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("20260917").join("120000_a")).unwrap();
        fs::write(
            root.join("20260917").join("120000_a").join("request.json"),
            b"0123456789",
        )
        .unwrap();
        fs::create_dir_all(root.join("20260918").join("120000_b")).unwrap();
        fs::write(
            root.join("20260918").join("120000_b").join("request.json"),
            b"01234",
        )
        .unwrap();

        let usage = debug_log_usage_at(&root);
        assert_eq!(usage.files, 2);
        assert_eq!(usage.bytes, 15);
        assert_eq!(usage.oldest_day.as_deref(), Some("20260917"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_requests_reserve_distinct_log_files() {
        let profile = kcoder_config::create_private_temp_dir("kcoder-debug-log-test").unwrap();
        let paths = std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for _ in 0..8 {
                let directory = profile.path();
                workers.push(scope.spawn(move || unique_log_path(directory, "same-timestamp").unwrap()));
            }
            workers.into_iter().map(|worker| worker.join().unwrap()).collect::<std::collections::BTreeSet<_>>()
        });
        assert_eq!(paths.len(), 8);
        assert!(paths.iter().all(|path| path.is_file()));
    }

    #[test]
    fn active_recorder_blocks_cleanup_and_retention_until_final_write() {
        let profile = kcoder_config::create_private_temp_dir("kcoder-debug-log-test").unwrap();
        let root = profile.path().join("llm-request");
        let recorder = LlmDebugRecorder::at_root(root.clone(), "fixture", Some("session"), "http://localhost", "{}");
        let path = recorder.path.clone().expect("recorder owns a log");
        fs::create_dir_all(root.join("20000101")).unwrap();
        fs::write(root.join("20000101/old.json"), b"old").unwrap();
        assert!(try_debug_log_cleanup_at(&root).unwrap().is_none());
        assert_eq!(prune_debug_log_directories(&root, Local::now().date_naive(), 7), 0);
        assert!(root.join("20000101/old.json").exists());
        drop(recorder);
        assert!(path.exists());
        assert_eq!(prune_debug_log_directories(&root, Local::now().date_naive(), 7), 1);
        let cleanup = try_debug_log_cleanup_at(&root).unwrap().unwrap();
        let blocked = LlmDebugRecorder::at_root(root, "fixture", Some("second"), "http://localhost", "{}");
        assert!(blocked.path.is_none());
        drop(cleanup);
    }

    #[test]
    fn prune_removes_date_directories_outside_the_retention_window() {
        let profile = kcoder_config::create_private_temp_dir("kcoder-debug-log-test").unwrap();
        let root = profile.path().join("llm-request");
        for name in ["20260801", "20260905", "20260912", "20260918", "not-a-date"] {
            fs::create_dir_all(root.join(name).join("120000_session")).unwrap();
        }
        let removed = prune_debug_log_directories(
            &root,
            chrono::NaiveDate::from_ymd_opt(2026, 9, 18).unwrap(),
            7,
        );
        assert_eq!(removed, 2, "only directories older than the cutoff go away");
        assert!(!root.join("20260801").exists());
        assert!(!root.join("20260905").exists());
        assert!(
            root.join("20260912").exists(),
            "the cutoff day itself is kept"
        );
        assert!(root.join("20260918").exists());
        assert!(
            root.join("not-a-date").exists(),
            "unknown names are left alone"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn user_config_root_honours_config_dir_env() {
        let resolved = user_config_root_with_override(Some("/tmp/kcoder-isolated-debug".into()));
        assert_eq!(resolved, Some(PathBuf::from("/tmp/kcoder-isolated-debug")));
    }

    #[test]
    fn dev_debug_false_values_disable_logging() {
        for value in ["", "0", "false", "off", "no"] {
            assert!(
                !dev_debug_value_enabled(value),
                "{value:?} should disable logging"
            );
        }
        assert!(dev_debug_value_enabled("1"));
        assert!(dev_debug_value_enabled("true"));
    }

    #[test]
    fn path_segments_are_sanitized() {
        assert_eq!(sanitize_path_segment("abc/def:123"), "abc_def_123");
        assert_eq!(sanitize_path_segment("   "), "unknown-session");
    }

    #[test]
    fn diagnostic_headers_include_cache_signals_but_exclude_credentials() {
        assert!(is_diagnostic_response_header("x-cache"));
        assert!(is_diagnostic_response_header("cf-cache-status"));
        assert!(is_diagnostic_response_header("x-request-id"));
        assert!(!is_diagnostic_response_header("set-cookie"));
        assert!(!is_diagnostic_response_header("authorization"));
    }
}
