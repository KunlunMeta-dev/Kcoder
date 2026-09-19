use crate::background::{
    ForegroundWaitOutcome, ManagedForegroundJob, wait_for_foreground_completion,
    wait_with_foreground_budget,
};
use crate::process::{
    LiveOutputCapture, OutputLimits, OutputStream, background_started_output,
    background_started_output_after_foreground_budget, configure_isolated_process_environment,
    format_process_output, join_output_pipe, read_output_pipe, redact_command_for_log,
};
use crate::{
    Tool, ToolContext, ToolDescriptionContext, ToolError, ToolOutput, ToolPermissionMode,
    parse_input,
};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::process::Command;
use tokio::time::{Duration, timeout};
use tracing::debug;

/// Execute a PowerShell command on Windows.
#[derive(Debug, Default)]
pub struct PowerShellTool;

const DEFAULT_TIMEOUT_MS: u64 = 300_000;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PowerShellInput {
    /// PowerShell command/script to execute in the current working directory.
    /// Pass exactly the command text, not a JSON-encoded command.
    pub command: String,
    /// Short human-readable description of the command's purpose, used in
    /// logs and background task summaries. Omit only when the command is
    /// already self-explanatory.
    pub description: Option<String>,
    /// Timeout in milliseconds. Use a JSON integer. Defaults to 300 seconds
    /// unless the engine injects a session-specific default.
    #[serde(default = "default_timeout_ms")]
    pub timeout: u64,
    /// JSON boolean controlling background task execution.
    ///
    /// Set true only for long-running commands where useful non-overlapping
    /// work can continue before checking with TaskOutput. Do not add shell
    /// wrappers like Start-Job unless explicitly needed.
    #[serde(default)]
    pub run_in_background: Option<bool>,
}

fn default_timeout_ms() -> u64 {
    timeout_from_env("BASH_DEFAULT_TIMEOUT_MS").unwrap_or(DEFAULT_TIMEOUT_MS)
}

fn timeout_from_env(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn detect_powershell() -> Option<&'static str> {
    if cfg!(windows) {
        Some("powershell")
    } else {
        None
    }
}

#[async_trait]
impl Tool for PowerShellTool {
    fn name(&self) -> String {
        "PowerShell".to_string()
    }

    fn description(&self) -> String {
        "Run a PowerShell command in the current working directory. \
         This Windows shell tool is exposed only on Windows by the default tool registry. \
         Use this for terminal operations such as build, test, git, package managers, Docker, or PowerShell cmdlets. \
         Prefer dedicated tools for file search (`glob`), content search (`grep`), reading (`read`), editing (`edit`), \
         and writing (`write`) because those tools provide better review and permission behavior. \
         Do not prefix commands with `cd` or `Set-Location`; the working directory is already the KCoder session directory. \
         Foreground commands are registered with the task manager and keep the same task ID if they exceed the configured foreground budget and move to background delivery. \
         For known long-running commands, set `run_in_background` instead of using `Start-Job` or polling with `Start-Sleep`."
            .to_string()
    }

