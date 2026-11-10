#[tokio::test]
async fn read_only_git_commands_are_real_and_workspace_bounded() {
    let workspace = tempfile::tempdir().unwrap();
    let repo = workspace.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "KCoder Test"]);
    git(&["config", "user.email", "kcoder@example.invalid"]);
    std::fs::write(repo.join("README.md"), "one\n").unwrap();
    git(&["add", "README.md"]);
    git(&["commit", "-m", "initial"]);
    let remote = tempfile::tempdir().unwrap();
    let remote_output = std::process::Command::new("git")
        .args(["init", "--bare", remote.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(remote_output.status.success());
    git(&["remote", "add", "origin", remote.path().to_str().unwrap()]);
    git(&["push", "-u", "origin", "main"]);
    std::fs::write(repo.join("README.md"), "one\ntwo\n").unwrap();

    let execute = |command_key: &str| DeviceExecuteParams {
        command_key: command_key.into(),
        thread_id: None,
        path: Some(repo.to_string_lossy().into_owned()),
        args: Vec::new(),
        max_output_bytes: Some(64 * 1024),
        timeout_seconds: Some(10),
        stdin: None,
        expected_revision: None,
    };
    let is_worktree = device_execute(workspace.path(), &execute("git_is_worktree"))
        .await
        .unwrap();
    assert!(is_worktree.success);
    assert_eq!(is_worktree.stdout.as_str().unwrap().trim(), "true");
    let branch = device_execute(workspace.path(), &execute("git_branch"))
        .await
        .unwrap();
    assert_eq!(branch.stdout.as_str().unwrap().trim(), "main");
    let status = device_execute(workspace.path(), &execute("git_status_porcelain"))
        .await
        .unwrap();
    assert!(status.stdout.as_str().unwrap().contains("README.md"));
    let shortstat = device_execute(workspace.path(), &execute("git_branch_diff_shortstat"))
        .await
        .unwrap();
    assert!(shortstat.success);
    assert!(shortstat.stdout.as_str().unwrap().contains("insertion"));
    std::fs::write(repo.join("NEW.txt"), "new\n").unwrap();
    let branch_diff = device_execute(workspace.path(), &execute("git_branch_diff"))
        .await
        .unwrap();
    assert!(branch_diff.success);
    assert!(branch_diff.stdout.as_str().unwrap().contains("+two"));
    assert!(branch_diff.stdout.as_str().unwrap().contains("NEW.txt"));
    let unstaged = device_execute(workspace.path(), &execute("git_diff_unstaged"))
        .await
        .unwrap();
    assert!(unstaged.stdout.as_str().unwrap().contains("+two"));

    let added = device_execute(workspace.path(), &execute("git_add_all"))
        .await
        .unwrap();
    assert!(added.success, "{}", added.stderr);
    let generated = device_execute(workspace.path(), &execute("git_generate_commit_message"))
        .await
        .unwrap();
    assert_eq!(generated.stdout["success"], true);
    assert_eq!(generated.stdout["message"], "Update 2 files");
    let staged = device_execute(workspace.path(), &execute("git_diff_staged"))
        .await
        .unwrap();
    assert!(staged.stdout.as_str().unwrap().contains("+two"));
    let committed = device_execute(
        workspace.path(),
        &DeviceExecuteParams {
            args: vec!["-m".into(), "Update README".into()],
            ..execute("git_commit")
        },
    )
    .await
    .unwrap();
    assert!(committed.success, "{}", committed.stderr);
    std::fs::write(repo.join("README.md"), "one\ntwo\nthree\n").unwrap();
    let committed_all = device_execute(
        workspace.path(),
        &DeviceExecuteParams {
            args: vec!["-m".into(), "Commit all changes".into()],
            ..execute("git_commit_all")
        },
    )
    .await
    .unwrap();
    assert!(committed_all.success, "{}", committed_all.stderr);
    let clean = device_execute(workspace.path(), &execute("git_status_porcelain"))
        .await
        .unwrap();
    assert!(clean.stdout.as_str().unwrap().trim().is_empty());
    let last_commit = device_execute(workspace.path(), &execute("git_diff_last_commit"))
        .await
        .unwrap();
    assert!(last_commit.stdout.as_str().unwrap().contains("+three"));
    let pushed = device_execute(workspace.path(), &execute("git_push"))
        .await
        .unwrap();
    assert!(pushed.success, "{}", pushed.stderr);
    let sync_status = device_execute(workspace.path(), &execute("git_sync_status"))
        .await
        .unwrap();
    assert_eq!(sync_status.stdout["currentBranch"], "main");
    assert_eq!(sync_status.stdout["hasRemote"], true);
    assert_eq!(sync_status.stdout["hasUpstream"], true);
    assert_eq!(sync_status.stdout["ahead"], 0);
    assert_eq!(sync_status.stdout["behind"], 0);
    let reversed = device_execute(
        workspace.path(),
        &DeviceExecuteParams {
            stdin: Some(last_commit.stdout.as_str().unwrap().to_string()),
            ..execute("git_apply_reverse")
        },
    )
    .await
    .unwrap();
    assert!(reversed.success, "{}", reversed.stderr);
    assert_eq!(
        std::fs::read_to_string(repo.join("README.md")).unwrap(),
        "one\ntwo\n"
    );
    git(&["reset", "--hard", "HEAD"]);

    let created_branch = device_execute(
        workspace.path(),
        &DeviceExecuteParams {
            args: vec!["feature/test".into()],
            ..execute("git_checkout_new")
        },
    )
    .await
    .unwrap();
    assert!(created_branch.success, "{}", created_branch.stderr);
    let feature_branch = device_execute(workspace.path(), &execute("git_branch"))
        .await
        .unwrap();
    assert_eq!(
        feature_branch.stdout.as_str().unwrap().trim(),
        "feature/test"
    );
    let first_feature_push = device_execute(workspace.path(), &execute("git_push"))
        .await
        .unwrap();
    assert!(first_feature_push.success, "{}", first_feature_push.stderr);
    let feature_upstream = device_execute(workspace.path(), &execute("git_sync_status"))
        .await
        .unwrap();
    assert_eq!(feature_upstream.stdout["hasUpstream"], true);
    let checked_out = device_execute(
        workspace.path(),
        &DeviceExecuteParams {
            args: vec!["main".into()],
            ..execute("git_checkout")
        },
    )
    .await
    .unwrap();
    assert!(checked_out.success, "{}", checked_out.stderr);
    let merged = device_execute(
        workspace.path(),
        &DeviceExecuteParams {
            args: vec!["feature/test".into()],
            ..execute("git_merge")
        },
    )
    .await
    .unwrap();
    assert!(merged.success, "{}", merged.stderr);
    let pulled = device_execute(workspace.path(), &execute("git_pull_ff"))
        .await
        .unwrap();
    assert!(pulled.success, "{}", pulled.stderr);
    let invalid_branch = device_execute(
        workspace.path(),
        &DeviceExecuteParams {
            args: vec!["--or unsafe".into()],
            ..execute("git_checkout_new")
        },
    )
    .await
    .unwrap();
    assert!(!invalid_branch.success);

    let outside = tempfile::tempdir().unwrap();
    let outside_request = DeviceExecuteParams {
        path: Some(outside.path().to_string_lossy().into_owned()),
        ..execute("git_status_porcelain")
    };
    let error = device_execute(workspace.path(), &outside_request)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("outside the configured workspace")
    );

    let bounded = DeviceExecuteParams {
        max_output_bytes: Some(4),
        ..execute("git_branch_list")
    };
    let result = device_execute(workspace.path(), &bounded).await.unwrap();
    assert!(!result.success);
    assert_eq!(result.stdout.as_str().unwrap().len(), 4);
    assert!(result.stderr.contains("truncated"));
}

