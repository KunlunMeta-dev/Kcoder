//! Agent verification workspace; state ownership is retained by the agent facade.

use super::*;

pub(super) fn verifier_ignores_untracked_path(path: &str) -> bool {
    // These directories contain runtime state, not candidate patches. In particular,
    // pytest basetemp creates many symlinks named after tests; do not report them as test modifications.
    path.replace('\\', "/")
        .split('/')
        .map(str::to_ascii_lowercase)
        .any(|component| {
            component == ".kcoder"
                || component == ".pytest_cache"
                || component.starts_with("pytest-of-")
        })
}

impl Drop for VerifierWorkspaceIsolation {
    fn drop(&mut self) {
        let mut all_removed = true;
        for worktree in [&self.worktree_root, &self.baseline_root] {
            all_removed &= verifier_git_command()
                .arg("-C")
                .arg(verifier_git_path_arg(&self.source_root))
                .args(["worktree", "remove", "--force"])
                .arg(verifier_git_path_arg(worktree))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .as_std_mut()
                .status()
                .is_ok_and(|status| status.success());
        }
        if !all_removed {
            let _ = verifier_git_command()
                .arg("-C")
                .arg(verifier_git_path_arg(&self.source_root))
                .args(["worktree", "prune"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .as_std_mut()
                .status();
        }
    }
}

pub(super) fn windows_verifier_git_argument(value: &str) -> std::borrow::Cow<'_, str> {
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        return format!("//{}", unc.replace('\\', "/")).into();
    }
    if let Some(dos) = value.strip_prefix(r"\\?\")
        && dos.as_bytes().get(1) == Some(&b':')
    {
        return dos.replace('\\', "/").into();
    }
    value.into()
}

pub(super) fn verifier_git_argument(value: &str) -> std::borrow::Cow<'_, str> {
    if cfg!(windows) {
        windows_verifier_git_argument(value)
    } else {
        value.into()
    }
}

pub(super) fn verifier_git_path_arg(path: &Path) -> std::ffi::OsString {
    path.to_str()
        .map(|value| std::ffi::OsString::from(verifier_git_argument(value).as_ref()))
        .unwrap_or_else(|| path.as_os_str().to_owned())
}

pub(super) fn verifier_git_command() -> tokio::process::Command {
    let mut command = tokio::process::Command::new("git");
    // Git for Windows expects DOS/UNC arguments, not Win32 verbatim paths.
    // Long-path support remains command-local and never changes user Git config.
    #[cfg(windows)]
    command
        .args(["-c", "core.longpaths=true"])
        .creation_flags(0x0800_0000);
    command.stdin(Stdio::null()).kill_on_drop(true);
    command
}

pub(super) async fn verifier_git_working_directory(
    private_root: &Path,
) -> Result<PathBuf, AgentError> {
    // The private root retains its DELETE-capable identity handle for secure
    // cleanup. Windows chdir opens a conflicting handle, so run Git in a child
    // directory without releasing the root capability or changing its ACL.
    let directory = private_root.join("git-command");
    tokio::fs::create_dir(&directory).await.map_err(|error| {
        AgentError::Execution(format!(
            "failed to create private Git working directory: {error}"
        ))
    })?;
    Ok(directory)
}

