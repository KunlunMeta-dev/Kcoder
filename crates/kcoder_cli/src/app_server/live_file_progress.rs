//! Bounded, connection-owned observation of workspace changes across all tools.
use super::*;
use kcoder_types::tool_ui::WorkspaceFileProgress;
use std::{collections::HashSet, future::Future, pin::Pin};

const INTERVAL: Duration = Duration::from_secs(2);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_NEW_FILES: usize = 200;
const MAX_NEW_FILE_BYTES: u64 = 8 * 1024 * 1024;
type Probe = Pin<Box<dyn Future<Output = Result<WorkspaceFileProgress>> + Send>>;
type EngineStream = Pin<Box<dyn futures::Stream<Item = EngineEvent> + Send>>;

pub(super) fn may_mutate_workspace(registry: &kcoder_tools::ToolRegistry, name: &str) -> bool {
    !registry.get(name).is_some_and(|tool| tool.is_read_only())
}

pub(super) enum Update {
    Engine(EngineEvent),
    Files(WorkspaceFileProgress),
    ToolFiles {
        id: String,
        counts: WorkspaceFileProgress,
    },
}

struct ToolObservation {
    id: String,
    generation: u64,
    before: Arc<native_file_progress::Snapshot>,
    last: Option<WorkspaceFileProgress>,
}

struct ToolProbe {
    id: String,
    generation: u64,
    future: Probe,
}

pub(super) struct LiveFileProgress {
    workspace: PathBuf,
    artifact_dir: PathBuf,
    turn_id: String,
    policy: kcoder_config::TurnFileChangesSettings,
    baseline: Option<(String, GitSnapshotBackend)>,
    native: Option<Arc<native_file_progress::Snapshot>>,
    probe: Option<Probe>,
    delay: Pin<Box<tokio::time::Sleep>>,
    last: Option<WorkspaceFileProgress>,
    active_writers: HashSet<String>,
    tool: Option<ToolObservation>,
    tool_probe: Option<ToolProbe>,
    tool_generation: u64,
    tool_cache: Option<Arc<native_file_progress::Snapshot>>,
}

impl LiveFileProgress {
    pub(super) fn new(
        workspace: PathBuf,
        artifact_dir: PathBuf,
        turn_id: String,
        policy: kcoder_config::TurnFileChangesSettings,
    ) -> Self {
        Self {
            workspace,
            artifact_dir,
            turn_id,
            policy,
            baseline: None,
            native: None,
            probe: None,
            delay: Box::pin(tokio::time::sleep(INTERVAL)),
            last: None,
            active_writers: HashSet::new(),
            tool: None,
            tool_probe: None,
            tool_generation: 0,
            tool_cache: None,
        }
    }

    pub(super) fn set_baseline(&mut self, before: &GitTreeSnapshot) {
        self.baseline = Some((before.tree.clone(), before.backend));
    }

    pub(super) async fn set_native_baseline(&mut self) {
        if let Ok(Ok(before)) = tokio::time::timeout(
            PROBE_TIMEOUT,
            native_file_progress::capture(&self.workspace, &self.policy, None),
        )
        .await
        {
            self.native = Some(Arc::new(before));
        }
    }

    // Called while ToolExecutionStarted has yielded, before polling Engine again.
    // A tool baseline never reuses the turn's cumulative diff.
    pub(super) async fn start_tool(&mut self, id: &str) {
        if !self.policy.enabled || !self.active_writers.insert(id.to_owned()) {
            return;
        }
        self.tool_generation = self.tool_generation.wrapping_add(1);
        self.tool = None;
        self.reap_tool_probe().await;
        if self.active_writers.len() != 1 {
            // Concurrent writers make a workspace-wide observation unattributable.
            // Do not resume attribution for either surviving writer later.
            return;
        }
        if let Ok(Ok(before)) = tokio::time::timeout(
            PROBE_TIMEOUT,
            native_file_progress::capture(
                &self.workspace,
                &self.policy,
                self.tool_cache.as_deref().or(self.native.as_deref()),
            ),
        )
        .await
        {
            let before = Arc::new(before);
            // Revalidate every directory/file revision; only unchanged file bodies
            // are shared with the previous baseline to avoid hashing them again.
            self.tool_cache = Some(Arc::clone(&before));
            self.tool = Some(ToolObservation {
                id: id.to_owned(),
                generation: self.tool_generation,
                before,
                last: None,
            });
            self.delay = Box::pin(tokio::time::sleep(INTERVAL));
        }
    }

