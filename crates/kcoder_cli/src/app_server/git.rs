use anyhow::{Context, Result};
use kcoder_app_protocol::DeviceExecuteResult;
use std::borrow::Cow;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

#[cfg(windows)]
const NULL_DEVICE_PATH: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE_PATH: &str = "/dev/null";

pub(super) async fn git_branch_diff_shortstat(
    cwd: &Path,
    max_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    let deadline = tokio::time::Instant::now() + timeout;
    if let Some(merge_base) = git_default_merge_base(cwd, deadline).await? {
        return run_git_command(
            cwd,
            &["diff", "--shortstat", &merge_base, "--"],
            max_bytes,
            remaining_git_timeout(deadline),
        )
        .await;
    }
    run_git_command(
        cwd,
        &["diff", "--shortstat", "HEAD", "--"],
        max_bytes,
        remaining_git_timeout(deadline),
    )
    .await
}

async fn git_default_merge_base(
    cwd: &Path,
    deadline: tokio::time::Instant,
) -> Result<Option<String>> {
    let origin_head = run_git_command(
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        4096,
        remaining_git_timeout(deadline),
    )
    .await?;
    let mut candidates = Vec::new();
    if origin_head.success {
        let candidate = origin_head.stdout.as_str().unwrap_or_default().trim();
        if !candidate.is_empty() {
            candidates.push(candidate.to_string());
        }
    }
    candidates.extend(
        ["origin/main", "main", "origin/master", "master"]
            .into_iter()
            .map(str::to_string),
    );
    let mut base = None;
    for candidate in candidates {
        let revision = format!("{candidate}^{{commit}}");
        let result = run_git_command(
            cwd,
            &["rev-parse", "--verify", "--quiet", &revision],
            4096,
            remaining_git_timeout(deadline),
        )
        .await?;
        if result.success {
            base = Some(candidate);
            break;
        }
    }
    if let Some(base) = base {
        let merge_base = run_git_command(
            cwd,
            &["merge-base", &base, "HEAD"],
            4096,
            remaining_git_timeout(deadline),
        )
        .await?;
        if merge_base.success {
            let merge_base = merge_base.stdout.as_str().unwrap_or_default().trim();
            if !merge_base.is_empty() {
                return Ok(Some(merge_base.to_string()));
            }
        }
    }
    Ok(None)
}

pub(super) async fn git_branch_diff(
    cwd: &Path,
    max_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    let deadline = tokio::time::Instant::now() + timeout;
    let tracked = if let Some(merge_base) = git_default_merge_base(cwd, deadline).await? {
        run_git_command(
            cwd,
            &["diff", &merge_base, "--"],
            max_bytes,
            remaining_git_timeout(deadline),
        )
        .await?
    } else {
        let head = run_git_command(
            cwd,
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            4096,
            remaining_git_timeout(deadline),
        )
        .await?;
        let args = if head.success {
            vec!["diff", "HEAD", "--"]
        } else {
            vec!["diff", "--"]
        };
        run_git_command(cwd, &args, max_bytes, remaining_git_timeout(deadline)).await?
    };
    append_untracked_git_patches(cwd, tracked, max_bytes, deadline).await
}

/// Return text hunks and binary summaries relative to the index, including untracked files absent from native Git diff.
pub(super) async fn git_working_diff(
    cwd: &Path,
    max_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    let deadline = tokio::time::Instant::now() + timeout;
    let tracked = run_git_command(
        cwd,
        &["-c", "core.quotePath=false", "diff", "--"],
        max_bytes,
        remaining_git_timeout(deadline),
    )
    .await?;
    append_untracked_git_patches(cwd, tracked, max_bytes, deadline).await
}

pub(super) async fn git_last_commit_diff(
    cwd: &Path,
    max_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    let deadline = tokio::time::Instant::now() + timeout;
    let parent = run_git_command(
        cwd,
        &["rev-parse", "--verify", "--quiet", "HEAD^"],
        4096,
        remaining_git_timeout(deadline),
    )
    .await?;
    let args = if parent.success {
        vec!["-c", "core.quotePath=false", "diff", "HEAD^..HEAD", "--"]
    } else {
        vec![
            "-c",
            "core.quotePath=false",
            "show",
            "--format=",
            "HEAD",
            "--",
        ]
    };
    run_git_command(cwd, &args, max_bytes, remaining_git_timeout(deadline)).await
}