    async fn description_for_model(
        &self,
        _input: Option<&Value>,
        ctx: &ToolDescriptionContext,
    ) -> String {
        let mut description = self.description();
        if matches!(
            ctx.permission_mode,
            ToolPermissionMode::Bypass | ToolPermissionMode::Yolo
        ) {
            description.push_str(
                " Current permission mode bypasses normal approval prompts; inspect commands carefully before using this tool.",
            );
        }
        if ctx.is_non_interactive {
            description.push_str(
                " This is a non-interactive/headless session; commands must not wait for terminal input, editors, pagers, or prompts.",
            );
        }
        description
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(PowerShellInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }

        let input: PowerShellInput = parse_input(&input)?;
        if ctx.block_dependency_mutation && crate::bash::dependency_mutation_command(&input.command)
        {
            return Ok(ToolOutput::error(
                "Goal Pro verifier dependency guard is active. Installing, uninstalling, updating, or creating dependency environments is forbidden because it can mutate shared task state. Run the target tests with the task's existing environment; if required dependencies are unavailable, return FLAKY instead of changing the environment.",
            ));
        }
        if let Some(reason) = crate::bash::verifier_test_command_rejection(
            &input.command,
            ctx.verifier_minimum_test_scope,
            ctx.verifier_require_raw_exit_code,
        ) {
            return Ok(ToolOutput::error(reason));
        }
        let unrestricted_implementer_scope =
            !ctx.block_shell_file_mutation && ctx.allowed_write_scope_covers_filesystem_root();
        let explicitly_delegated_shell = !ctx.block_shell_file_mutation
            && crate::bash::scoped_shell_command_matches_allowed_prefixes(
                &input.command,
                &ctx.allowed_shell_prefixes,
            );
        if (ctx.block_shell_file_mutation || !ctx.allowed_write_paths.is_empty())
            && !unrestricted_implementer_scope
            && !explicitly_delegated_shell
            && !scoped_powershell_command_is_read_only(&input.command)
        {
            let scope = if ctx.allowed_write_paths.is_empty() {
                "no file write scope".to_string()
            } else {
                format!(
                    "allowed_write_paths [{}]",
                    ctx.allowed_write_paths.join(", ")
                )
            };
            return Ok(ToolOutput::error(format!(
                "Arrangement shell mutation guard is active for this sub-agent ({scope}). \
                 Only conservatively recognized inspection commands are allowed. Tests, builds, \
                 scripts, redirects, .NET calls, and unknown commands are blocked because they can \
                 write outside the declared paths. Use the `write` or `edit` tool for authorized \
                 source changes and delegate executable validation to an unscoped verifier.",
            )));
        }

        if let Some(sandbox) = &ctx.sandbox {
            sandbox
                .check_shell()
                .map_err(|reason| ToolError::SandboxDenied {
                    reason,
                    output: None,
                })?;
        }
        let cwd = ctx.state.cwd();

        let shell = detect_powershell().ok_or_else(|| {
            ToolError::Execution(
                "PowerShell tool is only available on Windows in the default platform tool set."
                    .to_string(),
            )
        })?;

        let command_for_log = redact_command_for_log(&input.command);
        if let Some(desc) = &input.description {
            debug!(
                "powershell: {} ({})",
                redact_command_for_log(desc),
                command_for_log
            );
        } else {
            debug!("powershell: {}", command_for_log);
        }

        let limits = OutputLimits::from_context(ctx);
        let os_sandbox = ctx.sandbox.as_ref().and_then(|sandbox| sandbox.os_spec());
        let isolation_root = ctx.shell_isolation_root.clone();
        let isolation_workspace_root = ctx
            .shell_isolation_root
            .as_ref()
            .and(ctx.sandbox.as_ref())
            .map(|sandbox| sandbox.workspace_root().to_path_buf());

        if input.run_in_background.unwrap_or(false) {
            let result_cwd = cwd.clone();
            let live_output = LiveOutputCapture::new(limits.clone());
            let run_live_output = live_output.clone();
            let description = crate::background::tool_background_description(
                "PowerShell",
                input.description.as_deref().unwrap_or(&input.command),
            );
            let command = input.command.clone();
            let timeout_ms = input.timeout;
            let shell = shell.to_string();
            let task_id = ctx.spawn_background(description, async move {
                match run_powershell_command(
                    shell,
                    command,
                    cwd,
                    timeout_ms,
                    limits,
                    PowerShellRunPolicy {
                        live_output: Some(run_live_output),
                        os_sandbox,
                        isolation_root,
                        isolation_workspace_root,
                    },
                )
                .await
                {
                    Ok(output) => output,
                    Err(err) => ToolOutput::error(err.to_string()),
                }
            })?;
            attach_managed_output(ctx, &task_id, &live_output).await;

            return Ok(background_started_output(
                "PowerShell",
                &task_id,
                &input.command,
                input.timeout,
                &result_cwd,
            ));
        }

        if ctx.background_job_manager.is_none() {
            return run_powershell_command(
                shell.to_string(),
                input.command,
                cwd,
                input.timeout,
                limits,
                PowerShellRunPolicy {
                    live_output: None,
                    os_sandbox,
                    isolation_root,
                    isolation_workspace_root,
                },
            )
            .await;
        }

        let foreground_budget_ms = ctx
            .foreground_budget_ms_for("PowerShell")
            .min(input.timeout);
        let events = ctx.subscribe_background_jobs()?;
        let description = crate::background::tool_background_description(
            "PowerShell",
            input.description.as_deref().unwrap_or(&input.command),
        );
        let command = input.command.clone();
        let display_command = input.command.clone();
        let result_cwd = cwd.clone();
        let shell = shell.to_string();
        let timeout_ms = input.timeout;
        let live_output = LiveOutputCapture::new(limits.clone());
        let run_live_output = live_output.clone();
        let task_id = ctx.spawn_foreground(description, async move {
            match run_powershell_command(
                shell,
                command,
                cwd,
                timeout_ms,
                limits,
                PowerShellRunPolicy {
                    live_output: Some(run_live_output),
                    os_sandbox,
                    isolation_root,
                    isolation_workspace_root,
                },
            )
            .await
            {
                Ok(output) => output,
                Err(error) => ToolOutput::error(error.to_string()),
            }
        })?;
        attach_managed_output(ctx, &task_id, &live_output).await;
        let guard = ManagedForegroundJob::new(ctx, task_id.clone())?;
        let outcome = if foreground_budget_ms >= input.timeout {
            wait_for_foreground_completion(ctx, &task_id, events).await?
        } else {
            wait_with_foreground_budget(
                ctx,
                &task_id,
                events,
                Duration::from_millis(foreground_budget_ms),
            )
            .await?
        };
        match outcome {
            ForegroundWaitOutcome::Completed(output) => {
                guard.complete();
                Ok(output)
            }
            ForegroundWaitOutcome::TimedOut => {
                guard.promote_to_background()?;
                Ok(background_started_output_after_foreground_budget(
                    "PowerShell",
                    &task_id,
                    &display_command,
                    input.timeout,
                    foreground_budget_ms,
                    &result_cwd,
                ))
            }
        }
    }
}

