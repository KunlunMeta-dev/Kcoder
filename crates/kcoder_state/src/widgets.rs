//! Private immutable widget revisions. One atomic record is both content and receipt.
use anyhow::{Context, Result, bail, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::widgets::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
};

const RECORD_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetCommitRequest {
    pub identity: WidgetIdentity,
    pub title: String,
    pub summary: String,
    pub format: WidgetFormat,
    pub execution_mode: WidgetExecutionMode,
    pub libraries: Vec<WidgetLibrary>,
    pub source: String,
    pub widget_id: Option<String>,
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    version: u8,
    request_sha256: String,
    reference: WidgetRef,
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mcp_app: Option<kcoder_types::mcp_apps::McpAppView>,
}

#[derive(Serialize, Deserialize)]
struct RenderRecord {
    version: u8,
    identity: WidgetIdentity,
    widget_id: String,
    revision: u64,
    sha256: String,
    observation: WidgetRenderObservation,
}

pub struct WidgetStore {
    directory: PrivateDirectory,
    journal_root: PathBuf,
    thread_id: String,
}

impl WidgetStore {
    pub fn open(session_directory: &Path, thread_id: &str) -> Result<Self> {
        validate_thread_directory(session_directory, thread_id)?;
        Ok(Self {
            directory: PrivateDirectory::open_or_create(&session_directory.join("widgets"))?,
            journal_root: session_directory
                .parent()
                .context("widget session has no parent")?
                .into(),
            thread_id: thread_id.into(),
        })
    }

