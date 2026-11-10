use super::*;

async fn capture_worktree_tree(
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

#[tokio::test]
async fn snapshot_input_view_rejects_edits_and_inventory_changes_before_publication() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("result.txt"), "before\n").unwrap();
    let before = capture_worktree_tree(workspace.path(), artifacts.path(), "view", "before")
        .await
        .unwrap()
        .unwrap();
    let repository = private_snapshot_repository(artifacts.path(), "view");
    let policy = kcoder_config::TurnFileChangesSettings::default();
    let view = worktree_capture::CaptureView::create(workspace.path(), &repository, &policy)
        .await
        .unwrap();
    let view_path = view.path.clone();
    std::fs::write(workspace.path().join("result.txt"), "after!\n").unwrap();
    assert!(
        view.verify(workspace.path(), &repository).await.is_err(),
        "changed bytes retained a valid capture"
    );
    drop(view);
    assert!(!view_path.exists());
    let view = worktree_capture::CaptureView::create(workspace.path(), &repository, &policy)
        .await
        .unwrap();
    std::fs::write(workspace.path().join("new.txt"), "new\n").unwrap();
    assert!(
        view.verify(workspace.path(), &repository).await.is_err(),
        "changed inventory retained a valid capture"
    );
    drop(view);
    drop(before);
    assert!(!repository.exists());
}

#[tokio::test]
#[cfg(unix)]
async fn snapshot_policy_never_follows_links_and_reports_partial_coverage() {
    use std::os::unix::fs::symlink;
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "outside bytes\n").unwrap();
    symlink(
        outside.path().join("secret.txt"),
        workspace.path().join("alias.txt"),
    )
    .unwrap();
    std::fs::write(workspace.path().join("visible.txt"), "inside\n").unwrap();
    let snapshot = capture_worktree_tree(workspace.path(), artifacts.path(), "links", "before")
        .await
        .unwrap()
        .unwrap();
    assert!(snapshot.has_exclusions);
    let tree = run_git_command_with_private_repository(
        workspace.path(),
        &["ls-tree", "-r", "--name-only", &snapshot.tree],
        &private_snapshot_repository(artifacts.path(), "links"),
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(tree.success, "{}", tree.stderr);
    assert_eq!(tree.stdout.as_str().unwrap().trim(), "visible.txt");
}

#[tokio::test]
async fn snapshot_policy_total_input_budget_rejects_before_git_insertion() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("first.txt"), vec![b'x'; 32]).unwrap();
    std::fs::write(workspace.path().join("second.txt"), vec![b'y'; 32]).unwrap();
    let policy = kcoder_config::TurnFileChangesSettings {
        max_total_bytes: 48,
        max_file_bytes: 0,
        ..Default::default()
    };
    let failed = capture_worktree_tree_with_policy(
        workspace.path(),
        artifacts.path(),
        "total",
        "before",
        &policy,
    )
    .await;
    assert!(failed.is_err());
    assert!(!private_snapshot_repository(artifacts.path(), "total").exists());
    assert!(!workspace.path().join(".git").exists());
}

#[test]
fn turn_file_change_summary_parses_literal_quotes_tabs_and_binary_counts() {
    let files = parse_turn_file_change_items(
        "M\0report \"draft\".txt\0R100\0old\tname.txt\0new\tname.txt\0A\0image.bin\0",
        concat!(
            "2\t1\treport \"draft\".txt\0",
            "0\t0\t\0old\tname.txt\0new\tname.txt\0",
            "-\t-\timage.bin\0",
        ),
    )
    .unwrap();
    assert_eq!(files[0].path, "report \"draft\".txt");
    assert_eq!(files[1].old_path.as_deref(), Some("old\tname.txt"));
    assert_eq!(files[1].path, "new\tname.txt");
    assert!(files[2].binary);
    assert!(parse_turn_file_change_items("M\0path", "1\t0\tpath\0").is_err());
    assert!(parse_turn_file_change_items("M\0path\0", "1\t0\tother\0").is_err());
}
