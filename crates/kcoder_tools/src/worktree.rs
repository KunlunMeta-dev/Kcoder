//! Git worktree navigation tools.
//!
//! These tools allow the model to switch the session's working directory into a
//! git worktree and later return to the original project root.

use crate::{LifecycleHookResult, Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use kcoder_types::ContentBlock;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use tracing::debug;

use crate::process::configure_isolated_process_environment;

const WORKTREES_DIR: &str = ".kcoder/worktrees";
const MAX_WORKTREE_SLUG_LENGTH: usize = 64;

fn lifecycle_block_error(event: &str, result: &LifecycleHookResult) -> ToolError {
    ToolError::Execution(format!(
        "{event} hook blocked worktree operation: {}",
        result.block_reason()
    ))
}

fn append_lifecycle_messages(output: &mut ToolOutput, event: &str, result: &LifecycleHookResult) {
    for (text, is_error) in &result.messages {
        let level = if *is_error { "error" } else { "message" };
        output.content.push(ContentBlock::Text {
            text: format!("[hook:{event}:{level}] {text}"),
        });
    }
}

/// Switch the session's working directory to a git worktree.
#[derive(Debug, Default)]
pub struct EnterWorktreeTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EnterWorktreeInput {
    /// Optional existing git worktree directory. May be absolute or relative to
    /// the current working directory. Preserves the legacy KCoder behavior.
    pub path: Option<String>,
    /// Optional managed worktree name. When path is omitted, the tool creates
    /// or resumes `.kcoder/worktrees/<name>` on branch `worktree-<name>`.
    pub name: Option<String>,
}

#[async_trait]
impl Tool for EnterWorktreeTool {
    fn name(&self) -> String {
        "EnterWorktree".to_string()
    }

    fn description(&self) -> String {
        "Create or enter an isolated git worktree and switch the session working directory into it — the session-level worktree flow, paired with ExitWorktree to come back. Use only when the user explicitly asks to work in a worktree. Input is either {\"name\":\"feature-name\"} to create/resume a managed worktree under `.kcoder/worktrees/`, or {\"path\":\"../existing-worktree\"} to enter an existing git worktree. The optional name may contain letters, digits, dots, underscores, dashes, and nested `/` segments; it must be 64 characters or fewer. Do not use this merely to switch branches; use git commands for normal branch changes. For a bare `git worktree add` without switching the session, use WorktreeCreate; for isolating a sub-agent, use spawn_agent with isolation=\"worktree\" instead."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(EnterWorktreeInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: EnterWorktreeInput = parse_input(&input)?;
        if let Some(active) = ctx.state.active_worktree() {
            return Err(ToolError::InvalidInput(format!(
                "Already in a worktree session at {}. Use ExitWorktree before entering another worktree.",
                active.worktree_path.display()
            )));
        }

        let cwd = ctx.state.cwd();
        if let Some(raw_path) = input.path {
            enter_existing_worktree(ctx, &cwd, &raw_path).await
        } else {
            create_or_resume_session_worktree(ctx, &cwd, input.name).await
        }
    }
}

async fn enter_existing_worktree(
    ctx: &ToolContext,
    cwd: &Path,
    raw_path: &str,
) -> Result<ToolOutput, ToolError> {
    let path = resolve_path(raw_path, cwd);

    // Validate that the target looks like a git worktree. A linked worktree
    // has a `.git` file (not directory) pointing back to the main repo.
    let git_marker = path.join(".git");
    if !git_marker.exists() {
        return Err(ToolError::InvalidInput(format!(
            "{} does not appear to be a git worktree (missing .git)",
            path.display()
        )));
    }

    if let Some(sandbox) = &ctx.sandbox {
        sandbox
            .check_path(&path, false)
            .map_err(ToolError::Execution)?;
    }

    debug!("entering existing worktree {:?}", path);
    ctx.state.enter_worktree_session(
        cwd.to_path_buf(),
        path.clone(),
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("existing-worktree")
            .to_string(),
        None,
        None,
        false,
    );
    let cwd_result = ctx
        .emit_lifecycle_hook(
            "CwdChanged",
            path.display().to_string(),
            serde_json::json!({
                "old_cwd": cwd,
                "cwd": path.clone(),
                "source": "EnterWorktree",
                "created_by_session": false,
            }),
        )
        .await?;
    if cwd_result.should_block() {
        ctx.state.exit_worktree();
        return Err(lifecycle_block_error("CwdChanged", &cwd_result));
    }

    let mut output = ToolOutput::text(format!(
        "Switched working directory to existing worktree {}. Use ExitWorktree with action \"keep\" to return to {}. Because this worktree was supplied by path, ExitWorktree action \"remove\" will refuse; use WorktreeRemove explicitly if deletion is intended.",
        path.display(),
        cwd.display()
    ));
    append_lifecycle_messages(&mut output, "CwdChanged", &cwd_result);
    Ok(output)
}

async fn create_or_resume_session_worktree(
    ctx: &ToolContext,
    cwd: &Path,
    name: Option<String>,
) -> Result<ToolOutput, ToolError> {
    let slug = name.unwrap_or_else(|| format!("session-{}", ctx.state.session_id()));
    validate_worktree_slug(&slug)?;

    let repo_root = find_git_root(cwd).await?;
    let path = worktree_path_for(&repo_root, &slug);
    let branch = worktree_branch_name(&slug);

    if let Some(sandbox) = &ctx.sandbox {
        sandbox.check_shell().map_err(ToolError::Execution)?;
        sandbox
            .check_path(&path, true)
            .map_err(ToolError::Execution)?;
    }

    let hook_result = ctx
        .emit_lifecycle_hook(
            "WorktreeCreate",
            path.display().to_string(),
            serde_json::json!({
                "requested_name": slug,
                "worktree_path": path,
                "cwd": cwd,
                "base": "HEAD",
                "new_branch": branch,
                "force": true,
                "source": "EnterWorktree",
            }),
        )
        .await?;
    if hook_result.should_block() {
        return Err(lifecycle_block_error("WorktreeCreate", &hook_result));
    }

    let original_head = run_git(&repo_root, vec!["rev-parse".into(), "HEAD".into()])
        .await
        .ok();
    let existed = path.join(".git").exists();
    if !existed {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ToolError::Execution(format!(
                    "failed to create worktree parent directory {}: {e}",
                    parent.display()
                ))
            })?;
        }
        run_git(
            &repo_root,
            vec![
                "worktree".into(),
                "add".into(),
                "-B".into(),
                branch.clone(),
                path.to_string_lossy().to_string(),
                "HEAD".into(),
            ],
        )
        .await?;
    }

    debug!("entering managed worktree {:?}", path);
    ctx.state.enter_worktree_session(
        cwd.to_path_buf(),
        path.clone(),
        slug.clone(),
        Some(branch.clone()),
        original_head.clone(),
        true,
    );
    let cwd_result = ctx
        .emit_lifecycle_hook(
            "CwdChanged",
            path.display().to_string(),
            serde_json::json!({
                "old_cwd": cwd,
                "cwd": path.clone(),
                "source": "EnterWorktree",
                "created_by_session": true,
                "worktree_name": slug,
                "worktree_branch": branch,
                "existing": existed,
            }),
        )
        .await?;
    if cwd_result.should_block() {
        ctx.state.exit_worktree();
        return Err(lifecycle_block_error("CwdChanged", &cwd_result));
    }

    let verb = if existed { "Resumed" } else { "Created" };
    let mut output = ToolOutput::text(format!(
        "{verb} worktree at {} on branch {}. The session is now working in the worktree. Use ExitWorktree with action \"keep\" to preserve it, or action \"remove\" to remove this managed worktree after confirming changes can be discarded.",
        path.display(),
        branch
    ));
    append_lifecycle_messages(&mut output, "WorktreeCreate", &hook_result);
    append_lifecycle_messages(&mut output, "CwdChanged", &cwd_result);
    Ok(output)
}

