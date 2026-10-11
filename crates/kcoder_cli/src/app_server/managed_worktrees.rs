//! Managed worktrees: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn authorized_worktree_source(
    engine: &QueryEngine,
    configured_root: &Path,
    requested: &Path,
) -> Result<PathBuf> {
    if !requested.is_absolute() {
        anyhow::bail!("sourcePath must be absolute")
    }
    let resolved = dunce::canonicalize(requested)
        .with_context(|| format!("failed to resolve {}", requested.display()))?;
    if resolved == configured_root || resolved.starts_with(configured_root) {
        return Ok(resolved);
    }

    let workspace_store = ClientWorkspaceStore::new(engine);
    let registered_roots = {
        let _guard = workspace_store.lock()?;
        let state = workspace_store.load();
        state
            .records
            .values()
            .flat_map(|record| {
                std::iter::once(record.workspace_path.clone()).chain(record.roots.iter().cloned())
            })
            .collect::<Vec<_>>()
    };
    for root in registered_roots {
        let Ok(root) = dunce::canonicalize(root) else {
            continue;
        };
        if resolved == root || resolved.starts_with(root) {
            return Ok(resolved);
        }
    }
    anyhow::bail!("sourcePath is outside the configured or registered workspaces")
}

pub(super) async fn snapshot_client_worktree(
    path: &Path,
    snapshot_dir: &Path,
) -> Result<ClientWorktreeSnapshot> {
    std::fs::create_dir_all(snapshot_dir)?;
    let head = run_git_command(path, &["rev-parse", "HEAD"], 4096, Duration::from_secs(15)).await?;
    let common = run_git_command(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        4096,
        Duration::from_secs(15),
    )
    .await?;
    if !head.success || !common.success {
        anyhow::bail!("failed to resolve managed worktree snapshot metadata")
    }
    let head = head
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree HEAD is invalid")?;
    let git_common_dir = common
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("managed worktree Git common directory is invalid")?
        .to_string();
    let canonical = std::fs::canonicalize(path)?;
    let created_at = app_server_now_ms();
    let index_key = format!(
        "{}\0{}\0{}",
        canonical.display(),
        std::process::id(),
        created_at
    );
    let index_path = snapshot_dir.join(format!(
        "managed-worktree-snapshot-{}.index",
        hex_sha256(index_key.as_bytes())
    ));
    let _ = std::fs::remove_file(&index_path);

    let read_tree = run_git_command_with_index(
        path,
        &["read-tree", head],
        &index_path,
        4096,
        Duration::from_secs(15),
    )
    .await?;
    if !read_tree.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!(
            "failed to initialize managed worktree snapshot: {}",
            read_tree.stderr
        )
    }
    let add = run_git_command_with_index(
        path,
        &["add", "-A", "--", "."],
        &index_path,
        4096,
        Duration::from_secs(30),
    )
    .await?;
    if !add.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!("failed to capture managed worktree files: {}", add.stderr)
    }
    let tree = run_git_command_with_index(
        path,
        &["write-tree"],
        &index_path,
        4096,
        Duration::from_secs(30),
    )
    .await?;
    let _ = std::fs::remove_file(&index_path);
    if !tree.success {
        anyhow::bail!(
            "failed to write managed worktree snapshot tree: {}",
            tree.stderr
        )
    }
    let tree = tree
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree snapshot tree is invalid")?;
    let commit = run_git_command(
        path,
        &[
            "-c",
            "user.name=KCoder Worktree Snapshot",
            "-c",
            "user.email=snapshot@kcoder.local",
            "commit-tree",
            tree,
            "-p",
            head,
            "-m",
            "KCoder managed worktree snapshot",
        ],
        4096,
        Duration::from_secs(30),
    )
    .await?;
    if !commit.success {
        anyhow::bail!(
            "failed to commit managed worktree snapshot: {}",
            commit.stderr
        )
    }
    let commit = commit
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree snapshot commit is invalid")?
        .to_string();
    let reference = format!(
        "refs/kcoder/worktree-snapshots/{}",
        hex_sha256(canonical.to_string_lossy().as_bytes())
    );
    let update = run_git_command(
        path,
        &["update-ref", &reference, &commit],
        4096,
        Duration::from_secs(15),
    )
    .await?;
    if !update.success {
        anyhow::bail!(
            "failed to retain managed worktree snapshot: {}",
            update.stderr
        )
    }
    Ok(ClientWorktreeSnapshot {
        reference,
        commit,
        git_common_dir,
        created_at,
    })
}