#[tokio::test]
async fn last_commit_diff_supports_a_repository_with_only_the_initial_commit() {
    let workspace = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(workspace.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "-b", "main"]);
    git(&["config", "user.name", "KCoder Test"]);
    git(&["config", "user.email", "kcoder@example.invalid"]);
    std::fs::write(workspace.path().join("你好 world.txt"), "first\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-m", "initial"]);
    let result = device_execute(
        workspace.path(),
        &DeviceExecuteParams {
            command_key: "git_diff_last_commit".into(),
            thread_id: None,
            path: Some(workspace.path().to_string_lossy().into_owned()),
            args: Vec::new(),
            max_output_bytes: Some(64 * 1024),
            timeout_seconds: Some(10),
            stdin: None,
            expected_revision: None,
        },
    )
    .await
    .unwrap();
    assert!(result.success, "{}", result.stderr);
    assert!(result.stdout.as_str().unwrap().contains("first"));
}

#[tokio::test]
async fn turn_file_snapshot_respects_read_only_contracts_and_includes_unknown_writers() {
    let registry = kcoder_tools::default_registry();
    assert!(!live_file_progress::may_mutate_workspace(&registry, "read"));
    assert!(!live_file_progress::may_mutate_workspace(&registry, "grep"));
    for name in [
        "write",
        "edit",
        "apply_patch",
        "bash",
        "PowerShell",
        "spawn_agent",
        "vendor.batch_writer",
    ] {
        assert!(live_file_progress::may_mutate_workspace(&registry, name));
    }
}

