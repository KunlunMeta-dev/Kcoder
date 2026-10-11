use anyhow::{Context, Result};
use kcoder_app_protocol::{AgentArtifactKind, AgentArtifactReadParams, AgentArtifactReadResult};
use kcoder_engine::QueryEngine;
use kcoder_state::TaskKind;
use std::io::{Read, Seek, SeekFrom};

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
    let task = engine
        .state
        .task(agent_id)
        .filter(|task| {
            task.id == agent_id
                && task.kind == TaskKind::Subagent
                && task.parent_session_id.as_deref() == Some(session_id.as_str())
        })
        .ok_or_else(|| {
            ArtifactUnavailable(format!("agent `{agent_id}` does not belong to this thread"))
        })?;
    let kind = params.kind.unwrap_or(AgentArtifactKind::Output);
    let expected = match kind {
        AgentArtifactKind::Output => {
            let legacy = engine.state.subagent_output_path(agent_id);
            match task.output_path.as_ref() {
                None => legacy,
                Some(path) if path == &legacy => legacy,
                Some(path) => {
                    let run = task
                        .background_run
                        .as_ref()
                        .context("agent output has no run identity")?;
                    if run.agent_id != agent_id
                        || run.parent_session_id != session_id
                        || run.run_id.is_empty()
                        || run.run_id.len() > 128
                        || !run
                            .run_id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                    {
                        return Err(ArtifactUnavailable(
                            "agent output run identity is invalid".into(),
                        )
                        .into());
                    }
                    let owned = legacy
                        .parent()
                        .context("agent directory missing")?
                        .join("runs")
                        .join(&run.run_id)
                        .join("output.md");
                    if dunce::simplified(path) != dunce::simplified(&owned) {
                        return Err(ArtifactUnavailable(
                            "agent output path does not match its run".into(),
                        )
                        .into());
                    }
                    owned
                }
            }
        }
        AgentArtifactKind::Transcript => {
            let public = engine
                .state
                .subagent_transcript_path(agent_id)
                .with_extension("public.txt");
            engine
                .ensure_public_subagent_transcript(agent_id)
                .map_err(|error| {
                    ArtifactUnavailable(format!("public transcript unavailable: {error}"))
                })?;
            public
        }
    };

    if let Some(requested) = params.path.as_deref() {
        let requested = std::fs::canonicalize(requested).context("artifact path is missing")?;
        let expected_canonical = std::fs::canonicalize(&expected).context("artifact is missing")?;
        // Older clients retain the private checkpoint's advertised path. It is
        // accepted only as an identity hint; the bytes always come from the
        // filtered public projection and never fall back to the private file.
        let legacy_transcript_hint = kind == AgentArtifactKind::Transcript
            && std::fs::canonicalize(engine.state.subagent_transcript_path(agent_id))
                .is_ok_and(|private| private == requested);
        if requested != expected_canonical && !legacy_transcript_hint {
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
    let mut file = std::fs::File::open(&canonical).context("artifact is unreadable")?;
    let metadata = file.metadata().context("artifact metadata is unreadable")?;
    let limit = params
        .limit
        .map_or(MAX_AGENT_ARTIFACT_BYTES, |limit| limit as usize)
        .clamp(4, MAX_AGENT_ARTIFACT_BYTES);
    let offset = if params.tail == Some(true) {
        if params.offset.is_some_and(|offset| offset != 0) {
            return Err(
                ArtifactUnavailable("tail and explicit cursor cannot be combined".into()).into(),
            );
        }
        aligned_tail_offset(&mut file, metadata.len(), limit)?
    } else {
        params.offset.unwrap_or(0)
    };
    if offset > metadata.len() {
        return Err(ArtifactUnavailable("artifact cursor exceeds file size".into()).into());
    }
    let revision = artifact_snapshot_revision(&canonical, &metadata);
    if params
        .revision
        .as_ref()
        .is_some_and(|expected| expected != &revision)
    {
        return Err(ArtifactUnavailable("artifact_snapshot_changed".into()).into());
    }
    let content_bytes = read_bounded_page(&mut file, offset, limit)?;
    let after = file.metadata()?;
    if artifact_snapshot_revision(&canonical, &after) != revision {
        return Err(ArtifactUnavailable("artifact_snapshot_changed".into()).into());
    }
    let next = offset.saturating_add(content_bytes.len() as u64);
    let next_offset = (next < metadata.len()).then_some(next);
    let truncated = next_offset.is_some();
    let content = String::from_utf8_lossy(&content_bytes).into_owned();

    Ok(AgentArtifactReadResult {
        thread_id: params.thread_id.clone(),
        agent_id: agent_id.to_string(),
        kind,
        path: dunce::simplified(&canonical).to_string_lossy().into_owned(),
        name: canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: metadata.len(),
        truncated,
        content,
        revision,
        offset,
        next_offset,
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64),
    })
}