    /// Reads never create an empty session or artifact directory.
    pub fn open_existing(session_directory: &Path, thread_id: &str) -> Result<Option<Self>> {
        validate_thread_directory(session_directory, thread_id)?;
        let directory = match PrivateDirectory::open_existing(&session_directory.join("widgets")) {
            Ok(directory) => directory,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        Ok(Some(Self {
            directory,
            journal_root: session_directory
                .parent()
                .context("widget session has no parent")?
                .into(),
            thread_id: thread_id.into(),
        }))
    }

    pub fn commit(&self, request: WidgetCommitRequest) -> Result<WidgetRef> {
        self.commit_record(request, None)
    }

    /// Called only after reading the UI resource from its original authorized MCP handle.
    pub fn commit_mcp_app(
        &self,
        identity: WidgetIdentity,
        title: String,
        summary: String,
        mut view: kcoder_types::mcp_apps::McpAppView,
    ) -> Result<WidgetRef> {
        ensure!(
            serde_json::to_vec(&view)?.len() <= kcoder_types::mcp_apps::MCP_APP_VIEW_MAX_BYTES,
            "widget_quota: MCP App view exceeds the encoded budget"
        );
        ensure!(
            !view.connection_id.is_empty()
                && view.connection_id.len() <= 128
                && !view.server_name.is_empty()
                && view.server_name.len() <= 256
                && !view.tool_name.is_empty()
                && view.tool_name.len() <= 256
                && view
                    .plugin_id
                    .as_ref()
                    .is_none_or(|id| !id.is_empty() && id.len() <= 256)
                && !view.html.is_empty()
                && view.html.len() <= kcoder_types::mcp_apps::MCP_APP_HTML_MAX_BYTES
                && view.resource_uri.starts_with("ui://")
                && view.resource_uri.len() <= 2048
                && view.mime_type == kcoder_types::mcp_apps::MCP_APP_MIME_TYPE,
            "invalid_widget: MCP App source identity is invalid"
        );
        let source = std::mem::take(&mut view.html);
        self.commit_record(
            WidgetCommitRequest {
                identity,
                title,
                summary,
                format: WidgetFormat::Html,
                execution_mode: WidgetExecutionMode::IsolatedHtml,
                libraries: Vec::new(),
                source,
                widget_id: None,
                expected_revision: None,
            },
            Some(view),
        )
    }

    pub fn read_mcp_app(
        &self,
        widget_id: &str,
        revision: u64,
    ) -> Result<(WidgetRef, kcoder_types::mcp_apps::McpAppView)> {
        let file = self
            .directory
            .open_regular_file(OsStr::new(&record_name(widget_id, revision)?))?;
        let record = self.read_record(file)?;
        ensure!(
            record.reference.widget_id == widget_id && record.reference.revision == revision,
            "invalid_widget: MCP App revision identity mismatch"
        );
        let mut app = record
            .mcp_app
            .context("invalid_widget: this widget is not an MCP App")?;
        app.html = record.source;
        Ok((record.reference, app))
    }

    /// Store one bounded latest observation per immutable revision; never change its content.
    pub fn record_render_observation(
        &self,
        reference: &WidgetRef,
        status: WidgetRenderStatus,
        error_code: Option<String>,
    ) -> Result<WidgetRenderObservation> {
        validate_render_code(status, error_code.as_deref())?;
        let mut fence = crate::history_index::journal::JournalFence::acquire_for_write(
            &self.journal_root,
            crate::history_index::journal::JournalDomain::ClientMetadata,
        )?;
        let _lock = self
            .directory
            .try_exclusive_lock(OsStr::new("store.lock"))?
            .context("widget_busy: another writer owns the widget store")?;
        let stored = self.read(&reference.widget_id, reference.revision)?.0;
        ensure!(
            stored == *reference,
            "invalid_widget: render observation refers to another execution"
        );
        if let Some(previous) = self.render_observation(reference)?
            && previous.status == status
            && previous.error_code == error_code
        {
            return Ok(previous);
        }
        let observation = WidgetRenderObservation {
            status,
            error_code,
            observed_at_ms: chrono::Utc::now().timestamp_millis().max(0) as u64,
        };
        let record = RenderRecord {
            version: 1,
            identity: reference.identity.clone(),
            widget_id: reference.widget_id.clone(),
            revision: reference.revision,
            sha256: reference.sha256.clone(),
            observation: observation.clone(),
        };
        let bytes = serde_json::to_vec(&record)?;
        ensure!(
            bytes.len() <= 4096,
            "widget_quota: rendering observation is too large"
        );
        let name = render_record_name(reference)?;
        let previous_size = match self.directory.open_regular_file(OsStr::new(&name)) {
            Ok(file) => file.metadata()?.len(),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                0
            }
            Err(error) => return Err(error),
        };
        let content_bytes = self.content_record_bytes()?;
        ensure!(
            content_bytes
                .saturating_add(self.observation_bytes()?)
                .saturating_sub(previous_size)
                .saturating_add(bytes.len() as u64)
                <= WIDGET_SESSION_BYTES,
            "widget_quota: session encoded content limit reached"
        );
        let mutation = fence.begin(&self.thread_id)?;
        self.directory.atomic_replace(OsStr::new(&name), &bytes)?;
        if let Err(error) = mutation.finish() {
            tracing::warn!(%error, "widget rendering observation committed; journal needs reconciliation");
        }
        Ok(observation)
    }

    pub fn render_observation(
        &self,
        reference: &WidgetRef,
    ) -> Result<Option<WidgetRenderObservation>> {
        ensure!(
            reference.identity.thread_id == self.thread_id,
            "invalid_widget: render observation belongs to another thread"
        );
        let file = match self
            .directory
            .open_regular_file(OsStr::new(&render_record_name(reference)?))
        {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        ensure!(
            file.metadata()?.len() <= 4096,
            "widget_quota: oversized render observation"
        );
        let mut bytes = Vec::new();
        file.take(4097).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 4096,
            "widget_quota: render observation grew beyond limit"
        );
        let record: RenderRecord = serde_json::from_slice(&bytes)?;
        ensure!(
            record.version == 1
                && record.identity == reference.identity
                && record.widget_id == reference.widget_id
                && record.revision == reference.revision
                && record.sha256 == reference.sha256,
            "invalid_widget: render observation identity mismatch"
        );
        validate_render_code(
            record.observation.status,
            record.observation.error_code.as_deref(),
        )?;
        Ok(Some(record.observation))
    }