/// Return to the original project root directory.
#[derive(Debug, Default)]
pub struct ExitWorktreeTool;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExitWorktreeAction {
    Keep,
    Remove,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ExitWorktreeInput {
    /// "keep" leaves the worktree on disk; "remove" deletes a managed
    /// worktree created/resumed by EnterWorktree in this session.
    pub action: Option<ExitWorktreeAction>,
    /// Required true when action is "remove" and the worktree has uncommitted
    /// files or commits not on the original HEAD.
    #[serde(default, alias = "discardChanges")]
    pub discard_changes: bool,
}

#[async_trait]
impl Tool for ExitWorktreeTool {
    fn name(&self) -> String {
        "ExitWorktree".to_string()
    }

    fn description(&self) -> String {
        "Exit a worktree session created or entered by EnterWorktree and return to the previous working directory — the second half of the session-level worktree flow. Input shape is {\"action\":\"keep\"} or {\"action\":\"remove\",\"discard_changes\":true}. `keep` preserves the directory and branch. `remove` deletes only managed `.kcoder/worktrees/...` worktrees created/resumed by EnterWorktree in this session, and refuses if there are uncommitted files or new commits unless discard_changes is true. If no EnterWorktree session is active, the tool reports a no-op instead of touching filesystem state. To delete a worktree created directly with WorktreeCreate (not a session flow), use WorktreeRemove instead.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(ExitWorktreeInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ExitWorktreeInput = parse_input(&input)?;
        let action = input.action.unwrap_or(ExitWorktreeAction::Keep);
        let Some(session) = ctx.state.active_worktree() else {
            let previous = ctx.state.cwd();
            let base = ctx.state.base_cwd();
            if previous != base {
                ctx.state.exit_worktree();
                let cwd_result = ctx
                    .emit_lifecycle_hook(
                        "CwdChanged",
                        base.display().to_string(),
                        serde_json::json!({
                            "old_cwd": previous,
                            "cwd": base,
                            "source": "ExitWorktree",
                            "active_worktree": false,
                            "legacy_restore": true,
                        }),
                    )
                    .await?;
                if cwd_result.should_block() {
                    ctx.state.set_cwd(previous);
                    return Err(lifecycle_block_error("CwdChanged", &cwd_result));
                }
                let mut output = ToolOutput::text(format!(
                    "No active EnterWorktree session was recorded. Restored the session working directory to the original root {} for legacy compatibility; no worktree filesystem changes were made.",
                    base.display()
                ));
                append_lifecycle_messages(&mut output, "CwdChanged", &cwd_result);
                return Ok(output);
            }
            return Ok(ToolOutput::text(
                "No active EnterWorktree session to exit. This is a no-op; no filesystem changes were made.",
            ));
        };

        if matches!(action, ExitWorktreeAction::Remove) && !session.created_by_session {
            return Err(ToolError::InvalidInput(format!(
                "Refusing to remove {} because it was entered by explicit path, not created/resumed as a managed EnterWorktree session. Use action \"keep\" to leave it, or call WorktreeRemove with an explicit path if deletion is intended.",
                session.worktree_path.display()
            )));
        }

        let cwd_result = ctx
            .emit_lifecycle_hook(
                "CwdChanged",
                session.original_cwd.display().to_string(),
                serde_json::json!({
                    "old_cwd": session.worktree_path.clone(),
                    "cwd": session.original_cwd.clone(),
                    "source": "ExitWorktree",
                    "action": exit_action_name(&action),
                }),
            )
            .await?;
        if cwd_result.should_block() {
            return Err(lifecycle_block_error("CwdChanged", &cwd_result));
        }

        let mut discarded_files = 0usize;
        let mut discarded_commits = 0usize;
        if matches!(action, ExitWorktreeAction::Remove) {
            match count_worktree_changes(
                &session.worktree_path,
                session.original_head_commit.as_deref(),
            )
            .await?
            {
                Some(summary) => {
                    discarded_files = summary.changed_files;
                    discarded_commits = summary.commits;
                    if !input.discard_changes && (summary.changed_files > 0 || summary.commits > 0)
                    {
                        return Err(ToolError::InvalidInput(format!(
                            "Worktree has {} uncommitted file(s) and {} commit(s) after the original HEAD. Removing will discard this work permanently. Confirm with the user, then re-invoke ExitWorktree with {{\"action\":\"remove\",\"discard_changes\":true}}, or use {{\"action\":\"keep\"}} to preserve it.",
                            summary.changed_files, summary.commits
                        )));
                    }
                }
                None if !input.discard_changes => {
                    return Err(ToolError::InvalidInput(format!(
                        "Could not verify worktree state at {}. Refusing to remove without explicit confirmation. Re-invoke with {{\"action\":\"remove\",\"discard_changes\":true}} to proceed, or use {{\"action\":\"keep\"}} to preserve it.",
                        session.worktree_path.display()
                    )));
                }
                None => {}
            }

            let remove_result = ctx
                .emit_lifecycle_hook(
                    "WorktreeRemove",
                    session.worktree_path.display().to_string(),
                    serde_json::json!({
                        "worktree_path": session.worktree_path,
                        "cwd": session.original_cwd,
                        "force": true,
                        "discard_changes": input.discard_changes,
                        "source": "ExitWorktree",
                    }),
                )
                .await?;
            if remove_result.should_block() {
                return Err(lifecycle_block_error("WorktreeRemove", &remove_result));
            }
            run_git(
                &session.original_cwd,
                vec![
                    "worktree".into(),
                    "remove".into(),
                    "--force".into(),
                    session.worktree_path.to_string_lossy().to_string(),
                ],
            )
            .await?;
            let mut branch_warning = None;
            if let Some(branch) = &session.worktree_branch
                && let Err(e) = run_git(
                    &session.original_cwd,
                    vec!["branch".into(), "-D".into(), branch.clone()],
                )
                .await
            {
                branch_warning = Some(format!("{e}"));
            }

            ctx.state.exit_worktree();
            let discard_note = if discarded_files > 0 || discarded_commits > 0 {
                format!(
                    " Discarded {discarded_files} uncommitted file(s) and {discarded_commits} commit(s)."
                )
            } else {
                String::new()
            };
            let mut output = ToolOutput::text(format!(
                "Exited and removed managed worktree at {}.{} Session is now back in {}.",
                session.worktree_path.display(),
                discard_note,
                session.original_cwd.display()
            ));
            if let Some(warning) = branch_warning {
                output.content.push(ContentBlock::Text {
                    text: format!("Warning: worktree branch cleanup failed: {warning}"),
                });
            }
            append_lifecycle_messages(&mut output, "CwdChanged", &cwd_result);
            append_lifecycle_messages(&mut output, "WorktreeRemove", &remove_result);
            return Ok(output);
        }

        ctx.state.exit_worktree();
        let mut output = ToolOutput::text(format!(
            "Exited worktree. Work is preserved at {}{}. Session is now back in {}.",
            session.worktree_path.display(),
            session
                .worktree_branch
                .as_ref()
                .map(|branch| format!(" on branch {branch}"))
                .unwrap_or_default(),
            session.original_cwd.display()
        ));
        append_lifecycle_messages(&mut output, "CwdChanged", &cwd_result);
        Ok(output)
    }
}

/// Create a git worktree with `git worktree add`.
#[derive(Debug, Default)]
pub struct WorktreeCreateTool;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateInput {
    /// Destination directory for the new worktree. May be absolute or relative
    /// to the current working directory.
    pub path: String,
    /// Optional commit, branch, or tag to check out. When omitted, git uses its
    /// default worktree-add behavior.
    pub base: Option<String>,
    /// Optional branch name to create with `git worktree add -b <branch>`.
    pub new_branch: Option<String>,
    /// Pass `--force` to git. Use only when the target path or worktree state
    /// requires force.
    #[serde(default)]
    pub force: bool,
}

#[async_trait]
impl Tool for WorktreeCreateTool {
    fn name(&self) -> String {
        "WorktreeCreate".to_string()
    }

