//! Worktree artifacts: extracted from the app-server connection boundary.

use super::*;

#[cfg(test)]
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

pub(super) async fn capture_worktree_tree_with_policy(
    workspace: &Path,
    artifact_dir: &Path,
    turn_id: &str,
    stage: &str,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<Option<GitTreeSnapshot>> {
    let probe = run_git_command(
        workspace,
        &["rev-parse", "--is-inside-work-tree"],
        4096,
        Duration::from_secs(10),
    )
    .await?;
    let backend = if probe.success && probe.stdout.as_str().map(str::trim) == Some("true") {
        GitSnapshotBackend::Workspace
    } else {
        GitSnapshotBackend::Isolated
    };
    capture_worktree_tree_with_backend(workspace, artifact_dir, turn_id, stage, backend, policy)
        .await
        .map(Some)
}

/// Decides which staged paths stay out of a snapshot.
///
/// `size_of` receives the repository-relative path so callers can stat the
/// worktree without this helper touching the filesystem.
pub(super) fn snapshot_exclusions(
    policy: &kcoder_config::TurnFileChangesSettings,
    ignore: &globset::GlobSet,
    staged_paths: &[String],
    mut size_of: impl FnMut(&str) -> u64,
) -> Vec<String> {
    staged_paths
        .iter()
        .filter(|path| {
            let relative = Path::new(path.as_str());
            policy.excludes(relative, ignore) || policy.file_exceeds_limit(size_of(path))
        })
        .cloned()
        .collect()
}

pub(super) async fn run_snapshot_git_command(
    workspace: &Path,
    args: &[&str],
    private_git_dir: Option<&Path>,
    index_path: &Path,
    stdin: Option<&str>,
) -> Result<DeviceExecuteResult> {
    let timeout = Duration::from_secs(30);
    match private_git_dir {
        Some(git_dir) => {
            run_git_command_with_private_repository(
                workspace,
                args,
                git_dir,
                Some(workspace),
                Some(index_path),
                stdin,
                SNAPSHOT_PATH_LISTING_BYTES,
                timeout,
            )
            .await
        }
        None => match stdin {
            Some(stdin) => {
                run_git_command_with_index_and_stdin(
                    workspace,
                    args,
                    index_path,
                    stdin,
                    SNAPSHOT_PATH_LISTING_BYTES,
                    timeout,
                )
                .await
            }
            None => {
                run_git_command_with_index(
                    workspace,
                    args,
                    index_path,
                    SNAPSHOT_PATH_LISTING_BYTES,
                    timeout,
                )
                .await
            }
        },
    }
}

/// Drops staged entries the snapshot policy excludes (ignored globs, oversized files).
pub(super) async fn prune_policy_excluded_paths(
    workspace: &Path,
    private_git_dir: Option<&Path>,
    index_path: &Path,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<usize> {
    if !policy.enabled || (policy.ignore_globs.is_empty() && policy.max_file_bytes == 0) {
        return Ok(0);
    }
    let ignore = policy.compile_ignore_globs()?;
    let listing = run_snapshot_git_command(
        workspace,
        &["ls-files", "-z", "--cached"],
        private_git_dir,
        index_path,
        None,
    )
    .await?;
    if !listing.success {
        anyhow::bail!("failed to list staged snapshot paths: {}", listing.stderr);
    }
    let staged: Vec<String> = listing
        .stdout
        .as_str()
        .unwrap_or_default()
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect();
    let excluded = snapshot_exclusions(policy, &ignore, &staged, |path| {
        std::fs::metadata(workspace.join(path))
            .map(|meta| meta.len())
            .unwrap_or_default()
    });
    if excluded.is_empty() {
        return Ok(0);
    }
    let stdin = format!("{}\0", excluded.join("\0"));
    let removal = run_snapshot_git_command(
        workspace,
        &["update-index", "--force-remove", "-z", "--stdin"],
        private_git_dir,
        index_path,
        Some(&stdin),
    )
    .await?;
    if !removal.success {
        anyhow::bail!(
            "failed to prune excluded snapshot paths: {}",
            removal.stderr
        );
    }
    Ok(excluded.len())
}

pub(super) fn private_snapshot_repository(artifact_dir: &Path, turn_id: &str) -> PathBuf {
    artifact_dir.join(format!(
        "snapshot-repository-{}",
        hex_sha256(turn_id.as_bytes())
    ))
}

impl Drop for RemovePrivateFileOnDrop {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.0)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, path = %self.0.display(), "failed to remove private Git index");
        }
    }
}

