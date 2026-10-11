//! Device requests: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn device_execute(
    workspace_root: &Path,
    params: &DeviceExecuteParams,
) -> Result<DeviceExecuteResult> {
    let command = params.command_key.as_str();
    if matches!(
        command,
        "git_is_worktree"
            | "git_branch"
            | "git_branch_list"
            | "git_branch_diff"
            | "git_branch_diff_shortstat"
            | "git_diff_working"
            | "git_diff_unstaged"
            | "git_diff_staged"
            | "git_diff_last_commit"
            | "git_status_porcelain"
            | "git_status_porcelain_z"
            | "git_sync_status"
            | "git_remote_url"
            | "git_add_all"
            | "git_commit"
            | "git_commit_all"
            | "git_push"
            | "git_pull_ff"
            | "git_merge"
            | "git_apply_reverse"
            | "git_checkout"
            | "git_checkout_new"
            | "git_generate_commit_message"
    ) {
        return git_device_execute(workspace_root, params).await;
    }
    let stdout = match command {
        "home_dir" => dirs::home_dir()
            .context("home directory is unavailable")?
            .to_string_lossy()
            .into_owned()
            .into(),
        "project_workspace_root" => workspace_root.to_string_lossy().into_owned().into(),
        "ls_dirs" => {
            let requested = params.path.as_deref().context("ls_dirs requires path")?;
            workspace_list_directories(workspace_root, Path::new(requested)).await?
        }
        "mkdir_p" => {
            let requested = params
                .args
                .first()
                .map(String::as_str)
                .context("mkdir_p requires a path")?;
            workspace_create_directory(workspace_root, Path::new(requested)).await?
        }
        "workspace_tree" => {
            let requested = params
                .path
                .as_deref()
                .context("workspace_tree requires path")?;
            workspace_tree(workspace_root, Path::new(requested)).await?
        }
        "workspace_read_text_file" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_read_text_file requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_read_text_file requires a filename")?;
            let max_bytes = params
                .max_output_bytes
                .unwrap_or(MAX_WORKSPACE_TEXT_BYTES as u64)
                .clamp(1, MAX_WORKSPACE_TEXT_BYTES as u64) as usize;
            workspace_read_text_file(workspace_root, Path::new(parent), name, max_bytes).await?
        }
        "workspace_read_file_chunk" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_read_file_chunk requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_read_file_chunk requires a filename")?;
            let offset = params
                .args
                .get(1)
                .context("workspace_read_file_chunk requires an offset")?
                .parse::<u64>()
                .context("workspace file offset must be a non-negative integer")?;
            workspace_read_file_chunk(
                workspace_root,
                Path::new(parent),
                name,
                offset,
                params.expected_revision.as_deref(),
            )
            .await?
        }
        "workspace_write_text_file" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_write_text_file requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_write_text_file requires a filename")?;
            let expected_revision = params
                .args
                .get(1)
                .map(String::as_str)
                .context("workspace_write_text_file requires an expected revision")?;
            let content = params
                .stdin
                .as_deref()
                .context("workspace_write_text_file requires stdin content")?;
            workspace_write_text_file(
                workspace_root,
                Path::new(parent),
                name,
                expected_revision,
                content,
            )
            .await?
        }
        "workspace_create_text_file" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_create_text_file requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_create_text_file requires a filename")?;
            workspace_create_text_file(
                workspace_root,
                Path::new(parent),
                name,
                params.stdin.as_deref().unwrap_or_default(),
            )
            .await?
        }
        "workspace_create_directory" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_create_directory requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_create_directory requires a name")?;
            workspace_create_workspace_directory(workspace_root, Path::new(parent), name).await?
        }
        "workspace_rename_entry" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_rename_entry requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_rename_entry requires a name")?;
            let new_name = params
                .args
                .get(1)
                .map(String::as_str)
                .context("workspace_rename_entry requires a new name")?;
            workspace_rename_entry(workspace_root, Path::new(parent), name, new_name).await?
        }
        "workspace_delete_entry" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_delete_entry requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_delete_entry requires a name")?;
            let recursive = params.args.get(1).is_some_and(|value| value == "true");
            workspace_delete_entry(workspace_root, Path::new(parent), name, recursive).await?
        }
        _ => anyhow::bail!("unsupported device command: {command}"),
    };
    Ok(DeviceExecuteResult {
        success: true,
        exit_code: 0,
        stdout,
        stderr: String::new(),
    })
}