struct PowerShellRunPolicy {
    live_output: Option<LiveOutputCapture>,
    os_sandbox: Option<crate::os_sandbox::OsSandboxSpec>,
    isolation_root: Option<PathBuf>,
    isolation_workspace_root: Option<PathBuf>,
}

async fn run_powershell_command(
    shell: String,
    command: String,
    cwd: PathBuf,
    timeout_ms: u64,
    limits: OutputLimits,
    policy: PowerShellRunPolicy,
) -> Result<ToolOutput, ToolError> {
    let PowerShellRunPolicy {
        live_output,
        os_sandbox,
        isolation_root,
        isolation_workspace_root,
    } = policy;
    #[cfg(not(windows))]
    let _ = &os_sandbox;
    let args = powershell_invocation_args(&command);
    let isolation_environment = isolation_root
        .as_deref()
        .map(|root| {
            crate::bash::verifier_isolation_environment(root, isolation_workspace_root.as_deref())
        })
        .transpose()?;
    #[cfg(windows)]
    let (mut child, stdout_reader, stderr_reader) = if let Some(spec) = os_sandbox {
        let mut environment = crate::process::isolated_process_environment(&cwd);
        environment.push(("SHELL".into(), shell.clone().into()));
        if let Some(isolation_environment) = &isolation_environment {
            environment.extend(isolation_environment.iter().cloned());
        }
        let mut child = crate::windows_sandbox::spawn(
            std::ffi::OsStr::new(&shell),
            &args.iter().map(Into::into).collect::<Vec<_>>(),
            &cwd,
            &environment,
            &spec,
        )
        .map_err(|reason| ToolError::SandboxDenied {
            reason,
            output: None,
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ToolError::Execution("failed to capture sandboxed PowerShell stdout".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ToolError::Execution("failed to capture sandboxed PowerShell stderr".to_string())
        })?;
        let stdout_reader = tokio::spawn(read_output_pipe(
            stdout,
            limits.clone(),
            live_output
                .clone()
                .map(|capture| (capture, OutputStream::Stdout)),
        ));
        let stderr_reader = tokio::spawn(read_output_pipe(
            stderr,
            limits.clone(),
            live_output
                .clone()
                .map(|capture| (capture, OutputStream::Stderr)),
        ));
        (
            PowerShellChild::Windows(child),
            stdout_reader,
            stderr_reader,
        )
    } else {
        spawn_regular_powershell(
            &shell,
            &args,
            &cwd,
            &limits,
            live_output.clone(),
            isolation_environment.as_deref(),
        )?
    };
    #[cfg(not(windows))]
    let (mut child, stdout_reader, stderr_reader) = spawn_regular_powershell(
        &shell,
        &args,
        &cwd,
        &limits,
        live_output.clone(),
        isolation_environment.as_deref(),
    )?;
    #[cfg(windows)]
    let process_tree = (!child.uses_native_job())
        .then(|| child.id())
        .flatten()
        .map(WindowsProcessTreeTerminator::new);

    let duration = Duration::from_millis(timeout_ms);
    let result = timeout(duration, child.wait()).await;

    match result {
        Ok(Ok(status)) => {
            #[cfg(windows)]
            if let Some(process_tree) = &process_tree {
                process_tree.disarm();
            }
            #[cfg(windows)]
            if child.uses_native_job() {
                // A background descendant can keep inherited pipes open after
                // the root exits. End the Job before collecting output.
                let _ = child.start_kill();
            }
            let stdout = join_output_pipe(Some(stdout_reader), "stdout").await?;
            let stderr = join_output_pipe(Some(stderr_reader), "stderr").await?;
            let body = format_process_output(&stdout, &stderr, &limits);
            let exit_code = status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "null".to_string());
            let text = limits.truncate(&format!(
                "exit_code: {exit_code}\nworkdir: {}\nworkdir_scope: invocation_only\n{body}",
                cwd.display()
            ));
            Ok(ToolOutput {
                content: vec![kcoder_types::ContentBlock::Text { text }],
                is_error: !status.success(),
                execution_metadata: vec![crate::ToolExecutionMetadata::Process {
                    exit_code: status.code(),
                    signal: None,
                    cwd: cwd.clone(),
                }],
                user_context: Vec::new(),
            })
        }
        Ok(Err(e)) => Err(ToolError::Execution(format!(
            "failed to run PowerShell command: {e}"
        ))),
        Err(_) => {
            let _ = child.start_kill();
            #[cfg(windows)]
            if let Some(process_tree) = &process_tree {
                process_tree.terminate();
            }
            let _ = child.wait().await;
            let _ = join_output_pipe(Some(stdout_reader), "stdout").await;
            let _ = join_output_pipe(Some(stderr_reader), "stderr").await;
            Err(ToolError::Execution(format!(
                "PowerShell command timed out after {timeout_ms} ms"
            )))
        }
    }
}