    fn commit_record(
        &self,
        request: WidgetCommitRequest,
        mcp_app: Option<kcoder_types::mcp_apps::McpAppView>,
    ) -> Result<WidgetRef> {
        validate_request(&request, &self.thread_id)?;
        let mut fence = crate::history_index::journal::JournalFence::acquire_for_write(
            &self.journal_root,
            crate::history_index::journal::JournalDomain::ClientMetadata,
        )?;
        let _lock = self
            .directory
            .try_exclusive_lock(OsStr::new("store.lock"))?
            .context("widget_busy: another writer owns the widget store")?;
        let records = self.records()?;
        let request_hash = digest(&serde_json::to_vec(&(&request, &mcp_app))?);
        // A lost transport receipt is reconciled before a new revision is attempted.
        if let Some(previous) = records
            .iter()
            .find(|record| record.reference.identity == request.identity)
        {
            ensure!(
                previous.request_sha256 == request_hash,
                "widget_conflict: tool call identity already has different content"
            );
            return Ok(previous.reference.clone());
        }
        ensure!(
            records.len() < WIDGET_REVISION_LIMIT,
            "widget_quota: session revision limit reached"
        );
        let turn_count = records
            .iter()
            .filter(|record| record.reference.identity.turn_id == request.identity.turn_id)
            .count();
        ensure!(
            turn_count < WIDGET_TURN_LIMIT,
            "widget_quota: turn component limit reached"
        );
        let (widget_id, revision) = match (&request.widget_id, request.expected_revision) {
            (None, None) => (
                format!("w{}", digest(&serde_json::to_vec(&request.identity)?)),
                1,
            ),
            (Some(id), Some(expected)) => {
                validate_widget_id(id)?;
                let latest = records
                    .iter()
                    .filter(|record| record.reference.widget_id == *id)
                    .max_by_key(|record| record.reference.revision)
                    .context("artifact_unavailable: widget does not exist in this thread")?;
                ensure!(
                    expected == latest.reference.revision,
                    "revision_conflict: read the latest widget revision before updating"
                );
                let mut failed_revisions = 0usize;
                for previous in records.iter().filter(|record| {
                    record.reference.widget_id == *id
                        && record.reference.identity.turn_id == request.identity.turn_id
                }) {
                    if self
                        .render_observation(&previous.reference)?
                        .is_some_and(|observation| observation.status == WidgetRenderStatus::Failed)
                    {
                        failed_revisions += 1;
                    }
                }
                ensure!(
                    failed_revisions <= 2,
                    "widget_repair_budget_exhausted: two rendering repairs failed in this task; keep the accessible summary and explain the limitation"
                );
                (
                    id.clone(),
                    expected
                        .checked_add(1)
                        .context("widget revision exhausted")?,
                )
            }
            _ => bail!("invalid_widget: widget_id and expected_revision must be supplied together"),
        };
        let reference = WidgetRef {
            mcp_app: mcp_app.as_ref().map(|app| WidgetMcpSource {
                server_name: app.server_name.clone(),
                connection_id: app.connection_id.clone(),
                plugin_id: app.plugin_id.clone(),
                tool_name: app.tool_name.clone(),
                resource_uri: app.resource_uri.clone(),
                mime_type: app.mime_type.clone(),
            }),
            widget_id,
            identity: request.identity,
            revision,
            title: request.title,
            summary: request.summary,
            format: request.format,
            execution_mode: request.execution_mode,
            libraries: request.libraries,
            sha256: digest(request.source.as_bytes()),
            bytes: request.source.len() as u64,
            created_at_ms: chrono::Utc::now().timestamp_millis().max(0) as u64,
        };
        let record = Record {
            version: 1,
            request_sha256: request_hash,
            reference: reference.clone(),
            source: request.source,
            mcp_app,
        };
        let bytes = serde_json::to_vec(&record)?;
        let previous_bytes = records
            .iter()
            .try_fold(0u64, |total, record| -> Result<u64> {
                total
                    .checked_add(serde_json::to_vec(record)?.len() as u64)
                    .context("widget byte total overflow")
            })?;
        ensure!(
            bytes.len() as u64 <= RECORD_BYTES
                && previous_bytes
                    .saturating_add(self.observation_bytes()?)
                    .saturating_add(bytes.len() as u64)
                    <= WIDGET_SESSION_BYTES,
            "widget_quota: session encoded content limit reached"
        );
        let mutation = fence.begin(&self.thread_id)?;
        let filename = record_name(&reference.widget_id, reference.revision)?;
        self.directory
            .atomic_replace(OsStr::new(&filename), &bytes)?;
        // Authority is already committed; journal repair must not cause a replay.
        if let Err(error) = mutation.finish() {
            tracing::warn!(%error, thread_id = %self.thread_id, "widget committed; transcript journal needs reconciliation");
        }
        Ok(reference)
    }