    fn description(&self) -> String {
        "Create a real git worktree by running `git worktree add` — the low-level primitive: it creates the worktree but does NOT switch the session into it. Input must be an object: \
         {\"path\":\"../feature-worktree\",\"base\":\"main\",\"newBranch\":\"feature/name\",\"force\":false}. \
         Only `path` is required. Use `base` for an existing commit/branch/tag, `newBranch` to create a new branch, \
         and `force` only when git requires --force. When the goal is to actually work inside a worktree for \
         this session, prefer EnterWorktree (it creates/resumes the worktree and moves the session cwd); \
         for sub-agent isolation use spawn_agent with isolation=\"worktree\"."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(WorktreeCreateInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: WorktreeCreateInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let path = resolve_path(&input.path, &cwd);

        if let Some(sandbox) = &ctx.sandbox {
            sandbox.check_shell().map_err(ToolError::Execution)?;
            sandbox
                .check_path(&path, true)
                .map_err(ToolError::Execution)?;
        }

        let hook_result = ctx
            .emit_lifecycle_hook(
                "WorktreeCreate",
                path.display().to_string(),
                serde_json::json!({
                    "requested_path": input.path,
                    "worktree_path": path,
                    "cwd": cwd,
                    "base": input.base,
                    "new_branch": input.new_branch,
                    "force": input.force,
                    "source": "WorktreeCreate",
                }),
            )
            .await?;
        if hook_result.should_block() {
            return Err(lifecycle_block_error("WorktreeCreate", &hook_result));
        }

        let mut args = vec!["worktree".to_string(), "add".to_string()];
        if input.force {
            args.push("--force".to_string());
        }
        if let Some(branch) = input.new_branch {
            args.push("-b".to_string());
            args.push(branch);
        }
        args.push(path.to_string_lossy().to_string());
        if let Some(base) = input.base {
            args.push(base);
        }

        let git_output = run_git(&cwd, args).await?;
        let mut output = ToolOutput::text(format!(
            "Created git worktree at {}\n{}",
            path.display(),
            git_output.trim()
        ));
        append_lifecycle_messages(&mut output, "WorktreeCreate", &hook_result);
        Ok(output)
    }
}

/// Remove a git worktree with `git worktree remove`.
#[derive(Debug, Default)]
pub struct WorktreeRemoveTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorktreeRemoveInput {
    /// Path to the worktree directory to remove. May be absolute or relative to
    /// the current working directory.
    pub path: String,
    /// Pass `--force` to git. Use only when git reports the worktree cannot be
    /// removed without force.
    #[serde(default)]
    pub force: bool,
}

#[async_trait]
impl Tool for WorktreeRemoveTool {
    fn name(&self) -> String {
        "WorktreeRemove".to_string()
    }