fn artifact_snapshot_revision(path: &std::path::Path, metadata: &std::fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    let identity = format!("{}:{}:{modified:?}", path.display(), metadata.len());
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{identity}:{}:{}", metadata.dev(), metadata.ino())
    };
    hex_sha256(identity.as_bytes())
}

/// Read only one bounded page. The cursor must point to a UTF-8 boundary and a
/// final partial codepoint is left for the next page, including on live files.
fn read_bounded_page(file: &mut (impl Read + Seek), offset: u64, limit: usize) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset))?;
    let limit = limit.clamp(4, MAX_AGENT_ARTIFACT_BYTES);
    let mut bytes = Vec::with_capacity(limit);
    file.take(limit as u64).read_to_end(&mut bytes)?;
    if bytes.first().is_some_and(|byte| byte & 0xc0 == 0x80) {
        return Err(ArtifactUnavailable("artifact cursor is not a UTF-8 boundary".into()).into());
    }
    if let Err(error) = std::str::from_utf8(&bytes)
        && error.error_len().is_none()
    {
        bytes.truncate(error.valid_up_to());
    }
    Ok(bytes)
}

fn aligned_tail_offset(file: &mut (impl Read + Seek), size: u64, limit: usize) -> Result<u64> {
    let candidate = size.saturating_sub(limit as u64);
    file.seek(SeekFrom::Start(candidate))?;
    let mut prefix = [0u8; 4];
    let read = file.read(&mut prefix)?;
    let skip = prefix[..read]
        .iter()
        .take_while(|byte| **byte & 0xc0 == 0x80)
        .count();
    if skip > 3 {
        return Err(ArtifactUnavailable("artifact tail is not valid UTF-8".into()).into());
    }
    Ok(candidate + skip as u64)
}

#[cfg(test)]
mod bounded_tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn pages_do_not_split_multibyte_characters_or_replace_them() {
        let mut source = Cursor::new("abc你好！".as_bytes());
        let first = read_bounded_page(&mut source, 0, 4).unwrap();
        assert_eq!(first, b"abc");
        let second = read_bounded_page(&mut source, 3, 6).unwrap();
        assert_eq!(std::str::from_utf8(&second).unwrap(), "你好");
        let third = read_bounded_page(&mut source, 9, 4).unwrap();
        assert_eq!(std::str::from_utf8(&third).unwrap(), "！");
        assert!(read_bounded_page(&mut source, 4, 4).is_err());
    }

    #[test]
    fn large_files_are_not_read_beyond_the_page_budget() {
        let mut source = Cursor::new(vec![b'x'; MAX_AGENT_ARTIFACT_BYTES * 8]);
        let page = read_bounded_page(&mut source, 0, usize::MAX).unwrap();
        assert_eq!(page.len(), MAX_AGENT_ARTIFACT_BYTES);
        assert_eq!(source.position(), MAX_AGENT_ARTIFACT_BYTES as u64);
    }

    #[test]
    fn an_incomplete_live_codepoint_can_be_read_after_append() {
        let mut source = Cursor::new(vec![b'a', 0xe4, 0xbd]);
        let page = read_bounded_page(&mut source, 0, 4).unwrap();
        assert_eq!(page, b"a");
        source.get_mut().push(0xa0);
        assert_eq!(
            read_bounded_page(&mut source, 1, 4).unwrap(),
            "你".as_bytes()
        );
    }
}