#[tokio::test]
async fn turn_file_snapshot_excludes_ignored_content_in_a_repository_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let init = run_git_command(workspace.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(init.success, "{}", init.stderr);
    std::fs::write(workspace.path().join(".gitignore"), "target/\n").unwrap();
    std::fs::write(workspace.path().join("visible.txt"), "visible\n").unwrap();
    std::fs::create_dir_all(workspace.path().join("target/cache")).unwrap();
    std::fs::write(
        workspace.path().join("target/cache/generated.bin"),
        vec![b'x'; 1024 * 1024],
    )
    .unwrap();

    let artifact_dir = artifacts.path().join("thread-1").join("turn-file-changes");
    let snapshot = capture_worktree_tree(workspace.path(), &artifact_dir, "turn-1", "before")
        .await
        .unwrap()
        .unwrap();
    let tree = run_git_command_with_private_repository(
        workspace.path(),
        &["ls-tree", "-r", "--name-only", &snapshot.tree],
        &private_snapshot_repository(&artifact_dir, "turn-1"),
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(tree.success, "{}", tree.stderr);
    let paths = tree.stdout.as_str().unwrap_or_default();
    assert!(paths.contains("visible.txt"));
    assert!(!paths.contains("target/cache/generated.bin"));
}

#[tokio::test]
async fn turn_file_change_artifact_captures_dirty_baseline_and_reverses_exact_delta() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let init = run_git_command(workspace.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(init.success, "{}", init.stderr);
    std::fs::write(workspace.path().join("tracked.txt"), "dirty baseline\n").unwrap();
    let artifact_dir = artifacts.path().join("thread-1").join("turn-file-changes");
    let before = capture_worktree_tree(workspace.path(), &artifact_dir, "turn-1", "before")
        .await
        .unwrap()
        .unwrap();

    std::fs::write(workspace.path().join("tracked.txt"), "changed by turn\n").unwrap();
    std::fs::write(workspace.path().join("created.txt"), "created by turn\n").unwrap();
    let artifact = finalize_turn_file_changes(
        workspace.path(),
        &artifact_dir,
        "thread-1",
        "turn-1",
        before,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(artifact.status, "active");
    assert_eq!(artifact.file_count, 2);
    assert!(valid_artifact_id(&artifact.artifact_id));
    let patch_path = artifact_dir.join(format!("{}.patch", artifact.artifact_id));
    let patch = std::fs::read_to_string(&patch_path).unwrap();
    assert_eq!(hex_sha256(patch.as_bytes()), artifact.patch_sha256);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&patch_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let check = run_git_command_with_stdin(
        workspace.path(),
        &["apply", "--reverse", "--check", "--binary", "-"],
        &patch,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(check.success, "{}", check.stderr);
    let applied = run_git_command_with_stdin(
        workspace.path(),
        &["apply", "--reverse", "--binary", "-"],
        &patch,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(applied.success, "{}", applied.stderr);
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("tracked.txt")).unwrap(),
        "dirty baseline\n"
    );
    assert!(!workspace.path().join("created.txt").exists());
}

#[tokio::test]
async fn turn_file_change_artifact_supports_a_workspace_under_an_ignored_parent() {
    let repository = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let init = run_git_command(repository.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(init.success, "{}", init.stderr);
    std::fs::write(repository.path().join(".gitignore"), "ignored/\n").unwrap();
    let workspace = repository.path().join("ignored/workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("existing.txt"), "before\n").unwrap();
    let artifact_dir = artifacts.path().join("thread-1").join("turn-file-changes");
    let before = capture_worktree_tree(&workspace, &artifact_dir, "turn-1", "before")
        .await
        .unwrap()
        .unwrap();

    std::fs::write(workspace.join("existing.txt"), "after\n").unwrap();
    std::fs::write(workspace.join("created.txt"), "created\n").unwrap();
    let artifact =
        finalize_turn_file_changes(&workspace, &artifact_dir, "thread-1", "turn-1", before)
            .await
            .unwrap()
            .unwrap();

    assert_eq!(artifact.file_count, 2);
    let paths = artifact
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<Vec<_>>();
    assert!(paths.iter().any(|path| path.ends_with("existing.txt")));
    assert!(paths.iter().any(|path| path.ends_with("created.txt")));
}

#[tokio::test]
async fn turn_file_change_artifact_supports_a_non_git_workspace_with_broken_dot_git() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join(".git"),
        "gitdir: /missing/kcoder-e2e\n",
    )
    .unwrap();
    std::fs::write(workspace.path().join("existing.txt"), "before\n").unwrap();
    let artifact_dir = artifacts
        .path()
        .join("thread-nongit")
        .join("turn-file-changes");

    let before = capture_worktree_tree(workspace.path(), &artifact_dir, "turn-nongit", "before")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before.backend, GitSnapshotBackend::Isolated);
    assert!(!workspace.path().join(".git").is_dir());

    std::fs::write(workspace.path().join("existing.txt"), "after\n").unwrap();
    std::fs::write(workspace.path().join("created.txt"), "created\n").unwrap();
    let artifact = finalize_turn_file_changes(
        workspace.path(),
        &artifact_dir,
        "thread-nongit",
        "turn-nongit",
        before,
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(artifact.snapshot_backend, GitSnapshotBackend::Isolated);
    assert_eq!(artifact.file_count, 2);
    assert!(
        artifact
            .files
            .iter()
            .any(|file| file.path == "existing.txt")
    );
    assert!(artifact.files.iter().any(|file| file.path == "created.txt"));
    assert!(!private_snapshot_repository(&artifact_dir, "turn-nongit").exists());
    assert_eq!(
        std::fs::read_to_string(workspace.path().join(".git")).unwrap(),
        "gitdir: /missing/kcoder-e2e\n"
    );
}

#[tokio::test]
async fn isolated_snapshot_repository_is_removed_when_diff_generation_fails() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join(".git"),
        "gitdir: /missing/kcoder-e2e\n",
    )
    .unwrap();
    let changed_path = workspace.path().join("oversized.txt");
    std::fs::write(
        &changed_path,
        vec![b'a'; MAX_TURN_FILE_CHANGES_BYTES + 1024],
    )
    .unwrap();
    let artifact_dir = artifacts
        .path()
        .join("thread-oversized")
        .join("turn-file-changes");
    let turn_id = "turn-oversized";
    let before = capture_worktree_tree(workspace.path(), &artifact_dir, turn_id, "before")
        .await
        .unwrap()
        .unwrap();

    std::fs::write(
        &changed_path,
        vec![b'b'; MAX_TURN_FILE_CHANGES_BYTES + 1024],
    )
    .unwrap();
    let result = finalize_turn_file_changes(
        workspace.path(),
        &artifact_dir,
        "thread-oversized",
        turn_id,
        before,
    )
    .await;

    assert!(result.is_err(), "超限 diff 必须失败而不是生成截断 artifact");
    assert!(!private_snapshot_repository(&artifact_dir, turn_id).exists());
}