    // Called before projecting item/completed. Reap the owned probe and capture a
    // final observation while Engine is still paused at this tool's terminal event.
    pub(super) async fn finish_tool(&mut self, id: &str) -> Option<WorkspaceFileProgress> {
        if !self.active_writers.remove(id) {
            return None;
        }
        let observation = self.tool.take();
        self.reap_tool_probe().await;
        let observation = observation.filter(|tool| {
            tool.id == id
                && tool.generation == self.tool_generation
                && self.active_writers.is_empty()
        })?;
        let value = observe_tool(&self.workspace, &self.policy, &observation.before)
            .await
            .ok()?;
        should_publish(observation.last.as_ref(), &value).then_some(value)
    }

    async fn reap_tool_probe(&mut self) {
        if let Some(probe) = self.tool_probe.take() {
            let _ = probe.future.await;
        }
    }

    // No detached task: stopping the turn also stops polling and owns the current probe.
    pub(super) async fn next(&mut self, engine: &mut EngineStream) -> Option<Update> {
        loop {
            tokio::select! {
                event = engine.next() => return event.map(Update::Engine),
                result = async { self.probe.as_mut().unwrap().await }, if self.probe.is_some() => {
                    self.probe = None;
                    if let Ok(value) = result
                        && should_publish(self.last.as_ref(), &value)
                    {
                        self.last = Some(value.clone());
                        return Some(Update::Files(value));
                    }
                },
                result = async { self.tool_probe.as_mut().unwrap().future.as_mut().await }, if self.tool_probe.is_some() => {
                    let probe = self.tool_probe.take().unwrap();
                    if let Some(tool) = self.tool.as_mut()
                        && tool.id == probe.id
                        && tool.generation == probe.generation
                        && self.active_writers.len() == 1
                        && let Ok(counts) = result
                        && should_publish(tool.last.as_ref(), &counts)
                    {
                        tool.last = Some(counts.clone());
                        return Some(Update::ToolFiles { id: tool.id.clone(), counts });
                    }
                },
                _ = self.delay.as_mut() => {
                    self.schedule_probes();
                }
            }
        }
    }

    fn schedule_probes(&mut self) {
        self.delay = Box::pin(tokio::time::sleep(INTERVAL));
        if self.probe.is_none() {
            if let Some((tree, backend)) = &self.baseline {
                let (workspace, artifacts, turn, tree, backend, policy) = (
                    self.workspace.clone(),
                    self.artifact_dir.clone(),
                    self.turn_id.clone(),
                    tree.clone(),
                    *backend,
                    self.policy.clone(),
                );
                self.probe = Some(Box::pin(async move {
                    tokio::time::timeout(
                        PROBE_TIMEOUT,
                        probe(&workspace, &artifacts, &turn, &tree, backend, &policy),
                    )
                    .await
                    .context("live file progress timed out")?
                }));
            } else if let Some(before) = self.native.clone() {
                let workspace = self.workspace.clone();
                let policy = self.policy.clone();
                self.probe = Some(Box::pin(async move {
                    tokio::time::timeout(PROBE_TIMEOUT, async {
                        let after =
                            native_file_progress::capture(&workspace, &policy, Some(&before))
                                .await?;
                        Ok(native_file_progress::compare(&before, &after))
                    })
                    .await
                    .context("native file progress timed out")?
                }));
            }
        }
        if self.tool_probe.is_none()
            && self.active_writers.len() == 1
            && let Some(tool) = &self.tool
        {
            let workspace = self.workspace.clone();
            let policy = self.policy.clone();
            let before = Arc::clone(&tool.before);
            self.tool_probe = Some(ToolProbe {
                id: tool.id.clone(),
                generation: tool.generation,
                future: Box::pin(async move { observe_tool(&workspace, &policy, &before).await }),
            });
        }
    }

    pub(super) async fn stop(&mut self) {
        // Reap the bounded owned Git probe before releasing the baseline repository.
        if let Some(probe) = self.probe.take() {
            let _ = probe.await;
        }
        self.tool = None;
        self.tool_cache = None;
        self.active_writers.clear();
        self.reap_tool_probe().await;
    }
}

fn should_publish(previous: Option<&WorkspaceFileProgress>, value: &WorkspaceFileProgress) -> bool {
    previous != Some(value) && (value.files > 0 || value.partial || previous.is_some())
}

