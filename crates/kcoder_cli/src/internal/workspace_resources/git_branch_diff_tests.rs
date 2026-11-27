use super::*;

async fn git(cwd: &Path, args: &[&str]) -> String {
    let result = run_git_command(cwd, args, 64 * 1024, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(result.success, "{args:?}: {}", result.stderr);
    result.stdout.as_str().unwrap().trim().into()
}

async fn repository(branch: &str) -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-b", branch]).await;
    git(repo.path(), &["config", "user.name", "KCoder Fixture"]).await;
    git(
        repo.path(),
        &["config", "user.email", "fixture@example.invalid"],
    )
    .await;
    repo
}

async fn summary(cwd: &Path) -> serde_json::Value {
    let result = git_branch_diff_shortstat(cwd, 64 * 1024, Duration::from_secs(10), true)
        .await
        .unwrap();
    assert!(result.success, "{}", result.stderr);
    result.stdout
}

#[tokio::test]
async fn branch_summary_counts_lines_and_reports_the_review_base_without_writing_the_index() {
    let repo = repository("main").await;
    let cwd = repo.path();
    std::fs::write(cwd.join("tracked.txt"), "one\nold\n").unwrap();
    std::fs::write(cwd.join(".gitignore"), "ignored*\n").unwrap();
    git(cwd, &["add", "."]).await;
    git(cwd, &["commit", "-m", "base"]).await;
    let base = git(cwd, &["rev-parse", "HEAD"]).await;
    git(cwd, &["checkout", "-b", "feature/counts"]).await;
    std::fs::write(cwd.join("tracked.txt"), "one\nnew\n").unwrap();
    git(cwd, &["commit", "-am", "feature"]).await;
    std::fs::write(cwd.join("tracked.txt"), "one\nnew\nthird\n").unwrap();
    git(cwd, &["add", "tracked.txt"]).await;
    std::fs::write(cwd.join("tracked.txt"), "one\nnew\nthird\nfourth\n").unwrap();
    std::fs::write(cwd.join("new file.txt"), "alpha\nbeta\ngamma\n").unwrap();
    std::fs::write(cwd.join("binary.bin"), b"\0binary").unwrap();
    std::fs::write(cwd.join("ignored.txt"), "ignored\n").unwrap();
    let index = std::fs::read(cwd.join(".git/index")).unwrap();
    let actual = summary(cwd).await;
    assert_eq!(actual["additions"], 6);
    assert_eq!(actual["deletions"], 1);
    assert_eq!(actual["fileCount"], 3);
    assert_eq!(actual["binaryFiles"], 1);
    assert_eq!(actual["comparison"]["kind"], "merge-base");
    assert_eq!(actual["comparison"]["reference"], "main");
    assert_eq!(actual["comparison"]["commit"], base);
    let via_device = crate::device_requests::device_execute(
        cwd,
        &kcoder_app_protocol::DeviceExecuteParams {
            command_key: "git_branch_diff_shortstat".into(),
            path: Some(cwd.to_string_lossy().into_owned()),
            args: vec!["--json".into()],
            timeout_seconds: Some(10),
            max_output_bytes: Some(64 * 1024),
            thread_id: None,
            stdin: None,
            expected_revision: None,
        },
    )
    .await
    .unwrap();
    assert!(via_device.success);
    assert_eq!(via_device.stdout, actual);
    let review = git_branch_diff(cwd, 64 * 1024, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(review.success);
    let patch = review.stdout.as_str().unwrap();
    assert_eq!(
        patch
            .lines()
            .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
            .count(),
        6
    );
    assert_eq!(
        patch
            .lines()
            .filter(|line| line.starts_with('-') && !line.starts_with("---"))
            .count(),
        1
    );
    assert!(!patch.contains("ignored.txt"));
    let legacy = git_branch_diff_shortstat(cwd, 4096, Duration::from_secs(10), false)
        .await
        .unwrap();
    assert!(
        legacy
            .stdout
            .as_str()
            .unwrap()
            .contains("3 insertions(+), 1 deletion(-)")
    );
    assert_eq!(std::fs::read(cwd.join(".git/index")).unwrap(), index);
    let bounded = git_branch_diff_shortstat(cwd, 4, Duration::from_secs(10), true)
        .await
        .unwrap();
    assert!(!bounded.success);
    assert!(bounded.stderr.contains("truncated"));
}

#[tokio::test]
async fn unborn_branch_summary_counts_current_files_instead_of_pending_file_count() {
    let repo = repository("main").await;
    let cwd = repo.path();
    std::fs::write(cwd.join("staged.txt"), "staged\n").unwrap();
    std::fs::write(cwd.join("deleted.txt"), "deleted\n").unwrap();
    git(cwd, &["add", "."]).await;
    std::fs::write(cwd.join("staged.txt"), "first\nsecond\n").unwrap();
    std::fs::remove_file(cwd.join("deleted.txt")).unwrap();
    std::fs::write(cwd.join("new.txt"), "no trailing newline").unwrap();
    std::fs::write(cwd.join("binary.bin"), b"\0binary").unwrap();
    let actual = summary(cwd).await;
    assert_eq!(actual["additions"], 3);
    assert_eq!(actual["deletions"], 0);
    assert_eq!(actual["binaryFiles"], 1);
    assert_eq!(actual["comparison"]["kind"], "empty");
    assert!(actual["comparison"]["commit"].is_null());
    let review = git_branch_diff(cwd, 64 * 1024, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(review.success);
    assert!(review.stdout.as_str().unwrap().contains("+second"));
    assert!(!review.stdout.as_str().unwrap().contains("deleted.txt"));
}

#[tokio::test]
async fn branch_summary_head_fallback_and_review_share_the_selected_directory_scope() {
    let repo = repository("topic").await;
    let cwd = repo.path();
    let sub = cwd.join("sub");
    std::fs::create_dir(&sub).unwrap();
    std::fs::write(sub.join("inside.txt"), "one\n").unwrap();
    std::fs::write(cwd.join("outside.txt"), "outside\n").unwrap();
    git(cwd, &["add", "."]).await;
    git(cwd, &["commit", "-m", "base"]).await;
    std::fs::write(sub.join("inside.txt"), "one\ntwo\n").unwrap();
    std::fs::write(sub.join("new.txt"), "three\nfour\n").unwrap();
    std::fs::write(cwd.join("outside.txt"), "outside\nchanged\n").unwrap();
    let actual = summary(&sub).await;
    assert_eq!(actual["additions"], 3);
    assert_eq!(actual["deletions"], 0);
    assert_eq!(actual["comparison"]["kind"], "head");
    assert_eq!(actual["comparison"]["reference"], "HEAD");
    let review = git_branch_diff(&sub, 64 * 1024, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(review.success);
    assert!(!review.stdout.as_str().unwrap().contains("outside.txt"));
}