async fn append_untracked_git_patches(
    cwd: &Path,
    tracked: DeviceExecuteResult,
    max_bytes: usize,
    deadline: tokio::time::Instant,
) -> Result<DeviceExecuteResult> {
    if !tracked.success {
        return Ok(tracked);
    }
    let mut output = tracked
        .stdout
        .as_str()
        .unwrap_or_default()
        .as_bytes()
        .to_vec();
    let files = run_git_command(
        cwd,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        max_bytes,
        remaining_git_timeout(deadline),
    )
    .await?;
    if !files.success {
        return Ok(files);
    }
    for file in files
        .stdout
        .as_str()
        .unwrap_or_default()
        .split('\0')
        .filter(|file| !file.is_empty())
    {
        let remaining = max_bytes.saturating_sub(output.len());
        if remaining == 0 {
            return Ok(DeviceExecuteResult {
                success: false,
                exit_code: 1,
                stdout: String::from_utf8_lossy(&output).into_owned().into(),
                stderr: "git command output was truncated".into(),
            });
        }
        let patch = run_git_command(
            cwd,
            &["diff", "--no-index", "--", NULL_DEVICE_PATH, file],
            remaining,
            remaining_git_timeout(deadline),
        )
        .await?;
        if patch.exit_code > 1
            || patch.stderr.contains("timed out")
            || patch.stderr.contains("truncated")
        {
            return Ok(patch);
        }
        output.extend_from_slice(patch.stdout.as_str().unwrap_or_default().as_bytes());
    }
    Ok(DeviceExecuteResult {
        success: true,
        exit_code: 0,
        stdout: String::from_utf8_lossy(&output).into_owned().into(),
        stderr: String::new(),
    })
}

fn remaining_git_timeout(deadline: tokio::time::Instant) -> Duration {
    deadline
        .checked_duration_since(tokio::time::Instant::now())
        .unwrap_or_else(|| Duration::from_millis(1))
}

/// Project stored reversible patches for review without modifying their persisted bytes or hash.
pub(super) fn review_diff_without_binary_payload(patch: &str) -> Cow<'_, str> {
    if !patch.lines().any(|line| line == "GIT binary patch") {
        return Cow::Borrowed(patch);
    }
    let mut review = String::with_capacity(patch.len().min(64 * 1024));
    let mut in_binary_payload = false;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            in_binary_payload = false;
        }
        if line.trim_end_matches(['\r', '\n']) == "GIT binary patch" {
            review.push_str("Binary files differ\n");
            in_binary_payload = true;
        } else if !in_binary_payload {
            review.push_str(line);
        }
    }
    Cow::Owned(review)
}

pub(super) async fn run_git_command(
    cwd: &Path,
    args: &[&str],
    max_stdout_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    run_git_command_inner(
        cwd,
        args,
        max_stdout_bytes,
        timeout,
        false,
        None,
        None,
        None,
    )
    .await
}

pub(super) async fn run_git_command_with_auth(
    cwd: &Path,
    args: &[&str],
    max_stdout_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    run_git_command_inner(cwd, args, max_stdout_bytes, timeout, true, None, None, None).await
}

pub(super) async fn run_git_command_with_stdin(
    cwd: &Path,
    args: &[&str],
    stdin: &str,
    max_stdout_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    run_git_command_inner(
        cwd,
        args,
        max_stdout_bytes,
        timeout,
        false,
        Some(stdin),
        None,
        None,
    )
    .await
}

pub(super) async fn run_git_command_with_index(
    cwd: &Path,
    args: &[&str],
    index_file: &Path,
    max_stdout_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    run_git_command_inner(
        cwd,
        args,
        max_stdout_bytes,
        timeout,
        false,
        None,
        Some(index_file),
        None,
    )
    .await
}

/// Same as [`run_git_command_with_index`] but with stdin (pathspec pruning).
pub(super) async fn run_git_command_with_index_and_stdin(
    cwd: &Path,
    args: &[&str],
    index_file: &Path,
    stdin: &str,
    max_stdout_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    run_git_command_inner(
        cwd,
        args,
        max_stdout_bytes,
        timeout,
        false,
        Some(stdin),
        Some(index_file),
        None,
    )
    .await
}

