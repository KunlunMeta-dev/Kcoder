use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const MAX_PRESERVED_ARTIFACT_ID_BYTES: usize = 120;

/// Convert an externally supplied artifact identifier into exactly one safe
/// filesystem component.
///
/// Existing ASCII identifiers made only from letters, digits, `_`, and `-`
/// retain their historical on-disk names. Every other value is represented by
/// a domain-separated SHA-256 digest so separators, dot components, Windows
/// drive prefixes, and non-ASCII bytes can never affect path traversal.
pub fn artifact_id_path_component(id: &str) -> String {
    if !id.is_empty()
        && id.len() <= MAX_PRESERVED_ARTIFACT_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && !is_windows_reserved_device_name(id)
    {
        return id.to_owned();
    }

    let mut digest = Sha256::new();
    digest.update(b"kcoder-artifact-id\0");
    digest.update(id.as_bytes());
    // `~` is outside the preserved identifier alphabet, making the encoded
    // namespace disjoint from every historical safe identifier.
    format!("~unsafe-id-{:x}", digest.finalize())
}

fn is_windows_reserved_device_name(id: &str) -> bool {
    let basename = id
        .trim_end_matches(['.', ' '])
        .split('.')
        .next()
        .unwrap_or_default();
    let upper = basename.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

/// Stable output path shared by managed shell, OCR, and future tool tasks.
pub fn managed_task_output_path(
    project_dir: impl AsRef<Path>,
    session_id: &str,
    task_id: &str,
) -> PathBuf {
    session_dir_path(project_dir, session_id)
        .join("tasks")
        .join(artifact_id_path_component(task_id))
        .join("output.txt")
}

/// Session-private Git bundle used when a Goal Pro workspace has no HEAD.
pub fn goal_workspace_baseline_bundle_path(
    project_dir: impl AsRef<Path>,
    session_id: &str,
    goal_id: &str,
) -> PathBuf {
    session_dir_path(project_dir, session_id)
        .join("goal-baselines")
        .join(format!("{}.bundle", artifact_id_path_component(goal_id)))
}

/// Stable on-disk output path for a sub-agent's final response.
pub fn subagent_output_path(
    project_dir: impl AsRef<Path>,
    session_id: &str,
    agent_id: &str,
) -> PathBuf {
    subagent_dir_path(project_dir, session_id, agent_id).join("output.md")
}

/// Stable on-disk transcript path for a sub-agent conversation.
pub fn subagent_transcript_path(
    project_dir: impl AsRef<Path>,
    session_id: &str,
    agent_id: &str,
) -> PathBuf {
    subagent_dir_path(project_dir, session_id, agent_id).join("transcript.json")
}

/// Stable per-sub-agent raw model request/response artifact directory.
pub fn subagent_llm_request_history_dir_path(
    project_dir: impl AsRef<Path>,
    session_id: &str,
    agent_id: &str,
) -> PathBuf {
    subagent_dir_path(project_dir, session_id, agent_id).join("llm-requests")
}

fn subagent_dir_path(project_dir: impl AsRef<Path>, session_id: &str, agent_id: &str) -> PathBuf {
    session_dir_path(project_dir, session_id)
        .join("subagents")
        .join(artifact_id_path_component(agent_id))
}

/// Per-session memory summary path.
///
/// The markdown file is session-scoped state, not user transcript history. It
/// lives next to other session artifacts such as persisted tool outputs.
pub fn session_memory_summary_path(project_dir: impl AsRef<Path>, session_id: &str) -> PathBuf {
    session_dir_path(project_dir, session_id)
        .join("session-memory")
        .join("summary.md")
}

/// Per-session artifact directory.
///
/// The transcript itself is stored as `<project_dir>/<session_id>.jsonl`.
/// Session-scoped state lives under `<project_dir>/<session_id>/...`.
pub fn session_dir_path(project_dir: impl AsRef<Path>, session_id: &str) -> PathBuf {
    project_dir
        .as_ref()
        .join(artifact_id_path_component(session_id))
}

/// Per-session state sidecar path for model-only context and resumable state.
pub fn session_state_path(project_dir: impl AsRef<Path>, session_id: &str) -> PathBuf {
    session_dir_path(project_dir, session_id).join("state.json")
}

/// Per-session raw model request/response artifact directory.
pub fn llm_request_history_dir_path(project_dir: impl AsRef<Path>, session_id: &str) -> PathBuf {
    session_dir_path(project_dir, session_id).join("llm-requests")
}

/// Per-session raw model request/response artifacts for session-memory updates.
pub fn session_memory_llm_request_history_dir_path(
    project_dir: impl AsRef<Path>,
    session_id: &str,
) -> PathBuf {
    llm_request_history_dir_path(project_dir, session_id).join("session-memory")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_id_component_preserves_existing_safe_ids() {
        for id in ["session-1", "job_2", "ABC123", "-"] {
            assert_eq!(artifact_id_path_component(id), id);
        }
    }

    #[test]
    fn artifact_id_component_hashes_windows_devices_and_oversized_ids() {
        for id in ["CON", "con", "PrN", "AUX", "nul", "CON.txt", "NUL. "] {
            assert!(
                artifact_id_path_component(id).starts_with("~unsafe-id-"),
                "{id}"
            );
        }
        for number in 1..=9 {
            for id in [
                format!("COM{number}"),
                format!("com{number}"),
                format!("LPT{number}"),
                format!("lPt{number}"),
            ] {
                assert!(
                    artifact_id_path_component(&id).starts_with("~unsafe-id-"),
                    "{id}"
                );
            }
        }
        for id in [
            "COM0", "COM10", "LPT0", "LPT10", "CONSOLE", "NUL_", "normal",
        ] {
            assert_eq!(artifact_id_path_component(id), id);
        }
        let oversized = "a".repeat(MAX_PRESERVED_ARTIFACT_ID_BYTES + 1);
        assert!(artifact_id_path_component(&oversized).starts_with("~unsafe-id-"));
        assert_eq!(
            artifact_id_path_component(&"a".repeat(MAX_PRESERVED_ARTIFACT_ID_BYTES)),
            "a".repeat(MAX_PRESERVED_ARTIFACT_ID_BYTES)
        );
    }

    #[test]
    fn artifact_id_component_encodes_unsafe_ids_as_one_safe_component() {
        for id in [
            "",
            ".",
            "..",
            "../../outside",
            "/absolute",
            r"..\outside",
            r"C:\outside",
            "非ASCII",
        ] {
            let component = artifact_id_path_component(id);
            assert!(component.starts_with("~unsafe-id-"), "{id:?}: {component}");
            assert!(
                component
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'~'))
            );
            assert!(!matches!(component.as_str(), "." | ".."));
            assert!(!component.contains(['/', '\\', ':']));
            assert_eq!(component, artifact_id_path_component(id));
        }
        assert_ne!(
            artifact_id_path_component(""),
            artifact_id_path_component("..")
        );
        assert_ne!(
            artifact_id_path_component(".."),
            artifact_id_path_component(artifact_id_path_component("..").trim_start_matches('~'))
        );
    }

    #[test]
    fn every_artifact_id_path_stays_below_its_root() {
        let root = Path::new("/tmp/projects/demo");
        for id in [
            "../../outside",
            "/absolute",
            r"..\outside",
            r"C:\outside",
            ".",
            "..",
            "",
        ] {
            assert!(session_dir_path(root, id).starts_with(root));
            assert!(managed_task_output_path(root, "session", id).starts_with(root));
            assert!(subagent_output_path(root, "session", id).starts_with(root));
        }
    }

    #[test]
    fn managed_task_output_path_uses_session_task_directory() {
        assert_eq!(
            managed_task_output_path("/tmp/projects/demo", "session-1", "job-2"),
            PathBuf::from("/tmp/projects/demo/session-1/tasks/job-2/output.txt")
        );
    }

    #[test]
    fn subagent_output_path_shape() {
        let path = subagent_output_path("/tmp/project", "session-1", "job-123");
        assert_eq!(
            path,
            Path::new("/tmp/project").join("session-1/subagents/job-123/output.md")
        );
    }

    #[test]
    fn subagent_transcript_path_shape() {
        let path = subagent_transcript_path("/tmp/project", "session-1", "job-123");
        assert_eq!(
            path,
            Path::new("/tmp/project").join("session-1/subagents/job-123/transcript.json")
        );
    }

    #[test]
    fn subagent_llm_request_history_dir_shape() {
        let path = subagent_llm_request_history_dir_path("/tmp/project", "session-1", "job-123");
        assert_eq!(
            path,
            Path::new("/tmp/project").join("session-1/subagents/job-123/llm-requests")
        );
    }
}