pub(super) async fn verifier_git_output(
    cwd: &std::path::Path,
    args: &[&str],
) -> Result<Vec<u8>, AgentError> {
    let output = verifier_git_command()
        .arg("-C")
        .arg(verifier_git_path_arg(cwd))
        .args(
            args.iter()
                .map(|value| verifier_git_argument(value).into_owned()),
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .output()
        .await
        .map_err(|error| {
            AgentError::Execution(format!("failed to prepare verifier workspace: {error}"))
        })?;
    if !output.status.success() {
        return Err(AgentError::Execution(format!(
            "failed to prepare verifier workspace with `git {}`: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

pub(super) async fn verifier_snapshot_git_output(
    git_dir: &Path,
    work_tree: Option<&Path>,
    index_file: Option<&Path>,
    args: &[&str],
) -> Result<Vec<u8>, AgentError> {
    let mut command = verifier_git_command();
    command
        .args(
            args.iter()
                .map(|value| verifier_git_argument(value).into_owned()),
        )
        .env("GIT_DIR", verifier_git_path_arg(git_dir))
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            verifier_git_path_arg(&git_dir.join("kcoder-no-global-config")),
        )
        .env("LC_ALL", "C");
    if let Some(work_tree) = work_tree {
        command.env("GIT_WORK_TREE", verifier_git_path_arg(work_tree));
    }
    if let Some(index_file) = index_file {
        command.env("GIT_INDEX_FILE", verifier_git_path_arg(index_file));
    }
    let output = command.output().await.map_err(|error| {
        AgentError::Execution(format!(
            "failed to prepare private verifier snapshot: {error}"
        ))
    })?;
    if !output.status.success() {
        return Err(AgentError::Execution(format!(
            "failed to prepare private verifier snapshot with `git {}`: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

pub(super) fn verifier_snapshot_pathspec() -> [&'static str; 6] {
    [
        "add",
        "-A",
        "--",
        ".",
        ":(exclude).kcoder",
        ":(exclude).kcoder/**",
    ]
}

pub(super) async fn capture_verifier_workspace_baseline(
    source_cwd: &Path,
    bundle_path: &Path,
) -> Result<Option<VerifierWorkspaceBaseline>, AgentError> {
    let git_root = match verifier_git_output(source_cwd, &["rev-parse", "--show-toplevel"]).await {
        Ok(output) => Some(PathBuf::from(
            String::from_utf8(output)
                .map_err(|_| {
                    AgentError::Execution("git workspace root is not valid UTF-8".to_string())
                })?
                .trim(),
        )),
        Err(_) => None,
    };
    if let Some(git_root) = git_root.as_deref()
        && verifier_git_output(git_root, &["rev-parse", "--verify", "HEAD^{commit}"])
            .await
            .is_ok()
    {
        return Ok(None);
    }

    let source_root =
        dunce::canonicalize(git_root.as_deref().unwrap_or(source_cwd)).map_err(|error| {
            AgentError::Execution(format!(
                "failed to resolve Goal Pro baseline source `{}`: {error}",
                source_cwd.display()
            ))
        })?;
    let temporary =
        kcoder_config::create_private_temp_dir("kcoder-goal-capture").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate Goal Pro baseline capture directory: {error:#}"
            ))
        })?;
    let repository = temporary.path().join("repository.git");
    let index = temporary.path().join("baseline.index");
    let temporary_bundle = temporary.path().join("baseline.bundle");
    let git_cwd = verifier_git_working_directory(temporary.path()).await?;
    verifier_git_output(
        &git_cwd,
        &[
            "init",
            "--bare",
            repository.to_str().ok_or_else(|| {
                AgentError::Execution("Goal Pro baseline repository path is not UTF-8".to_string())
            })?,
        ],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        Some(&source_root),
        Some(&index),
        &["read-tree", "--empty"],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        Some(&source_root),
        Some(&index),
        &verifier_snapshot_pathspec(),
    )
    .await?;
    let tree = String::from_utf8(
        verifier_snapshot_git_output(
            &repository,
            Some(&source_root),
            Some(&index),
            &["write-tree"],
        )
        .await?,
    )
    .map_err(|_| AgentError::Execution("Goal Pro baseline tree id is not UTF-8".to_string()))?;
    let tree = tree.trim();
    let commit_output = verifier_git_command()
        .args(["commit-tree", tree, "-m", "KCoder Goal Pro baseline"])
        .env("GIT_DIR", verifier_git_path_arg(&repository))
        .env("GIT_AUTHOR_NAME", "KCoder")
        .env("GIT_AUTHOR_EMAIL", "kcoder@localhost")
        .env("GIT_COMMITTER_NAME", "KCoder")
        .env("GIT_COMMITTER_EMAIL", "kcoder@localhost")
        .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            verifier_git_path_arg(&repository.join("kcoder-no-global-config")),
        )
        .env("LC_ALL", "C")
        .output()
        .await
        .map_err(|error| {
            AgentError::Execution(format!("failed to commit Goal Pro baseline: {error}"))
        })?;
    if !commit_output.status.success() {
        return Err(AgentError::Execution(format!(
            "failed to commit Goal Pro baseline: {}",
            String::from_utf8_lossy(&commit_output.stderr).trim()
        )));
    }
    let commit = String::from_utf8(commit_output.stdout)
        .map_err(|_| AgentError::Execution("Goal Pro baseline commit is not UTF-8".to_string()))?
        .trim()
        .to_string();
    verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &["update-ref", "refs/heads/baseline", &commit],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &[
            "bundle",
            "create",
            temporary_bundle.to_str().ok_or_else(|| {
                AgentError::Execution("Goal Pro baseline bundle path is not UTF-8".to_string())
            })?,
            "refs/heads/baseline",
        ],
    )
    .await?;
    let bytes = tokio::fs::read(&temporary_bundle).await.map_err(|error| {
        AgentError::Execution(format!("failed to read Goal Pro baseline bundle: {error}"))
    })?;
    if bytes.len() > MAX_VERIFIER_BASELINE_BUNDLE_BYTES {
        return Err(AgentError::Execution(
            "Goal Pro baseline bundle exceeds the 256 MiB limit".to_string(),
        ));
    }
    let bundle_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let parent = bundle_path.parent().ok_or_else(|| {
        AgentError::Execution("Goal Pro baseline bundle has no parent directory".to_string())
    })?;
    let file_name = bundle_path.file_name().ok_or_else(|| {
        AgentError::Execution("Goal Pro baseline bundle has no file name".to_string())
    })?;
    kcoder_config::PrivateDirectory::open_or_create(parent)
        .and_then(|directory| directory.atomic_replace(file_name, &bytes))
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to persist Goal Pro baseline bundle `{}`: {error:#}",
                bundle_path.display()
            ))
        })?;
    Ok(Some(VerifierWorkspaceBaseline {
        bundle_path: bundle_path.to_path_buf(),
        bundle_sha256,
        commit,
        source_root,
    }))
}

/// Save a baseline for an artifact goal without a Git HEAD before the primary agent receives its first mutable turn.
pub async fn ensure_goal_pro_workspace_baseline(
    state: &AppState,
    goal: &Goal,
) -> Result<Goal, AgentError> {
    let policy = &goal.verifier_selection.verification;
    let requires_workspace_baseline = goal.mode.is_strict()
        && goal.verification_kind.is_artifact()
        && (!policy.allow_workspace_changes || policy.require_behavior_delta);
    if !requires_workspace_baseline || goal.workspace_baseline.is_some() {
        return Ok(goal.clone());
    }
    let bundle_path = state.goal_workspace_baseline_bundle_path(&goal.goal_id);
    let Some(captured) = capture_verifier_workspace_baseline(&state.cwd(), &bundle_path).await?
    else {
        return Ok(goal.clone());
    };
    state
        .set_goal_workspace_baseline_if_matches(
            &goal.goal_id,
            goal.revision,
            GoalWorkspaceBaseline {
                bundle_path: captured.bundle_path,
                bundle_sha256: captured.bundle_sha256,
                commit: captured.commit,
                source_root: captured.source_root,
            },
        )
        .ok_or_else(|| {
            AgentError::Execution(
                "Goal changed while its private verifier baseline was being captured".to_string(),
            )
        })
}

pub(super) async fn read_verifier_workspace_baseline_bundle(
    baseline: &VerifierWorkspaceBaseline,
) -> Result<Vec<u8>, AgentError> {
    let path = baseline.bundle_path.clone();
    let bytes = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("baseline bundle has no parent directory"))?;
        let name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("baseline bundle has no file name"))?;
        let directory = kcoder_config::PrivateDirectory::open_existing(parent)?;
        let mut file = directory.open_regular_file(name)?;
        let mut bytes = Vec::new();
        file.by_ref()
            .take((MAX_VERIFIER_BASELINE_BUNDLE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() <= MAX_VERIFIER_BASELINE_BUNDLE_BYTES,
            "baseline bundle exceeds the 256 MiB limit"
        );
        Ok(bytes)
    })
    .await
    .map_err(|error| AgentError::Execution(format!("Goal Pro baseline reader failed: {error}")))?
    .map_err(|error| {
        AgentError::Execution(format!(
            "failed to read Goal Pro baseline bundle: {error:#}"
        ))
    })?;
    let actual_sha256 = format!("{:x}", Sha256::digest(&bytes));
    if actual_sha256 != baseline.bundle_sha256 {
        return Err(AgentError::Execution(format!(
            "Goal Pro baseline bundle SHA-256 mismatch: expected {}, got {actual_sha256}",
            baseline.bundle_sha256
        )));
    }
    Ok(bytes)
}