impl RemovePrivateDirectoryOnDrop {
    pub(super) fn armed(path: PathBuf) -> Result<Self> {
        let parent = path.parent().context("snapshot repository has no parent")?;
        let lease = snapshot_leases::active(parent)?;
        Ok(Self {
            path,
            _lease: lease,
        })
    }
}

impl Drop for RemovePrivateDirectoryOnDrop {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, path = %self.path.display(), "failed to remove private Git repository");
        }
    }
}

pub(super) async fn capture_worktree_tree_with_backend(
    workspace: &Path,
    artifact_dir: &Path,
    turn_id: &str,
    stage: &str,
    backend: GitSnapshotBackend,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<GitTreeSnapshot> {
    ensure_private_artifact_directory(artifact_dir)?;
    let private_git_dir = private_snapshot_repository(artifact_dir, turn_id);
    let mut private_repository_cleanup = None;
    if backend == GitSnapshotBackend::Isolated && stage == "before" {
        private_repository_cleanup = Some(RemovePrivateDirectoryOnDrop::armed(
            private_git_dir.clone(),
        )?);
        match std::fs::remove_dir_all(&private_git_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let init = run_git_command_with_private_repository(
            workspace,
            &["init", "--bare"],
            &private_git_dir,
            None,
            None,
            None,
            4096,
            Duration::from_secs(15),
        )
        .await?;
        if !init.success {
            anyhow::bail!(
                "failed to initialize isolated Git snapshot repository: {}",
                init.stderr
            )
        }
        // Snapshots must stay inspectable with plain `git --git-dir=…` (P2-1).
        ensure_bare_snapshot_layout(&private_git_dir)?;
    }
    let key = format!("{turn_id}\0{stage}");
    let index_name = format!("snapshot-{}.index", hex_sha256(key.as_bytes()));
    let index_path = artifact_dir.join(index_name);
    match std::fs::remove_file(&index_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let _index_cleanup = RemovePrivateFileOnDrop(index_path.clone());
    let read_tree = match backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_index(
                workspace,
                &["read-tree", "HEAD"],
                &index_path,
                4096,
                Duration::from_secs(15),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                workspace,
                &["read-tree", "--empty"],
                &private_git_dir,
                Some(workspace),
                Some(&index_path),
                None,
                4096,
                Duration::from_secs(15),
            )
            .await?
        }
    };
    if !read_tree.success {
        let empty = match backend {
            GitSnapshotBackend::Workspace => {
                run_git_command_with_index(
                    workspace,
                    &["read-tree", "--empty"],
                    &index_path,
                    4096,
                    Duration::from_secs(15),
                )
                .await?
            }
            GitSnapshotBackend::Isolated => read_tree,
        };
        if !empty.success {
            let _ = std::fs::remove_file(&index_path);
            anyhow::bail!(
                "failed to initialize private Git snapshot index: {}",
                empty.stderr
            )
        }
    }
    let ignored_workspace = backend == GitSnapshotBackend::Workspace
        && run_git_command(
            workspace,
            &["check-ignore", "--quiet", "--", "."],
            4096,
            Duration::from_secs(10),
        )
        .await?
        .success;
    // An isolated test workspace may lie entirely inside an ignored repository path.
    // Force inclusion only for such small workspaces; normal repository workspaces
    // must honor .gitignore to avoid scanning artifacts such as target.
    let add_args = if ignored_workspace {
        &["add", "-A", "--force", "--", "."][..]
    } else {
        &["add", "-A", "--", "."][..]
    };
    let add = match backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_index(
                workspace,
                add_args,
                &index_path,
                4096,
                Duration::from_secs(5),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                workspace,
                add_args,
                &private_git_dir,
                Some(workspace),
                Some(&index_path),
                None,
                4096,
                Duration::from_secs(30),
            )
            .await?
        }
    };
    if !add.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!("failed to snapshot worktree files: {}", add.stderr)
    }
    let private_git_dir_for_pruning =
        (backend == GitSnapshotBackend::Isolated).then_some(private_git_dir.as_path());
    if let Err(error) =
        prune_policy_excluded_paths(workspace, private_git_dir_for_pruning, &index_path, policy)
            .await
    {
        tracing::warn!(%error, "failed to apply the snapshot exclusion policy");
    }
    let tree = match backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_index(
                workspace,
                &["write-tree"],
                &index_path,
                4096,
                Duration::from_secs(30),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                workspace,
                &["write-tree"],
                &private_git_dir,
                Some(workspace),
                Some(&index_path),
                None,
                4096,
                Duration::from_secs(30),
            )
            .await?
        }
    };
    if !tree.success {
        anyhow::bail!("failed to write private Git snapshot tree: {}", tree.stderr)
    }
    let tree = tree
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("Git snapshot returned an invalid tree id")?;
    Ok(GitTreeSnapshot {
        tree: tree.to_string(),
        backend,
        _private_repository_cleanup: private_repository_cleanup,
    })
}