    pub fn list(&self, offset: usize, limit: usize) -> Result<(Vec<WidgetRef>, Option<usize>)> {
        ensure!(
            (1..=100).contains(&limit),
            "invalid_widget: list limit must be between 1 and 100"
        );
        let _lock = self
            .directory
            .try_shared_lock(OsStr::new("store.lock"))?
            .context("widget_busy: widget store is being updated")?;
        let mut refs = self
            .records()?
            .into_iter()
            .map(|record| record.reference)
            .collect::<Vec<_>>();
        refs.sort_by(|a, b| {
            (a.created_at_ms, &a.widget_id, a.revision).cmp(&(
                b.created_at_ms,
                &b.widget_id,
                b.revision,
            ))
        });
        ensure!(
            offset <= refs.len(),
            "invalid_widget: list offset is beyond available revisions"
        );
        let mut end = offset;
        let mut encoded_bytes = 1024usize;
        for reference in refs.iter().skip(offset).take(limit) {
            let row_bytes = serde_json::to_vec(reference)?.len().saturating_add(1);
            if encoded_bytes.saturating_add(row_bytes) > 1024 * 1024 {
                break;
            }
            encoded_bytes += row_bytes;
            end += 1;
        }
        ensure!(
            end > offset || offset == refs.len(),
            "widget_quota: one widget reference exceeds the directory frame budget"
        );
        let next = (end < refs.len()).then_some(end);
        Ok((refs[offset..end].to_vec(), next))
    }

    pub fn latest(&self, widget_id: &str) -> Result<(WidgetRef, String)> {
        validate_widget_id(widget_id)?;
        let _lock = self
            .directory
            .try_shared_lock(OsStr::new("store.lock"))?
            .context("widget_busy: widget store is being updated")?;
        let record = self
            .records()?
            .into_iter()
            .filter(|record| record.reference.widget_id == widget_id)
            .max_by_key(|record| record.reference.revision)
            .context("artifact_unavailable: no widget with this identity in the current thread")?;
        Ok((record.reference, record.source))
    }

    pub fn find_call(
        &self,
        tool_call_id: &str,
        attempt_id: Option<&str>,
    ) -> Result<(WidgetRef, String)> {
        ensure!(
            !tool_call_id.is_empty() && tool_call_id.len() <= 256,
            "invalid_widget: invalid lookup tool call"
        );
        let _lock = self
            .directory
            .try_shared_lock(OsStr::new("store.lock"))?
            .context("widget_busy: widget store is being updated")?;
        let mut matches = self.records()?.into_iter().filter(|record| {
            record.reference.identity.tool_call_id == tool_call_id
                && attempt_id.is_none_or(|attempt| record.reference.identity.attempt_id == attempt)
        });
        let record = matches
            .next()
            .context("artifact_unavailable: no receipt was recorded for this tool call")?;
        ensure!(
            matches.next().is_none(),
            "widget_conflict: tool call ID was reused; supply lookup_attempt_id from the original execution"
        );
        Ok((record.reference, record.source))
    }