pub(super) async fn apply_verifier_candidate_patch(
    worktree_root: &Path,
    diff: &[u8],
) -> Result<(), AgentError> {
    if diff.is_empty() {
        return Ok(());
    }
    let mut child = verifier_git_command()
        .arg("-C")
        .arg(verifier_git_path_arg(worktree_root))
        .args(["apply", "--binary", "--whitespace=nowarn", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to apply candidate patch in verifier worktree: {error}"
            ))
        })?;
    child
        .stdin
        .take()
        .ok_or_else(|| {
            AgentError::Execution("verifier git apply stdin is unavailable".to_string())
        })?
        .write_all(diff)
        .await
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to stream candidate patch into verifier worktree: {error}"
            ))
        })?;
    let output = child.wait_with_output().await.map_err(|error| {
        AgentError::Execution(format!(
            "failed to apply candidate patch in verifier worktree: {error}"
        ))
    })?;
    if !output.status.success() {
        return Err(AgentError::Execution(format!(
            "candidate patch could not be reproduced in verifier worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

pub(super) async fn copy_verifier_issue_context(
    source_root: &Path,
    worktree_root: &Path,
) -> Result<(), AgentError> {
    let source_issue = source_root.join("issue.md");
    let target_issue = worktree_root.join("issue.md");
    if target_issue.exists() {
        return Ok(());
    }
    let Ok(metadata) = tokio::fs::symlink_metadata(&source_issue).await else {
        return Ok(());
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.len() > MAX_VERIFIER_ISSUE_CONTEXT_BYTES {
        return Err(AgentError::Execution(
            "issue.md exceeds the 1 MiB verifier context limit".to_string(),
        ));
    }
    tokio::fs::copy(&source_issue, &target_issue)
        .await
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to copy verifier issue context `{}`: {error}",
                source_issue.display()
            ))
        })?;
    tokio::fs::set_permissions(&target_issue, metadata.permissions())
        .await
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to preserve verifier issue context permissions: {error}"
            ))
        })?;
    Ok(())
}