// Private-repository commands require explicit isolated git-dir, work-tree, index,
// stdin, and output bounds. Keeping these security parameters visible at call sites
// is easier to audit than hiding them in an untyped tuple.
#[allow(clippy::too_many_arguments)]
/// A bare repository needs `HEAD` and `config`; a Git build whose template directory is
/// unavailable creates only `objects/` and `refs/`, and standard tools then refuse to open the
/// snapshot repository ("not a git repository"). Write the two files ourselves so snapshots
/// stay inspectable, and repair repositories created before this fix.
pub(super) fn ensure_bare_snapshot_layout(repository: &Path) -> std::io::Result<bool> {
    let mut repaired = false;
    let head = repository.join("HEAD");
    if !head.exists() {
        std::fs::write(&head, "ref: refs/heads/main\n")?;
        repaired = true;
    }
    let config = repository.join("config");
    if !config.exists() {
        std::fs::write(
            &config,
            "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n",
        )?;
        repaired = true;
    }
    Ok(repaired)
}

pub(super) async fn run_git_command_with_private_repository(
    cwd: &Path,
    args: &[&str],
    git_dir: &Path,
    work_tree: Option<&Path>,
    index_file: Option<&Path>,
    stdin: Option<&str>,
    max_stdout_bytes: usize,
    timeout: Duration,
) -> Result<DeviceExecuteResult> {
    run_git_command_inner(
        cwd,
        args,
        max_stdout_bytes,
        timeout,
        false,
        stdin,
        index_file,
        Some((git_dir, work_tree)),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_git_command_inner(
    cwd: &Path,
    args: &[&str],
    max_stdout_bytes: usize,
    timeout: Duration,
    preserve_ssh_agent: bool,
    stdin: Option<&str>,
    index_file: Option<&Path>,
    private_repository: Option<(&Path, Option<&Path>)>,
) -> Result<DeviceExecuteResult> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
        )
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(index_file) = index_file {
        command.env("GIT_INDEX_FILE", index_file);
    }
    if let Some((git_dir, work_tree)) = private_repository {
        command.env("GIT_DIR", git_dir);
        if let Some(work_tree) = work_tree {
            command.env("GIT_WORK_TREE", work_tree);
        }
    }
    for key in ["HOME", "USER", "LOGNAME", "XDG_CONFIG_HOME"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "COMSPEC",
            "PATHEXT",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    if preserve_ssh_agent && let Some(value) = std::env::var_os("SSH_AUTH_SOCK") {
        command.env("SSH_AUTH_SOCK", value);
    }
    let mut child = command.spawn().context("failed to start git")?;
    let stdout = child.stdout.take().context("git stdout was not captured")?;
    let stderr = child.stderr.take().context("git stderr was not captured")?;
    let stdout_task = tokio::spawn(read_bounded_output(stdout, max_stdout_bytes));
    let stderr_task = tokio::spawn(read_bounded_output(stderr, 64 * 1024));
    if let Some(input) = stdin {
        let mut child_stdin = child.stdin.take().context("git stdin was not captured")?;
        child_stdin
            .write_all(input.as_bytes())
            .await
            .context("failed to write git stdin")?;
        let _ = child_stdin.shutdown().await;
    }
    let (status, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => (Some(status.context("failed to wait for git")?), false),
        Err(_) => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            (None, true)
        }
    };
    let ((stdout, stdout_truncated), (stderr, stderr_truncated)) =
        collect_git_output(stdout_task, stderr_task, Duration::from_secs(1)).await?;
    let mut stderr = String::from_utf8_lossy(&stderr).into_owned();
    if timed_out {
        stderr.push_str(if stderr.is_empty() {
            "git command timed out"
        } else {
            "\ngit command timed out"
        });
    }
    if stdout_truncated || stderr_truncated {
        stderr.push_str(if stderr.is_empty() {
            "git command output was truncated"
        } else {
            "\ngit command output was truncated"
        });
    }
    Ok(DeviceExecuteResult {
        success: status
            .as_ref()
            .is_some_and(std::process::ExitStatus::success)
            && !timed_out
            && !stdout_truncated,
        exit_code: status
            .and_then(|status| status.code())
            .unwrap_or(if timed_out { 124 } else { 1 }),
        stdout: String::from_utf8_lossy(&stdout).into_owned().into(),
        stderr,
    })
}

type GitOutput = (Vec<u8>, bool);