    pub fn read(&self, widget_id: &str, revision: u64) -> Result<(WidgetRef, String)> {
        let name = record_name(widget_id, revision)?;
        let file = self
            .directory
            .open_regular_file(OsStr::new(&name))
            .context("artifact_unavailable: widget revision is missing")?;
        let record = self.read_record(file)?;
        ensure!(
            record.reference.widget_id == widget_id && record.reference.revision == revision,
            "invalid_widget: stored widget identity mismatch"
        );
        Ok((record.reference, record.source))
    }

    fn records(&self) -> Result<Vec<Record>> {
        let predicate = |name: &OsStr| name.to_str().is_some_and(|name| name.ends_with(".json"));
        let count = self
            .directory
            .count_regular_files_bounded(predicate, WIDGET_REVISION_LIMIT + 1)?;
        ensure!(
            count <= WIDGET_REVISION_LIMIT,
            "widget_quota: stored revision count exceeds limit"
        );
        let files = self.directory.open_regular_files(predicate)?;
        let mut total = 0u64;
        let mut records = Vec::with_capacity(count);
        for (name, file) in files {
            total = total
                .checked_add(file.metadata()?.len())
                .context("widget size overflow")?;
            ensure!(
                total <= WIDGET_SESSION_BYTES,
                "widget_quota: stored encoded content exceeds limit"
            );
            let record = self.read_record(file)?;
            ensure!(
                name == OsStr::new(&record_name(
                    &record.reference.widget_id,
                    record.reference.revision
                )?),
                "invalid_widget: revision filename mismatch"
            );
            records.push(record);
        }
        Ok(records)
    }

    fn observation_bytes(&self) -> Result<u64> {
        let predicate = |name: &OsStr| {
            name.to_str()
                .is_some_and(|name| name.ends_with(".json.render"))
        };
        ensure!(
            self.directory
                .count_regular_files_bounded(predicate, WIDGET_REVISION_LIMIT + 1)?
                <= WIDGET_REVISION_LIMIT,
            "widget_quota: rendering observation count exceeds limit"
        );
        self.directory
            .open_regular_files(predicate)?
            .into_iter()
            .try_fold(0u64, |total, (_, file)| {
                let bytes = file.metadata()?.len();
                ensure!(
                    bytes <= 4096,
                    "widget_quota: rendering observation is too large"
                );
                Ok(total.saturating_add(bytes))
            })
    }

    fn content_record_bytes(&self) -> Result<u64> {
        let predicate = |name: &OsStr| name.to_str().is_some_and(|name| name.ends_with(".json"));
        ensure!(
            self.directory
                .count_regular_files_bounded(predicate, WIDGET_REVISION_LIMIT + 1)?
                <= WIDGET_REVISION_LIMIT,
            "widget_quota: stored revision count exceeds limit"
        );
        self.directory
            .open_regular_files(predicate)?
            .into_iter()
            .try_fold(0u64, |total, (_, file)| {
                let bytes = file.metadata()?.len();
                ensure!(bytes <= RECORD_BYTES, "widget_quota: record is too large");
                Ok(total.saturating_add(bytes))
            })
    }

    fn read_record(&self, file: std::fs::File) -> Result<Record> {
        ensure!(
            file.metadata()?.len() <= RECORD_BYTES,
            "widget_quota: record is too large"
        );
        let mut bytes = Vec::new();
        file.take(RECORD_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= RECORD_BYTES,
            "widget_quota: record grew beyond limit"
        );
        let record: Record =
            serde_json::from_slice(&bytes).context("invalid_widget: corrupt stored record")?;
        ensure!(
            record.version == 1 && record.reference.identity.thread_id == self.thread_id,
            "invalid_widget: stored thread or schema mismatch"
        );
        ensure!(
            record.source.len() <= WIDGET_SOURCE_BYTES
                && record.source.len() as u64 == record.reference.bytes
                && digest(record.source.as_bytes()) == record.reference.sha256,
            "invalid_widget: stored content digest mismatch"
        );
        let expected_source = record.mcp_app.as_ref().map(|app| WidgetMcpSource {
            server_name: app.server_name.clone(),
            connection_id: app.connection_id.clone(),
            plugin_id: app.plugin_id.clone(),
            tool_name: app.tool_name.clone(),
            resource_uri: app.resource_uri.clone(),
            mime_type: app.mime_type.clone(),
        });
        ensure!(
            record.reference.mcp_app == expected_source
                && record.mcp_app.as_ref().is_none_or(|app| app.html.is_empty()
                    && record.reference.execution_mode == WidgetExecutionMode::IsolatedHtml
                    && record.reference.format == WidgetFormat::Html),
            "invalid_widget: stored MCP App origin mismatch"
        );
        Ok(record)
    }
}