async fn observe_tool(
    workspace: &Path,
    policy: &kcoder_config::TurnFileChangesSettings,
    before: &native_file_progress::Snapshot,
) -> Result<WorkspaceFileProgress> {
    tokio::time::timeout(PROBE_TIMEOUT, async {
        let after = native_file_progress::capture(workspace, policy, Some(before)).await?;
        Ok(native_file_progress::compare(before, &after))
    })
    .await
    .context("tool file progress timed out")?
}

async fn probe(
    workspace: &Path,
    artifacts: &Path,
    turn: &str,
    tree: &str,
    backend: GitSnapshotBackend,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<WorkspaceFileProgress> {
    let private_git = private_snapshot_repository(artifacts, turn);
    let git_dir = (backend == GitSnapshotBackend::Isolated).then_some(private_git.as_path());
    let index = artifacts.join(format!("live-{}.index", hex_sha256(turn.as_bytes())));
    let _cleanup = RemovePrivateFileOnDrop(index.clone());
    let initialized =
        run_snapshot_git_command(workspace, &["read-tree", tree], git_dir, &index, None).await?;
    anyhow::ensure!(initialized.success, "live file baseline unavailable");
    // Compare a private baseline index with the worktree. Never stage user files or
    // write intermediate Git objects just to render a progress counter.
    let diff = run_snapshot_git_command(
        workspace,
        &[
            "diff",
            "--numstat",
            "-z",
            "--no-ext-diff",
            "--no-renames",
            "--no-textconv",
        ],
        git_dir,
        &index,
        None,
    )
    .await?;
    anyhow::ensure!(diff.success, "live file diff unavailable");
    let mut counts = parse_numstat(diff.stdout.as_str().unwrap_or_default())?;
    let new = run_snapshot_git_command(
        workspace,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        git_dir,
        &index,
        None,
    )
    .await?;
    anyhow::ensure!(new.success, "live new file listing unavailable");
    let ignore = policy.compile_ignore_globs()?;
    for (position, relative) in new
        .stdout
        .as_str()
        .unwrap_or_default()
        .split('\0')
        .filter(|path| !path.is_empty())
        .enumerate()
    {
        if position >= MAX_NEW_FILES {
            counts.partial = true;
            break;
        }
        let relative = Path::new(relative);
        if policy.excludes(relative, &ignore) {
            continue;
        }
        if !relative
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
        {
            counts.partial = true;
            continue;
        }
        let file_path = workspace.join(relative);
        let Some(name) = file_path.file_name().and_then(|value| value.to_str()) else {
            counts.partial = true;
            continue;
        };
        let parent = file_path.parent().unwrap_or(workspace);
        match count_new_file(workspace, parent, name, policy).await {
            Ok((added, binary)) => {
                counts.files = counts.files.saturating_add(1);
                counts.additions = counts.additions.saturating_add(added);
                counts.binary_files = counts.binary_files.saturating_add(u64::from(binary));
            }
            Err(_) => counts.partial = true,
        }
    }
    Ok(counts)
}

async fn count_new_file(
    workspace: &Path,
    parent: &Path,
    name: &str,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<(u64, bool)> {
    use tokio::io::AsyncReadExt;
    let (_, directory, leaf, opened) = workspace_io::file(workspace, parent, name)?;
    let (metadata, revision) = workspace_revision::snapshot(&opened)?;
    anyhow::ensure!(
        metadata.len() <= MAX_NEW_FILE_BYTES && !policy.file_exceeds_limit(metadata.len()),
        "live file exceeds counting budget"
    );
    let mut file = tokio::fs::File::from_std(opened);
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_NEW_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    let file = file.into_std().await;
    let current = directory.open_regular_file(&leaf)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_NEW_FILE_BYTES
            && workspace_revision::revision(&file)? == revision
            && workspace_revision::revision(&current)? == revision,
        "live file changed while counting"
    );
    if bytes.iter().take(8000).any(|byte| *byte == 0) {
        return Ok((0, true));
    }
    let lines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64
        + u64::from(bytes.last().is_some_and(|last| *last != b'\n'));
    Ok((lines, false))
}

fn parse_numstat(text: &str) -> Result<WorkspaceFileProgress> {
    let mut result = WorkspaceFileProgress::default();
    for entry in text.split('\0').filter(|entry| !entry.is_empty()) {
        let mut fields = entry.splitn(3, '\t');
        let additions = fields.next().context("missing live additions")?;
        let deletions = fields.next().context("missing live deletions")?;
        let _path = fields.next().context("missing live path")?;
        result.files = result.files.saturating_add(1);
        if additions == "-" || deletions == "-" {
            result.binary_files = result.binary_files.saturating_add(1);
        } else {
            result.additions = result.additions.saturating_add(additions.parse::<u64>()?);
            result.deletions = result.deletions.saturating_add(deletions.parse::<u64>()?);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observer(workspace: &Path, artifacts: &Path) -> LiveFileProgress {
        LiveFileProgress::new(
            workspace.to_owned(),
            artifacts.to_owned(),
            "owned-tools".into(),
            kcoder_config::TurnFileChangesSettings::default(),
        )
    }

    async fn next_tool_update(progress: &mut LiveFileProgress) -> (String, WorkspaceFileProgress) {
        let mut engine: EngineStream = Box::pin(futures::stream::pending());
        progress.schedule_probes();
        match tokio::time::timeout(Duration::from_secs(5), progress.next(&mut engine))
            .await
            .unwrap()
            .unwrap()
        {
            Update::ToolFiles { id, counts } => (id, counts),
            _ => panic!("expected a tool-owned file update"),
        }
    }

    #[tokio::test]
    async fn sequential_tools_have_independent_baselines_and_reap_finished_probes() {
        let workspace = tempfile::tempdir().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let path = workspace.path().join("document.txt");
        std::fs::write(&path, "original\n").unwrap();
        let mut progress = observer(workspace.path(), artifacts.path());
        progress.start_tool("first").await;
        std::fs::write(&path, "first\nsecond\nthird\n").unwrap();
        let (id, counts) = next_tool_update(&mut progress).await;
        assert_eq!(id, "first");
        assert_eq!((counts.additions, counts.deletions), (3, 1));
        // A pending observation must be reaped before the terminal tool receipt.
        progress.schedule_probes();
        assert!(progress.tool_probe.is_some());
        assert!(progress.finish_tool("first").await.is_none());
        assert!(progress.tool_probe.is_none());
        assert!(progress.tool.is_none());

        progress.start_tool("second").await;
        std::fs::write(&path, "first\nsecond\nthird\nfourth\n").unwrap();
        let (id, counts) = next_tool_update(&mut progress).await;
        assert_eq!(id, "second");
        assert_eq!((counts.additions, counts.deletions), (1, 0));
        std::fs::write(&path, "first\nsecond\nthird\nfourth\nfifth\n").unwrap();
        let final_counts = progress.finish_tool("second").await.unwrap();
        assert_eq!((final_counts.additions, final_counts.deletions), (2, 0));
        assert!(progress.finish_tool("first").await.is_none());
        progress.schedule_probes();
        assert!(progress.tool_probe.is_none());
        progress.stop().await;
        assert!(!workspace.path().join(".git").exists());
        assert_eq!(std::fs::read_dir(artifacts.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn overlapping_writers_disable_attribution_until_a_new_tool_starts() {
        let workspace = tempfile::tempdir().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let path = workspace.path().join("document.txt");
        std::fs::write(&path, "before\n").unwrap();
        let mut progress = observer(workspace.path(), artifacts.path());
        progress.start_tool("first").await;
        std::fs::write(&path, "before\nfirst\n").unwrap();
        progress.schedule_probes();
        assert!(progress.tool_probe.is_some());
        progress.start_tool("overlapping").await;
        assert!(progress.tool.is_none());
        assert!(progress.tool_probe.is_none());
        std::fs::write(&path, "before\nfirst\noverlapping\n").unwrap();
        assert!(progress.finish_tool("first").await.is_none());
        progress.schedule_probes();
        assert!(progress.tool_probe.is_none());
        assert!(progress.finish_tool("overlapping").await.is_none());
        progress.start_tool("last").await;
        std::fs::write(&path, "before\nfirst\noverlapping\nlast\n").unwrap();
        let (id, counts) = next_tool_update(&mut progress).await;
        assert_eq!(id, "last");
        assert_eq!((counts.additions, counts.deletions), (1, 0));
        progress.stop().await;
        assert!(progress.tool_probe.is_none());
        assert!(progress.active_writers.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn normal_polling_emits_multiple_updates_before_a_slow_writer_result() {
        use kcoder_tools::owned_process::OwnedProcess;
        use tokio::io::AsyncWriteExt;
        let workspace = tempfile::tempdir().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let mut progress = observer(workspace.path(), artifacts.path());
        let working_directory = workspace.path().to_path_buf();
        let input = Arc::new(tokio::sync::Mutex::new(None::<tokio::process::ChildStdin>));
        let process_input = Arc::clone(&input);
        let mut engine: EngineStream = Box::pin(async_stream::stream! {
            yield EngineEvent::ToolUseStarted {
                id: "slow-writer".into(),
                name: "bash".into(),
                input: json!({"description":"owned slow filesystem writer"}),
            };
            yield EngineEvent::ToolExecutionStarted {
                id: "slow-writer".into(),
                name: "bash".into(),
            };
            let mut command = tokio::process::Command::new("sh");
            command.current_dir(&working_directory)
                .args(["-c", "printf 'one\\n' > slow.txt; read -r ack || exit 1; printf 'two\\n' >> slow.txt; read -r ack || exit 1; printf 'three\\n' >> slow.txt; read -r ack || exit 1"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            let mut child = OwnedProcess::spawn(&mut command).unwrap();
            *process_input.lock().await = child.child.stdin.take();
            assert!(child.child.wait().await.unwrap().success());
            child.finish().await.unwrap();
            yield EngineEvent::ToolResult {
                id: "slow-writer".into(),
                name: "bash".into(),
                output: kcoder_tools::ToolOutput::text("writer finished"),
            };
        });
        let updates = tokio::time::timeout(Duration::from_secs(16), async {
            let mut updates = Vec::new();
            while let Some(update) = progress.next(&mut engine).await {
                match update {
                    Update::Engine(EngineEvent::ToolExecutionStarted { id, .. }) => {
                        progress.start_tool(&id).await;
                    }
                    Update::ToolFiles { id, counts } => {
                        assert_eq!(id, "slow-writer");
                        assert_eq!(counts.deletions, 0);
                        assert!(!counts.partial);
                        updates.push(counts.additions);
                        // Advance the real child only after an ordinary timed
                        // observation. This avoids wall-clock race assumptions.
                        input
                            .lock()
                            .await
                            .as_mut()
                            .unwrap()
                            .write_all(b"next\n")
                            .await
                            .unwrap();
                    }
                    Update::Engine(EngineEvent::ToolResult { id, .. }) => {
                        // These observations came from the normal timer/select path,
                        // without manually scheduling a probe or a pending-only stream.
                        assert!(updates.len() >= 2, "updates before completion: {updates:?}");
                        let _ = progress.finish_tool(&id).await;
                        break;
                    }
                    _ => {}
                }
            }
            updates
        })
        .await
        .unwrap();
        assert_eq!(updates, [1, 2, 3]);
        drop(engine);
        progress.stop().await;
        assert!(!workspace.path().join(".git").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn emits_tool_owned_counts_while_an_owned_shell_writer_is_running() {
        use kcoder_tools::owned_process::OwnedProcess;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let workspace = tempfile::tempdir().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let mut progress = observer(workspace.path(), artifacts.path());
        progress.start_tool("shell-writer").await;
        let mut command = tokio::process::Command::new("sh");
        command.current_dir(workspace.path()).args(["-c", "printf 'one\\n' > streamed.txt; printf READY; read -r next; printf 'two\\n' >> streamed.txt"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        let mut child = OwnedProcess::spawn(&mut command).unwrap();
        let mut ready = [0; 5];
        child
            .child
            .stdout
            .take()
            .unwrap()
            .read_exact(&mut ready)
            .await
            .unwrap();
        assert_eq!(&ready, b"READY");
        let (id, counts) = next_tool_update(&mut progress).await;
        assert_eq!(id, "shell-writer");
        assert_eq!((counts.additions, counts.deletions), (1, 0));
        assert!(child.child.try_wait().unwrap().is_none());
        child
            .child
            .stdin
            .take()
            .unwrap()
            .write_all(b"continue\n")
            .await
            .unwrap();
        assert!(child.child.wait().await.unwrap().success());
        child.finish().await.unwrap();
        let final_counts = progress.finish_tool("shell-writer").await.unwrap();
        assert_eq!((final_counts.additions, final_counts.deletions), (2, 0));
        assert!(!workspace.path().join(".git").exists());
    }

    #[tokio::test]
    async fn preserves_the_staged_user_index_in_an_existing_git_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("staged.txt"), "original\n").unwrap();
        assert!(
            run_git_command(
                workspace.path(),
                &["-c", "init.templateDir=", "init", "--quiet"],
                4096,
                Duration::from_secs(5)
            )
            .await
            .unwrap()
            .success
        );
        assert!(
            run_git_command(
                workspace.path(),
                &["add", "staged.txt"],
                4096,
                Duration::from_secs(5)
            )
            .await
            .unwrap()
            .success
        );
        let index = std::fs::read(workspace.path().join(".git/index")).unwrap();
        let policy = kcoder_config::TurnFileChangesSettings::default();
        let before = capture_worktree_tree_with_policy(
            workspace.path(),
            artifacts.path(),
            "indexed",
            "before",
            &policy,
        )
        .await
        .unwrap()
        .unwrap();
        std::fs::write(workspace.path().join("staged.txt"), "replacement\nmore\n").unwrap();
        let observed = probe(
            workspace.path(),
            artifacts.path(),
            "indexed",
            &before.tree,
            before.backend,
            &policy,
        )
        .await
        .unwrap();
        assert_eq!((observed.additions, observed.deletions), (2, 1));
        assert_eq!(
            std::fs::read(workspace.path().join(".git/index")).unwrap(),
            index
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn observes_an_owned_shell_writer_before_the_process_finishes() {
        use kcoder_tools::owned_process::OwnedProcess;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let workspace = tempfile::tempdir().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        let policy = kcoder_config::TurnFileChangesSettings::default();
        let before = capture_worktree_tree_with_policy(
            workspace.path(),
            artifacts.path(),
            "shell",
            "before",
            &policy,
        )
        .await
        .unwrap()
        .unwrap();
        let mut command = tokio::process::Command::new("sh");
        command.current_dir(workspace.path()).args(["-c", "printf 'one\\n' > streamed.txt; printf READY; read -r next; printf 'two\\n' >> streamed.txt"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        let mut child = OwnedProcess::spawn(&mut command).unwrap();
        let mut ready = [0; 5];
        child
            .child
            .stdout
            .take()
            .unwrap()
            .read_exact(&mut ready)
            .await
            .unwrap();
        assert_eq!(&ready, b"READY");
        let live = probe(
            workspace.path(),
            artifacts.path(),
            "shell",
            &before.tree,
            before.backend,
            &policy,
        )
        .await
        .unwrap();
        assert_eq!((live.additions, live.deletions), (1, 0));
        assert!(child.child.try_wait().unwrap().is_none());
        child
            .child
            .stdin
            .take()
            .unwrap()
            .write_all(b"continue\n")
            .await
            .unwrap();
        assert!(child.child.wait().await.unwrap().success());
        child.finish().await.unwrap();
        let done = probe(
            workspace.path(),
            artifacts.path(),
            "shell",
            &before.tree,
            before.backend,
            &policy,
        )
        .await
        .unwrap();
        assert_eq!(done.additions, 2);
    }

    #[tokio::test]
    async fn counts_arbitrary_writers_and_new_files_without_modifying_the_user_index() {
        let workspace = tempfile::tempdir().unwrap();
        let artifacts = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("existing.txt"), "old\nline\n").unwrap();
        let policy = kcoder_config::TurnFileChangesSettings::default();
        let before = capture_worktree_tree_with_policy(
            workspace.path(),
            artifacts.path(),
            "live-test",
            "before",
            &policy,
        )
        .await
        .unwrap()
        .unwrap();
        std::fs::write(workspace.path().join("existing.txt"), "new\n").unwrap();
        std::fs::write(workspace.path().join("created.txt"), "one\ntwo\nthree\n").unwrap();
        let first = probe(
            workspace.path(),
            artifacts.path(),
            "live-test",
            &before.tree,
            before.backend,
            &policy,
        )
        .await
        .unwrap();
        assert_eq!((first.additions, first.deletions, first.files), (4, 2, 2));
        std::fs::write(
            workspace.path().join("created.txt"),
            "one\ntwo\nthree\nfour\n",
        )
        .unwrap();
        let next = probe(
            workspace.path(),
            artifacts.path(),
            "live-test",
            &before.tree,
            before.backend,
            &policy,
        )
        .await
        .unwrap();
        assert_eq!((next.additions, next.deletions), (5, 2));
        assert!(!next.partial);
        assert!(!workspace.path().join(".git").exists());
        assert!(
            !artifacts
                .path()
                .join(format!("live-{}.index", hex_sha256(b"live-test")))
                .exists()
        );
    }
}
