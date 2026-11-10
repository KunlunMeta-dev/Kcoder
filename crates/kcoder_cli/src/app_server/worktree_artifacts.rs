//! Worktree artifacts: extracted from the app-server connection boundary.

use crate::{live_file_progress::LiveFileProgress, turn_file_capture::TurnFileCaptureTracker};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{DeviceExecuteParams, DeviceExecuteResult};
use kcoder_cli_storage::{
    private_files::{hex_sha256, write_private_artifact_file},
    transcript_artifact_journal,
};
use kcoder_config::TurnFileChangesSettings;
use kcoder_engine::QueryEngine;
use kcoder_transcript::truncate_utf8_bytes;
use kcoder_types::TurnAttemptIdentity;
use kcoder_workspace_resources::managed_worktrees::valid_artifact_id;
use kcoder_workspace_resources::snapshots::{
    GitTreeSnapshot, MAX_TURN_FILE_CHANGES_BYTES, TurnFileChangesArtifact,
};
use kcoder_workspace_resources::{git, workspace_revision};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const MAX_TURN_FILE_CHANGES_REVIEW_BYTES: usize = 1_800_000;
pub use kcoder_workspace_resources::snapshots::{
    FinalizedTurnFileCapture, capture_worktree_tree_with_policy,
};

pub async fn finalize_turn_file_changes_with_policy(
    workspace: &Path,
    artifact_dir: &Path,
    thread_id: &str,
    turn_id: &str,
    before: GitTreeSnapshot,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<FinalizedTurnFileCapture> {
    kcoder_workspace_resources::snapshots::finalize_turn_file_changes_with_policy(
        workspace,
        artifact_dir,
        thread_id,
        turn_id,
        before,
        policy,
        save_turn_file_changes_artifact_with_patch,
    )
    .await
}

pub fn save_turn_file_changes_artifact_with_patch(
    artifact_dir: &Path,
    artifact: &TurnFileChangesArtifact,
    patch: Option<&[u8]>,
) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(artifact)?;
    transcript_artifact_journal::write(
        artifact_dir,
        &artifact.thread_id,
        transcript_artifact_journal::Kind::TurnFileChanges,
        || {
            if let Some(patch) = patch {
                write_private_artifact_file(
                    &artifact_dir.join(format!("{}.patch", artifact.artifact_id)),
                    patch,
                )?;
            }
            write_private_artifact_file(
                &artifact_dir.join(format!("{}.json", artifact.artifact_id)),
                &bytes,
            )
        },
    )
}

fn read_turn_artifact(
    directory: &kcoder_config::PrivateDirectory,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = directory.open_single_link_regular_file(std::ffi::OsStr::new(name))?;
    let revision = workspace_revision::revision(&file)?;
    ensure!(
        file.metadata()?.len() <= limit,
        "turn artifact exceeds its read budget"
    );
    let mut bytes = Vec::new();
    (&file).take(limit + 1).read_to_end(&mut bytes)?;
    let current = directory.open_single_link_regular_file(std::ffi::OsStr::new(name))?;
    ensure!(
        bytes.len() as u64 <= limit
            && workspace_revision::revision(&file)? == revision
            && workspace_revision::revision(&current)? == revision,
        "turn artifact changed while reading"
    );
    Ok(bytes)
}

pub fn load_turn_file_changes_artifact(
    engine: &QueryEngine,
    artifact_id: &str,
) -> Result<(PathBuf, TurnFileChangesArtifact, String)> {
    if !valid_artifact_id(artifact_id) {
        anyhow::bail!("invalid turn file changes artifact id")
    }
    let artifact_dir = engine
        .session_storage_dir_for(&engine.session_id())
        .join("turn-file-changes");
    let directory = kcoder_config::PrivateDirectory::open_existing(&artifact_dir)?;
    let metadata = read_turn_artifact(&directory, &format!("{artifact_id}.json"), 1024 * 1024)?;
    let artifact: TurnFileChangesArtifact = serde_json::from_slice(&metadata)?;
    if artifact.artifact_id != artifact_id || artifact.thread_id != engine.session_id() {
        anyhow::bail!("turn file changes artifact binding is invalid")
    }
    let expected_workspace = dunce::canonicalize(engine.state.cwd())?;
    if dunce::canonicalize(&artifact.workspace_path)? != expected_workspace {
        anyhow::bail!("turn file changes artifact belongs to another workspace")
    }
    let patch = String::from_utf8(read_turn_artifact(
        &directory,
        &format!("{artifact_id}.patch"),
        MAX_TURN_FILE_CHANGES_BYTES as u64,
    )?)?;
    ensure!(!patch.is_empty(), "turn file changes patch is empty");
    if hex_sha256(patch.as_bytes()) != artifact.patch_sha256 {
        anyhow::bail!("turn file changes patch checksum mismatch")
    }
    Ok((artifact_dir, artifact, patch))
}