#[tokio::test]
async fn isolated_snapshot_repository_is_removed_when_before_snapshot_is_abandoned() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join(".git"),
        "gitdir: /missing/kcoder-e2e\n",
    )
    .unwrap();
    std::fs::write(workspace.path().join("existing.txt"), "before\n").unwrap();
    let artifact_dir = artifacts.path().join("thread-1").join("turn-file-changes");
    let turn_id = "turn-abandoned";

    let before = capture_worktree_tree(workspace.path(), &artifact_dir, turn_id, "before")
        .await
        .unwrap()
        .unwrap();
    assert!(private_snapshot_repository(&artifact_dir, turn_id).exists());
    drop(before);

    assert!(!private_snapshot_repository(&artifact_dir, turn_id).exists());
    let leftovers = std::fs::read_dir(&artifact_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("snapshot-") && name.ends_with(".index"))
        .collect::<Vec<_>>();
    assert!(leftovers.is_empty(), "残留私有 index: {leftovers:?}");
}

#[test]
fn legacy_turn_file_changes_artifact_defaults_to_workspace_backend() {
    let artifact: TurnFileChangesArtifact = serde_json::from_value(serde_json::json!({
        "version": 1,
        "status": "active",
        "artifact_id": "a".repeat(64),
        "thread_id": "thread-legacy",
        "turn_id": "turn-legacy",
        "workspace_path": "/tmp/legacy",
        "before_tree": "b".repeat(40),
        "after_tree": "c".repeat(40),
        "patch_sha256": "d".repeat(64),
        "file_count": 0,
        "additions": 0,
        "deletions": 0,
        "files": [],
        "created_at": "2026-08-03T00:00:00Z"
    }))
    .unwrap();

    assert_eq!(artifact.snapshot_backend, GitSnapshotBackend::Workspace);
}