#[cfg(test)]
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
}

pub(super) async fn finalize_turn_file_changes_with_policy(
    workspace: &Path,
    artifact_dir: &Path,
    thread_id: &str,
    turn_id: &str,
    before: GitTreeSnapshot,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<Option<TurnFileChangesArtifact>> {
    let private_git_dir = private_snapshot_repository(artifact_dir, turn_id);
    let after = capture_worktree_tree_with_backend(
        workspace,
        artifact_dir,
        turn_id,
        "after",
        before.backend,
        policy,
    )
    .await?;
    if before.tree == after.tree {
        return Ok(None);
    }
    let diff_args = [
        "diff",
        "--binary",
        "--no-ext-diff",
        &before.tree,
        &after.tree,
        "--",
        ".",
    ];
    let diff = match before.backend {
        GitSnapshotBackend::Workspace => {
            run_git_command(
                workspace,
                &diff_args,
                MAX_TURN_FILE_CHANGES_BYTES,
                Duration::from_secs(60),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                workspace,
                &diff_args,
                &private_git_dir,
                Some(workspace),
                None,
                None,
                MAX_TURN_FILE_CHANGES_BYTES,
                Duration::from_secs(60),
            )
            .await?
        }
    };
    if !diff.success {
        anyhow::bail!("failed to generate turn file changes: {}", diff.stderr)
    }
    let patch = diff.stdout.as_str().unwrap_or_default();
    if patch.is_empty() {
        return Ok(None);
    }
    let status_args = [
        "diff",
        "--name-status",
        "--find-renames",
        &before.tree,
        &after.tree,
        "--",
        ".",
    ];
    let numstat_args = [
        "diff",
        "--numstat",
        "--find-renames",
        &before.tree,
        &after.tree,
        "--",
        ".",
    ];
    let (status, numstat) = match before.backend {
        GitSnapshotBackend::Workspace => (
            run_git_command(
                workspace,
                &status_args,
                2 * 1024 * 1024,
                Duration::from_secs(30),
            )
            .await?,
            run_git_command(
                workspace,
                &numstat_args,
                2 * 1024 * 1024,
                Duration::from_secs(30),
            )
            .await?,
        ),
        GitSnapshotBackend::Isolated => (
            run_git_command_with_private_repository(
                workspace,
                &status_args,
                &private_git_dir,
                Some(workspace),
                None,
                None,
                2 * 1024 * 1024,
                Duration::from_secs(30),
            )
            .await?,
            run_git_command_with_private_repository(
                workspace,
                &numstat_args,
                &private_git_dir,
                Some(workspace),
                None,
                None,
                2 * 1024 * 1024,
                Duration::from_secs(30),
            )
            .await?,
        ),
    };
    if !status.success || !numstat.success {
        anyhow::bail!("failed to summarize turn file changes")
    }
    let counts = numstat
        .stdout
        .as_str()
        .unwrap_or_default()
        .lines()
        .map(|line| {
            let mut fields = line.splitn(3, '\t');
            let additions = fields.next().unwrap_or("-");
            let deletions = fields.next().unwrap_or("-");
            (
                additions.parse::<u64>().unwrap_or(0),
                deletions.parse::<u64>().unwrap_or(0),
                additions == "-" || deletions == "-",
            )
        })
        .collect::<Vec<_>>();
    let files = status
        .stdout
        .as_str()
        .unwrap_or_default()
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let fields = line.split('\t').collect::<Vec<_>>();
            let code = fields.first()?.chars().next()?;
            let (old_path, path) = if matches!(code, 'R' | 'C') {
                (
                    fields.get(1).map(|value| (*value).to_string()),
                    fields.get(2)?,
                )
            } else {
                (None, fields.get(1)?)
            };
            let (additions, deletions, binary) = counts.get(index).copied().unwrap_or_default();
            Some(TurnFileChangeItem {
                old_path,
                path: (*path).to_string(),
                change_type: match code {
                    'A' => "created",
                    'D' => "deleted",
                    'R' | 'C' => "renamed",
                    _ => "modified",
                }
                .to_string(),
                additions,
                deletions,
                binary,
            })
        })
        .collect::<Vec<_>>();
    let workspace_path = dunce::canonicalize(workspace)?
        .to_string_lossy()
        .into_owned();
    let patch_sha256 = hex_sha256(patch.as_bytes());
    let artifact_id = hex_sha256(
        format!(
            "{thread_id}\0{turn_id}\0{workspace_path}\0{}\0{}\0{patch_sha256}",
            before.tree, after.tree
        )
        .as_bytes(),
    );
    let artifact = TurnFileChangesArtifact {
        version: 1,
        status: "active".into(),
        artifact_id: artifact_id.clone(),
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        workspace_path,
        snapshot_backend: before.backend,
        before_tree: before.tree,
        after_tree: after.tree,
        patch_sha256,
        file_count: files.len(),
        additions: files.iter().map(|file| file.additions).sum(),
        deletions: files.iter().map(|file| file.deletions).sum(),
        files,
        created_at: chrono::Utc::now().to_rfc3339(),
        reverted_at: None,
    };
    save_turn_file_changes_artifact_with_patch(artifact_dir, &artifact, Some(patch.as_bytes()))?;
    Ok(Some(artifact))
}

