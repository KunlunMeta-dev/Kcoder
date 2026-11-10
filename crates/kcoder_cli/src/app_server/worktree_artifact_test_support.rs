use super::*;
pub(super) use kcoder_workspace_resources::snapshots::private_snapshot_repository;

pub(super) async fn capture_worktree_tree(
    workspace: &Path,
    artifact_dir: &Path,
    turn_id: &str,
    stage: &str,
) -> Result<Option<GitTreeSnapshot>> {
    capture_worktree_tree_with_policy(
        workspace,
        artifact_dir,
        turn_id,
        stage,
        &kcoder_config::TurnFileChangesSettings::default(),
    )
    .await
}

pub(super) async fn finalize_turn_file_changes(
    workspace: &Path,
    artifact_dir: &Path,
    thread_id: &str,
    turn_id: &str,
    before: GitTreeSnapshot,
) -> Result<Option<TurnFileChangesArtifact>> {
    finalize_turn_file_changes_with_policy(
        workspace,
        artifact_dir,
        thread_id,
        turn_id,
        before,
        &kcoder_config::TurnFileChangesSettings::default(),
    )
    .await
    .map(|result| result.artifact)
}

pub(super) fn save_turn_file_changes_artifact(
    artifact_dir: &Path,
    artifact: &TurnFileChangesArtifact,
) -> Result<()> {
    save_turn_file_changes_artifact_with_patch(artifact_dir, artifact, None)
}