enum PowerShellChild {
    Tokio(tokio::process::Child),
    #[cfg(windows)]
    Windows(crate::windows_sandbox::WindowsSandboxChild),
}

type SpawnedPowerShell = (
    PowerShellChild,
    tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
    tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
);

impl PowerShellChild {
    #[cfg(windows)]
    fn id(&self) -> Option<u32> {
        match self {
            Self::Tokio(child) => child.id(),
            Self::Windows(child) => Some(child.pid),
        }
    }

    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        match self {
            Self::Tokio(child) => child.wait().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait().await,
        }
    }

    fn start_kill(&mut self) -> std::io::Result<()> {
        match self {
            Self::Tokio(child) => child.start_kill(),
            #[cfg(windows)]
            Self::Windows(child) => {
                child.terminate();
                Ok(())
            }
        }
    }

    #[cfg(windows)]
    fn uses_native_job(&self) -> bool {
        matches!(self, Self::Windows(_))
    }
}

fn spawn_regular_powershell(
    shell: &str,
    args: &[String],
    cwd: &std::path::Path,
    limits: &OutputLimits,
    live_output: Option<LiveOutputCapture>,
    isolation_environment: Option<&[(std::ffi::OsString, std::ffi::OsString)]>,
) -> Result<SpawnedPowerShell, ToolError> {
    let mut command_builder = Command::new(shell);
    command_builder.args(args);
    configure_isolated_process_environment(&mut command_builder, cwd);
    if let Some(environment) = isolation_environment {
        command_builder.envs(environment.iter().cloned());
    }
    let mut child = command_builder
        .env("SHELL", shell)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| ToolError::Execution(format!("failed to spawn PowerShell: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ToolError::Execution("failed to capture PowerShell stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ToolError::Execution("failed to capture PowerShell stderr".to_string()))?;
    let stdout_reader = tokio::spawn(read_output_pipe(
        stdout,
        limits.clone(),
        live_output
            .clone()
            .map(|capture| (capture, OutputStream::Stdout)),
    ));
    let stderr_reader = tokio::spawn(read_output_pipe(
        stderr,
        limits.clone(),
        live_output.map(|capture| (capture, OutputStream::Stderr)),
    ));
    Ok((PowerShellChild::Tokio(child), stdout_reader, stderr_reader))
}

fn powershell_invocation_args(command: &str) -> Vec<String> {
    // Windows PowerShell 5.1 falls back to the active OEM code page when its
    // stdout is redirected to a pipe. Force a BOM-less UTF-8 console encoding
    // so captured tool output preserves the same Unicode text as Unix shells.
    // Keep the user's command in a script block so leading `param(...)` and
    // other script-level constructs remain valid after the preamble.
    let command = format!(
        "$KCoderUtf8 = [System.Text.UTF8Encoding]::new($false); \
         [Console]::OutputEncoding = $KCoderUtf8; \
         $OutputEncoding = $KCoderUtf8; & {{ {command}\n}}"
    );
    vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        command,
    ]
}