    fn description(&self) -> String {
        "Remove a real git worktree by running `git worktree remove` — the low-level deletion primitive, \
         paired with WorktreeCreate. Input must be an object: \
         {\"path\":\"../feature-worktree\",\"force\":false}. Do not use this for merely leaving a worktree; \
         use ExitWorktree for changing the session cwd back to the original project, and use ExitWorktree \
         action=remove for deleting a managed worktree created by EnterWorktree."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(WorktreeRemoveInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: WorktreeRemoveInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let path = resolve_path(&input.path, &cwd);

        if crate::sandbox::path_starts_with(&cwd, &path) {
            return Err(ToolError::InvalidInput(format!(
                "cannot remove the current session working directory {}; call ExitWorktree first",
                path.display()
            )));
        }

        if let Some(sandbox) = &ctx.sandbox {
            sandbox.check_shell().map_err(ToolError::Execution)?;
            sandbox
                .check_path(&path, true)
                .map_err(ToolError::Execution)?;
        }

        let hook_result = ctx
            .emit_lifecycle_hook(
                "WorktreeRemove",
                path.display().to_string(),
                serde_json::json!({
                    "requested_path": input.path,
                    "worktree_path": path,
                    "cwd": cwd,
                    "force": input.force,
                    "source": "WorktreeRemove",
                }),
            )
            .await?;
        if hook_result.should_block() {
            return Err(lifecycle_block_error("WorktreeRemove", &hook_result));
        }

        let mut args = vec!["worktree".to_string(), "remove".to_string()];
        if input.force {
            args.push("--force".to_string());
        }
        args.push(path.to_string_lossy().to_string());

        let git_output = run_git(&cwd, args).await?;
        let mut output = ToolOutput::text(format!(
            "Removed git worktree at {}\n{}",
            path.display(),
            git_output.trim()
        ));
        append_lifecycle_messages(&mut output, "WorktreeRemove", &hook_result);
        Ok(output)
    }
}

fn resolve_path(path: &str, cwd: &Path) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() { p } else { cwd.join(p) }
}

async fn run_git(cwd: &Path, args: Vec<String>) -> Result<String, ToolError> {
    let git_path = which::which("git")
        .map_err(|e| ToolError::Execution(format!("failed to locate git: {e}")))?;
    run_git_program(cwd, args, &git_path).await
}

async fn run_git_program(
    cwd: &Path,
    args: Vec<String>,
    git_path: &Path,
) -> Result<String, ToolError> {
    let mut command = Command::new(git_path);
    command.args(&args);
    configure_isolated_process_environment(&mut command, cwd);
    let output = command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| ToolError::Execution(format!("failed to run git: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map_or_else(|| "signal".to_string(), |code| code.to_string());
        return Err(ToolError::Execution(format_git_failure(
            &args, &code, &stdout, &stderr,
        )));
    }

    Ok(match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    })
}

fn format_git_failure(args: &[String], code: &str, stdout: &str, stderr: &str) -> String {
    let mut message = format!(
        "git {} failed with exit code {code}\nstdout: {stdout}\nstderr: {stderr}",
        args.join(" ")
    );
    if stderr.contains("'$GIT_DIR' too big") {
        message.push_str(
            "\nGit for Windows keeps an internal repository/worktree path limit even when \
             core.longpaths=true. Choose a shorter repository or worktree destination \
             (about 210 characters or fewer).",
        );
    }
    message
}

async fn find_git_root(cwd: &Path) -> Result<PathBuf, ToolError> {
    let root = run_git(cwd, vec!["rev-parse".into(), "--show-toplevel".into()]).await?;
    let root = root.trim();
    if root.is_empty() {
        return Err(ToolError::Execution(
            "git rev-parse --show-toplevel returned an empty path".to_string(),
        ));
    }
    Ok(PathBuf::from(root))
}

fn validate_worktree_slug(slug: &str) -> Result<(), ToolError> {
    if slug.len() > MAX_WORKTREE_SLUG_LENGTH {
        return Err(ToolError::InvalidInput(format!(
            "Invalid worktree name: must be {MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got {})",
            slug.len()
        )));
    }
    for segment in slug.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(ToolError::InvalidInput(format!(
                "Invalid worktree name \"{slug}\": must not contain empty, \".\", or \"..\" path segments"
            )));
        }
        if !segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            return Err(ToolError::InvalidInput(format!(
                "Invalid worktree name \"{slug}\": each \"/\"-separated segment must contain only letters, digits, dots, underscores, and dashes"
            )));
        }
    }
    Ok(())
}