async fn collect_git_output(
    mut stdout: tokio::task::JoinHandle<Result<GitOutput>>,
    mut stderr: tokio::task::JoinHandle<Result<GitOutput>>,
    timeout: Duration,
) -> Result<(GitOutput, GitOutput)> {
    // Descendants can retain inherited pipe handles after Git exits. Never let
    // their EOF block the app-server dispatcher and unrelated conversation RPCs.
    let result = tokio::time::timeout(timeout, async {
        let out = (&mut stdout).await.context("git stdout reader failed")??;
        let err = (&mut stderr).await.context("git stderr reader failed")??;
        Ok((out, err))
    })
    .await;
    match result {
        Ok(Ok(output)) => Ok(output),
        other => {
            stdout.abort();
            stderr.abort();
            match other {
                Ok(Err(error)) => Err(error),
                Err(_) => anyhow::bail!(
                    "git output pipes did not close after process exit; the command may have completed, refresh status before retrying"
                ),
                Ok(Ok(_)) => unreachable!(),
            }
        }
    }
}

async fn read_bounded_output<R>(mut reader: R, limit: usize) -> Result<(Vec<u8>, bool)>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut retained = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..read.min(remaining)]);
        truncated |= read > remaining;
    }
    Ok((retained, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::{capture_worktree_tree, device_execute, finalize_turn_file_changes};
    use kcoder_app_protocol::DeviceExecuteParams;

    #[tokio::test]
    async fn git_output_drain_is_bounded_when_a_descendant_keeps_a_pipe_open() {
        let (reader, writer) = tokio::io::duplex(64);
        let stdout = tokio::spawn(read_bounded_output(reader, 64));
        let stderr = tokio::spawn(async { Ok((b"diagnostic".to_vec(), false)) });
        let abort = stdout.abort_handle();
        let result = collect_git_output(stdout, stderr, Duration::from_millis(25)).await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("may have completed")
        );
        tokio::task::yield_now().await;
        assert!(abort.is_finished());
        drop(writer);
    }

    #[tokio::test]
    async fn git_output_drain_preserves_output_and_truncation_markers() {
        let stdout = tokio::spawn(async { Ok((b"output".to_vec(), true)) });
        let stderr = tokio::spawn(async { Ok((b"warning".to_vec(), false)) });
        let result = collect_git_output(stdout, stderr, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(
            result,
            ((b"output".to_vec(), true), (b"warning".to_vec(), false))
        );
    }

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

    #[tokio::test]
    async fn text_review_still_enforces_the_output_limit() {
        let workspace = tempfile::tempdir().unwrap();
        git(workspace.path(), &["init", "-b", "main"]).await;
        std::fs::write(
            workspace.path().join("large.txt"),
            "text line\n".repeat(10_000),
        )
        .unwrap();
        let result = git_working_diff(workspace.path(), 4096, Duration::from_secs(10))
            .await
            .unwrap();
        assert!(!result.success);
        assert!(result.stderr.contains("git command output was truncated"));
        assert!(result.stdout.as_str().unwrap().len() <= 4096);
    }

    #[test]
    fn stored_patch_review_preserves_neighboring_text_hunks_and_original_bytes() {
        let text = "diff --git a/readme b/readme\n--- a/readme\n+++ b/readme\n@@ -1 +1 @@\n-old\n+GIT binary patch\n";
        assert!(matches!(
            review_diff_without_binary_payload(text),
            Cow::Borrowed(_)
        ));
        let binary = "diff --git a/picture.png b/picture.png\nindex 123..456 100644\nGIT binary patch\nliteral 1300000\nzOpaquePayload\n\nliteral 0\nHcmV?d00001\n\n";
        let patch = format!("{text}{binary}{text}");
        let expected = format!(
            "{text}diff --git a/picture.png b/picture.png\nindex 123..456 100644\nBinary files differ\n{text}"
        );
        assert_eq!(review_diff_without_binary_payload(&patch), expected);
        assert_eq!(patch, format!("{text}{binary}{text}"));
    }
}

#[cfg(test)]
mod bare_snapshot_layout_tests {
    use super::*;

    fn git_is_bare(repository: &Path) -> String {
        let output = std::process::Command::new("git")
            .arg(format!("--git-dir={}", repository.display()))
            .args(["rev-parse", "--is-bare-repository"])
            .output()
            .expect("git must be available in tests");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn repairs_a_template_less_repository_and_stays_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("snapshot-repository");
        std::fs::create_dir_all(repository.join("objects")).unwrap();
        std::fs::create_dir_all(repository.join("refs")).unwrap();
        assert_ne!(git_is_bare(&repository), "true");

        assert!(ensure_bare_snapshot_layout(&repository).unwrap());
        assert_eq!(git_is_bare(&repository), "true");
        assert!(!ensure_bare_snapshot_layout(&repository).unwrap());
    }
}