fn validate_thread_directory(directory: &Path, thread_id: &str) -> Result<()> {
    ensure!(
        !thread_id.is_empty() && thread_id.len() <= 256,
        "invalid_widget: thread identity is invalid"
    );
    ensure!(
        directory.file_name() == Some(OsStr::new(&crate::artifact_id_path_component(thread_id))),
        "invalid_widget: storage thread mismatch"
    );
    Ok(())
}

fn validate_request(request: &WidgetCommitRequest, thread_id: &str) -> Result<()> {
    ensure!(
        request.identity.thread_id == thread_id,
        "invalid_widget: request belongs to another thread"
    );
    for id in [
        &request.identity.turn_id,
        &request.identity.attempt_id,
        &request.identity.tool_call_id,
    ] {
        ensure!(
            !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control),
            "invalid_widget: invalid execution identity"
        );
    }
    ensure!(
        !request.title.trim().is_empty() && request.title.len() <= WIDGET_TITLE_BYTES,
        "invalid_widget: /title must contain 1..256 bytes"
    );
    ensure!(
        !request.summary.trim().is_empty() && request.summary.len() <= WIDGET_SUMMARY_BYTES,
        "invalid_widget: /summary must contain 1..4096 bytes"
    );
    ensure!(
        !request.source.is_empty() && request.source.len() <= WIDGET_SOURCE_BYTES,
        "widget_quota: /widget_code must contain 1..1048576 bytes"
    );
    ensure!(
        request.libraries.len() <= 3,
        "invalid_widget: too many library entries"
    );
    Ok(())
}

fn validate_widget_id(id: &str) -> Result<()> {
    ensure!(
        id.len() == 65
            && id.starts_with('w')
            && id[1..].bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid_widget: malformed widget identity"
    );
    Ok(())
}

fn record_name(id: &str, revision: u64) -> Result<String> {
    validate_widget_id(id)?;
    ensure!(revision > 0, "invalid_widget: revision must be positive");
    Ok(format!("{id}.{revision}.json"))
}

fn render_record_name(reference: &WidgetRef) -> Result<String> {
    Ok(format!(
        "{}.render",
        record_name(&reference.widget_id, reference.revision)?
    ))
}