#[cfg(windows)]
struct WindowsProcessTreeTerminator {
    pid: u32,
    finished: AtomicBool,
}

#[cfg(windows)]
impl WindowsProcessTreeTerminator {
    fn new(pid: u32) -> Self {
        Self {
            pid,
            finished: AtomicBool::new(false),
        }
    }

    fn terminate(&self) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &self.pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    fn disarm(&self) {
        self.finished.store(true, Ordering::SeqCst);
    }
}

#[cfg(windows)]
impl Drop for WindowsProcessTreeTerminator {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn attach_managed_output(ctx: &ToolContext, task_id: &str, capture: &LiveOutputCapture) {
    if let Some(path) = ctx.state.task(task_id).and_then(|task| task.output_path) {
        capture.attach(path).await;
    }
}

fn scoped_powershell_command_is_read_only(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    if lower.trim().is_empty() {
        return true;
    }
    if lower.contains('>')
        || lower.contains("$(")
        || lower.contains("::")
        || lower.contains("[scriptblock]")
        || lower.contains("invoke-expression")
        || lower.contains("iex ")
        || lower.contains("-file ")
        || lower.contains("& ")
    {
        return false;
    }
    lower
        .replace("&&", ";")
        .replace("||", ";")
        .split([';', '\n', '|'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .all(scoped_powershell_segment_is_read_only)
}

fn scoped_powershell_segment_is_read_only(segment: &str) -> bool {
    let tokens = powershell_tokens(segment);
    let Some(command) = tokens.first() else {
        return true;
    };
    matches!(
        command.as_str(),
        "get-content"
            | "gc"
            | "type"
            | "get-childitem"
            | "gci"
            | "dir"
            | "ls"
            | "get-item"
            | "gi"
            | "get-location"
            | "pwd"
            | "test-path"
            | "select-string"
            | "measure-object"
            | "sort-object"
            | "format-list"
            | "format-table"
            | "out-string"
            | "write-output"
            | "echo"
    )
}

fn powershell_tokens(command: &str) -> Vec<String> {
    command
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|c: char| {
                    matches!(
                        c,
                        '(' | ')' | '{' | '}' | '[' | ']' | '"' | '\'' | '`' | ','
                    )
                })
                .to_ascii_lowercase()
        })
        .filter(|token| !token.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_fallback_timeout_is_five_minutes() {
        assert_eq!(DEFAULT_TIMEOUT_MS, 300_000);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_preserves_standard_windows_profile_environment() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(tmp.path()));
        let output = PowerShellTool
            .call(
                serde_json::json!({
                    "command": "if ([string]::IsNullOrEmpty($env:APPDATA) -or [string]::IsNullOrEmpty($env:ProgramData) -or [string]::IsNullOrEmpty($env:PSModulePath)) { throw 'missing standard Windows environment' }; Write-Output 'WINDOWS_ENV_OK'"
                }),
                &ctx,
            )
            .await
            .unwrap();
        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();

        assert!(!output.is_error, "{text}");
        assert!(text.contains("WINDOWS_ENV_OK"), "{text}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_uses_native_windows_sandbox() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let allowed = tempfile::Builder::new()
            .prefix("kcoder-sandbox-allowed-")
            .tempdir_in(dirs::home_dir().unwrap())
            .unwrap();
        let outside = tempfile::Builder::new()
            .prefix("kcoder-sandbox-outside-")
            .tempdir_in(dirs::home_dir().unwrap())
            .unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let inside = workspace.join("inside.txt");
        let escaped = outside.path().join("escaped.txt");
        let allowed_file = allowed.path().join("allowed.txt");
        let sandbox = std::sync::Arc::new(crate::Sandbox::new(
            &workspace,
            kcoder_types::SandboxConfig {
                enabled: true,
                allowed_paths: vec![allowed.path().display().to_string()],
                ..Default::default()
            },
        ));
        let ctx = ToolContext::new(kcoder_state::AppState::new(&workspace)).with_sandbox(sandbox);
        let command = format!(
            "$ErrorActionPreference='Continue'; Set-Content -LiteralPath '{}' -Value inside; Set-Content -LiteralPath '{}' -Value allowed; & cmd.exe /d /s /c 'echo escaped>\"{}\"'",
            inside.display(),
            allowed_file.display(),
            escaped.display()
        );

        let output = PowerShellTool
            .call(serde_json::json!({ "command": command }), &ctx)
            .await
            .expect("PowerShell sandbox should start");

        assert!(
            inside.exists(),
            "PowerShell should write inside the workspace: {output:?}"
        );
        assert!(
            allowed_file.exists(),
            "PowerShell should write to an explicit allowed path: {output:?}"
        );
        let escaped_exists = escaped.exists();
        let _ = std::fs::remove_file(&escaped);
        assert!(
            !escaped_exists,
            "a PowerShell child process must not write outside the workspace: {output:?}"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn native_windows_job_closes_pipes_left_open_by_background_descendant() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let marker = workspace.join("powershell-descendant-survived.txt");
        let script = workspace.join("powershell-descendant.ps1");
        std::fs::write(
            &script,
            format!(
                "Start-Sleep -Milliseconds 1500; Set-Content -LiteralPath '{}' -Value survived",
                marker.display()
            ),
        )
        .unwrap();
        let sandbox = std::sync::Arc::new(crate::Sandbox::new(
            &workspace,
            kcoder_types::SandboxConfig {
                enabled: true,
                ..Default::default()
            },
        ));
        let ctx = ToolContext::new(kcoder_state::AppState::new(&workspace)).with_sandbox(sandbox);
        let command = format!(
            "Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-File','{}')",
            script.display()
        );

        let result = tokio::time::timeout(
            Duration::from_secs(5),
            PowerShellTool.call(serde_json::json!({ "command": command }), &ctx),
        )
        .await;
        assert!(result.is_ok(), "output pipe remained open after root exit");
        assert!(result.unwrap().is_ok());
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(!marker.exists(), "background descendant escaped its Job");
    }

    #[test]
    fn scoped_powershell_policy_is_fail_closed() {
        assert!(scoped_powershell_command_is_read_only(
            "Get-ChildItem src | Select-String needle"
        ));
        assert!(!scoped_powershell_command_is_read_only("dotnet test"));
        assert!(!scoped_powershell_command_is_read_only(
            "[System.IO.File]::WriteAllText('x', 'y')"
        ));
        assert!(!scoped_powershell_command_is_read_only(
            "Get-Content x > copied.txt"
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn powershell_business_denial_text_remains_an_ordinary_process_failure() {
        use std::os::unix::fs::PermissionsExt;

        for stream in ["", " >&2"] {
            let temp = tempfile::tempdir().unwrap();
            let fake_powershell = temp.path().join("fake-powershell");
            let staged_powershell = temp.path().join("fake-powershell.staged");
            std::fs::write(
                &staged_powershell,
                format!(
                    "#!/bin/sh\nprintf '%s\\n' 'Access Denied.' 'Permission denied by remote API.'{stream}\nexit 23\n"
                ),
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&staged_powershell).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&staged_powershell, permissions).unwrap();
            std::fs::rename(staged_powershell, &fake_powershell).unwrap();

            let output = run_powershell_command(
                fake_powershell.display().to_string(),
                "ignored".to_string(),
                temp.path().to_path_buf(),
                10_000,
                OutputLimits::from_context(&ToolContext::new(kcoder_state::AppState::new(
                    temp.path(),
                ))),
                PowerShellRunPolicy {
                    live_output: None,
                    os_sandbox: None,
                    isolation_root: None,
                    isolation_workspace_root: None,
                },
            )
            .await
            .expect("目标程序的普通拒绝文本不能被识别成沙箱拒绝");
            let text = output
                .content
                .iter()
                .filter_map(|block| match block {
                    kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>();

            assert!(output.is_error, "{text}");
            assert!(text.starts_with("exit_code: 23\n"), "{text}");
            assert!(text.contains("Access Denied."), "{text}");
            assert!(text.contains("Permission denied by remote API."), "{text}");
        }
    }

    #[tokio::test]
    async fn powershell_explicit_sandbox_policy_denial_remains_structured() {
        let temp = tempfile::tempdir().unwrap();
        let sandbox = std::sync::Arc::new(crate::Sandbox::new(
            temp.path(),
            kcoder_types::SandboxConfig {
                enabled: true,
                readonly: true,
                ..Default::default()
            },
        ));
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path())).with_sandbox(sandbox);

        let result = PowerShellTool
            .call(
                serde_json::json!({ "command": "Write-Output ignored" }),
                &ctx,
            )
            .await;

        match result {
            Err(ToolError::SandboxDenied { reason, output }) => {
                assert!(reason.contains("read-only"), "{reason}");
                assert!(output.is_none());
            }
            other => panic!("显式沙箱策略拒绝应保持结构化错误: {other:?}"),
        }
    }

    #[test]
    fn powershell_background_schema_is_not_ignored() {
        let tool = PowerShellTool;
        let schema = tool.input_schema();
        let background = schema
            .get("properties")
            .unwrap()
            .get("run_in_background")
            .unwrap();
        let description = background
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        assert!(description.contains("background task"));
        assert!(!description.contains("ignored"));
    }

    #[test]
    fn powershell_schema_keeps_timeout_as_plain_integer() {
        let tool = PowerShellTool;
        let schema = tool.input_schema();
        let timeout = &schema["properties"]["timeout"];
        assert_eq!(timeout["type"], serde_json::json!("integer"));
        assert!(timeout.get("maximum").is_none());
    }

    #[test]
    fn powershell_invocation_disables_profiles_and_interactive_prompts() {
        let args = powershell_invocation_args("Get-Content Cargo.toml");
        assert_eq!(&args[..3], ["-NoProfile", "-NonInteractive", "-Command"]);
        assert!(args[3].contains("& { Get-Content Cargo.toml\n}"));
    }

    #[test]
    fn powershell_invocation_forces_utf8_for_redirected_unicode_output() {
        let args = powershell_invocation_args("Write-Output '\u{6606}\u{4ed1}'");

        assert!(args[3].contains("[Console]::OutputEncoding"));
        assert!(args[3].contains("[System.Text.UTF8Encoding]"));
        assert!(args[3].contains("$OutputEncoding"));
        assert!(args[3].contains("& { Write-Output '\u{6606}\u{4ed1}'\n}"));
    }
}
