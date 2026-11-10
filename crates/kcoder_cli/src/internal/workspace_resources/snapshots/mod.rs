//! Bounded snapshots and file change evidence for an already selected workspace.

#[path = "../../../app_server/snapshot_leases.rs"]
pub mod snapshot_leases;
#[path = "../../../app_server/worktree_capture.rs"]
pub mod worktree_capture;

use crate::git::{
    ensure_bare_snapshot_layout, run_git_command, run_git_command_with_index,
    run_git_command_with_index_and_stdin, run_git_command_with_private_repository,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::DeviceExecuteResult;
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", sha2::Sha256::digest(bytes))
}

pub const MAX_TURN_FILE_CHANGES_BYTES: usize = 20 * 1024 * 1024;

/// Output bound for snapshot path listings (they are NUL-separated paths).
const SNAPSHOT_PATH_LISTING_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct RemovePrivateDirectoryOnDrop {
    path: PathBuf,
    _lease: std::fs::File,
}

#[derive(Debug)]
pub struct RemovePrivateFileOnDrop(pub PathBuf);

#[derive(Debug)]
pub struct GitTreeSnapshot {
    pub capture_window: kcoder_app_protocol::TurnFileCaptureWindow,
    pub has_exclusions: bool,
    excluded_paths: Vec<String>,
    pub tree: String,
    pub backend: GitSnapshotBackend,
    // The isolated-before snapshot owns cleanup, so object storage is released even if the event stream returns before finalize.
    _private_repository_cleanup: Option<RemovePrivateDirectoryOnDrop>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitSnapshotBackend {
    #[default]
    Workspace,
    Isolated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnFileChangeItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub path: String,
    pub change_type: String,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnFileChangesArtifact {
    pub version: u8,
    pub status: String,
    pub artifact_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub snapshot_backend: GitSnapshotBackend,
    pub before_tree: String,
    pub after_tree: String,
    pub patch_sha256: String,
    pub file_count: usize,
    pub additions: u64,
    pub deletions: u64,
    pub files: Vec<TurnFileChangeItem>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverted_at: Option<String>,
}

pub fn file_capture_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub async fn capture_worktree_tree_with_policy(
    workspace: &Path,
    artifact_dir: &Path,
    turn_id: &str,
    stage: &str,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<Option<GitTreeSnapshot>> {
    capture_worktree_tree_with_backend(
        workspace,
        artifact_dir,
        turn_id,
        stage,
        GitSnapshotBackend::Isolated,
        policy,
    )
    .await
    .map(Some)
}

pub async fn run_snapshot_git_command(
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

pub fn private_snapshot_repository(artifact_dir: &Path, turn_id: &str) -> PathBuf {
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
    pub fn armed(path: PathBuf) -> Result<Self> {
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

async fn capture_worktree_tree_with_backend(
    workspace: &Path,
    artifact_dir: &Path,
    turn_id: &str,
    stage: &str,
    backend: GitSnapshotBackend,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<GitTreeSnapshot> {
    ensure!(
        backend == GitSnapshotBackend::Isolated,
        "new captures require isolated object storage"
    );
    let capture_started_at = file_capture_now_ms();
    policy
        .compile_ignore_globs()
        .context("invalid snapshot exclusion policy")?;
    kcoder_config::PrivateDirectory::open_or_create(artifact_dir)?;
    let repository = private_snapshot_repository(artifact_dir, turn_id);
    let cleanup = if stage == "before" {
        let cleanup = RemovePrivateDirectoryOnDrop::armed(repository.clone())?;
        match std::fs::remove_dir_all(&repository) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let initialized = run_git_command_with_private_repository(
            workspace,
            &["init", "--bare"],
            &repository,
            None,
            None,
            None,
            4096,
            Duration::from_secs(15),
        )
        .await?;
        ensure!(
            initialized.success,
            "failed to initialize private snapshot storage: {}",
            initialized.stderr
        );
        ensure_bare_snapshot_layout(&repository)?;
        // info/attributes has higher priority than captured .gitattributes.
        let directory = kcoder_config::PrivateDirectory::open_existing(&repository)?;
        let info = directory.open_child(std::ffi::OsStr::new("info"), true)?;
        let mut attributes = info.open_read_write_file(std::ffi::OsStr::new("attributes"), true)?;
        std::io::Write::write_all(
            &mut attributes,
            b"* -text -filter -ident -working-tree-encoding\n",
        )?;
        Some(cleanup)
    } else {
        None
    };
    let view = worktree_capture::CaptureView::create(workspace, &repository, policy).await?;
    let index_path = artifact_dir.join(format!(
        "snapshot-{}.index",
        hex_sha256(format!("{turn_id}\0{stage}").as_bytes())
    ));
    match std::fs::remove_file(&index_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let _index_cleanup = RemovePrivateFileOnDrop(index_path.clone());
    for args in [
        vec!["read-tree", "--empty"],
        vec!["add", "--force", "-A", "--", "."],
    ] {
        let result = run_git_command_with_private_repository(
            &view.path,
            &args,
            &repository,
            Some(&view.path),
            Some(&index_path),
            None,
            4096,
            Duration::from_secs(30),
        )
        .await?;
        ensure!(
            result.success,
            "failed to snapshot bounded input view: {}",
            result.stderr
        );
    }
    let tree = run_git_command_with_private_repository(
        &view.path,
        &["write-tree"],
        &repository,
        Some(&view.path),
        Some(&index_path),
        None,
        4096,
        Duration::from_secs(30),
    )
    .await?;
    ensure!(
        tree.success,
        "failed to write private snapshot tree: {}",
        tree.stderr
    );
    let tree = tree
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| {
            (value.len() == 40 || value.len() == 64)
                && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .context("invalid snapshot tree identity")?;
    view.verify(workspace, &repository).await?;
    Ok(GitTreeSnapshot {
        capture_window: kcoder_app_protocol::TurnFileCaptureWindow {
            started_at_ms: capture_started_at,
            completed_at_ms: file_capture_now_ms().max(capture_started_at),
        },
        has_exclusions: view.has_exclusions,
        excluded_paths: view.excluded_paths.clone(),
        tree: tree.to_owned(),
        backend,
        _private_repository_cleanup: cleanup,
    })
}

pub struct FinalizedTurnFileCapture {
    pub artifact: Option<TurnFileChangesArtifact>,
    pub head: kcoder_app_protocol::TurnFileCaptureWindow,
    pub has_exclusions: bool,
}

type PersistFileChanges = fn(&Path, &TurnFileChangesArtifact, Option<&[u8]>) -> Result<()>;

pub async fn finalize_turn_file_changes_with_policy(
    workspace: &Path,
    artifact_dir: &Path,
    thread_id: &str,
    turn_id: &str,
    mut before: GitTreeSnapshot,
    policy: &kcoder_config::TurnFileChangesSettings,
    persist: PersistFileChanges,
) -> Result<FinalizedTurnFileCapture> {
    let private_git_dir = private_snapshot_repository(artifact_dir, turn_id);
    let mut after = capture_worktree_tree_with_backend(
        workspace,
        artifact_dir,
        turn_id,
        "after",
        before.backend,
        policy,
    )
    .await?;
    let head = after.capture_window.clone();
    let has_exclusions = before.has_exclusions || after.has_exclusions;
    let excluded = before
        .excluded_paths
        .iter()
        .chain(&after.excluded_paths)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|path| format!("{path}\0"))
        .collect::<String>();
    if before.tree != after.tree && !excluded.is_empty() {
        ensure!(
            excluded.len() <= SNAPSHOT_PATH_LISTING_BYTES,
            "snapshot exclusion budget exceeded"
        );
        // If either sample excludes a path, omit it from both sides. A file
        // crossing a limit is unknown, not a captured creation or deletion.
        let index = artifact_dir.join(format!(
            "snapshot-prune-{}.index",
            hex_sha256(turn_id.as_bytes())
        ));
        match std::fs::remove_file(&index) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let _cleanup = RemovePrivateFileOnDrop(index.clone());
        for tree in [&mut before.tree, &mut after.tree] {
            for (args, input) in [
                (vec!["read-tree", tree.as_str()], None),
                (
                    vec!["update-index", "--force-remove", "-z", "--stdin"],
                    Some(excluded.as_str()),
                ),
            ] {
                let result = run_snapshot_git_command(
                    workspace,
                    &args,
                    Some(&private_git_dir),
                    &index,
                    input,
                )
                .await?;
                ensure!(result.success, "failed to exclude uncovered snapshot paths");
            }
            let result = run_snapshot_git_command(
                workspace,
                &["write-tree"],
                Some(&private_git_dir),
                &index,
                None,
            )
            .await?;
            ensure!(result.success, "failed to finalize covered snapshot paths");
            *tree = result
                .stdout
                .as_str()
                .context("missing covered snapshot tree")?
                .trim()
                .to_owned();
        }
    }
    if before.tree == after.tree {
        return Ok(FinalizedTurnFileCapture {
            artifact: None,
            head,
            has_exclusions,
        });
    }
    let diff_args = [
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
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
        return Ok(FinalizedTurnFileCapture {
            artifact: None,
            head,
            has_exclusions,
        });
    }
    let status_args = [
        "diff",
        "--name-status",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        &before.tree,
        &after.tree,
        "--",
        ".",
    ];
    let numstat_args = [
        "diff",
        "--numstat",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
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
    let files = parse_turn_file_change_items(
        status
            .stdout
            .as_str()
            .context("invalid change status output")?,
        numstat
            .stdout
            .as_str()
            .context("invalid change count output")?,
    )?;
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
    persist(artifact_dir, &artifact, Some(patch.as_bytes()))?;
    Ok(FinalizedTurnFileCapture {
        artifact: Some(artifact),
        head,
        has_exclusions,
    })
}

fn parse_turn_file_change_items(status: &str, numstat: &str) -> Result<Vec<TurnFileChangeItem>> {
    ensure!(
        (status.is_empty() || status.ends_with('\0'))
            && (numstat.is_empty() || numstat.ends_with('\0')),
        "incomplete change summary"
    );
    let mut counts = HashMap::new();
    let mut entries = numstat.split_terminator('\0');
    while let Some(entry) = entries.next() {
        let mut fields = entry.splitn(3, '\t');
        let added = fields.next().context("missing addition count")?;
        let deleted = fields.next().context("missing deletion count")?;
        let mut path = fields.next().context("missing count path")?;
        if path.is_empty() {
            entries.next().context("missing original rename path")?;
            path = entries.next().context("missing new rename path")?;
        }
        ensure!(!path.is_empty(), "empty change count path");
        let binary = added == "-" || deleted == "-";
        let value = if binary {
            ensure!(added == "-" && deleted == "-", "inconsistent binary counts");
            (0, 0, true)
        } else {
            (added.parse::<u64>()?, deleted.parse::<u64>()?, false)
        };
        ensure!(
            counts.insert(path.to_owned(), value).is_none(),
            "duplicate change count path"
        );
    }
    let mut files = Vec::new();
    let mut entries = status.split_terminator('\0');
    while let Some(kind) = entries.next() {
        let code = kind.chars().next().context("empty change kind")?;
        ensure!(
            matches!(code, 'A' | 'D' | 'M' | 'R' | 'C' | 'T'),
            "unsupported change kind"
        );
        let mut path = entries.next().context("missing change path")?;
        let old_path = if matches!(code, 'R' | 'C') {
            let old = path.to_owned();
            path = entries.next().context("missing renamed change path")?;
            Some(old)
        } else {
            None
        };
        let (additions, deletions, binary) = counts
            .remove(path)
            .context("change count does not match status")?;
        files.push(TurnFileChangeItem {
            old_path,
            path: path.to_owned(),
            change_type: match code {
                'A' => "created",
                'D' => "deleted",
                'R' | 'C' => "renamed",
                _ => "modified",
            }
            .into(),
            additions,
            deletions,
            binary,
        });
    }
    ensure!(counts.is_empty(), "change counts contain unmatched paths");
    Ok(files)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