pub(super) fn save_turn_file_changes_artifact(
    artifact_dir: &Path,
    artifact: &TurnFileChangesArtifact,
) -> Result<()> {
    save_turn_file_changes_artifact_with_patch(artifact_dir, artifact, None)
}

pub(super) fn save_turn_file_changes_artifact_with_patch(
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

pub(super) fn valid_artifact_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn load_turn_file_changes_artifact(
    engine: &QueryEngine,
    artifact_id: &str,
) -> Result<(PathBuf, TurnFileChangesArtifact, String)> {
    if !valid_artifact_id(artifact_id) {
        anyhow::bail!("invalid turn file changes artifact id")
    }
    let artifact_dir = engine
        .session_storage_dir_for(&engine.session_id())
        .join("turn-file-changes");
    let metadata_path = artifact_dir.join(format!("{artifact_id}.json"));
    let metadata = std::fs::symlink_metadata(&metadata_path)
        .context("turn file changes artifact metadata is missing")?;
    if !metadata.file_type().is_file() || metadata.len() > 1024 * 1024 {
        anyhow::bail!("turn file changes artifact metadata is invalid")
    }
    let artifact: TurnFileChangesArtifact =
        serde_json::from_slice(&std::fs::read(&metadata_path)?)?;
    if artifact.artifact_id != artifact_id || artifact.thread_id != engine.session_id() {
        anyhow::bail!("turn file changes artifact binding is invalid")
    }
    let expected_workspace = dunce::canonicalize(engine.state.cwd())?;
    if dunce::canonicalize(&artifact.workspace_path)? != expected_workspace {
        anyhow::bail!("turn file changes artifact belongs to another workspace")
    }
    let patch_path = artifact_dir.join(format!("{artifact_id}.patch"));
    let patch_metadata =
        std::fs::symlink_metadata(&patch_path).context("turn file changes patch is missing")?;
    if !patch_metadata.file_type().is_file()
        || patch_metadata.len() == 0
        || patch_metadata.len() > MAX_TURN_FILE_CHANGES_BYTES as u64
    {
        anyhow::bail!("turn file changes patch is invalid")
    }
    let patch = std::fs::read_to_string(&patch_path)?;
    if hex_sha256(patch.as_bytes()) != artifact.patch_sha256 {
        anyhow::bail!("turn file changes patch checksum mismatch")
    }
    Ok((artifact_dir, artifact, patch))
}

pub(super) fn turn_file_changes_summary(artifact: &TurnFileChangesArtifact) -> Value {
    let workspace_path = dunce::simplified(Path::new(&artifact.workspace_path))
        .to_string_lossy()
        .into_owned();
    json!({
        "version": artifact.version,
        "status": artifact.status,
        "artifact_id": artifact.artifact_id,
        "device_id": "kcoder",
        "workspace_path": workspace_path,
        "file_count": artifact.file_count,
        "additions": artifact.additions,
        "deletions": artifact.deletions,
        "files": artifact.files,
        "reverted_at": artifact.reverted_at,
        "revertible": artifact.status == "active",
    })
}

pub(super) async fn turn_file_changes_command(
    engine: &QueryEngine,
    params: &DeviceExecuteParams,
) -> Result<DeviceExecuteResult> {
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
    let (artifact_dir, mut artifact, patch) =
        load_turn_file_changes_artifact(engine, &params.args[0])?;
    let workspace_cwd = engine.state.cwd();
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
    let apply_args = [
        "apply",
        "--reverse",
        "--check",
        "--binary",
        "--whitespace=nowarn",
        "-",
    ];
    let private_revert_git_dir =
        artifact_dir.join(format!("revert-repository-{}", artifact.artifact_id));
    let _private_revert_repository_cleanup = (artifact.snapshot_backend
        == GitSnapshotBackend::Isolated)
        .then(|| RemovePrivateDirectoryOnDrop::armed(private_revert_git_dir.clone()))
        .transpose()?;
    if artifact.snapshot_backend == GitSnapshotBackend::Isolated {
        let _ = std::fs::remove_dir_all(&private_revert_git_dir);
        let init = run_git_command_with_private_repository(
            &workspace_cwd,
            &["init", "--bare"],
            &private_revert_git_dir,
            None,
            None,
            None,
            4096,
            Duration::from_secs(15),
        )
        .await?;
        if !init.success {
            anyhow::bail!(
                "failed to initialize isolated Git revert repository: {}",
                init.stderr
            )
        }
        ensure_bare_snapshot_layout(&private_revert_git_dir)?;
    }
    let check = match artifact.snapshot_backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_stdin(
                &workspace_cwd,
                &apply_args,
                &patch,
                64 * 1024,
                Duration::from_secs(30),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                &workspace_cwd,
                &apply_args,
                &private_revert_git_dir,
                Some(&workspace_cwd),
                None,
                Some(&patch),
                64 * 1024,
                Duration::from_secs(30),
            )
            .await?
        }
    };
    if !check.success {
        artifact.status = "conflicted".into();
        save_turn_file_changes_artifact(&artifact_dir, &artifact)?;
        return Ok(DeviceExecuteResult {
            success: true,
            exit_code: 0,
            stdout: json!({
                "success": false,
                "error": if check.stderr.is_empty() { "Git cannot safely reverse this artifact" } else { &check.stderr },
                "file_changes": turn_file_changes_summary(&artifact),
            }),
            stderr: String::new(),
        });
    }
    let apply_args = ["apply", "--reverse", "--binary", "--whitespace=nowarn", "-"];
    let applied = match artifact.snapshot_backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_stdin(
                &workspace_cwd,
                &apply_args,
                &patch,
                64 * 1024,
                Duration::from_secs(30),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                &workspace_cwd,
                &apply_args,
                &private_revert_git_dir,
                Some(&workspace_cwd),
                None,
                Some(&patch),
                64 * 1024,
                Duration::from_secs(30),
            )
            .await?
        }
    };
    if !applied.success {
        artifact.status = "conflicted".into();
        save_turn_file_changes_artifact(&artifact_dir, &artifact)?;
    } else {
        artifact.status = "reverted".into();
        artifact.reverted_at = Some(chrono::Utc::now().to_rfc3339());
        save_turn_file_changes_artifact(&artifact_dir, &artifact)?;
    }
    Ok(DeviceExecuteResult {
        success: true,
        exit_code: 0,
        stdout: json!({
            "success": applied.success,
            "error": (!applied.success).then_some(applied.stderr),
            "file_changes": turn_file_changes_summary(&artifact),
        }),
        stderr: String::new(),
    })
}
