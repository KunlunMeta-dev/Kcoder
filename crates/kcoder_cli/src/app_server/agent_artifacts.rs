use anyhow::{Context, Result};
use kcoder_app_protocol::{AgentArtifactKind, AgentArtifactReadParams, AgentArtifactReadResult};
use kcoder_engine::QueryEngine;
use kcoder_state::TaskKind;

use super::private_files::hex_sha256;

pub(super) const MAX_AGENT_ARTIFACT_BYTES: usize = 256 * 1024;

/// Failures that are not residency errors; surfaced with a dedicated code so
/// the client can distinguish "thread not active" from "artifact unavailable".
#[derive(Debug)]
pub(super) struct ArtifactUnavailable(pub(super) String);

impl std::fmt::Display for ArtifactUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ArtifactUnavailable {}

pub(super) fn read(
    engine: &QueryEngine,
    params: &AgentArtifactReadParams,
) -> Result<AgentArtifactReadResult> {
    let agent_id = params.agent_id.trim();
    if agent_id.is_empty() {
        anyhow::bail!("agent id is required");
    }
    let session_id = engine.session_id();
    let belongs_to_thread = engine.state.tasks().into_values().any(|task| {
        task.kind == TaskKind::Subagent
            && task.id == agent_id
            && task.parent_session_id.as_deref() == Some(session_id.as_str())
    });
    if !belongs_to_thread {
        return Err(ArtifactUnavailable(format!(
            "agent `{agent_id}` does not belong to this thread"
        ))
        .into());
    }

    let kind = params.kind.unwrap_or(AgentArtifactKind::Output);
    let expected = match kind {
        AgentArtifactKind::Output => engine.state.subagent_output_path(agent_id),
        AgentArtifactKind::Transcript => engine.state.subagent_transcript_path(agent_id),
    };

    if let Some(requested) = params.path.as_deref() {
        let requested = std::fs::canonicalize(requested).context("artifact path is missing")?;
        let expected_canonical = std::fs::canonicalize(&expected).context("artifact is missing")?;
        if requested != expected_canonical {
            return Err(ArtifactUnavailable(
                "artifact path does not match the whitelisted target".to_string(),
            )
            .into());
        }
    }

    let metadata = std::fs::symlink_metadata(&expected).context("artifact is missing")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ArtifactUnavailable("artifact must be a regular file".to_string()).into());
    }
    let canonical = std::fs::canonicalize(&expected).context("artifact is missing")?;
    let bytes = std::fs::read(&canonical).context("artifact is unreadable")?;
    let truncated = bytes.len() > MAX_AGENT_ARTIFACT_BYTES;
    let content_bytes = &bytes[..bytes.len().min(MAX_AGENT_ARTIFACT_BYTES)];
    let content = String::from_utf8_lossy(content_bytes).into_owned();

    Ok(AgentArtifactReadResult {
        thread_id: params.thread_id.clone(),
        agent_id: agent_id.to_string(),
        kind,
        path: dunce::simplified(&canonical).to_string_lossy().into_owned(),
        name: canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: bytes.len() as u64,
        truncated,
        content,
        revision: hex_sha256(content_bytes),
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64),
    })
}
