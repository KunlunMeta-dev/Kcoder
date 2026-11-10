use crate::session_persistence::{
    load_session_state, parse_session_state, session_id_from_history_path,
    session_state_path_for_history,
};
use crate::{SessionMode, session_state_path};
use anyhow::Context;
use std::fs;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};

mod goal_observation;
mod timestamps;
pub(super) use goal_observation::HeldGoalMetadata;
const TASK_WORKSPACE_METADATA_LIMIT: u64 = 8 * 1024 * 1024;

/// One call's validated sidecar fields, not a reusable cache or an authorization decision.
pub struct PreparedSessionMetadata {
    path: PathBuf,
    base_cwd: Option<PathBuf>,
    session_mode: SessionMode,
    studio_work_mode: kcoder_types::StudioWorkMode,
    studio_tool_selection: Option<kcoder_types::StudioToolSelections>,
    model_selection_mode: kcoder_types::ModelSelectionMode,
    selected_model: Option<String>,
    agent_definition: Option<kcoder_types::agent_definition::AgentTaskBinding>,
    channel_task_source: Option<kcoder_types::agent_definition::ChannelTaskSource>,
    workflow_definition_id: Option<String>,
    created_at_ms: Option<u64>,
    updated_at_ms: Option<u64>,
}

/// Immutable bytes copied under a caller's source fence; parsing can happen after releasing it.
pub struct CapturedSessionMetadata {
    history_path: PathBuf,
    selected: PathBuf,
    selection: &'static str,
    identity: Option<(u64, u64)>,
    bytes: Option<Vec<u8>>,
}

/// Bounded sidecar facts for comparison with a resident Goal observation.
/// These values are not an authorization or a reusable persistence receipt.
pub struct PreparedGoalObservation {
    pub base_cwd: Option<PathBuf>,
    pub goal: Option<(String, u64, crate::GoalStatus)>,
    pub goal_created_at_ms: Option<u64>,
}

/// Read-only historical facts; these records never authorize a new agent run.
pub struct PersistedSubagentRecord {
    pub id: String,
    pub description: String,
    pub status: kcoder_types::TaskStatus,
    pub background_run: Option<kcoder_types::BackgroundRunKey>,
}

pub struct PersistedSubagentSnapshot {
    pub agents: Vec<PersistedSubagentRecord>,
    pub complete: bool,
}

impl CapturedSessionMetadata {
    /// Capture an existing sidecar between two checks of its history source fence.
    ///
    /// Lock acquisition is nonblocking, but filesystem operations may block and
    /// must run on an owned bounded worker. This method never creates a lock or
    /// repairs an incomplete source. Parse after the returned fence is released.
    pub fn try_capture_fenced_goal(
        path: &Path,
        max_bytes: u64,
        check: impl FnMut() -> anyhow::Result<()>,
    ) -> anyhow::Result<Self> {
        crate::history_store::try_capture_goal_metadata(path, max_bytes, check)
    }

