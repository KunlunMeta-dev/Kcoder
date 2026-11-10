pub(super) use kcoder_workspace_resources::git::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::{capture_worktree_tree, device_execute, finalize_turn_file_changes};
    use kcoder_app_protocol::DeviceExecuteParams;
    use std::{path::Path, time::Duration};

    fn binary_fixture(mut seed: u32) -> Vec<u8> {
        // Deterministic, incompressible test bytes reproduce large Git binary payloads.
        let mut bytes = vec![0; 1_300_000];
        for byte in &mut bytes[1..] {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *byte = seed as u8;
        }
        bytes
    }

    async fn git(cwd: &Path, args: &[&str]) {
        let result = run_git_command(cwd, args, 4096, Duration::from_secs(10))
            .await
            .unwrap();
        assert!(result.success, "git {args:?}: {}", result.stderr);
    }

    async fn assert_review(cwd: &Path, command_key: &str, text: &str) {
        let result = device_execute(
            cwd,
            &DeviceExecuteParams {
                command_key: command_key.into(),
                thread_id: None,
                path: Some(cwd.to_string_lossy().into_owned()),
                args: Vec::new(),
                max_output_bytes: Some(64 * 1024),
                timeout_seconds: Some(10),
                stdin: None,
                expected_revision: None,
            },
        )
        .await
        .unwrap();
        assert!(result.success, "{command_key}: {}", result.stderr);
        let diff = result.stdout.as_str().unwrap();
        assert!(
            diff.contains("Binary files "),
            "{command_key} omitted binary summary"
        );
        assert!(
            !diff.contains("GIT binary patch"),
            "{command_key} exposed binary payload"
        );
        assert!(diff.contains(text), "{command_key} lost text hunks");
        assert!(
            diff.len() < 4096,
            "{command_key} binary summary is unexpectedly large"
        );
        assert!(!result.stderr.contains("truncated"));
    }

    #[tokio::test]
    async fn review_diffs_summarize_large_binary_files_and_keep_text_hunks() {
        let workspace = tempfile::tempdir().unwrap();
        let cwd = workspace.path();
        git(cwd, &["init", "-b", "main"]).await;
        git(cwd, &["config", "user.name", "KCoder Test"]).await;
        git(cwd, &["config", "user.email", "kcoder@example.invalid"]).await;
        std::fs::write(cwd.join("picture.png"), binary_fixture(42)).unwrap();
        std::fs::write(cwd.join("README.md"), "initial text\n").unwrap();
        assert_review(cwd, "git_diff_working", "+initial text").await;
        assert_review(cwd, "git_branch_diff", "+initial text").await;
        git(cwd, &["add", "--all"]).await;
        git(
            cwd,
            &["-c", "commit.gpgsign=false", "commit", "-m", "initial"],
        )
        .await;
        assert_review(cwd, "git_diff_last_commit", "+initial text").await;

        std::fs::write(cwd.join("picture.png"), binary_fixture(43)).unwrap();
        std::fs::write(cwd.join("README.md"), "changed text\n").unwrap();
        std::fs::write(cwd.join("untracked.png"), binary_fixture(44)).unwrap();
        std::fs::write(cwd.join("untracked.txt"), "untracked text\n").unwrap();
        for command in ["git_diff_unstaged", "git_diff_working", "git_branch_diff"] {
            assert_review(cwd, command, "+changed text").await;
        }
        assert_review(cwd, "git_diff_working", "+untracked text").await;
        git(cwd, &["add", "--all"]).await;
        assert_review(cwd, "git_diff_staged", "+changed text").await;
        assert_review(cwd, "git_branch_diff", "+untracked text").await;
        git(
            cwd,
            &["-c", "commit.gpgsign=false", "commit", "-m", "changed"],
        )
        .await;
        assert_review(cwd, "git_diff_last_commit", "+changed text").await;
    }

    #[tokio::test]
    async fn binary_snapshot_patch_retains_exact_reversible_bytes() {
        let workspace = tempfile::tempdir().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let artifact_dir = artifacts.path().join("binary-thread/turn-file-changes");
        let cwd = workspace.path();
        git(cwd, &["init", "-b", "main"]).await;
        let original = binary_fixture(45);
        std::fs::write(cwd.join("picture.png"), &original).unwrap();
        let before = capture_worktree_tree(cwd, &artifact_dir, "binary-turn", "before")
            .await
            .unwrap()
            .unwrap();
        std::fs::write(cwd.join("picture.png"), binary_fixture(46)).unwrap();
        let artifact =
            finalize_turn_file_changes(cwd, &artifact_dir, "binary-thread", "binary-turn", before)
                .await
                .unwrap()
                .unwrap();
        let patch =
            std::fs::read_to_string(artifact_dir.join(format!("{}.patch", artifact.artifact_id)))
                .unwrap();
        assert!(patch.contains("GIT binary patch"));
        assert_eq!(
            crate::app_server::hex_sha256(patch.as_bytes()),
            artifact.patch_sha256
        );
        let review = review_diff_without_binary_payload(&patch);
        assert!(review.contains("Binary files differ"));
        assert!(!review.contains("GIT binary patch"));
        assert!(review.len() < 4096);
        assert_eq!(
            crate::app_server::hex_sha256(patch.as_bytes()),
            artifact.patch_sha256
        );
        let result = run_git_command_with_stdin(
            cwd,
            &["apply", "--reverse", "--binary", "--whitespace=nowarn", "-"],
            &patch,
            4096,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(result.success, "{}", result.stderr);
        assert_eq!(std::fs::read(cwd.join("picture.png")).unwrap(), original);
    }
}