fn validate_render_code(status: WidgetRenderStatus, code: Option<&str>) -> Result<()> {
    if let Some(code) = code {
        ensure!(
            status == WidgetRenderStatus::Failed
                && !code.is_empty()
                && code.len() <= 64
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
            "invalid_widget: errorCode must be a bounded diagnostic code for a failed render"
        );
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(call: &str) -> WidgetCommitRequest {
        WidgetCommitRequest {
            identity: WidgetIdentity {
                thread_id: "thread-1".into(),
                turn_id: "turn-1".into(),
                attempt_id: "attempt-1".into(),
                tool_call_id: call.into(),
            },
            title: "Example".into(),
            summary: "A real retained widget".into(),
            format: WidgetFormat::Svg,
            execution_mode: WidgetExecutionMode::Managed,
            libraries: vec![],
            source: "<svg></svg>".into(),
            widget_id: None,
            expected_revision: None,
        }
    }

    #[test]
    fn restart_and_lost_receipt_reuse_the_same_immutable_content() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("thread-1");
        let first = WidgetStore::open(&dir, "thread-1")
            .unwrap()
            .commit(request("call-1"))
            .unwrap();
        let store = WidgetStore::open_existing(&dir, "thread-1")
            .unwrap()
            .unwrap();
        assert_eq!(store.commit(request("call-1")).unwrap(), first);
        assert_eq!(store.read(&first.widget_id, 1).unwrap().1, "<svg></svg>");
        assert_eq!(store.list(0, 50).unwrap().0.len(), 1);
        let mut bad = request("call-1");
        bad.source = "<svg>different</svg>".into();
        assert!(
            store
                .commit(bad)
                .unwrap_err()
                .to_string()
                .contains("widget_conflict")
        );
    }

    #[test]
    fn update_preserves_history_and_rejects_a_stale_revision() {
        let temp = tempfile::tempdir().unwrap();
        let store = WidgetStore::open(&temp.path().join("thread-1"), "thread-1").unwrap();
        let first = store.commit(request("call-1")).unwrap();
        let mut update = request("call-2");
        update.widget_id = Some(first.widget_id.clone());
        update.expected_revision = Some(1);
        update.source = "<svg>updated</svg>".into();
        let second = store.commit(update.clone()).unwrap();
        assert_eq!(second.revision, 2);
        update.identity.tool_call_id = "call-3".into();
        assert!(
            store
                .commit(update)
                .unwrap_err()
                .to_string()
                .contains("revision_conflict")
        );
        assert_eq!(store.read(&first.widget_id, 1).unwrap().1, "<svg></svg>");
    }

    #[test]
    fn reads_do_not_create_missing_directories_or_accept_other_thread_paths() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("thread-1");
        assert!(
            WidgetStore::open_existing(&dir, "thread-1")
                .unwrap()
                .is_none()
        );
        assert!(!dir.exists());
        assert!(WidgetStore::open(&dir, "thread-2").is_err());
    }

    #[test]
    fn corrupt_content_and_path_traversal_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("thread-1");
        let store = WidgetStore::open(&dir, "thread-1").unwrap();
        let first = store.commit(request("call-1")).unwrap();
        assert!(store.read("../other", 1).is_err());
        let file = dir
            .join("widgets")
            .join(record_name(&first.widget_id, 1).unwrap());
        let mut record: Record = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        record.source.push('x');
        std::fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(
            store
                .read(&first.widget_id, 1)
                .unwrap_err()
                .to_string()
                .contains("digest mismatch")
        );
    }

    #[test]
    fn client_render_observations_survive_restart_without_changing_content_or_receipts() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("thread-1");
        let store = WidgetStore::open(&dir, "thread-1").unwrap();
        let widget = store.commit(request("call-1")).unwrap();
        let observation = store
            .record_render_observation(
                &widget,
                WidgetRenderStatus::Failed,
                Some("render_failed".into()),
            )
            .unwrap();
        assert_eq!(
            store
                .record_render_observation(
                    &widget,
                    WidgetRenderStatus::Failed,
                    Some("render_failed".into())
                )
                .unwrap(),
            observation
        );
        assert!(
            store
                .record_render_observation(
                    &widget,
                    WidgetRenderStatus::Failed,
                    Some("untrusted\nmodel instructions".into())
                )
                .is_err()
        );
        assert!(
            store
                .record_render_observation(
                    &widget,
                    WidgetRenderStatus::Rendered,
                    Some("unexpected_code".into())
                )
                .is_err()
        );
        let mut forged = widget.clone();
        forged.identity.attempt_id = "different-attempt".into();
        assert!(
            store
                .record_render_observation(&forged, WidgetRenderStatus::Rendered, None)
                .is_err()
        );
        drop(store);
        let reopened = WidgetStore::open_existing(&dir, "thread-1")
            .unwrap()
            .unwrap();
        assert_eq!(
            reopened.render_observation(&widget).unwrap(),
            Some(observation)
        );
        assert_eq!(reopened.list(0, 50).unwrap().0, vec![widget.clone()]);
        assert_eq!(reopened.commit(request("call-1")).unwrap(), widget);
        assert_eq!(
            reopened.read(&widget.widget_id, 1).unwrap().1,
            "<svg></svg>"
        );
    }

    #[test]
    fn call_lookup_refuses_ambiguous_ids_and_latest_follows_only_compatible_revisions() {
        let temp = tempfile::tempdir().unwrap();
        let store = WidgetStore::open(&temp.path().join("thread-1"), "thread-1").unwrap();
        let first = store.commit(request("call-1")).unwrap();
        assert_eq!(store.find_call("call-1", None).unwrap().0, first);
        let mut retry = request("call-1");
        retry.identity.attempt_id = "attempt-2".into();
        let second = store.commit(retry).unwrap();
        assert!(
            store
                .find_call("call-1", None)
                .unwrap_err()
                .to_string()
                .contains("widget_conflict")
        );
        assert_eq!(
            store.find_call("call-1", Some("attempt-2")).unwrap().0,
            second
        );
        assert_eq!(store.latest(&first.widget_id).unwrap().0, first);
        assert!(store.find_call("missing", None).is_err());
    }

    #[test]
    fn failed_rendering_updates_are_bounded_per_task_and_do_not_block_a_new_user_task() {
        let temp = tempfile::tempdir().unwrap();
        let store = WidgetStore::open(&temp.path().join("thread-1"), "thread-1").unwrap();
        let mut widget = store.commit(request("call-0")).unwrap();
        for revision in 1..=3 {
            store
                .record_render_observation(
                    &widget,
                    WidgetRenderStatus::Failed,
                    Some("render_failed".into()),
                )
                .unwrap();
            let mut repair = request(&format!("call-{revision}"));
            repair.widget_id = Some(widget.widget_id.clone());
            repair.expected_revision = Some(widget.revision);
            let result = store.commit(repair);
            if revision == 3 {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("widget_repair_budget_exhausted")
                );
            } else {
                widget = result.unwrap();
            }
        }
        let mut later = request("user-request-2");
        later.identity.turn_id = "turn-2".into();
        later.identity.attempt_id = "attempt-2".into();
        later.widget_id = Some(widget.widget_id);
        later.expected_revision = Some(3);
        assert_eq!(store.commit(later).unwrap().revision, 4);
    }

    #[test]
    fn mcp_artifacts_keep_ui_only_data_in_one_record_and_validate_original_connection() {
        use kcoder_types::mcp_apps::*;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("thread-1");
        let store = WidgetStore::open(&dir, "thread-1").unwrap();
        let view = McpAppView {
            server_name: "source-server".into(),
            connection_id: "original-connection".into(),
            plugin_id: Some("fixture-plugin".into()),
            tool_name: "chart".into(),
            resource_uri: "ui://charts/view".into(),
            mime_type: MCP_APP_MIME_TYPE.into(),
            html: "<html>ui-only-secret-marker</html>".into(),
            csp: McpAppCsp::default(),
            requested_permissions: McpAppPermissions::default(),
            prefers_border: Some(true),
            structured_content: Some(serde_json::json!({"uiData":42})),
            result_meta: Some(serde_json::json!({"uiOnly":"private-metadata"})),
            tool_input: Some(serde_json::json!({"values":[1,2]})),
            tool_content: vec![],
        };
        let widget = store
            .commit_mcp_app(
                request("app-call").identity,
                "Chart".into(),
                "Two values".into(),
                view.clone(),
            )
            .unwrap();
        assert_eq!(store.read_mcp_app(&widget.widget_id, 1).unwrap().1, view);
        let path = dir
            .join("widgets")
            .join(record_name(&widget.widget_id, 1).unwrap());
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            String::from_utf8(bytes.clone())
                .unwrap()
                .matches("ui-only-secret-marker")
                .count(),
            1
        );
        let mut corrupt: Record = serde_json::from_slice(&bytes).unwrap();
        corrupt.mcp_app.as_mut().unwrap().connection_id = "replacement-connection".into();
        std::fs::write(&path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
        assert!(
            store
                .read_mcp_app(&widget.widget_id, 1)
                .unwrap_err()
                .to_string()
                .contains("origin mismatch")
        );
    }
}