pub(super) async fn create_snapshot_verifier_workspace_isolation(
    source_cwd: &Path,
    baseline: &VerifierWorkspaceBaseline,
) -> Result<VerifierWorkspaceIsolation, AgentError> {
    let canonical_cwd = dunce::canonicalize(source_cwd).map_err(|error| {
        AgentError::Execution(format!(
            "failed to resolve verifier source cwd `{}`: {error}",
            source_cwd.display()
        ))
    })?;
    let canonical_source_root = dunce::canonicalize(&baseline.source_root).map_err(|error| {
        AgentError::Execution(format!(
            "failed to resolve Goal Pro baseline source `{}`: {error}",
            baseline.source_root.display()
        ))
    })?;
    let relative_cwd = canonical_cwd
        .strip_prefix(&canonical_source_root)
        .map_err(|_| {
            AgentError::Execution(
                "current verifier cwd is outside the captured Goal Pro baseline source".to_string(),
            )
        })?;
    let bundle = read_verifier_workspace_baseline_bundle(baseline).await?;
    let private_root =
        kcoder_config::create_private_temp_dir("kcoder-goal-worktree").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier worktree: {error:#}"
            ))
        })?;
    let baseline_root =
        kcoder_config::create_private_temp_dir("kcoder-goal-baseline").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier baseline: {error:#}"
            ))
        })?;
    let repository_root = kcoder_config::create_private_temp_dir("kcoder-goal-repository")
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier repository: {error:#}"
            ))
        })?;
    let private_bundle = repository_root.path().join("baseline.bundle");
    let repository = repository_root.path().join("repository.git");
    let candidate_index = repository_root.path().join("candidate.index");
    let git_cwd = verifier_git_working_directory(repository_root.path()).await?;
    tokio::fs::write(&private_bundle, bundle)
        .await
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to materialize private Goal Pro baseline bundle: {error}"
            ))
        })?;
    verifier_git_output(
        &git_cwd,
        &[
            "clone",
            "--bare",
            private_bundle.to_str().ok_or_else(|| {
                AgentError::Execution("private baseline bundle path is not UTF-8".to_string())
            })?,
            repository.to_str().ok_or_else(|| {
                AgentError::Execution("private baseline repository path is not UTF-8".to_string())
            })?,
        ],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &["cat-file", "-e", &format!("{}^{{commit}}", baseline.commit)],
    )
    .await?;

    let worktree_root = private_root.path().join("workspace");
    let baseline_worktree_root = baseline_root.path().join("workspace");
    verifier_git_output(
        &repository,
        &[
            "worktree",
            "add",
            "--detach",
            worktree_root.to_str().ok_or_else(|| {
                AgentError::Execution("verifier worktree path is not valid UTF-8".to_string())
            })?,
            &baseline.commit,
        ],
    )
    .await?;
    if let Err(error) = verifier_git_output(
        &repository,
        &[
            "worktree",
            "add",
            "--detach",
            baseline_worktree_root.to_str().ok_or_else(|| {
                AgentError::Execution("verifier baseline path is not valid UTF-8".to_string())
            })?,
            &baseline.commit,
        ],
    )
    .await
    {
        let _ = verifier_git_output(
            &repository,
            &[
                "worktree",
                "remove",
                "--force",
                worktree_root.to_str().unwrap_or_default(),
            ],
        )
        .await;
        return Err(error);
    }

    verifier_snapshot_git_output(
        &repository,
        Some(&canonical_source_root),
        Some(&candidate_index),
        &["read-tree", &baseline.commit],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        Some(&canonical_source_root),
        Some(&candidate_index),
        &verifier_snapshot_pathspec(),
    )
    .await?;
    let candidate_tree = String::from_utf8(
        verifier_snapshot_git_output(
            &repository,
            Some(&canonical_source_root),
            Some(&candidate_index),
            &["write-tree"],
        )
        .await?,
    )
    .map_err(|_| AgentError::Execution("candidate snapshot tree id is not UTF-8".to_string()))?;
    let candidate_tree = candidate_tree.trim();
    let diff = verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &[
            "diff",
            "--binary",
            "--full-index",
            &baseline.commit,
            candidate_tree,
            "--",
            ".",
        ],
    )
    .await?;
    if diff.len() > MAX_VERIFIER_WORKSPACE_SNAPSHOT_BYTES {
        return Err(AgentError::Execution(
            "verifier workspace diff exceeds the 64 MiB snapshot limit".to_string(),
        ));
    }
    apply_verifier_candidate_patch(&worktree_root, &diff).await?;
    copy_verifier_issue_context(&canonical_source_root, &worktree_root).await?;
    let changed_paths = verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &[
            "diff",
            "--name-only",
            "-z",
            &baseline.commit,
            candidate_tree,
            "--",
            ".",
        ],
    )
    .await?
    .split(|byte| *byte == 0)
    .filter(|path| !path.is_empty())
    .map(|path| String::from_utf8_lossy(path).into_owned())
    .filter(|path| !verifier_ignores_untracked_path(path))
    .collect();

    Ok(VerifierWorkspaceIsolation {
        _private_root: private_root,
        _baseline_root: baseline_root,
        _repository_root: Some(repository_root),
        source_root: repository,
        cwd: worktree_root.join(relative_cwd),
        worktree_root,
        baseline_root: baseline_worktree_root,
        changed_paths,
    })
}