pub(super) async fn git_device_execute(
    workspace_root: &Path,
    params: &DeviceExecuteParams,
) -> Result<DeviceExecuteResult> {
    let requested = params.path.as_deref().unwrap_or_else(|| {
        workspace_root
            .to_str()
            .expect("configured workspace path is valid UTF-8")
    });
    let root = dunce::canonicalize(workspace_root).with_context(|| {
        format!(
            "failed to resolve workspace root {}",
            workspace_root.display()
        )
    })?;
    let cwd = workspace_path(&root, Path::new(requested)).await?;
    if !tokio::fs::metadata(&cwd).await?.is_dir() {
        anyhow::bail!("git command path is not a directory")
    }
    let max_bytes = params
        .max_output_bytes
        .unwrap_or(64 * 1024)
        .clamp(1, MAX_GIT_OUTPUT_BYTES as u64) as usize;
    let timeout = Duration::from_secs(params.timeout_seconds.unwrap_or(10).clamp(1, 120));
    match params.command_key.as_str() {
        "git_is_worktree" => {
            run_git_command(
                &cwd,
                &["rev-parse", "--is-inside-work-tree"],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_branch" => {
            run_git_command(&cwd, &["branch", "--show-current"], max_bytes, timeout).await
        }
        "git_branch_list" => {
            run_git_command(
                &cwd,
                &["branch", "--format=%(refname:short)"],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_status_porcelain" => {
            run_git_command(&cwd, &["status", "--porcelain"], max_bytes, timeout).await
        }
        "git_status_porcelain_z" => {
            run_git_command(
                &cwd,
                &[
                    "-c",
                    "core.quotePath=false",
                    "status",
                    "--porcelain=v1",
                    "-z",
                ],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_sync_status" => {
            let branch =
                run_git_command(&cwd, &["branch", "--show-current"], 64 * 1024, timeout).await?;
            if !branch.success {
                return Ok(branch);
            }
            let dirty =
                run_git_command(&cwd, &["status", "--porcelain"], 512 * 1024, timeout).await?;
            if !dirty.success {
                return Ok(dirty);
            }
            let remote =
                run_git_command(&cwd, &["remote", "get-url", "origin"], 64 * 1024, timeout).await?;
            let upstream = run_git_command(
                &cwd,
                &[
                    "rev-parse",
                    "--abbrev-ref",
                    "--symbolic-full-name",
                    "@{upstream}",
                ],
                64 * 1024,
                timeout,
            )
            .await?;
            let (ahead, behind) = if upstream.success {
                let counts = run_git_command(
                    &cwd,
                    &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
                    64 * 1024,
                    timeout,
                )
                .await?;
                let values = counts
                    .stdout
                    .as_str()
                    .unwrap_or_default()
                    .split_whitespace()
                    .filter_map(|value| value.parse::<u64>().ok())
                    .collect::<Vec<_>>();
                (
                    values.first().copied().unwrap_or(0),
                    values.get(1).copied().unwrap_or(0),
                )
            } else {
                (0, 0)
            };
            Ok(DeviceExecuteResult {
                success: true,
                exit_code: 0,
                stdout: json!({
                    "currentBranch": branch.stdout.as_str().unwrap_or_default().trim(),
                    "dirty": !dirty.stdout.as_str().unwrap_or_default().is_empty(),
                    "hasRemote": remote.success,
                    "remoteUrl": remote.success.then(|| remote.stdout.as_str().unwrap_or_default().trim()),
                    "hasUpstream": upstream.success,
                    "upstream": upstream.success.then(|| upstream.stdout.as_str().unwrap_or_default().trim()),
                    "ahead": ahead,
                    "behind": behind,
                }),
                stderr: String::new(),
            })
        }
        "git_remote_url" => {
            run_git_command(&cwd, &["remote", "get-url", "origin"], max_bytes, timeout).await
        }
        "git_branch_diff_shortstat" => git_branch_diff_shortstat(&cwd, max_bytes, timeout).await,
        "git_branch_diff" => git_branch_diff(&cwd, max_bytes, timeout).await,
        "git_diff_unstaged" => {
            run_git_command(
                &cwd,
                &["-c", "core.quotePath=false", "diff", "--"],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_diff_working" => git_working_diff(&cwd, max_bytes, timeout).await,
        "git_diff_staged" => {
            run_git_command(
                &cwd,
                &["-c", "core.quotePath=false", "diff", "--cached", "--"],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_diff_last_commit" => git_last_commit_diff(&cwd, max_bytes, timeout).await,
        "git_add_all" => run_git_command(&cwd, &["add", "--all"], max_bytes, timeout).await,
        "git_commit" => {
            if params.args.len() != 2 || params.args[0] != "-m" || params.args[1].len() > 10_000 {
                anyhow::bail!("git_commit requires one bounded -m message")
            }
            run_git_command(&cwd, &["commit", "-m", &params.args[1]], max_bytes, timeout).await
        }
        "git_commit_all" => {
            if params.args.len() != 2 || params.args[0] != "-m" || params.args[1].len() > 10_000 {
                anyhow::bail!("git_commit_all requires one bounded -m message")
            }
            let staged = run_git_command(&cwd, &["add", "--all"], max_bytes, timeout).await?;
            if !staged.success {
                return Ok(staged);
            }
            run_git_command(&cwd, &["commit", "-m", &params.args[1]], max_bytes, timeout).await
        }
        "git_push" => {
            if !params.args.is_empty() {
                anyhow::bail!("git_push does not accept arguments")
            }
            let upstream = run_git_command(
                &cwd,
                &["rev-parse", "--abbrev-ref", "@{upstream}"],
                4096,
                timeout,
            )
            .await?;
            if upstream.success {
                run_git_command_with_auth(&cwd, &["push"], max_bytes, timeout).await
            } else {
                run_git_command_with_auth(
                    &cwd,
                    &["push", "-u", "origin", "HEAD"],
                    max_bytes,
                    timeout,
                )
                .await
            }
        }
        "git_pull_ff" => {
            if !params.args.is_empty() {
                anyhow::bail!("git_pull_ff does not accept arguments")
            }
            let dirty =
                run_git_command(&cwd, &["status", "--porcelain"], 512 * 1024, timeout).await?;
            if !dirty.success || !dirty.stdout.as_str().unwrap_or_default().is_empty() {
                return Ok(DeviceExecuteResult {
                    success: false,
                    exit_code: 1,
                    stdout: Value::String(String::new()),
                    stderr: "pull requires a clean working tree".into(),
                });
            }
            run_git_command_with_auth(&cwd, &["pull", "--ff-only"], max_bytes, timeout).await
        }
        "git_merge" => {
            if params.args.len() != 1 || params.args[0].starts_with('-') {
                anyhow::bail!("git_merge requires exactly one branch or ref")
            }
            let target = &params.args[0];
            let verify = run_git_command(
                &cwd,
                &["rev-parse", "--verify", &format!("{target}^{{commit}}")],
                4096,
                timeout,
            )
            .await?;
            if !verify.success {
                return Ok(verify);
            }
            let dirty =
                run_git_command(&cwd, &["status", "--porcelain"], 512 * 1024, timeout).await?;
            if !dirty.success || !dirty.stdout.as_str().unwrap_or_default().is_empty() {
                return Ok(DeviceExecuteResult {
                    success: false,
                    exit_code: 1,
                    stdout: Value::String(String::new()),
                    stderr: "merge requires a clean working tree".into(),
                });
            }
            let merged =
                run_git_command(&cwd, &["merge", "--no-edit", target], max_bytes, timeout).await?;
            if !merged.success {
                let aborted =
                    run_git_command(&cwd, &["merge", "--abort"], 64 * 1024, timeout).await?;
                if !aborted.success {
                    return Ok(DeviceExecuteResult {
                        stderr: format!(
                            "{}\nmerge --abort failed: {}",
                            merged.stderr, aborted.stderr
                        ),
                        ..merged
                    });
                }
            }
            Ok(merged)
        }
        "git_apply_reverse" => {
            let patch = params.stdin.as_deref().context("stdin patch is required")?;
            if patch.is_empty() || patch.len() > MAX_GIT_OUTPUT_BYTES {
                anyhow::bail!("git reverse patch must contain between 1 byte and 5 MiB")
            }
            run_git_command_with_stdin(
                &cwd,
                &["apply", "--reverse", "--whitespace=nowarn", "-"],
                patch,
                max_bytes,
                timeout,
            )
            .await
        }
        "git_checkout" | "git_checkout_new" => {
            if params.args.len() != 1 {
                anyhow::bail!("{} requires exactly one branch name", params.command_key)
            }
            let dirty =
                run_git_command(&cwd, &["status", "--porcelain"], 512 * 1024, timeout).await?;
            if !dirty.success || !dirty.stdout.as_str().unwrap_or_default().is_empty() {
                return Ok(DeviceExecuteResult {
                    success: false,
                    exit_code: 1,
                    stdout: Value::String(String::new()),
                    stderr: "branch changes require a clean working tree".into(),
                });
            }
            let branch = &params.args[0];
            let validation = run_git_command(
                &cwd,
                &["check-ref-format", "--branch", branch],
                4096,
                timeout,
            )
            .await?;
            if !validation.success {
                return Ok(validation);
            }
            let args = if params.command_key == "git_checkout_new" {
                vec!["checkout", "-b", branch.as_str()]
            } else {
                vec!["checkout", branch.as_str()]
            };
            run_git_command(&cwd, &args, max_bytes, timeout).await
        }
        "git_generate_commit_message" => {
            let names = run_git_command(
                &cwd,
                &["diff", "--cached", "--name-only", "--"],
                64 * 1024,
                timeout,
            )
            .await?;
            if !names.success {
                return Ok(names);
            }
            let files = names
                .stdout
                .as_str()
                .unwrap_or_default()
                .lines()
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>();
            let stdout = if files.is_empty() {
                json!({"success": false, "error": "No staged changes"})
            } else if files.len() == 1 {
                json!({"success": true, "message": format!("Update {}", files[0])})
            } else {
                json!({"success": true, "message": format!("Update {} files", files.len())})
            };
            Ok(DeviceExecuteResult {
                success: true,
                exit_code: 0,
                stdout,
                stderr: String::new(),
            })
        }
        command => anyhow::bail!("unsupported git command: {command}"),
    }
}