fn flatten_slug(slug: &str) -> String {
    slug.replace('/', "+")
}

fn worktree_branch_name(slug: &str) -> String {
    format!("worktree-{}", flatten_slug(slug))
}

fn worktree_path_for(repo_root: &Path, slug: &str) -> PathBuf {
    repo_root.join(WORKTREES_DIR).join(flatten_slug(slug))
}

fn exit_action_name(action: &ExitWorktreeAction) -> &'static str {
    match action {
        ExitWorktreeAction::Keep => "keep",
        ExitWorktreeAction::Remove => "remove",
    }
}

/// Create (or resume) the managed isolation worktree for a sub-agent spawned
/// with `isolation="worktree"`. Returns the worktree path and its branch.
///
/// The worktree lives under `.kcoder/worktrees/<agent_id>` inside the repo
/// root, so it stays inside the parent workspace sandbox while keeping the
/// child's edits out of the parent's working tree. Re-using an existing path
/// lets a re-spawned or continued agent resume its earlier work.
pub(crate) async fn create_agent_isolation_worktree(
    cwd: &Path,
    agent_id: &str,
) -> Result<(PathBuf, String), ToolError> {
    validate_worktree_slug(agent_id)?;
    let repo_root = find_git_root(cwd).await.map_err(|e| {
        ToolError::Execution(format!(
            "isolation=\"worktree\" requires the session cwd to be inside a git repository: {e}"
        ))
    })?;
    let path = worktree_path_for(&repo_root, agent_id);
    let branch = worktree_branch_name(agent_id);
    if path.join(".git").exists() {
        return Ok((path, branch));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            ToolError::Execution(format!(
                "failed to create worktree parent directory {}: {e}",
                parent.display()
            ))
        })?;
    }
    run_git(
        &repo_root,
        vec![
            "worktree".into(),
            "add".into(),
            "-B".into(),
            branch.clone(),
            path.to_string_lossy().to_string(),
            "HEAD".into(),
        ],
    )
    .await?;
    Ok((path, branch))
}