pub(super) async fn managed_worktree_content_token(
    path: &Path,
    scratch_dir: &Path,
) -> Result<String> {
    std::fs::create_dir_all(scratch_dir)?;
    let head = run_git_command(path, &["rev-parse", "HEAD"], 4096, Duration::from_secs(15)).await?;
    if !head.success {
        anyhow::bail!("failed to resolve managed worktree HEAD: {}", head.stderr)
    }
    let head = head
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree HEAD is invalid")?;
    let index_key = format!(
        "preview\0{}\0{}\0{}",
        path.display(),
        std::process::id(),
        app_server_now_ms()
    );
    let index_path = scratch_dir.join(format!(
        "managed-worktree-preview-{}.index",
        hex_sha256(index_key.as_bytes())
    ));
    let _ = std::fs::remove_file(&index_path);
    let read_tree = run_git_command_with_index(
        path,
        &["read-tree", head],
        &index_path,
        4096,
        Duration::from_secs(15),
    )
    .await?;
    if !read_tree.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!(
            "failed to initialize worktree preview index: {}",
            read_tree.stderr
        )
    }
    let add = run_git_command_with_index(
        path,
        &["add", "-A", "--", "."],
        &index_path,
        4096,
        Duration::from_secs(30),
    )
    .await?;
    if !add.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!("failed to inspect managed worktree content: {}", add.stderr)
    }
    let tree = run_git_command_with_index(
        path,
        &["write-tree"],
        &index_path,
        4096,
        Duration::from_secs(30),
    )
    .await?;
    let _ = std::fs::remove_file(&index_path);
    if !tree.success {
        anyhow::bail!("failed to hash managed worktree content: {}", tree.stderr)
    }
    let tree = tree
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree content tree is invalid")?;
    Ok(hex_sha256(format!("{head}\0{tree}").as_bytes()))
}