pub(super) async fn create_verifier_workspace_isolation(
    source_cwd: &Path,
    baseline: Option<&VerifierWorkspaceBaseline>,
) -> Result<VerifierWorkspaceIsolation, AgentError> {
    match baseline {
        Some(baseline) => create_snapshot_verifier_workspace_isolation(source_cwd, baseline)
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "goal_pro_workspace_baseline_unavailable: the captured private baseline cannot be reconstructed; clear and recreate the Goal Pro before continuing: {error}"
                ))
            }),
        None => create_git_verifier_workspace_isolation(source_cwd).await,
    }
}

pub(super) async fn create_git_verifier_workspace_isolation(
    source_cwd: &std::path::Path,
) -> Result<VerifierWorkspaceIsolation, AgentError> {
    let source_root = PathBuf::from(
        String::from_utf8(
            verifier_git_output(source_cwd, &["rev-parse", "--show-toplevel"])
                .await
                .map_err(|error| {
                    AgentError::Execution(format!(
                        "goal_pro_workspace_baseline_missing: this Goal has no captured private baseline and its workspace is not a usable Git repository; clear and recreate the Goal Pro so KCoder can capture a baseline before work starts: {error}"
                    ))
                })?,
        )
        .map_err(|_| AgentError::Execution("git workspace root is not valid UTF-8".to_string()))?
        .trim(),
    );
    let canonical_cwd = dunce::canonicalize(source_cwd).map_err(|error| {
        AgentError::Execution(format!(
            "failed to resolve verifier source cwd `{}`: {error}",
            source_cwd.display()
        ))
    })?;
    let canonical_root = dunce::canonicalize(&source_root).map_err(|error| {
        AgentError::Execution(format!(
            "failed to resolve verifier repository `{}`: {error}",
            source_root.display()
        ))
    })?;
    verifier_git_output(
        &canonical_root,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )
    .await
    .map_err(|error| {
        AgentError::Execution(format!(
            "goal_pro_workspace_baseline_missing: this Goal has no captured private baseline and its Git repository has no usable HEAD; clear and recreate the Goal Pro so KCoder can capture a baseline before work starts: {error}"
        ))
    })?;
    let relative_cwd = canonical_cwd.strip_prefix(&canonical_root).map_err(|_| {
        AgentError::Execution("verifier cwd is outside its git repository".to_string())
    })?;
    let private_root =
        kcoder_config::create_private_temp_dir("kcoder-goal-worktree").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier worktree: {error:#}"
            ))
        })?;
    let worktree_root = private_root.path().join("workspace");
    let baseline_root =
        kcoder_config::create_private_temp_dir("kcoder-goal-baseline").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier baseline: {error:#}"
            ))
        })?;
    let baseline_worktree_root = baseline_root.path().join("workspace");
    verifier_git_output(
        &canonical_root,
        &[
            "worktree",
            "add",
            "--detach",
            worktree_root.to_str().ok_or_else(|| {
                AgentError::Execution("verifier worktree path is not valid UTF-8".to_string())
            })?,
            "HEAD",
        ],
    )
    .await?;
    if let Err(error) = verifier_git_output(
        &canonical_root,
        &[
            "worktree",
            "add",
            "--detach",
            baseline_worktree_root.to_str().ok_or_else(|| {
                AgentError::Execution("verifier baseline path is not valid UTF-8".to_string())
            })?,
            "HEAD",
        ],
    )
    .await
    {
        let _ = verifier_git_output(
            &canonical_root,
            &[
                "worktree",
                "remove",
                "--force",
                worktree_root.to_str().unwrap_or_default(),
            ],
        )
        .await;
        return Err(error);
    }

    let mut isolation = VerifierWorkspaceIsolation {
        _private_root: private_root,
        _baseline_root: baseline_root,
        _repository_root: None,
        source_root: canonical_root.clone(),
        cwd: worktree_root.join(relative_cwd),
        worktree_root,
        baseline_root: baseline_worktree_root,
        changed_paths: Vec::new(),
    };
    let diff = verifier_git_output(
        &canonical_root,
        &[
            "diff",
            "--binary",
            "--full-index",
            "HEAD",
            "--",
            ".",
            ":(exclude).kcoder",
            ":(exclude).kcoder/**",
        ],
    )
    .await?;
    if !diff.is_empty() {
        let mut child = verifier_git_command()
            .arg("-C")
            .arg(verifier_git_path_arg(&isolation.worktree_root))
            .args(["apply", "--binary", "--whitespace=nowarn", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to apply candidate patch in verifier worktree: {error}"
                ))
            })?;
        child
            .stdin
            .take()
            .ok_or_else(|| {
                AgentError::Execution("verifier git apply stdin is unavailable".to_string())
            })?
            .write_all(&diff)
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to stream candidate patch into verifier worktree: {error}"
                ))
            })?;
        let output = child.wait_with_output().await.map_err(|error| {
            AgentError::Execution(format!(
                "failed to apply candidate patch in verifier worktree: {error}"
            ))
        })?;
        if !output.status.success() {
            return Err(AgentError::Execution(format!(
                "candidate patch could not be reproduced in verifier worktree: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
    }

    let untracked = verifier_git_output(
        &canonical_root,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
    )
    .await?;
    let mut copied_bytes = 0u64;
    for raw_path in untracked.split(|byte| *byte == 0) {
        if raw_path.is_empty() {
            continue;
        }
        let relative = String::from_utf8_lossy(raw_path);
        if verifier_ignores_untracked_path(&relative) {
            continue;
        }
        let source = canonical_root.join(relative.as_ref());
        let target = isolation.worktree_root.join(relative.as_ref());
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to inspect untracked candidate file `{}`: {error}",
                    source.display()
                ))
            })?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                AgentError::Execution(format!(
                    "failed to create verifier candidate directory `{}`: {error}",
                    parent.display()
                ))
            })?;
        }
        if metadata.file_type().is_symlink() {
            let link_target = tokio::fs::read_link(&source).await.map_err(|error| {
                AgentError::Execution(format!(
                    "failed to read untracked candidate symlink `{}`: {error}",
                    source.display()
                ))
            })?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(link_target, &target).map_err(|error| {
                AgentError::Execution(format!(
                    "failed to copy untracked candidate symlink `{}`: {error}",
                    source.display()
                ))
            })?;
            #[cfg(windows)]
            {
                let target_is_dir = tokio::fs::metadata(&source)
                    .await
                    .is_ok_and(|metadata| metadata.is_dir());
                let result = if target_is_dir {
                    std::os::windows::fs::symlink_dir(link_target, &target)
                } else {
                    std::os::windows::fs::symlink_file(link_target, &target)
                };
                result.map_err(|error| {
                    AgentError::Execution(format!(
                        "failed to copy untracked candidate symlink `{}`: {error}",
                        source.display()
                    ))
                })?;
            }
        } else if metadata.is_file() {
            copied_bytes = copied_bytes.saturating_add(metadata.len());
            if copied_bytes > MAX_VERIFIER_UNTRACKED_COPY_BYTES {
                return Err(AgentError::Execution(
                    "untracked candidate files exceed the 256 MiB verifier isolation limit"
                        .to_string(),
                ));
            }
            tokio::fs::copy(&source, &target).await.map_err(|error| {
                AgentError::Execution(format!(
                    "failed to copy untracked candidate file `{}`: {error}",
                    source.display()
                ))
            })?;
            tokio::fs::set_permissions(&target, metadata.permissions())
                .await
                .map_err(|error| {
                    AgentError::Execution(format!(
                        "failed to preserve verifier candidate permissions `{}`: {error}",
                        source.display()
                    ))
                })?;
        }
    }
    // Some evaluation harnesses place an ignored issue.md at the repository root,
    // causing ordinary untracked-file queries to omit verifier context. Copy only
    // the context file without counting it in candidate changes or workspace fingerprints.
    let source_issue = canonical_root.join("issue.md");
    let target_issue = isolation.worktree_root.join("issue.md");
    if !target_issue.exists()
        && let Ok(metadata) = tokio::fs::symlink_metadata(&source_issue).await
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        if metadata.len() > MAX_VERIFIER_ISSUE_CONTEXT_BYTES {
            return Err(AgentError::Execution(
                "issue.md exceeds the 1 MiB verifier context limit".to_string(),
            ));
        }
        tokio::fs::copy(&source_issue, &target_issue)
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to copy verifier issue context `{}`: {error}",
                    source_issue.display()
                ))
            })?;
        tokio::fs::set_permissions(&target_issue, metadata.permissions())
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to preserve verifier issue context permissions: {error}"
                ))
            })?;
    }
    let tracked_paths = verifier_git_output(
        &isolation.worktree_root,
        &[
            "diff",
            "--name-only",
            "-z",
            "HEAD",
            "--",
            ".",
            ":(exclude).kcoder",
            ":(exclude).kcoder/**",
        ],
    )
    .await?;
    isolation.changed_paths = tracked_paths
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .chain(
            untracked
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(|path| String::from_utf8_lossy(path).into_owned())
                .filter(|path| !verifier_ignores_untracked_path(path)),
        )
        .collect();
    isolation.changed_paths.sort();
    isolation.changed_paths.dedup();
    Ok(isolation)
}