#[derive(Debug, Clone, Copy)]
struct WorktreeChangeSummary {
    changed_files: usize,
    commits: usize,
}

async fn count_worktree_changes(
    worktree_path: &Path,
    original_head_commit: Option<&str>,
) -> Result<Option<WorktreeChangeSummary>, ToolError> {
    let status = match run_git(worktree_path, vec!["status".into(), "--porcelain".into()]).await {
        Ok(status) => status,
        Err(_) => return Ok(None),
    };
    let changed_files = status
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();

    let Some(original_head_commit) = original_head_commit else {
        return Ok(None);
    };
    let commits = match run_git(
        worktree_path,
        vec![
            "rev-list".into(),
            "--count".into(),
            format!("{original_head_commit}..HEAD"),
        ],
    )
    .await
    {
        Ok(count) => count.trim().parse::<usize>().unwrap_or(0),
        Err(_) => return Ok(None),
    };

    Ok(Some(WorktreeChangeSummary {
        changed_files,
        commits,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enter_worktree_rejects_missing_git() {
        let ctx = ToolContext::new(kcoder_state::AppState::new("/tmp"));
        let tool = EnterWorktreeTool;
        let input = serde_json::json!({ "path": "/nonexistent/worktree" });
        let result = tool.call(input, &ctx).await;
        assert!(result.is_err());
    }

    #[test]
    fn worktree_slug_validation_matches_upstream_shape() {
        assert!(validate_worktree_slug("user/feature.one_2-3").is_ok());
        assert!(validate_worktree_slug("../escape").is_err());
        assert!(validate_worktree_slug("/absolute").is_err());
        assert!(validate_worktree_slug("bad name").is_err());
        assert!(validate_worktree_slug(&"x".repeat(MAX_WORKTREE_SLUG_LENGTH + 1)).is_err());
        assert_eq!(
            worktree_branch_name("user/feature"),
            "worktree-user+feature"
        );
    }

    #[test]
    fn git_dir_too_big_error_includes_actionable_windows_path_guidance() {
        let message = format_git_failure(
            &["worktree".into(), "add".into(), "C:\\very-long".into()],
            "128",
            "",
            "fatal: '$GIT_DIR' too big.",
        );
        assert!(message.contains("core.longpaths=true"));
        assert!(message.contains("shorter repository or worktree destination"));
        assert!(message.contains("210 characters or fewer"));
    }

    #[tokio::test]
    async fn exit_worktree_without_active_session_is_noop_at_base() {
        let ctx = ToolContext::new(kcoder_state::AppState::new("/tmp"));
        let tool = ExitWorktreeTool;
        let output = tool
            .call(serde_json::json!({ "action": "keep" }), &ctx)
            .await
            .unwrap();
        let text = match &output.content[0] {
            ContentBlock::Text { text } => text,
            _ => panic!("expected text"),
        };
        assert!(text.contains("No active EnterWorktree session"));
        assert_eq!(ctx.state.cwd(), PathBuf::from("/tmp"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_git_uses_clean_environment_and_session_cwd() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let fake_git = temp.path().join("git");
        std::fs::write(
            &fake_git,
            "#!/bin/sh\nprintf 'home=%s\\npwd=%s\\nprompt=%s\\naskpass=%s\\nargs=%s\\n' \"${HOME-unset}\" \"$PWD\" \"$GIT_TERMINAL_PROMPT\" \"${GIT_ASKPASS-unset}\" \"$*\"\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake_git).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_git, permissions).unwrap();

        let output = run_git_program(
            temp.path(),
            vec!["status".to_string(), "--porcelain".to_string()],
            &fake_git,
        )
        .await
        .unwrap();

        assert!(output.contains("home=unset"), "{output}");
        assert!(
            output.contains(&format!("pwd={}", temp.path().display())),
            "{output}"
        );
        assert!(output.contains("prompt=0"), "{output}");
        assert!(output.contains("askpass="), "{output}");
        assert!(output.contains("args=status --porcelain"), "{output}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn run_git_keeps_required_windows_runtime_environment() {
        let temp = tempfile::tempdir().unwrap();
        let fake_git = temp.path().join("git.cmd");
        std::fs::write(
            &fake_git,
            "@echo off\r\necho root=%SystemRoot%\r\necho path=%PATH%\r\necho home=%USERPROFILE%\r\necho prompt=%GIT_TERMINAL_PROMPT%\r\necho askpass=%GIT_ASKPASS%\r\n",
        )
        .unwrap();

        let output = run_git_program(
            temp.path(),
            vec!["status".to_string(), "--porcelain".to_string()],
            &fake_git,
        )
        .await
        .unwrap();

        let system_root = std::env::var("SystemRoot").unwrap();
        let path = std::env::var("PATH").unwrap();
        let user_profile = std::env::var("USERPROFILE").unwrap();
        assert!(output.contains(&format!("root={system_root}")), "{output}");
        assert!(output.contains(&format!("path={path}")), "{output}");
        assert!(output.contains(&format!("home={user_profile}")), "{output}");
        assert!(output.contains("prompt=0"), "{output}");
        assert!(output.contains("askpass="), "{output}");
    }

    #[tokio::test]
    async fn enter_worktree_with_name_creates_managed_worktree() {
        if which::which("git").is_err() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(temp.path())
            .status()
            .unwrap();
        std::fs::write(temp.path().join("README.md"), "hello\n").unwrap();
        std::process::Command::new("git")
            .args(["add", "README.md"])
            .current_dir(temp.path())
            .status()
            .unwrap();
        std::process::Command::new("git")
            .args([
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test User",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(temp.path())
            .status()
            .unwrap();

        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let enter = EnterWorktreeTool;
        enter
            .call(serde_json::json!({ "name": "feature-test" }), &ctx)
            .await
            .unwrap();

        let active = ctx.state.active_worktree().unwrap();
        assert!(active.created_by_session);
        assert_eq!(
            active.worktree_branch.as_deref(),
            Some("worktree-feature-test")
        );
        assert!(ctx.state.cwd().ends_with(".kcoder/worktrees/feature-test"));

        let exit = ExitWorktreeTool;
        exit.call(serde_json::json!({ "action": "keep" }), &ctx)
            .await
            .unwrap();
        assert!(ctx.state.active_worktree().is_none());
        assert_eq!(ctx.state.cwd(), temp.path());
    }

    #[tokio::test]
    async fn exit_worktree_refuses_to_remove_path_entered_worktree() {
        let ctx = ToolContext::new(kcoder_state::AppState::new("/repo"));
        ctx.state.enter_worktree_session(
            "/repo",
            "/repo/.kcoder/worktrees/manual",
            "manual",
            None,
            None,
            false,
        );
        let tool = ExitWorktreeTool;
        let err = tool
            .call(
                serde_json::json!({ "action": "remove", "discard_changes": true }),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("explicit path"));
    }

    #[tokio::test]
    async fn agent_isolation_worktree_creates_then_resumes_same_path() {
        if which::which("git").is_err() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(temp.path())
            .status()
            .unwrap();
        std::fs::write(temp.path().join("README.md"), "hello\n").unwrap();
        std::process::Command::new("git")
            .args(["add", "README.md"])
            .current_dir(temp.path())
            .status()
            .unwrap();
        std::process::Command::new("git")
            .args([
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test User",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(temp.path())
            .status()
            .unwrap();

        let (path, branch) = create_agent_isolation_worktree(temp.path(), "job-42")
            .await
            .unwrap();
        assert!(path.ends_with(".kcoder/worktrees/job-42"));
        assert_eq!(branch, "worktree-job-42");
        assert!(path.join(".git").exists());
        assert!(path.join("README.md").exists());

        // A second call for the same agent resumes instead of failing.
        let (resumed_path, resumed_branch) = create_agent_isolation_worktree(temp.path(), "job-42")
            .await
            .unwrap();
        assert_eq!(resumed_path, path);
        assert_eq!(resumed_branch, branch);
    }
}