pub(super) async fn preview_client_worktree_archive(
    store: &ClientWorktreeStore,
    record: &ClientManagedWorktree,
    check_runtime_lease: bool,
) -> Result<ClientWorktreeArchivePreview> {
    let path = Path::new(&record.path);
    let mut blocking_reasons = Vec::new();
    if !path.exists() {
        blocking_reasons.push("worktree directory is unavailable".to_string());
        return Ok(ClientWorktreeArchivePreview {
            path: record.path.clone(),
            state: record.state.clone(),
            revision: record.revision,
            content_token: None,
            dirty: false,
            untracked_file_count: 0,
            ignored_entry_count: 0,
            dirty_submodule_count: 0,
            nested_repository_count: 0,
            baseline_known: record.base_commit.is_some(),
            commits_since_creation: None,
            requires_confirmation: false,
            archive_allowed: false,
            blocking_reasons,
        });
    }

    if check_runtime_lease {
        let runtime_lease = store.acquire_workspace_archive_lease(path);
        if let Err(error) = runtime_lease {
            blocking_reasons.push(error.to_string());
        }
    }
    let status = run_git_command(
        path,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignored=matching",
        ],
        MAX_GIT_OUTPUT_BYTES,
        Duration::from_secs(15),
    )
    .await?;
    if !status.success {
        anyhow::bail!(
            "failed to inspect managed worktree status: {}",
            status.stderr
        )
    }
    let status_text = status.stdout.as_str().unwrap_or_default();
    let dirty = status_text.lines().any(|line| !line.starts_with("!! "));
    let untracked_file_count = status_text
        .lines()
        .filter(|line| line.starts_with("?? "))
        .count();
    let ignored_entry_count = status_text
        .lines()
        .filter(|line| line.starts_with("!! "))
        .count();
    if ignored_entry_count > 0 {
        blocking_reasons.push(
            "ignored files are present and cannot be preserved by the worktree snapshot"
                .to_string(),
        );
    }
    let submodules = run_git_command(
        path,
        &[
            "submodule",
            "foreach",
            "--recursive",
            "--quiet",
            "test -z \"$(git status --porcelain=v1 --untracked-files=all)\" || echo \"$sm_path\"",
        ],
        MAX_GIT_OUTPUT_BYTES,
        Duration::from_secs(30),
    )
    .await?;
    let dirty_submodule_count = if submodules.success {
        submodules
            .stdout
            .as_str()
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count()
    } else {
        blocking_reasons.push("submodule state cannot be verified".to_string());
        0
    };
    if dirty_submodule_count > 0 {
        blocking_reasons.push(
            "dirty submodules are present and cannot be preserved by the worktree snapshot"
                .to_string(),
        );
    }
    let mut nested_repository_count = 0_usize;
    let mut scanned_entries = 0_usize;
    let mut nested_scan_failed = false;
    for entry in WalkDir::new(path).follow_links(false) {
        scanned_entries = scanned_entries.saturating_add(1);
        if scanned_entries > 100_000 {
            nested_scan_failed = true;
            break;
        }
        match entry {
            Ok(entry) if entry.depth() > 1 && entry.file_name() == std::ffi::OsStr::new(".git") => {
                nested_repository_count = nested_repository_count.saturating_add(1);
            }
            Ok(_) => {}
            Err(_) => nested_scan_failed = true,
        }
    }
    if nested_repository_count > 0 {
        blocking_reasons
            .push("nested Git repositories are present and cannot be preserved safely".to_string());
    }
    if nested_scan_failed {
        blocking_reasons.push("nested repository scan could not be completed".to_string());
    }
    let commits_since_creation = if let Some(base_commit) = record.base_commit.as_deref() {
        let range = format!("{base_commit}..HEAD");
        let count = run_git_command(
            path,
            &["rev-list", "--count", &range],
            4096,
            Duration::from_secs(15),
        )
        .await?;
        if count.success {
            Some(
                count
                    .stdout
                    .as_str()
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .unwrap_or(0),
            )
        } else {
            blocking_reasons.push("managed worktree baseline cannot be verified".to_string());
            None
        }
    } else {
        None
    };
    let scratch_dir = store
        .state_path
        .parent()
        .context("worktree state directory is missing")?;
    let content_token = managed_worktree_content_token(path, scratch_dir).await?;
    let requires_confirmation = dirty
        || commits_since_creation.is_none()
        || commits_since_creation.is_some_and(|count| count > 0);
    Ok(ClientWorktreeArchivePreview {
        path: record.path.clone(),
        state: record.state.clone(),
        revision: record.revision,
        content_token: Some(content_token),
        dirty,
        untracked_file_count,
        ignored_entry_count,
        dirty_submodule_count,
        nested_repository_count,
        baseline_known: record.base_commit.is_some(),
        commits_since_creation,
        requires_confirmation,
        archive_allowed: blocking_reasons.is_empty(),
        blocking_reasons,
    })
}