#[tokio::test]
async fn snapshot_policy_keeps_oversized_and_ignored_files_out_of_the_tree() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let init = run_git_command(workspace.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(init.success, "{}", init.stderr);

    std::fs::write(workspace.path().join("visible.txt"), "small\n").unwrap();
    std::fs::create_dir_all(workspace.path().join("models")).unwrap();
    std::fs::write(workspace.path().join("models/big.bin"), vec![b'x'; 4096]).unwrap();
    std::fs::create_dir_all(workspace.path().join("cache")).unwrap();
    std::fs::write(
        workspace.path().join("cache/blob.gguf"),
        "small but ignored\n",
    )
    .unwrap();

    let policy = kcoder_config::TurnFileChangesSettings {
        max_file_bytes: 1024,
        ignore_globs: vec!["**/*.gguf".into()],
        ..kcoder_config::TurnFileChangesSettings::default()
    };
    let artifact_dir = artifacts.path().join("thread-1").join("turn-file-changes");
    let snapshot = capture_worktree_tree_with_policy(
        workspace.path(),
        &artifact_dir,
        "turn-1",
        "before",
        &policy,
    )
    .await
    .unwrap()
    .unwrap();

    let tree = run_git_command_with_private_repository(
        workspace.path(),
        &["ls-tree", "-r", "--name-only", &snapshot.tree],
        &private_snapshot_repository(&artifact_dir, "turn-1"),
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(tree.success, "{}", tree.stderr);
    let paths = tree.stdout.as_str().unwrap_or_default();
    assert!(paths.contains("visible.txt"), "{paths}");
    assert!(
        !paths.contains("models/big.bin"),
        "oversized file must stay out: {paths}"
    );
    assert!(
        !paths.contains("cache/blob.gguf"),
        "ignored glob must stay out: {paths}"
    );
}

#[tokio::test]
async fn snapshot_policy_excluded_bytes_never_enter_the_object_database() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let init = run_git_command(workspace.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(init.success, "{}", init.stderr);
    std::fs::write(workspace.path().join("visible.txt"), "visible\n").unwrap();
    std::fs::write(
        workspace.path().join("private.gguf"),
        "excluded secret bytes\n",
    )
    .unwrap();
    std::fs::write(workspace.path().join("large.bin"), vec![b'z'; 4096]).unwrap();
    let policy = kcoder_config::TurnFileChangesSettings {
        max_file_bytes: 1024,
        ignore_globs: vec!["**/*.gguf".into()],
        ..Default::default()
    };
    let mut excluded_objects = Vec::new();
    for path in ["private.gguf", "large.bin"] {
        let hash = run_git_command(
            workspace.path(),
            &["hash-object", "--no-filters", "--", path],
            4096,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(hash.success, "{}", hash.stderr);
        excluded_objects.push(hash.stdout.as_str().unwrap().trim().to_string());
    }
    let artifact_dir = artifacts.path().join("thread").join("turn-file-changes");
    capture_worktree_tree_with_policy(workspace.path(), &artifact_dir, "turn-1", "before", &policy)
        .await
        .unwrap()
        .unwrap();
    for oid in excluded_objects {
        let read = run_git_command(
            workspace.path(),
            &["cat-file", "-e", &oid],
            4096,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(
            !read.success,
            "excluded bytes were written to the shared object database"
        );
    }
}

#[tokio::test]
async fn snapshot_policy_invalid_exclusions_cannot_produce_a_successful_snapshot() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let init = run_git_command(workspace.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(init.success, "{}", init.stderr);
    std::fs::write(workspace.path().join("note.txt"), "retain me\n").unwrap();
    let policy = kcoder_config::TurnFileChangesSettings {
        ignore_globs: vec!["[".into()],
        ..Default::default()
    };
    let result = capture_worktree_tree_with_policy(
        workspace.path(),
        artifacts.path(),
        "turn-invalid",
        "before",
        &policy,
    )
    .await;
    assert!(
        result.is_err(),
        "invalid exclusion policy was reported as a complete snapshot"
    );
}

#[tokio::test]
async fn snapshot_policy_excludes_internal_writer_and_recovery_files() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let init = run_git_command(workspace.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(init.success, "{}", init.stderr);
    for name in [
        "visible.txt",
        ".kcoder-previous-probe",
        ".kcoder-workspace-write.lock",
    ] {
        std::fs::write(workspace.path().join(name), format!("content of {name}\n")).unwrap();
    }
    let snapshot = capture_worktree_tree(workspace.path(), artifacts.path(), "turn-1", "before")
        .await
        .unwrap()
        .unwrap();
    let listing = run_git_command_with_private_repository(
        workspace.path(),
        &["ls-tree", "-r", "--name-only", &snapshot.tree],
        &private_snapshot_repository(artifacts.path(), "turn-1"),
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(listing.success, "{}", listing.stderr);
    assert_eq!(listing.stdout.as_str().unwrap().trim(), "visible.txt");
}

#[tokio::test]
async fn snapshot_policy_literal_paths_preserve_deletions_and_the_real_index() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    for args in [
        vec!["init"],
        vec!["config", "user.name", "KCoder Test"],
        vec!["config", "user.email", "kcoder@example.invalid"],
    ] {
        let result = run_git_command(workspace.path(), &args, 4096, Duration::from_secs(10))
            .await
            .unwrap();
        assert!(result.success, "{}", result.stderr);
    }
    std::fs::write(workspace.path().join("deleted.txt"), "tracked\n").unwrap();
    for args in [
        vec!["add", "deleted.txt"],
        vec!["-c", "commit.gpgsign=false", "commit", "-m", "baseline"],
    ] {
        let result = run_git_command(workspace.path(), &args, 4096, Duration::from_secs(10))
            .await
            .unwrap();
        assert!(result.success, "{}", result.stderr);
    }
    let original_index = std::fs::read(workspace.path().join(".git/index")).unwrap();
    std::fs::remove_file(workspace.path().join("deleted.txt")).unwrap();
    for name in ["report [draft].txt", "资料.txt"] {
        std::fs::write(workspace.path().join(name), "new content\n").unwrap();
    }
    let snapshot = capture_worktree_tree(workspace.path(), artifacts.path(), "turn-1", "before")
        .await
        .unwrap()
        .unwrap();
    let listing = run_git_command_with_private_repository(
        workspace.path(),
        &["ls-tree", "-rz", "--name-only", &snapshot.tree],
        &private_snapshot_repository(artifacts.path(), "turn-1"),
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(listing.success, "{}", listing.stderr);
    let paths = listing.stdout.as_str().unwrap();
    assert!(paths.split('\0').any(|path| path == "report [draft].txt"));
    assert!(paths.split('\0').any(|path| path == "资料.txt"));
    assert!(!paths.split('\0').any(|path| path == "deleted.txt"));
    assert_eq!(
        original_index,
        std::fs::read(workspace.path().join(".git/index")).unwrap()
    );
}

#[tokio::test]
#[cfg(unix)]
#[ignore = "requires an unprivileged Unix UID"]
async fn snapshot_policy_unreadable_file_cannot_be_reported_as_success() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    assert_ne!(
        std::fs::metadata(workspace.path()).unwrap().uid(),
        0,
        "run this test as a non-root UID"
    );
    let init = run_git_command(workspace.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(init.success, "{}", init.stderr);
    let denied = workspace.path().join("unreadable.txt");
    std::fs::write(&denied, "private\n").unwrap();
    std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o000)).unwrap();
    assert!(
        std::fs::read(&denied).is_err(),
        "the fixture must actually deny reading"
    );
    let result =
        capture_worktree_tree(workspace.path(), artifacts.path(), "turn-denied", "before").await;
    assert!(
        result.is_err(),
        "an unreadable file was reported as a complete snapshot"
    );
}

#[tokio::test]
async fn snapshot_policy_defaults_keep_small_files_inside_the_tree() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let init = run_git_command(workspace.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(init.success, "{}", init.stderr);
    std::fs::write(workspace.path().join("kept.txt"), "kept\n").unwrap();

    let artifact_dir = artifacts.path().join("thread-1").join("turn-file-changes");
    let snapshot = capture_worktree_tree(workspace.path(), &artifact_dir, "turn-1", "before")
        .await
        .unwrap()
        .unwrap();
    let tree = run_git_command_with_private_repository(
        workspace.path(),
        &["ls-tree", "-r", "--name-only", &snapshot.tree],
        &private_snapshot_repository(&artifact_dir, "turn-1"),
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(
        tree.stdout
            .as_str()
            .unwrap_or_default()
            .contains("kept.txt")
    );
}

#[test]
fn snapshot_repository_debris_is_repaired_and_reclaimed() {
    // Repositories are scratch space for one turn. Debris from an interrupted session is
    // repaired into a standard bare repository (P2-1) while it is young, and reclaimed once it
    // has been left untouched, so the 27 repositories / 50 GB the audit found cannot grow back.
    let projects = tempfile::tempdir().unwrap();
    let artifact = projects
        .path()
        .join("proj")
        .join("client-sessions")
        .join("sess")
        .join("turn-file-changes");
    std::fs::create_dir_all(&artifact).unwrap();
    let repositories = [
        artifact.join("snapshot-repository-abandoned"),
        artifact.join("revert-repository-abandoned"),
    ];
    for repository in &repositories {
        std::fs::create_dir_all(repository.join("objects")).unwrap();
        std::fs::create_dir_all(repository.join("refs")).unwrap();
        std::fs::write(repository.join("objects").join("blob"), b"payload").unwrap();
    }

    let policy = kcoder_config::TurnFileChangesSettings::default();
    let outcome = super::storage_diagnostics::enforce_turn_snapshot_budget_at(
        projects.path(),
        &policy,
        SystemTime::now(),
    );
    assert_eq!(outcome.removed_snapshots, 0, "{outcome:?}");
    for repository in &repositories {
        assert!(repository.join("HEAD").is_file(), "{repository:?}");
        assert!(repository.join("config").is_file(), "{repository:?}");
        let bare = std::process::Command::new("git")
            .arg(format!("--git-dir={}", repository.display()))
            .args(["rev-parse", "--is-bare-repository"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&bare.stdout).trim(), "true");
    }

    let outcome = super::storage_diagnostics::enforce_turn_snapshot_budget_at_with(
        projects.path(),
        &policy,
        SystemTime::now(),
        Duration::ZERO,
    );
    assert_eq!(outcome.removed_snapshots, 2, "{outcome:?}");
    assert!(outcome.removed_bytes > 0, "{outcome:?}");
    for repository in &repositories {
        assert!(!repository.exists(), "{repository:?}");
    }
}

#[cfg(windows)]
#[tokio::test]
async fn isolated_turn_snapshot_supports_windows_paths_beyond_max_path() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("kept.txt"), "owned baseline\n").unwrap();
    let mut artifact_dir = artifacts.path().to_path_buf();
    while artifact_dir.as_os_str().len() < 320 {
        artifact_dir.push("owned-snapshot-subdirectory");
    }
    artifact_dir.push("thread-1");
    artifact_dir.push("turn-file-changes");
    let snapshot = capture_worktree_tree(workspace.path(), &artifact_dir, "turn-1", "before")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.backend, GitSnapshotBackend::Isolated);
    let tree = run_git_command_with_private_repository(
        workspace.path(),
        &["ls-tree", "-r", "--name-only", &snapshot.tree],
        &private_snapshot_repository(&artifact_dir, "turn-1"),
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(tree.success, "{}", tree.stderr);
    assert!(tree.stdout.as_str().unwrap().contains("kept.txt"));
    let retained = artifact_dir.join("retained-data.txt");
    std::fs::write(&retained, "keep the actual artifact directory\n").unwrap();
    assert!(
        private_snapshot_repository(&artifact_dir, "turn-1")
            .join("objects")
            .is_dir()
    );

    std::fs::write(workspace.path().join("kept.txt"), "changed by turn\n").unwrap();
    std::fs::write(workspace.path().join("created.txt"), "created by turn\n").unwrap();
    let artifact = finalize_turn_file_changes(
        workspace.path(),
        &artifact_dir,
        "thread-1",
        "turn-1",
        snapshot,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(artifact.file_count, 2);
    assert_eq!(artifact.snapshot_backend, GitSnapshotBackend::Isolated);
    let patch =
        std::fs::read_to_string(artifact_dir.join(format!("{}.patch", artifact.artifact_id)))
            .unwrap();
    assert_eq!(hex_sha256(patch.as_bytes()), artifact.patch_sha256);
    assert_eq!(
        std::fs::read_to_string(&retained).unwrap(),
        "keep the actual artifact directory\n"
    );
    assert!(!private_snapshot_repository(&artifact_dir, "turn-1").exists());

    let revert_repository =
        artifact_dir.join(format!("revert-repository-{}", artifact.artifact_id));
    let revert_cleanup = RemovePrivateDirectoryOnDrop::armed(revert_repository.clone()).unwrap();
    let init = run_git_command_with_private_repository(
        workspace.path(),
        &["init", "--bare"],
        &revert_repository,
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(init.success, "{}", init.stderr);
    for args in [
        &["apply", "--reverse", "--check", "--binary", "-"][..],
        &["apply", "--reverse", "--binary", "-"][..],
    ] {
        let result = run_git_command_with_private_repository(
            workspace.path(),
            args,
            &revert_repository,
            Some(workspace.path()),
            None,
            Some(&patch),
            4096,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(result.success, "{}", result.stderr);
    }
    drop(revert_cleanup);
    assert!(!revert_repository.exists());
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("kept.txt")).unwrap(),
        "owned baseline\n"
    );
    assert!(!workspace.path().join("created.txt").exists());
    assert_eq!(
        std::fs::read_to_string(&retained).unwrap(),
        "keep the actual artifact directory\n"
    );
    assert!(!workspace.path().join(".git").exists());
}

#[tokio::test]
#[cfg(unix)]
async fn snapshot_policy_does_not_execute_repository_filters_or_fsmonitor() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let marker = workspace.path().join("unexpected-execution");
    let filter = format!("printf triggered >> '{}'; cat", marker.display());
    let monitor = format!("printf triggered >> '{}'", marker.display());
    for args in [
        vec!["init"],
        vec!["config", "filter.fixture.clean", &filter],
        vec!["config", "core.fsmonitor", &monitor],
    ] {
        let result = run_git_command(workspace.path(), &args, 4096, Duration::from_secs(10))
            .await
            .unwrap();
        assert!(result.success, "{}", result.stderr);
    }
    std::fs::write(
        workspace.path().join(".gitattributes"),
        "*.txt text eol=lf filter=fixture ident\n",
    )
    .unwrap();
    std::fs::write(workspace.path().join("report.txt"), "original bytes\r\n").unwrap();
    let before = capture_worktree_tree(workspace.path(), artifacts.path(), "turn-filter", "before")
        .await
        .unwrap()
        .unwrap();
    assert!(!marker.exists(), "capture executed user configuration");
    assert_eq!(before.backend, GitSnapshotBackend::Isolated);
    let hash = run_git_command(
        workspace.path(),
        &["hash-object", "--no-filters", "report.txt"],
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    let expected = hash.stdout.as_str().unwrap().trim();
    let actual = run_git_command_with_private_repository(
        workspace.path(),
        &["rev-parse", &format!("{}:report.txt", before.tree)],
        &private_snapshot_repository(artifacts.path(), "turn-filter"),
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(actual.success, "{}", actual.stderr);
    assert_eq!(
        actual.stdout.as_str().unwrap().trim(),
        expected,
        "snapshot normalized the source bytes"
    );
    let shared = run_git_command(
        workspace.path(),
        &["cat-file", "-e", expected],
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(
        !shared.success,
        "snapshot content leaked into the user's object database"
    );
}

#[tokio::test]
async fn snapshot_policy_uses_actual_bytes_for_tracked_ignored_and_index_flagged_files() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("tracked.txt"), "old bytes\n").unwrap();
    std::fs::write(workspace.path().join("sparse.txt"), "old sparse\n").unwrap();
    for args in [
        vec!["init"],
        vec!["add", "tracked.txt", "sparse.txt"],
        vec!["update-index", "--assume-unchanged", "tracked.txt"],
        vec!["update-index", "--skip-worktree", "sparse.txt"],
    ] {
        let result = run_git_command(workspace.path(), &args, 4096, Duration::from_secs(10))
            .await
            .unwrap();
        assert!(result.success, "{}", result.stderr);
    }
    std::fs::write(workspace.path().join(".gitignore"), "*.txt\n").unwrap();
    std::fs::write(workspace.path().join("tracked.txt"), "current bytes\r\n").unwrap();
    std::fs::write(workspace.path().join("sparse.txt"), "current sparse\n").unwrap();
    std::fs::write(workspace.path().join("ignored.txt"), "stay ignored\n").unwrap();
    let index = std::fs::read(workspace.path().join(".git/index")).unwrap();
    let snapshot = capture_worktree_tree(workspace.path(), artifacts.path(), "flags", "before")
        .await
        .unwrap()
        .unwrap();
    for name in ["tracked.txt", "sparse.txt"] {
        let expected = run_git_command(
            workspace.path(),
            &["hash-object", "--no-filters", name],
            4096,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        let actual = run_git_command_with_private_repository(
            workspace.path(),
            &["rev-parse", &format!("{}:{name}", snapshot.tree)],
            &private_snapshot_repository(artifacts.path(), "flags"),
            None,
            None,
            None,
            4096,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(actual.success, "{}", actual.stderr);
        assert_eq!(actual.stdout, expected.stdout);
    }
    let absent = run_git_command_with_private_repository(
        workspace.path(),
        &["cat-file", "-e", &format!("{}:ignored.txt", snapshot.tree)],
        &private_snapshot_repository(artifacts.path(), "flags"),
        None,
        None,
        None,
        4096,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    assert!(!absent.success);
    assert_eq!(
        std::fs::read(workspace.path().join(".git/index")).unwrap(),
        index
    );
}

#[tokio::test]
async fn turn_file_changes_native_review_remains_read_only_when_reversal_is_requested() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let artifacts = engine
        .session_storage_dir_for(&engine.session_id())
        .join("turn-file-changes");
    let file = workspace.path().join("result.txt");
    std::fs::write(&file, "before\n").unwrap();
    let before = capture_worktree_tree(workspace.path(), &artifacts, "review", "before")
        .await
        .unwrap()
        .unwrap();
    std::fs::write(&file, "after\n").unwrap();
    let artifact = finalize_turn_file_changes(
        workspace.path(),
        &artifacts,
        &engine.session_id(),
        "review",
        before,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(turn_file_changes_summary(&artifact)["revertible"], false);
    let mut params = DeviceExecuteParams {
        command_key: "turn_file_changes_review".into(),
        thread_id: None,
        path: Some(workspace.path().to_string_lossy().into_owned()),
        args: vec![artifact.artifact_id.clone()],
        max_output_bytes: None,
        timeout_seconds: None,
        stdin: None,
        expected_revision: None,
    };
    let review = turn_file_changes_command(&engine, &params).await.unwrap();
    assert!(review.success);
    assert!(review.stdout.to_string().contains("+after"));
    let metadata_path = artifacts.join(format!("{}.json", artifact.artifact_id));
    let retained = std::fs::read(&metadata_path).unwrap();
    std::fs::write(&file, "concurrent user content\n").unwrap();
    params.command_key = "turn_file_changes_revert".into();
    let denied = turn_file_changes_command(&engine, &params).await.unwrap();
    assert_eq!(denied.stdout["success"], false);
    assert_eq!(std::fs::read(&file).unwrap(), b"concurrent user content\n");
    assert_eq!(std::fs::read(metadata_path).unwrap(), retained);
}

#[tokio::test]
async fn snapshot_policy_limit_crossings_do_not_fabricate_file_creation_or_deletion() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let artifact_dir = artifacts.path().join("thread/turn-file-changes");
    let policy = kcoder_config::TurnFileChangesSettings {
        max_file_bytes: 64,
        ..Default::default()
    };
    for (name, bytes) in [
        ("growing.txt", vec![b'a'; 16]),
        ("shrinking.txt", vec![b'b'; 128]),
        ("visible.txt", b"before\n".to_vec()),
    ] {
        std::fs::write(workspace.path().join(name), bytes).unwrap();
    }
    let before = capture_worktree_tree_with_policy(
        workspace.path(),
        &artifact_dir,
        "crossing",
        "before",
        &policy,
    )
    .await
    .unwrap()
    .unwrap();
    std::fs::write(workspace.path().join("growing.txt"), vec![b'c'; 128]).unwrap();
    std::fs::write(workspace.path().join("shrinking.txt"), vec![b'd'; 16]).unwrap();
    std::fs::write(workspace.path().join("visible.txt"), "after\n").unwrap();
    let capture = finalize_turn_file_changes_with_policy(
        workspace.path(),
        &artifact_dir,
        "thread",
        "crossing",
        before,
        &policy,
    )
    .await
    .unwrap();
    assert!(capture.has_exclusions);
    let artifact = capture.artifact.unwrap();
    assert_eq!(artifact.file_count, 1);
    assert_eq!(artifact.files[0].path, "visible.txt");
    let patch =
        std::fs::read_to_string(artifact_dir.join(format!("{}.patch", artifact.artifact_id)))
            .unwrap();
    assert!(!patch.contains("growing.txt"));
    assert!(!patch.contains("shrinking.txt"));
}

#[tokio::test]
async fn turn_file_change_summary_preserves_unicode_names_and_renames() {
    let workspace = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let artifact_dir = artifacts.path().join("thread/turn-file-changes");
    std::fs::write(workspace.path().join("资料.txt"), "old document\n").unwrap();
    std::fs::write(
        workspace.path().join("before name.txt"),
        "unchanged rename body\n",
    )
    .unwrap();
    let before = capture_worktree_tree(workspace.path(), &artifact_dir, "names", "before")
        .await
        .unwrap()
        .unwrap();
    std::fs::write(workspace.path().join("资料.txt"), "new document\n").unwrap();
    std::fs::rename(
        workspace.path().join("before name.txt"),
        workspace.path().join("新路径.txt"),
    )
    .unwrap();
    let artifact =
        finalize_turn_file_changes(workspace.path(), &artifact_dir, "thread", "names", before)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(artifact.file_count, 2);
    let changed = artifact
        .files
        .iter()
        .find(|file| file.path == "资料.txt")
        .expect("Unicode path was quoted or lost");
    assert_eq!((changed.additions, changed.deletions), (1, 1));
    let renamed = artifact
        .files
        .iter()
        .find(|file| file.path == "新路径.txt")
        .expect("Unicode rename was quoted or lost");
    assert_eq!(renamed.old_path.as_deref(), Some("before name.txt"));
    assert_eq!(renamed.change_type, "renamed");
}