pub use kcoder_transcript_observation::turn_file_changes_summary;

pub async fn turn_file_changes_command(
    engine: &QueryEngine,
    params: &DeviceExecuteParams,
) -> Result<DeviceExecuteResult> {
    ensure!(
        matches!(
            params.command_key.as_str(),
            "turn_file_changes_review" | "turn_file_changes_revert"
        ),
        "unsupported turn file changes command"
    );
    if params.args.len() != 1 {
        anyhow::bail!("{} requires exactly one artifact id", params.command_key)
    }
    let requested_path = params
        .path
        .as_deref()
        .context("turn file changes command requires workspace path")?;
    if std::fs::canonicalize(requested_path)? != std::fs::canonicalize(engine.state.cwd())? {
        anyhow::bail!("turn file changes workspace does not match the active thread")
    }
    let (_artifact_dir, artifact, patch) =
        load_turn_file_changes_artifact(engine, &params.args[0])?;
    if params.command_key == "turn_file_changes_review" {
        return Ok(DeviceExecuteResult {
            success: true,
            exit_code: 0,
            stdout: turn_file_changes_review_payload(
                git::review_diff_without_binary_payload(&patch).into_owned(),
                MAX_TURN_FILE_CHANGES_REVIEW_BYTES,
            ),
            stderr: String::new(),
        });
    }
    if artifact.status == "reverted" {
        return Ok(DeviceExecuteResult {
            success: true,
            exit_code: 0,
            stdout: json!({"success": true, "file_changes": turn_file_changes_summary(&artifact)}),
            stderr: String::new(),
        });
    }
    // A reversible patch alone does not prove current-byte applicability or
    // protect concurrent writers. Keep review/export, without an unsafe write.
    Ok(DeviceExecuteResult {
        success: true,
        exit_code: 0,
        stdout: json!({
            "success": false,
            "error": "Automatic reversal is unavailable: this artifact has no protected current-file applicability proof. Review or export the patch instead.",
            "file_changes": turn_file_changes_summary(&artifact),
        }),
        stderr: String::new(),
    })
}

pub fn turn_file_changes_review_payload(diff: String, limit: usize) -> Value {
    // Count UTF-8 bytes before truncation; the helper's original count is characters.
    let diff_original_bytes = diff.len();
    let (diff, diff_truncated, _) = truncate_utf8_bytes(diff, limit);
    json!({
        "success": true,
        "diff": diff,
        "diffTruncated": diff_truncated,
        "diffOriginalBytes": diff_original_bytes,
    })
}

pub struct TurnFileScope<'a> {
    pub workspace: &'a Path,
    pub artifact_dir: &'a Path,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub policy: &'a TurnFileChangesSettings,
}

impl TurnFileScope<'_> {
    /// Establish the baseline after projecting the tool-start event and before polling it.
    pub async fn capture_baseline(
        &self,
        engine: &QueryEngine,
        attempt: &TurnAttemptIdentity,
        live_files: &mut LiveFileProgress,
    ) -> (Option<GitTreeSnapshot>, TurnFileCaptureTracker) {
        let mut capture = TurnFileCaptureTracker::new(engine, attempt, self.policy.enabled);
        if !self.policy.enabled {
            return (None, capture);
        }
        let snapshot = match capture_worktree_tree_with_policy(
            self.workspace,
            self.artifact_dir,
            self.turn_id,
            "before",
            self.policy,
        )
        .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                capture.failed();
                tracing::warn!(%error, turn_id = %self.turn_id, "failed to snapshot worktree before mutating app-server tool");
                None
            }
        };
        if let Some(before) = &snapshot {
            capture.baseline(before);
            live_files.set_baseline(before);
        } else {
            live_files.set_native_baseline().await;
        }
        (snapshot, capture)
    }

    pub async fn finish_capture(
        &self,
        before: Option<GitTreeSnapshot>,
        capture: &mut Option<TurnFileCaptureTracker>,
    ) -> Option<Value> {
        let before = before?;
        match finalize_turn_file_changes_with_policy(
            self.workspace,
            self.artifact_dir,
            self.thread_id,
            self.turn_id,
            before,
            self.policy,
        )
        .await
        {
            Ok(result) => {
                if let Some(capture) = capture {
                    capture.finalized(&result);
                }
                result.artifact.as_ref().map(turn_file_changes_summary)
            }
            Err(error) => {
                if let Some(capture) = capture {
                    capture.failed();
                }
                tracing::warn!(%error, turn_id = %self.turn_id, "failed to create turn file changes artifact");
                None
            }
        }
    }
}