    /// Parse only the owned bytes; a missing sidecar does not prove no Goal.
    pub fn prepare_goal_observation(self) -> anyhow::Result<PreparedGoalObservation> {
        let bytes = self.bytes.context("session sidecar is unavailable")?;
        // Ordinary restoration maps unknown Goal statuses to Paused for legacy
        // compatibility. A status observation must preserve unknown as unknown.
        let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
        match raw.get("goal") {
            None | Some(serde_json::Value::Null) => {}
            Some(serde_json::Value::Object(goal)) => {
                anyhow::ensure!(
                    goal.get("goal_id")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|id| !id.is_empty()),
                    "goal identity is unavailable"
                );
                anyhow::ensure!(
                    goal.get("revision")
                        .and_then(serde_json::Value::as_u64)
                        .is_some(),
                    "goal revision is unavailable"
                );
                anyhow::ensure!(
                    matches!(
                        goal.get("status").and_then(serde_json::Value::as_str),
                        Some(
                            "active"
                                | "paused"
                                | "blocked"
                                | "usage_limited"
                                | "budget_limited"
                                | "complete"
                                | "cancelled"
                        )
                    ),
                    "goal status is unavailable"
                );
            }
            _ => anyhow::bail!("goal is corrupt"),
        }
        let state = parse_session_state(
            &self.selected,
            std::str::from_utf8(&bytes).context("session sidecar is not UTF-8")?,
        )?;
        Ok(PreparedGoalObservation {
            base_cwd: state.base_cwd.or(state.cwd),
            goal_created_at_ms: state.goal.as_ref().map(|goal| goal.created_at_ms),
            goal: state
                .goal
                .map(|goal| (goal.goal_id, goal.revision, goal.status)),
        })
    }

    /// Compare copied bytes with the actual source control's last metadata operation.
    /// This proves only that the observed transaction records these bytes.
    pub(super) fn matches_source_metadata(
        &self,
        relative_path: &[String],
        length: u64,
        sha256: &str,
    ) -> anyhow::Result<bool> {
        use sha2::{Digest, Sha256};
        let parent = self
            .history_path
            .parent()
            .context("history parent unavailable")?;
        let relative = self
            .selected
            .strip_prefix(parent)
            .context("sidecar is outside history parent")?;
        let components = relative
            .components()
            .map(|part| match part {
                std::path::Component::Normal(value) => {
                    value.to_str().context("sidecar path is not UTF-8")
                }
                _ => anyhow::bail!("sidecar path is not relative"),
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let bytes = self
            .bytes
            .as_ref()
            .context("session sidecar is unavailable")?;
        Ok(components
            .iter()
            .copied()
            .eq(relative_path.iter().map(String::as_str))
            && u64::try_from(bytes.len())? == length
            && format!("{:x}", Sha256::digest(bytes)) == sha256)
    }

    pub fn bytes_read(&self) -> usize {
        self.bytes.as_ref().map_or(0, Vec::len)
    }

    /// Return only owned subagent facts from a supported, captured sidecar.
    /// Missing and legacy sidecars do not prove that no historical agents existed.
    pub fn prepare_subagents(self) -> anyhow::Result<Option<PersistedSubagentSnapshot>> {
        let Some(bytes) = self.bytes else {
            return Ok(None);
        };
        let session_id = session_id_from_history_path(&self.history_path)?;
        let state = parse_session_state(
            &self.selected,
            std::str::from_utf8(&bytes).context("session sidecar is not UTF-8")?,
        )?;
        if state.schema_version < crate::session_persistence::SESSION_STATE_SCHEMA_VERSION {
            return Ok(None);
        }
        let mut complete = true;
        let mut agents = Vec::new();
        let mut observed = 0usize;
        for (key, task) in state.tasks {
            if task.kind != crate::TaskKind::Subagent {
                continue;
            }
            observed += 1;
            anyhow::ensure!(observed <= 512, "historical agent capacity exceeded");
            match task.parent_session_id.as_deref() {
                None => {
                    complete = false;
                    continue;
                }
                Some(parent) if parent != session_id => continue,
                Some(_) => {}
            }
            if task.id.is_empty() || task.id != key {
                complete = false;
                continue;
            }
            let background_run = task.background_run.filter(|run| {
                let valid = run.parent_session_id == session_id && run.agent_id == task.id;
                if !valid {
                    complete = false;
                }
                valid
            });
            agents.push(PersistedSubagentRecord {
                id: task.id,
                description: task.description,
                status: task.status,
                background_run,
            });
        }
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(Some(PersistedSubagentSnapshot { agents, complete }))
    }

    /// Hash the selected raw input and its explicit missing/primary/legacy decision, without IO.
    pub fn input_key(&self) -> anyhow::Result<[u8; 32]> {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        hash.update(serde_json::to_vec(&(
            "kcoder.captured-session-metadata.v1",
            &self.history_path,
            &self.selected,
            self.selection,
            self.identity,
        ))?);
        if let Some(bytes) = &self.bytes {
            hash.update((bytes.len() as u64).to_le_bytes());
            hash.update(bytes);
        }
        Ok(hash.finalize().into())
    }

    /// Use exactly the copied UTF-8/schema input, never reopen the sidecar to parse it.
    pub fn prepare(self) -> anyhow::Result<PreparedSessionMetadata> {
        let state = match self.bytes {
            Some(bytes) => parse_session_state(
                &self.selected,
                std::str::from_utf8(&bytes).context("session sidecar is not UTF-8")?,
            )?,
            None => crate::PersistedSessionState::default(),
        };
        Ok(PreparedSessionMetadata::from_state(
            &self.history_path,
            state,
        ))
    }
}

/// Copy one existing sidecar without parsing, creating files or repairing legacy metadata.
/// Only an actual NotFound selects the legacy path; invalid handles and permissions are errors.
pub fn capture_session_metadata_bounded(
    path: &Path,
    max_bytes: u64,
) -> anyhow::Result<CapturedSessionMetadata> {
    capture_session_metadata_bounded_with_check(path, max_bytes, || Ok(()))
}

/// The caller can share a cooperative deadline with other fenced input copies.
/// A blocking filesystem syscall cannot be preempted; the next boundary rejects expiry.
pub fn capture_session_metadata_bounded_with_check(
    path: &Path,
    max_bytes: u64,
    check: impl FnMut() -> anyhow::Result<()>,
) -> anyhow::Result<CapturedSessionMetadata> {
    capture_metadata_with_limit(path, max_bytes, 1024 * 1024, check)
}

/// Capture one session sidecar for a bounded historical task observation.
pub fn capture_task_workspace_metadata(
    path: &Path,
    check: impl FnMut() -> anyhow::Result<()>,
) -> anyhow::Result<CapturedSessionMetadata> {
    capture_metadata_with_limit(
        path,
        TASK_WORKSPACE_METADATA_LIMIT,
        TASK_WORKSPACE_METADATA_LIMIT,
        check,
    )
}

fn capture_metadata_with_limit(
    path: &Path,
    max_bytes: u64,
    ceiling: u64,
    mut check: impl FnMut() -> anyhow::Result<()>,
) -> anyhow::Result<CapturedSessionMetadata> {
    anyhow::ensure!(
        (1..=ceiling).contains(&max_bytes),
        "invalid captured metadata budget"
    );
    let session_id = session_id_from_history_path(path)?;
    let parent = path.parent().context("session sidecar has no parent")?;
    let primary = session_state_path(parent, &session_id);
    let legacy = session_state_path_for_history(path);
    check()?;
    let directory = kcoder_config::PrivateDirectory::open_existing(parent)?;
    for (selected, selection) in [(&primary, "primary"), (&legacy, "legacy")] {
        check()?;
        // The primary sidecar is <session>/state.json; legacy state is a root leaf.
        let selected_directory;
        let directory = if selection == "primary" {
            let name = primary
                .parent()
                .and_then(Path::file_name)
                .context("primary sidecar has no session directory")?;
            selected_directory = match directory.open_child(name, false) {
                Ok(directory) => directory,
                Err(error) if metadata_not_found(&error) => continue,
                Err(error) => return Err(error),
            };
            &selected_directory
        } else {
            &directory
        };
        let name = selected
            .file_name()
            .context("session sidecar has no name")?;
        let mut file = match directory.open_regular_file_snapshot(name) {
            Ok(file) => file,
            Err(error) if metadata_not_found(&error) => continue,
            Err(error) => return Err(error),
        };
        check()?;
        let before = file.metadata()?;
        check()?;
        anyhow::ensure!(
            before.len() <= max_bytes,
            "session sidecar exceeds byte budget"
        );
        let identity = crate::history_index::transcript_input_identity(&file)?;
        check()?;
        let mut bytes = Vec::with_capacity(before.len() as usize);
        let mut chunk = [0_u8; 16 * 1024];
        while (bytes.len() as u64) < before.len() {
            check()?;
            let allowance = (before.len() - bytes.len() as u64).min(chunk.len() as u64) as usize;
            let read = file.read(&mut chunk[..allowance])?;
            check()?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        let after = file.metadata()?;
        check()?;
        let current_identity = crate::history_index::transcript_input_identity(
            &directory.open_regular_file_snapshot(name)?,
        )?;
        check()?;
        anyhow::ensure!(
            bytes.len() as u64 <= max_bytes
                && before.len() == bytes.len() as u64
                && after.len() == before.len()
                && after.modified().ok() == before.modified().ok()
                && current_identity == identity,
            "session sidecar changed during capture"
        );
        return Ok(CapturedSessionMetadata {
            history_path: path.to_path_buf(),
            selected: selected.to_path_buf(),
            selection,
            identity: Some(identity),
            bytes: Some(bytes),
        });
    }
    check()?;
    Ok(CapturedSessionMetadata {
        history_path: path.to_path_buf(),
        selected: primary,
        selection: "missing",
        identity: None,
        bytes: None,
    })
}

fn metadata_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

pub fn prepare_session_metadata(path: &Path) -> anyhow::Result<PreparedSessionMetadata> {
    let state = load_metadata_state(path)?;
    Ok(PreparedSessionMetadata::from_state(path, state))
}

/// Read the original session configuration at a tracked commit boundary.
/// The result is a preview only. Restoring or owning the task still requires
/// the normal history validation and lease. Untracked and recovering sources
/// need the existing full preparation path.
pub fn prepare_committed_session_metadata(
    path: &Path,
) -> anyhow::Result<Option<PreparedSessionMetadata>> {
    use crate::history_store::source_stamp;
    let before = source_stamp(path)?;
    let Some(bytes) = before.known_committed_bytes() else {
        return Ok(None);
    };
    let parent = path.parent().context("history has no parent")?;
    let name = path.file_name().context("history has no file name")?;
    let file = kcoder_config::PrivateDirectory::open_existing(parent)?
        .open_single_link_regular_file(name)?;
    if file.metadata()?.len() != bytes {
        anyhow::ensure!(
            source_stamp(path)? == before,
            "SESSION_CONFIGURATION_PREVIEW_CHANGED"
        );
        anyhow::bail!("committed history length changed during model preflight");
    }
    // Large existing sidecars retain the ordinary compatibility path.
    if fs::symlink_metadata(metadata_state_path(path)?)
        .is_ok_and(|meta| meta.len() > TASK_WORKSPACE_METADATA_LIMIT)
    {
        return Ok(None);
    }
    let captured = capture_task_workspace_metadata(path, || Ok(()));
    anyhow::ensure!(
        file.metadata()?.len() == bytes && source_stamp(path)? == before,
        "SESSION_CONFIGURATION_PREVIEW_CHANGED"
    );
    Ok(Some(captured?.prepare()?))
}

/// Read one validated regular sidecar handle, consuming at most `max_bytes + 1` bytes.
/// The extra byte detects overflow; oversized sidecars are errors, never truncated metadata.
pub fn prepare_session_metadata_bounded(
    path: &Path,
    max_bytes: u64,
) -> anyhow::Result<PreparedSessionMetadata> {
    let sidecar = metadata_state_path(path)?;
    let open = || -> anyhow::Result<std::fs::File> {
        let parent = sidecar.parent().context("session sidecar has no parent")?;
        let name = sidecar
            .file_name()
            .context("session sidecar has no file name")?;
        kcoder_config::PrivateDirectory::open_existing(parent)?.open_regular_file(name)
    };
    let state = match open() {
        Ok(file) => read_bounded_metadata(&sidecar, file, max_bytes)?,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            crate::PersistedSessionState::default()
        }
        Err(error) => return Err(error),
    };
    Ok(PreparedSessionMetadata::from_state(path, state))
}

fn read_bounded_metadata(
    path: &Path,
    reader: impl Read,
    max_bytes: u64,
) -> anyhow::Result<crate::PersistedSessionState> {
    let limit = max_bytes
        .checked_add(1)
        .context("invalid sidecar byte budget")?;
    let mut content = Vec::new();
    reader.take(limit).read_to_end(&mut content)?;
    anyhow::ensure!(
        content.len() as u64 <= max_bytes,
        "session sidecar exceeds byte budget"
    );
    parse_session_state(
        path,
        std::str::from_utf8(&content).context("session sidecar is not UTF-8")?,
    )
}

impl PreparedSessionMetadata {
    fn from_state(path: &Path, state: crate::PersistedSessionState) -> Self {
        Self {
            path: path.to_path_buf(),
            base_cwd: state.base_cwd.or(state.cwd),
            session_mode: state.session_mode,
            studio_work_mode: state.studio_work_mode,
            studio_tool_selection: state.studio_tool_selection,
            model_selection_mode: state.model_selection_mode,
            selected_model: state.selected_model,
            agent_definition: state.agent_definition,
            channel_task_source: state.channel_task_source,
            workflow_definition_id: state.workflow_definition_id,
            created_at_ms: state.created_at_ms,
            updated_at_ms: state.updated_at_ms,
        }
    }

    /// Bind all prepared inputs actually used by list projection, not future sidecar freshness.
    pub fn list_input_key(&self) -> anyhow::Result<[u8; 32]> {
        use sha2::{Digest, Sha256};
        let encoded = serde_json::to_vec(&(
            "kcoder.prepared-list-input.v1",
            &self.path,
            &self.base_cwd,
            self.session_mode,
            self.studio_work_mode,
            self.model_selection_mode,
            &self.selected_model,
            &self.agent_definition,
            &self.channel_task_source,
            &self.workflow_definition_id,
            self.created_at_ms,
            self.updated_at_ms,
        ))?;
        Ok(Sha256::digest(encoded).into())
    }

    pub fn channel_task_source(
        &self,
    ) -> Option<&kcoder_types::agent_definition::ChannelTaskSource> {
        self.channel_task_source.as_ref()
    }

    pub fn agent_definition(&self) -> Option<&kcoder_types::agent_definition::AgentTaskBinding> {
        self.agent_definition.as_ref()
    }

    pub fn model_selection_mode(&self) -> kcoder_types::ModelSelectionMode {
        self.model_selection_mode
    }

    pub fn selected_model(&self) -> Option<&str> {
        self.selected_model.as_deref()
    }

    /// Preserve the same client selection used by a real resume, with no
    /// attached history, persistence writer, or execution authority.
    pub fn client_configuration_preview(&self, cwd: &Path) -> crate::AppState {
        let state = crate::AppState::new(cwd);
        {
            let mut inner = state.write_inner();
            inner.session_mode = self.session_mode;
            inner.studio_work_mode = self.studio_work_mode;
            inner.studio_tool_selection = self.studio_tool_selection.clone();
            inner.model_selection_mode = self.model_selection_mode;
            inner.selected_model = self.selected_model.clone();
        }
        state
    }

    pub fn workflow_definition_id(&self) -> Option<&str> {
        self.workflow_definition_id.as_deref()
    }

    pub fn base_cwd(&self) -> Option<&Path> {
        self.base_cwd.as_deref()
    }
    pub fn studio_work_mode(&self) -> kcoder_types::StudioWorkMode {
        self.studio_work_mode
    }

    pub fn session_mode(&self) -> SessionMode {
        self.session_mode
    }

    /// Scan timestamps only after the caller has checked the prepared workspace identity.
    pub fn timestamps_ms(&self) -> anyhow::Result<(u64, u64)> {
        Ok(HistoryTimestampBounds::read(&self.path)?.resolve(
            &self.path,
            self.created_at_ms,
            self.updated_at_ms,
        ))
    }

    pub fn first_prompt(&self, max_chars: usize) -> Option<String> {
        crate::history::session_first_prompt(&self.path, max_chars)
    }

    pub(crate) fn observed_timestamps_ms(
        &self,
        bounds: &HistoryTimestampBounds,
        modified: Option<std::time::SystemTime>,
    ) -> (u64, u64) {
        bounds.resolve_with_fallback(self.created_at_ms, self.updated_at_ms, || {
            modified
                .and_then(|timestamp| timestamp.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default()
        })
    }
}

pub(super) fn load_metadata_state(path: &Path) -> anyhow::Result<crate::PersistedSessionState> {
    load_session_state(&metadata_state_path(path)?)
}

fn metadata_state_path(path: &Path) -> anyhow::Result<PathBuf> {
    let session_id = session_id_from_history_path(path)?;
    let primary = path
        .parent()
        .map(|dir| session_state_path(dir, &session_id))
        .unwrap_or_else(|| session_state_path_for_history(path));
    let legacy = session_state_path_for_history(path);
    Ok(if primary.exists() || !legacy.exists() {
        primary
    } else {
        legacy
    })
}

#[derive(Default)]
pub(super) struct HistoryTimestampBounds {
    first: Option<u64>,
    latest: Option<u64>,
}

impl HistoryTimestampBounds {
    pub(super) fn observe(&mut self, value: &serde_json::Value) {
        let timestamp = value
            .get("timestamp_ms")
            .or_else(|| value.get("timestampMs"));
        self.observe_timestamp(timestamp.and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.parse::<u64>().ok())
        }));
    }

    fn observe_timestamp(&mut self, timestamp: Option<u64>) {
        if let Some(timestamp) = timestamp {
            self.first.get_or_insert(timestamp);
            self.latest = Some(self.latest.unwrap_or(0).max(timestamp));
        }
    }

    pub(crate) fn observe_line(&mut self, line: &str) {
        if let Ok(timestamp) = timestamps::timestamp_from_line(line) {
            self.observe_timestamp(timestamp);
        }
    }

    pub(super) fn read(path: &Path) -> anyhow::Result<Self> {
        let _span = tracing::debug_span!("history.timestamp_replay").entered();
        let mut bounds = Self::default();
        let mut reader = std::io::BufReader::new(fs::File::open(path)?);
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                break;
            }
            bounds.observe_line(&line);
        }
        Ok(bounds)
    }

    pub(super) fn resolve(
        &self,
        path: &Path,
        created_at_ms: Option<u64>,
        updated_at_ms: Option<u64>,
    ) -> (u64, u64) {
        self.resolve_with_fallback(created_at_ms, updated_at_ms, || {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|timestamp| timestamp.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default()
        })
    }

    fn resolve_with_fallback(
        &self,
        created_at_ms: Option<u64>,
        updated_at_ms: Option<u64>,
        fallback: impl FnOnce() -> u64,
    ) -> (u64, u64) {
        let created = created_at_ms.or(self.first).unwrap_or_else(fallback);
        let updated = self
            .latest
            .into_iter()
            .chain(updated_at_ms)
            .chain(self.first)
            .max()
            .unwrap_or(created)
            .max(created);
        (created, updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn committed_model_preview_uses_the_original_sidecar_without_replaying_the_body() {
        use kcoder_types::{ModelSelectionMode, StudioWorkMode};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        fs::write(&path, b"").unwrap();
        assert!(prepare_committed_session_metadata(&path).unwrap().is_none());
        let source = crate::history_store::HistorySource::bind(&path).unwrap();
        source.append(b"\xff\n").unwrap();
        let sidecar = session_state_path(temp.path(), "session");
        let body = serde_json::to_vec(&json!({
            "schema_version": 1, "base_cwd": temp.path(), "cwd": temp.path(),
            "model_selection_mode": "follow_target_default", "selected_model": "fixture/model",
            "studio_work_mode": "kworker",
        }))
        .unwrap();
        source
            .write_metadata(&sidecar, || Ok(body.clone()))
            .unwrap();
        let metadata = prepare_committed_session_metadata(&path).unwrap().unwrap();
        let preview = metadata.client_configuration_preview(temp.path());
        assert_eq!(
            preview.model_selection_mode(),
            ModelSelectionMode::FollowTargetDefault
        );
        assert_eq!(preview.selected_model().as_deref(), Some("fixture/model"));
        assert_eq!(preview.studio_work_mode(), StudioWorkMode::Kworker);
        assert!(preview.history_path().is_none());
        assert!(preview.messages().is_empty());
        assert!(crate::prepare_session_resume(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"\xff\n");
        assert_eq!(fs::read(&sidecar).unwrap(), body);
        fs::write(&path, b"untracked modification\n").unwrap();
        assert!(prepare_committed_session_metadata(&path).is_err());
    }

    #[test]
    fn historical_subagents_require_a_supported_captured_sidecar_and_original_parent() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let sidecar = session_state_path_for_history(&history);
        assert!(
            capture_task_workspace_metadata(&history, || Ok(()))
                .unwrap()
                .prepare_subagents()
                .unwrap()
                .is_none()
        );
        fs::write(&sidecar, br#"{"schema_version":1}"#).unwrap();
        assert!(
            capture_task_workspace_metadata(&history, || Ok(()))
                .unwrap()
                .prepare_subagents()
                .unwrap()
                .is_none()
        );

        let mut own = crate::Task::new("own", "Owned agent");
        own.kind = crate::TaskKind::Subagent;
        own.parent_session_id = Some("session".into());
        own.status = kcoder_types::TaskStatus::Completed;
        own.background_run = Some(kcoder_types::BackgroundRunKey {
            parent_session_id: "session".into(),
            agent_id: "own".into(),
            run_id: "run-1".into(),
        });
        let mut foreign = crate::Task::new("foreign", "Other session");
        foreign.kind = crate::TaskKind::Subagent;
        foreign.parent_session_id = Some("other".into());
        let mut missing_parent = crate::Task::new("missing", "Unbound");
        missing_parent.kind = crate::TaskKind::Subagent;
        fs::write(&sidecar, serde_json::to_vec(&json!({"schema_version":2,"delivery_format":"lease_ack_v1","tasks":{"own":own,"foreign":foreign,"missing":missing_parent}})).unwrap()).unwrap();
        let before = fs::read(&sidecar).unwrap();
        let snapshot = capture_task_workspace_metadata(&history, || Ok(()))
            .unwrap()
            .prepare_subagents()
            .unwrap()
            .unwrap();
        assert!(!snapshot.complete);
        assert_eq!(snapshot.agents.len(), 1);
        assert_eq!(snapshot.agents[0].id, "own");
        assert_eq!(
            snapshot.agents[0].status,
            kcoder_types::TaskStatus::Completed
        );
        assert_eq!(
            snapshot.agents[0].background_run.as_ref().unwrap().run_id,
            "run-1"
        );
        assert_eq!(fs::read(&sidecar).unwrap(), before);
    }

    #[test]
    fn historical_subagents_distinguish_empty_records_from_missing_and_reject_bad_bindings() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let sidecar = session_state_path_for_history(&history);
        fs::write(
            &sidecar,
            br#"{"schema_version":2,"delivery_format":"lease_ack_v1"}"#,
        )
        .unwrap();
        let empty = capture_task_workspace_metadata(&history, || Ok(()))
            .unwrap()
            .prepare_subagents()
            .unwrap()
            .unwrap();
        assert!(empty.complete && empty.agents.is_empty());
        let mut task = crate::Task::new("agent", "Agent");
        task.kind = crate::TaskKind::Subagent;
        task.parent_session_id = Some("session".into());
        task.background_run = Some(kcoder_types::BackgroundRunKey {
            parent_session_id: "other".into(),
            agent_id: "agent".into(),
            run_id: "run-1".into(),
        });
        fs::write(&sidecar, serde_json::to_vec(&json!({"schema_version":2,"delivery_format":"lease_ack_v1","tasks":{"agent":task}})).unwrap()).unwrap();
        let invalid = capture_task_workspace_metadata(&history, || Ok(()))
            .unwrap()
            .prepare_subagents()
            .unwrap()
            .unwrap();
        assert!(
            !invalid.complete
                && invalid.agents.len() == 1
                && invalid.agents[0].background_run.is_none()
        );
    }

    #[cfg(unix)]
    #[test]
    fn captured_metadata_rejects_hard_linked_sidecars() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let sidecar = session_state_path_for_history(&history);
        fs::write(&sidecar, br#"{"schema_version":1}"#).unwrap();
        fs::hard_link(&sidecar, temp.path().join("alias.json")).unwrap();
        assert!(capture_task_workspace_metadata(&history, || Ok(())).is_err());
    }

    #[test]
    fn captured_metadata_preserves_missing_legacy_and_nested_primary_selection() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let primary = session_state_path(temp.path(), "session");
        let legacy = session_state_path_for_history(&history);
        let missing = capture_session_metadata_bounded(&history, 1024).unwrap();
        let missing_key = missing.input_key().unwrap();
        assert_eq!(missing.bytes_read(), 0);
        assert_eq!(missing.prepare().unwrap().base_cwd(), None);
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
        fs::write(&legacy, br#"{"schema_version":1,"cwd":"legacy"}"#).unwrap();
        let captured = capture_session_metadata_bounded(&history, 1024).unwrap();
        assert_ne!(captured.input_key().unwrap(), missing_key);
        assert_eq!(
            captured.prepare().unwrap().base_cwd(),
            Some(Path::new("legacy"))
        );
        fs::create_dir(primary.parent().unwrap()).unwrap();
        fs::write(&primary, br#"{"schema_version":1,"base_cwd":"primary"}"#).unwrap();
        let captured = capture_session_metadata_bounded(&history, 1024).unwrap();
        assert_eq!(
            captured.prepare().unwrap().base_cwd(),
            Some(Path::new("primary"))
        );
        assert_eq!(
            prepare_session_metadata(&history).unwrap().base_cwd(),
            Some(Path::new("primary"))
        );
    }

    #[test]
    fn captured_metadata_parses_only_its_immutable_bytes_after_capture() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let sidecar = session_state_path_for_history(&history);
        let first = br#"{"schema_version":1,"cwd":"first"}"#;
        fs::write(&sidecar, first).unwrap();
        let captured = capture_session_metadata_bounded(&history, 1024).unwrap();
        let key = captured.input_key().unwrap();
        assert_eq!(captured.bytes_read(), first.len());
        fs::write(&sidecar, br#"{"schema_version":1,"cwd":"second"}"#).unwrap();
        assert_eq!(
            captured.prepare().unwrap().base_cwd(),
            Some(Path::new("first"))
        );
        let next = capture_session_metadata_bounded(&history, 1024).unwrap();
        assert_ne!(next.input_key().unwrap(), key);
        assert_eq!(
            next.prepare().unwrap().base_cwd(),
            Some(Path::new("second"))
        );
    }

    #[test]
    fn captured_metadata_defers_utf8_and_schema_validation_without_legacy_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let primary = session_state_path(temp.path(), "session");
        fs::create_dir(primary.parent().unwrap()).unwrap();
        fs::write(
            session_state_path_for_history(&history),
            br#"{"schema_version":1}"#,
        )
        .unwrap();
        for bytes in [
            b"\xff".as_slice(),
            b"{",
            br#"{"schema_version":4294967295}"#,
        ] {
            fs::write(&primary, bytes).unwrap();
            let captured = capture_session_metadata_bounded(&history, 1024).unwrap();
            assert_eq!(captured.bytes_read(), bytes.len());
            assert!(captured.prepare().is_err());
            assert!(prepare_session_metadata_bounded(&history, 1024).is_err());
            assert_eq!(fs::read(&primary).unwrap(), bytes);
        }
    }

    #[test]
    fn captured_metadata_rejects_invalid_or_exceeded_budget_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let sidecar = session_state_path_for_history(&history);
        let bytes = br#"{"schema_version":1}"#;
        fs::write(&sidecar, bytes).unwrap();
        for budget in [0, bytes.len() as u64 - 1, 1024 * 1024 + 1, u64::MAX] {
            assert!(capture_session_metadata_bounded(&history, budget).is_err());
            assert_eq!(fs::read(&sidecar).unwrap(), bytes);
            assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
        }
        assert!(capture_session_metadata_bounded(&history, bytes.len() as u64).is_ok());
    }

    #[test]
    fn captured_metadata_shared_deadline_can_abort_copy_without_parsing_or_writes() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let sidecar = session_state_path_for_history(&history);
        let bytes = vec![b'x'; 64 * 1024];
        fs::write(&sidecar, &bytes).unwrap();
        let mut checks = 0;
        let error = capture_session_metadata_bounded_with_check(&history, 128 * 1024, || {
            checks += 1;
            anyhow::ensure!(checks < 10, "shared capture deadline expired");
            Ok(())
        })
        .err()
        .unwrap();
        assert!(
            error
                .to_string()
                .contains("shared capture deadline expired")
        );
        assert_eq!(checks, 10);
        assert_eq!(fs::read(&sidecar).unwrap(), bytes);
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
        // The unchecked copy accepts raw invalid JSON; schema validation remains a later phase.
        assert!(
            capture_session_metadata_bounded(&history, 128 * 1024)
                .unwrap()
                .prepare()
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn captured_metadata_rejects_primary_links_and_nonfiles_without_fallback() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let primary = session_state_path(temp.path(), "session");
        fs::write(
            session_state_path_for_history(&history),
            br#"{"schema_version":1}"#,
        )
        .unwrap();
        symlink(temp.path().join("absent"), primary.parent().unwrap()).unwrap();
        assert!(capture_session_metadata_bounded(&history, 1024).is_err());
        fs::remove_file(primary.parent().unwrap()).unwrap();
        fs::create_dir(primary.parent().unwrap()).unwrap();
        symlink(temp.path().join("absent"), &primary).unwrap();
        assert!(capture_session_metadata_bounded(&history, 1024).is_err());
        fs::remove_file(&primary).unwrap();
        fs::create_dir(&primary).unwrap();
        assert!(capture_session_metadata_bounded(&history, 1024).is_err());
    }

    #[test]
    fn bounded_metadata_rejects_oversize_sidecar_without_changing_legacy_reads() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let sidecar = session_state_path_for_history(&history);
        let bytes = br#"{"schema_version":1,"cwd":"project"}"#;
        fs::write(&sidecar, bytes).unwrap();
        assert!(prepare_session_metadata(&history).is_ok());
        assert!(prepare_session_metadata_bounded(&history, bytes.len() as u64).is_ok());
        assert!(prepare_session_metadata_bounded(&history, bytes.len() as u64 - 1).is_err());
    }

    #[test]
    fn bounded_metadata_reads_at_most_budget_plus_one_from_its_handle() {
        let mut input = std::io::Cursor::new(vec![b' '; 1024]);
        assert!(read_bounded_metadata(Path::new("state.json"), &mut input, 7).is_err());
        assert_eq!(input.position(), 8);
    }

    #[test]
    fn bounded_metadata_uses_shared_schema_validation_and_primary_selection() {
        let temp = tempfile::tempdir().unwrap();
        let history = temp.path().join("session.jsonl");
        let legacy = session_state_path_for_history(&history);
        let primary = session_state_path(temp.path(), "session");
        fs::write(&legacy, br#"{"schema_version":1,"cwd":"legacy"}"#).unwrap();
        assert_eq!(
            prepare_session_metadata_bounded(&history, 1024)
                .unwrap()
                .base_cwd(),
            Some(Path::new("legacy"))
        );
        fs::create_dir_all(primary.parent().unwrap()).unwrap();
        for bytes in [
            br#"{"schema_version":4294967295}"#.as_slice(),
            br#"{"schema_version":2,"delivery_format":"invalid"}"#,
            b"{",
            b"\xff",
        ] {
            fs::write(&primary, bytes).unwrap();
            assert!(prepare_session_metadata(&history).is_err());
            assert!(prepare_session_metadata_bounded(&history, 1024).is_err());
        }
        fs::write(
            &primary,
            br#"{"schema_version":2,"delivery_format":"lease_ack_v1","base_cwd":"primary"}"#,
        )
        .unwrap();
        assert_eq!(
            prepare_session_metadata_bounded(&history, 1024)
                .unwrap()
                .base_cwd(),
            Some(Path::new("primary"))
        );
    }

    #[test]
    fn prepared_list_input_key_binds_each_used_field() {
        let original = || PreparedSessionMetadata {
            path: PathBuf::from("session.jsonl"),
            base_cwd: Some(PathBuf::from("workspace")),
            session_mode: SessionMode::Default,
            studio_work_mode: Default::default(),
            studio_tool_selection: None,
            model_selection_mode: Default::default(),
            selected_model: None,
            agent_definition: None,
            channel_task_source: None,
            workflow_definition_id: None,
            created_at_ms: Some(1),
            updated_at_ms: Some(2),
        };
        let key = original().list_input_key().unwrap();
        assert_eq!(key, original().list_input_key().unwrap());
        for field in 0..9 {
            let mut prepared = original();
            match field {
                0 => prepared.path = PathBuf::from("other.jsonl"),
                1 => prepared.base_cwd = Some(PathBuf::from("other")),
                2 => prepared.session_mode = SessionMode::Orchestrate,
                3 => prepared.created_at_ms = None,
                4 => prepared.updated_at_ms = Some(3),
                5 => prepared.studio_work_mode = kcoder_types::StudioWorkMode::Kworker,
                6 => prepared.workflow_definition_id = Some("workflow-fixture".into()),
                7 => prepared.selected_model = Some("Provider::Flash".into()),
                _ => {
                    prepared.model_selection_mode =
                        kcoder_types::ModelSelectionMode::FollowTargetDefault
                }
            }
            assert_ne!(key, prepared.list_input_key().unwrap(), "field {field}");
        }
    }

    #[test]
    #[ignore = "explicit isolated timestamp scan baseline; not a timing assertion"]
    fn metadata_timestamp_scan_warm_baseline() {
        const SESSIONS: usize = 10;
        const RECORDS: usize = 2_000;
        const SAMPLES: usize = 21;
        let temp = tempfile::tempdir().unwrap();
        let text = "中文工具输出与上下文 ".repeat(32);
        let mut body = String::new();
        for ordinal in 1..=RECORDS {
            let record = json!({
                "timestamp_ms": ordinal,
                "role": if ordinal % 2 == 0 { "assistant" } else { "user" },
                "content": [{"type": "text", "text": text}],
            });
            body.push_str(&record.to_string());
            body.push('\n');
        }
        let paths: Vec<_> = (0..SESSIONS)
            .map(|index| {
                let id = format!("baseline-{index}");
                let path = temp.path().join(format!("{id}.jsonl"));
                fs::write(&path, body.as_bytes()).unwrap();
                let sidecar = session_state_path(temp.path(), &id);
                fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
                fs::write(
                    &sidecar,
                    serde_json::to_vec(&json!({
                        "schema_version": 1, "base_cwd": temp.path(),
                    }))
                    .unwrap(),
                )
                .unwrap();
                path
            })
            .collect();
        let scan = || {
            for path in &paths {
                let metadata = prepare_session_metadata(path).unwrap();
                assert_eq!(metadata.base_cwd(), Some(temp.path()));
                assert_eq!(metadata.timestamps_ms().unwrap(), (1, RECORDS as u64));
            }
        };
        // Warm this fixture only; do not evict host caches or read personal histories.
        scan();
        let mut samples = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let start = std::time::Instant::now();
            scan();
            samples.push(start.elapsed().as_micros());
        }
        samples.sort_unstable();
        let percentile = |p: usize| samples[(SAMPLES * p).div_ceil(100) - 1];
        eprintln!(
            "{}",
            json!({
                "benchmark": "prepared_metadata_timestamp_scan",
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "debug_assertions": cfg!(debug_assertions),
                "cache": "fixture-warmed",
                "sessions": SESSIONS,
                "records_per_session": RECORDS,
                "fixture_body_bytes": body.len() * SESSIONS,
                "samples": SAMPLES,
                "p50_us": percentile(50),
                "p95_us": percentile(95),
                "p99_us": percentile(99),
                "min_us": samples[0],
                "max_us": samples[SAMPLES - 1],
            })
        );
        for path in paths {
            assert_eq!(fs::read(path).unwrap(), body.as_bytes());
        }
    }

    #[test]
    fn metadata_preparation_preserves_primary_legacy_selection_and_validation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let legacy = session_state_path_for_history(&path);
        let primary = session_state_path(temp.path(), "session");
        let old_cwd = temp.path().join("legacy-project");
        let base_cwd = temp.path().join("base-project");
        fs::write(
            &legacy,
            serde_json::to_vec(&json!({"schema_version":1,"cwd":old_cwd})).unwrap(),
        )
        .unwrap();
        let metadata = prepare_session_metadata(&path).unwrap();
        assert_eq!(metadata.base_cwd(), Some(old_cwd.as_path()));
        fs::create_dir_all(primary.parent().unwrap()).unwrap();
        fs::write(
            &primary,
            serde_json::to_vec(&json!({
                "schema_version":1,"cwd":old_cwd,"base_cwd":base_cwd,"session_mode":"orchestrate"
            }))
            .unwrap(),
        )
        .unwrap();
        let metadata = prepare_session_metadata(&path).unwrap();
        assert_eq!(metadata.base_cwd(), Some(base_cwd.as_path()));
        assert_eq!(metadata.session_mode(), SessionMode::Orchestrate);
        fs::write(&primary, br#"{"schema_version":4294967295}"#).unwrap();
        assert!(
            prepare_session_metadata(&path)
                .err()
                .unwrap()
                .to_string()
                .contains("future schema")
        );
        fs::remove_file(&primary).unwrap();
        assert_eq!(
            prepare_session_metadata(&path).unwrap().base_cwd(),
            Some(old_cwd.as_path())
        );
    }

    #[test]
    fn metadata_preparation_retains_all_record_timestamps_during_resume() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let records = [
            json!({"session_id":"session","timestamp_ms":100,"uuid":"user-1","role":"user","content":[{"type":"text","text":"first request"}]}),
            json!({"type":"system","subtype":"compact_boundary","timestampMs":"900"}),
            json!({"session_id":"session","timestamp_ms":500,"uuid":"summary","isCompactSummary":true,"role":"user","content":[{"type":"text","text":"Earlier conversation summary: compacted"}]}),
            json!({"type":"system","subtype":"rewind_boundary","timestamp_ms":700,"rewindMetadata":{"anchorUuid":"summary"}}),
        ];
        let raw = records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>();
        fs::write(&path, raw).unwrap();
        let before = fs::read(&path).unwrap();
        let expected = crate::session_timestamps_ms(&path).unwrap();
        assert_eq!(expected, (100, 900));
        let resumed = crate::AppState::new(temp.path());
        resumed.resume_from_history(&path).unwrap();
        assert_eq!(resumed.session_timestamps_ms(), expected);
        assert_eq!(resumed.messages().len(), 1);
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn metadata_preparation_uses_file_mtime_only_when_all_timestamps_are_absent() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        fs::write(&path, b"{\"type\":\"system\",\"subtype\":\"notice\"}\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(42))
            .unwrap();
        assert_eq!(
            crate::session_timestamps_ms(&path).unwrap(),
            (42_000, 42_000)
        );
        let resumed = crate::AppState::new(temp.path());
        resumed.resume_from_history(&path).unwrap();
        assert_eq!(resumed.session_timestamps_ms(), (42_000, 42_000));
    }

    #[test]
    fn metadata_timestamp_resolution_preserves_field_precedence_and_state_bounds() {
        let mut bounds = HistoryTimestampBounds::default();
        for value in [
            json!({"timestamp_ms":null,"timestampMs":9999}),
            json!({"timestamp_ms":"20"}),
            json!({"timestampMs":10}),
            json!({"timestamp_ms":100}),
        ] {
            bounds.observe(&value);
        }
        let temp = tempfile::tempdir().unwrap();
        let unused = temp.path().join("not-read.jsonl");
        assert_eq!(bounds.resolve(&unused, None, None), (20, 100));
        assert_eq!(bounds.resolve(&unused, Some(5), Some(200)), (5, 200));
        assert_eq!(bounds.resolve(&unused, Some(300), Some(200)), (300, 300));
    }

    #[test]
    fn metadata_timestamp_read_matches_value_lines_and_sidecar_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let raw = concat!(
            "\r\n \t\r\n",
            "{\"timestamp_ms\":null,\"timestampMs\":9999}\r\n",
            "{\"timestamp_ms\":20,\"timestamp_ms\":\"+40\"}\r\n",
            "{\"timestamp_ms\":9000,\"body\":[1,]}\n",
            "{\"timestamp_ms\":8000} trailing\n",
            "[{\"timestamp_ms\":7000}]\n",
            "{\"timestampMs\":100,\"body\":{\"timestamp_ms\":6000}}\n",
            "{\"timestamp_ms\":0}\r\n",
            "{\"timestamp\\u005fms\":\"80\"}"
        );
        fs::write(&path, raw).unwrap();
        let mut oracle = HistoryTimestampBounds::default();
        for line in std::io::BufReader::new(raw.as_bytes()).lines() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line.unwrap()) {
                oracle.observe(&value);
            }
        }
        let actual = HistoryTimestampBounds::read(&path).unwrap();
        assert_eq!((oracle.first, oracle.latest), (Some(40), Some(100)));
        assert_eq!((actual.first, actual.latest), (oracle.first, oracle.latest));
        assert_eq!(
            prepare_session_metadata(&path)
                .unwrap()
                .timestamps_ms()
                .unwrap(),
            (40, 100)
        );
        let sidecar = session_state_path(temp.path(), "session");
        fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        for (created, updated, expected) in [
            (None, Some(150), (40, 150)),
            (Some(5), Some(90), (5, 100)),
            (Some(300), Some(200), (300, 300)),
            (Some(0), None, (0, 100)),
        ] {
            fs::write(
                &sidecar,
                serde_json::to_vec(&json!({
                    "schema_version": 1,
                    "created_at_ms": created,
                    "updated_at_ms": updated,
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(
                actual.resolve(&path, created, updated),
                oracle.resolve(&path, created, updated)
            );
            assert_eq!(
                prepare_session_metadata(&path)
                    .unwrap()
                    .timestamps_ms()
                    .unwrap(),
                expected
            );
        }
        assert_eq!(fs::read(&path).unwrap(), raw.as_bytes());
    }

    #[test]
    fn metadata_timestamp_read_propagates_io_and_utf8_errors() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        assert!(HistoryTimestampBounds::read(&path).is_err());
        assert!(HistoryTimestampBounds::read(temp.path()).is_err());
        fs::write(&path, b"{\"timestamp_ms\":1}\n\xff\n{\"timestamp_ms\":9}\n").unwrap();
        let error = HistoryTimestampBounds::read(&path).err().unwrap();
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::InvalidData
        );
    }
}