pub(super) async fn worktree_request(
    engine: &QueryEngine,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let store = ClientWorktreeStore::new(engine);
    let device_id = params
        .get("deviceId")
        .and_then(Value::as_str)
        .unwrap_or("local");
    match method {
        "runtime.worktrees.settings.get" => {
            let _guard = store.lock()?;
            let state = store.load()?;
            let mut value = serde_json::to_value(state.settings)?;
            value["deviceId"] = device_id.into();
            Ok(value)
        }
        "runtime.worktrees.settings.update" => {
            let _guard = store.lock()?;
            let mut state = store.load()?;
            if let Some(root) = params.get("worktreeRoot").and_then(Value::as_str) {
                let root = root.trim();
                if root.is_empty() {
                    state.settings.worktree_root.clear();
                    state.settings.resolved_worktree_root =
                        store.default_root.to_string_lossy().into_owned();
                } else {
                    let path = PathBuf::from(root);
                    if !path.is_absolute() || path.parent().is_none() {
                        anyhow::bail!("worktreeRoot must be an absolute non-root directory")
                    }
                    if path.file_name().and_then(|name| name.to_str()) == Some(".kcoder") {
                        anyhow::bail!("worktreeRoot must not be a project .kcoder directory")
                    }
                    std::fs::create_dir_all(&path)?;
                    let resolved = dunce::canonicalize(&path)?;
                    state.settings.worktree_root = root.to_string();
                    state.settings.resolved_worktree_root = resolved.to_string_lossy().into_owned();
                }
            }
            if let Some(enabled) = params.get("autoCleanupEnabled").and_then(Value::as_bool) {
                state.settings.auto_cleanup_enabled = enabled;
            }
            if let Some(keep_count) = params.get("keepCount").and_then(Value::as_u64) {
                if keep_count == 0 || keep_count > 10_000 {
                    anyhow::bail!("keepCount must be between 1 and 10000")
                }
                state.settings.keep_count = keep_count as usize;
            }
            let resolved_root = Path::new(&state.settings.resolved_worktree_root);
            if state.records.values().any(|record| {
                let path = Path::new(&record.path);
                !path.starts_with(resolved_root) || path == resolved_root
            }) {
                anyhow::bail!(
                    "worktreeRoot cannot change while managed worktrees remain under another root"
                )
            }
            std::fs::create_dir_all(&state.settings.resolved_worktree_root)?;
            store.save(&state)?;
            let mut value = serde_json::to_value(state.settings)?;
            value["deviceId"] = device_id.into();
            Ok(value)
        }
        "runtime.worktrees.prepare" => {
            let source_path = params
                .get("sourcePath")
                .or_else(|| params.get("source_path"))
                .and_then(Value::as_str)
                .context("sourcePath is required")?;
            let worktree_id = params
                .get("worktreeId")
                .or_else(|| params.get("worktree_id"))
                .and_then(Value::as_str)
                .context("worktreeId is required")?;
            validate_worktree_id(worktree_id)?;
            let configured_root = dunce::canonicalize(engine.state.cwd())?;
            let source =
                authorized_worktree_source(engine, &configured_root, Path::new(source_path))
                    .await?;
            if !tokio::fs::metadata(&source).await?.is_dir() {
                anyhow::bail!("sourcePath is not a directory")
            }
            let repository_name = source
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("repository");
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let root = PathBuf::from(&state.settings.resolved_worktree_root);
            if !root.is_absolute() || root.parent().is_none() {
                anyhow::bail!("managed worktree root is unsafe")
            }
            std::fs::create_dir_all(&root)?;
            let root = dunce::canonicalize(root)?;
            let target = managed_worktree_target_path(&root, worktree_id, repository_name)?;
            if !target.exists() {
                std::fs::create_dir_all(target.parent().context("worktree parent is missing")?)?;
                let target_value = target.to_string_lossy().into_owned();
                let mut args = vec!["worktree", "add", "--detach", target_value.as_str()];
                let git_ref = params
                    .get("ref")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty());
                if let Some(git_ref) = git_ref {
                    let revision = format!("{git_ref}^{{commit}}");
                    let valid = run_git_command(
                        &source,
                        &["rev-parse", "--verify", "--quiet", &revision],
                        4096,
                        Duration::from_secs(15),
                    )
                    .await?;
                    if !valid.success {
                        return Ok(json!({
                            "success": false,
                            "deviceId": device_id,
                            "error": valid.stderr,
                        }));
                    }
                    args.push(git_ref);
                }
                let added =
                    run_git_command(&source, &args, 64 * 1024, Duration::from_secs(60)).await?;
                if !added.success {
                    anyhow::bail!("failed to create Git worktree: {}", added.stderr)
                }
            }
            let now = app_server_now_ms();
            let key = target.to_string_lossy().into_owned();
            let lease_key = hex_sha256(key.as_bytes());
            let head = run_git_command(
                &target,
                &["rev-parse", "--verify", "HEAD"],
                4096,
                Duration::from_secs(15),
            )
            .await?;
            if !head.success {
                anyhow::bail!(
                    "failed to resolve managed worktree baseline: {}",
                    head.stderr
                )
            }
            let head = head
                .stdout
                .as_str()
                .map(str::trim)
                .filter(|value| value.len() == 40 || value.len() == 64)
                .context("managed worktree baseline is invalid")?
                .to_string();
            let previous = state.records.remove(&key).unwrap_or_default();
            let base_commit = if previous.created_at == 0 {
                Some(head)
            } else {
                previous.base_commit.clone()
            };
            let record = ClientManagedWorktree {
                worktree_id: worktree_id.into(),
                path: key.clone(),
                repository_name: repository_name.into(),
                source_path: Some(source.to_string_lossy().into_owned()),
                permanent: params
                    .get("permanent")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                revision: previous.revision.saturating_add(1).max(1),
                base_commit,
                lease_key,
                created_at: if previous.created_at != 0 {
                    previous.created_at
                } else {
                    now
                },
                updated_at: now,
                state: "active".into(),
                ..previous
            };
            state.records.insert(key, record.clone());
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "path": record.path,
                "worktree": record,
            }))
        }
        "runtime.worktrees.list" => {
            let measure_bytes = params
                .get("measureBytes")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let mut changed = false;
            for record in state.records.values_mut() {
                let detected_state = if Path::new(&record.path).exists() {
                    "active"
                } else if (record.snapshot_ref.is_some() || record.snapshot_commit.is_some())
                    && record.git_common_dir.is_some()
                {
                    "restorable"
                } else {
                    "missing"
                };
                if record.state != detected_state {
                    changed = true;
                    record.state = detected_state.into();
                    record.revision = record.revision.saturating_add(1);
                    record.updated_at = app_server_now_ms();
                }
            }
            if changed {
                store.save(&state)?;
            }
            let items = state
                .records
                .values()
                .rev()
                .map(|record| {
                    let bytes = measure_bytes
                        .then(|| measured_path_bytes(Path::new(&record.path), 100_000))
                        .transpose()
                        .ok()
                        .flatten();
                    json!({
                        "deviceId": device_id,
                        "worktreeId": record.worktree_id,
                        "path": record.path,
                        "repositoryName": record.repository_name,
                        "sourcePath": record.source_path,
                        "permanent": record.permanent,
                        "revision": record.revision,
                        "baseCommit": record.base_commit,
                        "createdAt": record.created_at,
                        "updatedAt": record.updated_at,
                        "state": record.state,
                        "snapshotAt": record.snapshot_at,
                        "lastError": record.last_error,
                        "bytes": bytes,
                        "conversations": record.archived_conversations,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({"success": true, "deviceId": device_id, "items": items}))
        }
        "runtime.worktrees.archive.preview" => {
            let requested_path = params
                .get("path")
                .and_then(Value::as_str)
                .context("path is required")?;
            let _guard = store.lock()?;
            let state = store.load()?;
            let record = state
                .records
                .get(requested_path)
                .context("managed worktree was not found")?;
            let preview = preview_client_worktree_archive(&store, record, true).await?;
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "preview": preview,
            }))
        }
        "runtime.worktrees.archive" => {
            let requested_path = params
                .get("path")
                .and_then(Value::as_str)
                .context("path is required")?;
            let expected_revision = params
                .get("expectedRevision")
                .or_else(|| params.get("expected_revision"))
                .and_then(Value::as_u64)
                .context("expectedRevision is required")?;
            let expected_content_token = params
                .get("expectedContentToken")
                .or_else(|| params.get("expected_content_token"))
                .and_then(Value::as_str)
                .context("expectedContentToken is required")?;
            let risk_accepted = params
                .get("riskAccepted")
                .or_else(|| params.get("risk_accepted"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let archived_conversations = params
                .get("archivedConversations")
                .or_else(|| params.get("archived_conversations"))
                .map(|value| {
                    serde_json::from_value::<Vec<ClientWorktreeConversation>>(value.clone())
                        .context("archivedConversations is invalid")
                })
                .transpose()?;
            if archived_conversations
                .as_ref()
                .is_some_and(|conversations| {
                    conversations
                        .iter()
                        .any(|conversation| conversation.workspace_path != requested_path)
                })
            {
                anyhow::bail!("archived conversation workspace does not match the worktree")
            }
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let current = state
                .records
                .get(requested_path)
                .context("managed worktree was not found")?
                .clone();
            if current.revision != expected_revision {
                anyhow::bail!(
                    "managed worktree changed; expected revision {}, current revision {}",
                    expected_revision,
                    current.revision
                )
            }
            if current.state != "active" {
                anyhow::bail!("only an active managed worktree can be archived")
            }
            let path = PathBuf::from(&current.path);
            let _archive_lease = store.acquire_workspace_archive_lease(&path)?;
            let preview = preview_client_worktree_archive(&store, &current, false).await?;
            if preview.content_token.as_deref() != Some(expected_content_token) {
                anyhow::bail!("managed worktree content changed after preview")
            }
            if !preview.archive_allowed {
                anyhow::bail!(
                    "managed worktree cannot be archived safely: {}",
                    preview.blocking_reasons.join("; ")
                )
            }
            if preview.requires_confirmation && !risk_accepted {
                anyhow::bail!(
                    "managed worktree has local changes; explicit risk acceptance is required"
                )
            }
            let snapshot_dir = store
                .state_path
                .parent()
                .context("worktree state directory is missing")?;
            let snapshot = snapshot_client_worktree(&path, snapshot_dir).await?;
            let post_snapshot = preview_client_worktree_archive(&store, &current, false).await?;
            if post_snapshot.content_token.as_deref() != Some(expected_content_token) {
                let _ = run_git_command(
                    &path,
                    &["update-ref", "-d", &snapshot.reference],
                    4096,
                    Duration::from_secs(15),
                )
                .await;
                anyhow::bail!("managed worktree content changed while creating its snapshot")
            }
            {
                let record = state
                    .records
                    .get_mut(requested_path)
                    .context("managed worktree was not found")?;
                record.snapshot_ref = Some(snapshot.reference.clone());
                record.snapshot_commit = Some(snapshot.commit.clone());
                record.snapshot_at = Some(snapshot.created_at);
                record.git_common_dir = Some(snapshot.git_common_dir.clone());
                if record.lease_key.is_empty() {
                    record.lease_key = hex_sha256(record.path.as_bytes());
                }
                if let Some(conversations) = archived_conversations {
                    // Archival enumeration may only add or refresh references; a temporarily empty
                    // thread/list must not overwrite protection registered at creation. References
                    // are removed through conversations.remove, with revision CAS preventing stale previews from re-adding them.
                    for conversation in conversations {
                        if let Some(existing) = record
                            .archived_conversations
                            .iter_mut()
                            .find(|item| item.task_id == conversation.task_id)
                        {
                            *existing = conversation;
                        } else {
                            record.archived_conversations.push(conversation);
                        }
                    }
                }
                record.state = "snapshot_ready".into();
                record.last_error = None;
                record.revision = record.revision.saturating_add(1);
                record.updated_at = app_server_now_ms();
            }
            // Persist the recoverable snapshot identity before removing the directory. If the
            // process exits afterward, the next list can still mark the missing-directory record
            // as restorable without losing the snapshot index.
            store.save(&state)?;
            let source = PathBuf::from(
                current
                    .source_path
                    .as_deref()
                    .context("source repository is missing")?,
            );
            let removed = run_git_command(
                &source,
                &["worktree", "remove", "--force", requested_path],
                64 * 1024,
                Duration::from_secs(60),
            )
            .await?;
            if !removed.success {
                let record = state
                    .records
                    .get_mut(requested_path)
                    .context("managed worktree was not found")?;
                record.state = "active".into();
                record.last_error = Some(format!(
                    "failed to archive Git worktree: {}",
                    removed.stderr
                ));
                record.revision = record.revision.saturating_add(1);
                record.updated_at = app_server_now_ms();
                store.save(&state)?;
                anyhow::bail!("failed to archive Git worktree: {}", removed.stderr)
            }
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            record.state = "restorable".into();
            record.revision = record.revision.saturating_add(1);
            record.updated_at = app_server_now_ms();
            let response_record = record.clone();
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "worktree": response_record,
            }))
        }
        "runtime.worktrees.delete" => {
            if params
                .get("preserveSnapshot")
                .or_else(|| params.get("preserve_snapshot"))
                .and_then(Value::as_bool)
                == Some(false)
            {
                anyhow::bail!(
                    "irreversible worktree deletion is disabled; archive it first, then use forget"
                )
            }
            let preview = Box::pin(worktree_request(
                engine,
                "runtime.worktrees.archive.preview",
                params,
            ))
            .await?
            .get("preview")
            .cloned()
            .context("managed worktree archive preview is missing")?;
            if preview
                .get("requiresConfirmation")
                .and_then(Value::as_bool)
                .unwrap_or(true)
            {
                anyhow::bail!(
                    "managed worktree has local changes; use archive.preview and explicit archive confirmation"
                )
            }
            let mut archive_params = json!({
                "deviceId": device_id,
                "path": params.get("path").cloned().unwrap_or(Value::Null),
                "expectedRevision": preview.get("revision").cloned().unwrap_or(Value::Null),
                "expectedContentToken": preview.get("contentToken").cloned().unwrap_or(Value::Null),
                "riskAccepted": false,
            });
            if let Some(conversations) = params
                .get("archivedConversations")
                .or_else(|| params.get("archived_conversations"))
            {
                archive_params["archivedConversations"] = conversations.clone();
            }
            Box::pin(worktree_request(
                engine,
                "runtime.worktrees.archive",
                &archive_params,
            ))
            .await
        }
        "runtime.worktrees.restore" => {
            let requested_path = params
                .get("path")
                .or_else(|| params.get("workspacePath"))
                .and_then(Value::as_str)
                .context("path is required")?;
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let expected_revision = params
                .get("expectedRevision")
                .or_else(|| params.get("expected_revision"))
                .and_then(Value::as_u64)
                .context("expectedRevision is required")?;
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            let path = PathBuf::from(&record.path);
            if record.revision != expected_revision {
                anyhow::bail!(
                    "managed worktree changed; expected revision {}, current revision {}",
                    expected_revision,
                    record.revision
                )
            }
            if record.state != "restorable" {
                anyhow::bail!("only a restorable managed worktree can be restored")
            }
            if path.exists() {
                anyhow::bail!(
                    "restore target already exists; refusing to bind a colliding directory"
                )
            }
            let lease_key = if record.lease_key.is_empty() {
                hex_sha256(record.path.as_bytes())
            } else {
                record.lease_key.clone()
            };
            let _restore_lease = store.acquire_workspace_archive_lease_by_key(&lease_key)?;
            let snapshot = record
                .snapshot_ref
                .as_deref()
                .or(record.snapshot_commit.as_deref())
                .context("worktree snapshot is unavailable")?
                .to_string();
            let common = record
                .git_common_dir
                .as_deref()
                .context("source repository is unavailable")?
                .to_string();
            let source = PathBuf::from(
                record
                    .source_path
                    .as_deref()
                    .context("source repository is missing")?,
            );
            record.lease_key = lease_key;
            record.state = "restoring".into();
            record.revision = record.revision.saturating_add(1);
            record.updated_at = app_server_now_ms();
            store.save(&state)?;
            std::fs::create_dir_all(path.parent().context("worktree parent is missing")?)?;
            let restored = run_git_command(
                &source,
                &[
                    "--git-dir",
                    &common,
                    "worktree",
                    "add",
                    "--detach",
                    requested_path,
                    &snapshot,
                ],
                64 * 1024,
                Duration::from_secs(60),
            )
            .await?;
            if !restored.success {
                let record = state
                    .records
                    .get_mut(requested_path)
                    .context("managed worktree was not found")?;
                record.state = "restorable".into();
                record.last_error = Some(format!(
                    "failed to restore Git worktree: {}",
                    restored.stderr
                ));
                record.revision = record.revision.saturating_add(1);
                record.updated_at = app_server_now_ms();
                store.save(&state)?;
                anyhow::bail!("failed to restore Git worktree: {}", restored.stderr)
            }
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            record.state = "active".into();
            record.last_error = None;
            record.revision = record.revision.saturating_add(1);
            record.updated_at = app_server_now_ms();
            let response_record = record.clone();
            store.save(&state)?;
            Ok(json!({"success": true, "deviceId": device_id, "worktree": response_record}))
        }
        "runtime.worktrees.forget" => {
            let requested_path = params
                .get("path")
                .or_else(|| params.get("workspacePath"))
                .and_then(Value::as_str)
                .context("path is required")?;
            let expected_revision = params
                .get("expectedRevision")
                .or_else(|| params.get("expected_revision"))
                .and_then(Value::as_u64)
                .context("expectedRevision is required")?;
            let confirmed = params
                .get("confirmPermanent")
                .or_else(|| params.get("confirm_permanent"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !confirmed {
                anyhow::bail!("permanent worktree deletion requires explicit confirmation")
            }
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let record = state
                .records
                .get(requested_path)
                .context("managed worktree was not found")?
                .clone();
            if record.revision != expected_revision {
                anyhow::bail!(
                    "managed worktree changed; expected revision {}, current revision {}",
                    expected_revision,
                    record.revision
                )
            }
            if Path::new(&record.path).exists() {
                anyhow::bail!("active worktree must be archived before it can be forgotten")
            }
            if !matches!(record.state.as_str(), "restorable" | "deleted" | "missing") {
                anyhow::bail!("managed worktree operation is not in a forgettable state")
            }
            if !record.archived_conversations.is_empty() {
                anyhow::bail!("managed worktree still has archived conversation references")
            }
            let lease_key = if record.lease_key.is_empty() {
                hex_sha256(record.path.as_bytes())
            } else {
                record.lease_key.clone()
            };
            let _forget_lease = store.acquire_workspace_archive_lease_by_key(&lease_key)?;
            if let (Some(reference), Some(common)) = (
                record.snapshot_ref.as_deref(),
                record.git_common_dir.as_deref(),
            ) {
                let source = PathBuf::from(
                    record
                        .source_path
                        .as_deref()
                        .context("source repository is missing")?,
                );
                let deleted = run_git_command(
                    &source,
                    &["--git-dir", common, "update-ref", "-d", reference],
                    4096,
                    Duration::from_secs(15),
                )
                .await?;
                if !deleted.success {
                    anyhow::bail!(
                        "failed to delete managed worktree snapshot: {}",
                        deleted.stderr
                    )
                }
            }
            state.records.remove(requested_path);
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "path": requested_path,
                "forgotten": true,
            }))
        }
        "runtime.worktrees.conversations.link" => {
            let requested_path = params
                .get("path")
                .or_else(|| params.get("workspacePath"))
                .and_then(Value::as_str)
                .context("path is required")?;
            let conversation_value = params
                .get("conversation")
                .context("conversation is required")?;
            let conversation =
                serde_json::from_value::<ClientWorktreeConversation>(conversation_value.clone())
                    .context("conversation is invalid")?;
            if conversation.workspace_path != requested_path {
                anyhow::bail!("conversation workspace does not match the worktree")
            }
            if conversation.task_id.is_empty() || conversation.thread_id.is_empty() {
                anyhow::bail!("conversation taskId and threadId are required")
            }
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            if let Some(existing) = record
                .archived_conversations
                .iter_mut()
                .find(|item| item.task_id == conversation.task_id)
            {
                *existing = conversation;
            } else {
                record.archived_conversations.push(conversation);
            }
            record.revision = record.revision.saturating_add(1);
            record.updated_at = app_server_now_ms();
            let revision = record.revision;
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "path": requested_path,
                "revision": revision,
                "linked": true,
            }))
        }
        "runtime.worktrees.conversations.remove" => {
            let requested_path = params
                .get("path")
                .or_else(|| params.get("workspacePath"))
                .and_then(Value::as_str)
                .context("path is required")?;
            let task_id = params
                .get("taskId")
                .or_else(|| params.get("task_id"))
                .and_then(Value::as_str)
                .context("taskId is required")?;
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            let before = record.archived_conversations.len();
            record
                .archived_conversations
                .retain(|conversation| conversation.task_id != task_id);
            record.updated_at = app_server_now_ms();
            let removed = before != record.archived_conversations.len();
            if removed {
                record.revision = record.revision.saturating_add(1);
            }
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "path": requested_path,
                "taskId": task_id,
                "removed": removed,
            }))
        }
        "runtime.worktrees.prune" => {
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let before = state.records.len();
            if state.settings.auto_cleanup_enabled {
                let mut inactive = state
                    .records
                    .iter()
                    .filter(|(_, record)| {
                        !Path::new(&record.path).exists()
                            && !record.permanent
                            && record.snapshot_ref.is_none()
                            && record.snapshot_commit.is_none()
                            && record.archived_conversations.is_empty()
                    })
                    .map(|(key, record)| (key.clone(), record.updated_at))
                    .collect::<Vec<_>>();
                inactive.sort_by_key(|(_, updated_at)| std::cmp::Reverse(*updated_at));
                for (key, _) in inactive.into_iter().skip(state.settings.keep_count) {
                    state.records.remove(&key);
                }
            }
            let pruned_count = before.saturating_sub(state.records.len());
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "prunedCount": pruned_count,
            }))
        }
        _ => anyhow::bail!("unsupported worktree method: {method}"),
    }
}

pub(super) fn measured_path_bytes(path: &Path, max_entries: usize) -> Result<u64> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut bytes = 0u64;
    let mut visited = 0usize;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            visited = visited.saturating_add(1);
            if visited > max_entries {
                anyhow::bail!("path contains more than {max_entries} entries")
            }
            let metadata = std::fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok(bytes)
}

pub(super) fn managed_worktree_target_path(
    root: &Path,
    worktree_id: &str,
    repository_name: &str,
) -> Result<PathBuf> {
    validate_worktree_id(worktree_id)?;
    let target = root.join(worktree_id).join(repository_name);
    if !target.starts_with(root) {
        anyhow::bail!("managed worktree path escaped its root")
    }
    Ok(target)
}

pub(super) fn app_server_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
