use crate::background::{
    ForegroundWaitOutcome, ManagedForegroundJob, wait_for_foreground_completion,
    wait_with_foreground_budget,
};
#[cfg(windows)]
use crate::process::isolated_process_environment;
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
use kcoder_config::GoalProTestScope;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
#[cfg(target_os = "linux")]
use std::sync::atomic::AtomicU64;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, timeout};
use tracing::debug;

/// Execute a Unix-like shell command in the workspace directory.
#[derive(Debug, Default)]
pub struct BashTool;

const DEFAULT_TIMEOUT_MS: u64 = 300_000;
#[cfg(target_os = "linux")]
const PROCESS_SCOPE_ENV: &str = "KCODER_PROCESS_SCOPE";
#[cfg(target_os = "linux")]
static NEXT_PROCESS_SCOPE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BashInput {
    /// Shell command or script executed in the current working directory. Pass raw
    /// command text without additional JSON encoding. Prefer specialized file tools
    /// when attached; otherwise keep shell inspection bounded and permission-scoped.
    pub command: String,
    /// Optional invocation directory. Relative paths resolve from the session
    /// directory and are checked by the active sandbox before execution.
    pub workdir: Option<PathBuf>,
    /// Short human-readable description of the command's purpose, used in
    /// logs and background task summaries. Omit only when the command is
    /// already self-explanatory.
    pub description: Option<String>,
    /// Total command lifetime in milliseconds. Use a JSON integer. Defaults to 300 seconds
    /// unless the engine injects a session-specific default.
    #[serde(default = "default_timeout_ms")]
    pub timeout: u64,
    /// JSON boolean controlling background execution.
    ///
    /// Persistent servers, watchers, and other commands that must survive the
    /// Bash response must set this to true and use an explicit total lifetime.
    /// Keep the command in foreground form; never add `&`, `nohup`, `setsid`,
    /// or `disown` wrappers.
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

#[async_trait]
impl Tool for BashTool {
    fn ui_metadata(&self) -> kcoder_types::tool_ui::ToolUiMetadata {
        use kcoder_types::tool_ui::{ToolUiGroup, ToolUiIcon, ToolUiMetadata};
        ToolUiMetadata {
            display_name: "Run command".into(),
            group: ToolUiGroup::Terminal,
            icon: ToolUiIcon::Terminal,
            description: self.description(),
        }
        .bounded(&self.name())
    }

    fn name(&self) -> String {
        "bash".to_string()
    }

    fn description(&self) -> String {
        "Run a Unix-like shell command in the current session directory. \
         This shell tool uses the system shell on Unix-like platforms and Git Bash on Windows. \
         Use this for terminal operations such as build, test, git, package managers, or project-specific CLIs. \
         Prefer specialized file tools when they are attached to this request; otherwise use bounded shell inspection and honor workspace exclusions. \
         Each bash call starts from the session directory; `cd` only affects that one command and does not persist. \
         Do not prefix commands with `cd` just to reach the session directory. \
         When inspecting a child repository or another directory, use absolute paths or include `cd path && ...` in the same command. \
         Prefer command-native output limits such as `sed -n` for terminal output; large producers piped into `head` can be truncated by SIGPIPE under pipefail. \
         Foreground commands are registered with the task manager and keep the same task ID if they exceed the configured foreground budget and move to background delivery. \
         Persistent servers and watchers must use foreground-form commands with `run_in_background=true` and an explicit total lifetime timeout. \
         Never append `&` or wrap them with `nohup`, `setsid`, or `disown`: Bash completion cleans every descendant in this invocation scope."
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
                " Current permission mode bypasses normal approval prompts, including the runtime sandbox-escalation approval path. Explicit deny rules still apply. This mode is not a confinement guarantee; execute only work authorized by the user.",
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
        crate::clean_schema(schemars::schema_for!(BashInput))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }

        let input: BashInput = parse_input(&input)?;
        let session_cwd = ctx.state.cwd();
        let mut cwd = input
            .workdir
            .as_deref()
            .map(|path| {
                if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    session_cwd.join(path)
                }
            })
            .unwrap_or_else(|| session_cwd.clone());
        if ctx.verifier_baseline_root.is_some() {
            cwd = dunce::canonicalize(&cwd).map_err(|error| {
                ToolError::Execution(format!(
                    "failed to resolve Goal Pro verifier workdir `{}`: {error}",
                    cwd.display()
                ))
            })?;
            if let Some(reason) = verifier_workdir_command_rejection(&input.command) {
                return Ok(ToolOutput::error(reason));
            }
        }
        let verifier_roots = if let Some(baseline) = ctx.verifier_baseline_root.as_deref() {
            let sandbox = ctx.sandbox.as_ref().ok_or_else(|| {
                ToolError::Execution(
                    "Goal Pro verifier execution requires an active sandbox".to_string(),
                )
            })?;
            let candidate = dunce::canonicalize(sandbox.workspace_root()).map_err(|error| {
                ToolError::Execution(format!(
                    "failed to resolve Goal Pro candidate root `{}`: {error}",
                    sandbox.workspace_root().display()
                ))
            })?;
            let baseline = dunce::canonicalize(baseline).map_err(|error| {
                ToolError::Execution(format!(
                    "failed to resolve Goal Pro baseline root `{}`: {error}",
                    baseline.display()
                ))
            })?;
            if !cwd.starts_with(&candidate) && !cwd.starts_with(&baseline) {
                return Ok(ToolOutput::error(
                    "Goal Pro verifier workdir guard rejected a directory outside the isolated candidate and pristine baseline repositories.",
                ));
            }
            Some((candidate, baseline))
        } else {
            None
        };
        if let Some(sandbox) = &ctx.sandbox
            && input.workdir.is_some()
            && let Err(reason) = sandbox.check_path(&cwd, false)
        {
            return Err(ToolError::SandboxDenied {
                reason,
                output: None,
            });
        }
        let verifier_native_build = ctx.verifier_baseline_root.is_some()
            && verifier_native_build_command_signature(&input.command).is_some();
        if let Some(reason) = verifier_native_build_execution_rejection(
            verifier_native_build,
            input.run_in_background.unwrap_or(false),
        ) {
            return Ok(ToolOutput::error(reason));
        }
        if let Some(reason) = verifier_baseline_command_rejection(
            &input.command,
            &cwd,
            ctx.verifier_baseline_root.as_deref(),
            ctx.verifier_require_behavior_delta,
        ) {
            return Ok(ToolOutput::error(reason));
        }
        if verifier_native_build {
            let (candidate, baseline) = verifier_roots.as_ref().ok_or_else(|| {
                ToolError::Execution("Goal Pro native build roots are unavailable".to_string())
            })?;
            if cwd != *candidate && cwd != *baseline {
                return Ok(ToolOutput::error(
                    "Goal Pro verifier native build guard rejected a subdirectory workdir. Run the typed setup.py recipe from the isolated repository root in both Candidate and Baseline.",
                ));
            }
            let setup = cwd.join("setup.py");
            let metadata = std::fs::symlink_metadata(&setup).map_err(|error| {
                ToolError::Execution(format!(
                    "Goal Pro verifier native build requires `{}` to exist: {error}",
                    setup.display()
                ))
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Ok(ToolOutput::error(
                    "Goal Pro verifier native build guard requires setup.py to be a regular non-symlink file at the isolated repository root.",
                ));
            }
        }
        if ctx.block_dependency_mutation && dependency_mutation_command(&input.command) {
            return Ok(ToolOutput::error(
                "Goal Pro verifier dependency guard is active. Installing, uninstalling, updating, or creating dependency environments is forbidden because it can mutate shared task state. Run the target tests with the task's existing environment; if required dependencies are unavailable, return FLAKY instead of changing the environment.",
            ));
        }
        if let Some(reason) = verifier_test_command_rejection(
            &input.command,
            ctx.verifier_minimum_test_scope,
            ctx.verifier_require_raw_exit_code,
        ) {
            return Ok(ToolOutput::error(reason));
        }
        let unrestricted_implementer_scope =
            !ctx.block_shell_file_mutation && ctx.allowed_write_scope_covers_filesystem_root();
        let explicitly_delegated_shell = !ctx.block_shell_file_mutation
            && scoped_shell_command_matches_allowed_prefixes(
                &input.command,
                &ctx.allowed_shell_prefixes,
            );
        if (ctx.block_shell_file_mutation || !ctx.allowed_write_paths.is_empty())
            && !unrestricted_implementer_scope
            && !explicitly_delegated_shell
            && !scoped_shell_command_is_read_only(&input.command)
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
                 interpreters, redirects, and unknown executables are blocked because they can write \
                 outside the declared paths. Use the `write` or `edit` tool for authorized source \
                 changes. For an external runtime, ask the main orchestrator to delegate a narrow \
                 allowed_shell_prefixes entry containing the exact container target; otherwise \
                 delegate executable validation to an unscoped verifier.",
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
        let command_for_log = redact_command_for_log(&input.command);
        if let Some(desc) = &input.description {
            debug!(
                "bash: {} ({})",
                redact_command_for_log(desc),
                command_for_log
            );
        } else {
            debug!("bash: {}", command_for_log);
        }

        let shell = default_bash_shell();
        let limits = OutputLimits::from_context(ctx);
        let runs_in_baseline = verifier_roots
            .as_ref()
            .is_some_and(|(_, baseline)| cwd.starts_with(baseline));
        let authenticated_workspace_root = verifier_roots.as_ref().map(|(candidate, baseline)| {
            if runs_in_baseline {
                baseline.as_path()
            } else {
                candidate.as_path()
            }
        });
        let verifier_runtime_namespace = match (
            ctx.shell_isolation_root.as_deref(),
            authenticated_workspace_root,
        ) {
            (Some(root), Some(workspace)) => {
                let namespace = verifier_isolation_workspace_directory(root, Some(workspace));
                std::fs::create_dir_all(&namespace).map_err(|error| {
                    ToolError::Execution(format!(
                        "failed to prepare Goal Pro verifier runtime namespace `{}`: {error}",
                        namespace.display()
                    ))
                })?;
                Some(namespace)
            }
            _ => None,
        };
        if verifier_roots.is_some() && verifier_runtime_namespace.is_none() {
            return Err(ToolError::Execution(
                "Goal Pro verifier source isolation requires a private runtime namespace"
                    .to_string(),
            ));
        }
        let os_sandbox = if let (Some((candidate, baseline)), Some(runtime)) =
            (verifier_roots.as_ref(), verifier_runtime_namespace.as_ref())
        {
            let writable_workspace = if runs_in_baseline {
                verifier_native_build.then_some(baseline.as_path())
            } else {
                verifier_native_build.then_some(candidate.as_path())
            };
            ctx.sandbox
                .as_ref()
                .expect("verifier roots require a sandbox")
                .os_spec_for_verifier_invocation(writable_workspace, runtime)
                .map_err(|reason| ToolError::SandboxDenied {
                    reason,
                    output: None,
                })?
        } else {
            ctx.sandbox.as_ref().and_then(|sandbox| sandbox.os_spec())
        };

        let snapshot_selection = select_shell_snapshot(
            ctx.shell_environment_snapshot.as_ref(),
            ctx.shell_isolation_root.is_some(),
            os_sandbox.as_ref(),
        )?;
        let snapshot_path = snapshot_selection.path;
        let snapshot_copy_root = if ctx.shell_isolation_root.is_none() {
            ordinary_shell_snapshot_copy_root(
                snapshot_selection.requires_private_copy,
                &cwd,
                os_sandbox.as_ref(),
                std::env::var_os("TMPDIR").as_deref(),
            )?
        } else {
            None
        };
        let running = RunningShell::spawn(
            shell,
            &input.command,
            cwd.clone(),
            input.timeout,
            limits.clone(),
            ShellSpawnPolicy {
                snapshot_path: snapshot_path.as_deref(),
                snapshot_copy_root: snapshot_copy_root.as_deref(),
                isolation_root: ctx.shell_isolation_root.as_deref(),
                isolation_workspace_root: authenticated_workspace_root,
                os_sandbox,
            },
        )?;
        let live_output = running.live_output_capture();

        if input.run_in_background.unwrap_or(false) {
            let task_id = spawn_running_shell_background(ctx, &input, running, limits.clone())?;
            attach_managed_output(ctx, &task_id, &live_output).await;

            return Ok(background_started_output(
                "bash",
                &task_id,
                &input.command,
                input.timeout,
                &cwd,
            ));
        }

        if ctx.background_job_manager.is_none() {
            return running.wait_for_output(&input.command, limits).await;
        }

        // A strict verifier requires the test process's own exit status. If a
        // target-suite command is silently promoted to a background job, the
        // verifier can exhaust its finite turns before collecting that status
        // and incorrectly report FLAKY. Keep these machine-gated tests in the
        // foreground for their explicitly requested lifetime; ordinary Bash
        // calls retain the configurable promotion budget.
        let foreground_budget_ms = if verifier_native_build
            || (ctx.verifier_minimum_test_scope.is_some() && test_like_command(&input.command))
        {
            input.timeout
        } else {
            ctx.foreground_budget_ms_for("bash").min(input.timeout)
        };
        let events = ctx.subscribe_background_jobs()?;
        let description = crate::background::tool_background_description(
            "bash",
            input.description.as_deref().unwrap_or(&input.command),
        );
        let command = input.command.clone();
        let cancel = running.cancel_callback();
        let task_id = ctx.spawn_cancellable_foreground(
            description,
            async move {
                match running.wait_for_output(&command, limits).await {
                    Ok(output) => output,
                    Err(error) => ToolOutput::error(error.to_string()),
                }
            },
            cancel,
        )?;
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
                    "bash",
                    &task_id,
                    &input.command,
                    input.timeout,
                    foreground_budget_ms,
                    &cwd,
                ))
            }
        }
    }
}

fn spawn_running_shell_background(
    ctx: &ToolContext,
    input: &BashInput,
    running: RunningShell,
    limits: OutputLimits,
) -> Result<String, ToolError> {
    let description = crate::background::tool_background_description(
        "bash",
        input.description.as_deref().unwrap_or(&input.command),
    );
    let command = input.command.clone();
    let cancel = running.cancel_callback();
    ctx.spawn_cancellable_background(
        description,
        async move {
            match running.wait_for_output(&command, limits).await {
                Ok(output) => output,
                Err(err) => ToolOutput::error(err.to_string()),
            }
        },
        cancel,
    )
}

async fn attach_managed_output(ctx: &ToolContext, task_id: &str, capture: &LiveOutputCapture) {
    if let Some(path) = ctx.state.task(task_id).and_then(|task| task.output_path) {
        capture.attach(path).await;
    }
}

#[cfg(test)]
async fn run_shell_command(
    shell: String,
    command: String,
    cwd: PathBuf,
    timeout_ms: u64,
    limits: OutputLimits,
) -> Result<ToolOutput, ToolError> {
    RunningShell::spawn(
        shell,
        &command,
        cwd,
        timeout_ms,
        limits.clone(),
        ShellSpawnPolicy::default(),
    )?
    .wait_for_output(&command, limits)
    .await
}

struct RunningShell {
    child: Option<ManagedChild>,
    stdout: Option<JoinHandle<std::io::Result<Vec<u8>>>>,
    stderr: Option<JoinHandle<std::io::Result<Vec<u8>>>>,
    terminator: Arc<ProcessGroupTerminator>,
    deadline: Instant,
    timeout_ms: u64,
    live_output: LiveOutputCapture,
    cwd: PathBuf,
    /// Keep a randomized temporary snapshot alive until the sandboxed child finishes sourcing it.
    _shell_snapshot: Option<tempfile::NamedTempFile>,
}

enum ShellWait {
    Exited(ExitStatus),
    TimedOut,
    StillRunning,
}

enum ManagedChild {
    Tokio(Child),
    #[cfg(windows)]
    Windows(crate::windows_sandbox::WindowsSandboxChild),
}

#[derive(Default)]
struct ShellSpawnPolicy<'a> {
    snapshot_path: Option<&'a Path>,
    /// Trusted temporary directory used by a regular sandboxed shell when deny_read covers the original snapshot.
    snapshot_copy_root: Option<&'a Path>,
    isolation_root: Option<&'a Path>,
    isolation_workspace_root: Option<&'a Path>,
    os_sandbox: Option<crate::os_sandbox::OsSandboxSpec>,
}

impl ManagedChild {
    async fn wait(&mut self) -> std::io::Result<ExitStatus> {
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
}

impl RunningShell {
    fn spawn(
        shell: String,
        command: &str,
        cwd: PathBuf,
        timeout_ms: u64,
        limits: OutputLimits,
        policy: ShellSpawnPolicy<'_>,
    ) -> Result<Self, ToolError> {
        let ShellSpawnPolicy {
            snapshot_path,
            snapshot_copy_root,
            isolation_root,
            isolation_workspace_root,
            os_sandbox,
        } = policy;
        let prepared_snapshot =
            shell_snapshot_for_spawn(snapshot_path, isolation_root.or(snapshot_copy_root))?;
        let snapshot_path = prepared_snapshot
            .as_ref()
            .map(|snapshot| snapshot.path.as_path());
        let invocation = shell_invocation(
            &shell,
            command,
            prepared_snapshot.is_some(),
            isolation_root.is_some(),
        );
        let isolation_environment = isolation_root
            .map(|root| verifier_isolation_environment(root, isolation_workspace_root))
            .transpose()?;
        let mut command_builder = Command::new(&invocation.program);
        command_builder
            .args(&invocation.args)
            .env("SHELL", &invocation.program)
            .env("PWD", &cwd)
            .env("TERM", "xterm-256color")
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        // Bash commands run in their own process group while KCoder remains
        // the controlling terminal's foreground group. If they inherit the
        // TTY, programs such as Vite that install stdin shortcuts receive
        // SIGTTIN as soon as they read, leaving a managed task present but
        // stopped. Tool calls are non-interactive, so EOF is the only safe
        // stdin contract, including commands later promoted to background.
        configure_isolated_process_environment(&mut command_builder, &cwd);
        if let Some(environment) = &isolation_environment {
            command_builder.envs(environment.iter().cloned());
        }
        command_builder.env("SHELL", &invocation.program);
        if let Some(path) = snapshot_path {
            command_builder.env("KCODER_SHELL_SNAPSHOT", path);
        }
        #[cfg(target_os = "linux")]
        let process_scope = {
            let scope = new_process_scope();
            command_builder.env(PROCESS_SCOPE_ENV, &scope);
            Some(scope)
        };
        #[cfg(not(target_os = "linux"))]
        let process_scope = None;
        #[cfg(unix)]
        {
            command_builder.process_group(0);
            if let Some(spec) = os_sandbox {
                // SAFETY: the hook only invokes Landlock syscalls (no locks,
                // no allocation-dependent library state) before exec.
                unsafe {
                    command_builder.pre_exec(move || {
                        crate::os_sandbox::apply(&spec).map_err(|reason| {
                            std::io::Error::new(std::io::ErrorKind::PermissionDenied, reason)
                        })
                    });
                }
            }
        }

        let live_output = LiveOutputCapture::new(limits.clone());

        #[cfg(windows)]
        if let Some(spec) = os_sandbox {
            let mut environment = isolated_process_environment(&cwd);
            if let Some(isolation_environment) = &isolation_environment {
                environment.extend(isolation_environment.iter().cloned());
            }
            environment.push(("SHELL".into(), invocation.program.clone().into()));
            environment.push(("PWD".into(), cwd.as_os_str().to_os_string()));
            environment.push(("TERM".into(), "xterm-256color".into()));
            if let Some(path) = snapshot_path {
                environment.push((
                    "KCODER_SHELL_SNAPSHOT".into(),
                    path.as_os_str().to_os_string(),
                ));
            }
            let mut child = crate::windows_sandbox::spawn(
                std::ffi::OsStr::new(&invocation.program),
                &invocation.args.iter().map(Into::into).collect::<Vec<_>>(),
                &cwd,
                &environment,
                &spec,
            )
            .map_err(|reason| ToolError::SandboxDenied {
                reason,
                output: None,
            })?;
            let pid = child.pid;
            let stdout = child.stdout.take().ok_or_else(|| {
                ToolError::Execution("failed to capture sandboxed shell stdout".to_string())
            })?;
            let stderr = child.stderr.take().ok_or_else(|| {
                ToolError::Execution("failed to capture sandboxed shell stderr".to_string())
            })?;
            let native_terminator = child.terminator();
            return Ok(Self {
                child: Some(ManagedChild::Windows(child)),
                stdout: Some(tokio::spawn(read_output_pipe(
                    stdout,
                    limits.clone(),
                    Some((live_output.clone(), OutputStream::Stdout)),
                ))),
                stderr: Some(tokio::spawn(read_output_pipe(
                    stderr,
                    limits.clone(),
                    Some((live_output.clone(), OutputStream::Stderr)),
                ))),
                terminator: Arc::new(ProcessGroupTerminator::new_windows(pid, native_terminator)),
                deadline: Instant::now() + Duration::from_millis(timeout_ms),
                timeout_ms,
                live_output,
                cwd,
                _shell_snapshot: prepared_snapshot.and_then(|snapshot| snapshot.temporary),
            });
        }

        let mut child = command_builder
            .spawn()
            .map_err(|e| ToolError::Execution(format!("failed to spawn shell: {e}")))?;
        let pid = child.id().ok_or_else(|| {
            ToolError::Execution("spawned shell did not expose a process id".to_string())
        })?;
        let terminator = Arc::new(ProcessGroupTerminator::new(pid, process_scope));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::Execution("failed to capture shell stdout".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::Execution("failed to capture shell stderr".to_string()))?;

        Ok(Self {
            child: Some(ManagedChild::Tokio(child)),
            stdout: Some(tokio::spawn(read_output_pipe(
                stdout,
                limits.clone(),
                Some((live_output.clone(), OutputStream::Stdout)),
            ))),
            stderr: Some(tokio::spawn(read_output_pipe(
                stderr,
                limits.clone(),
                Some((live_output.clone(), OutputStream::Stderr)),
            ))),
            terminator,
            deadline: Instant::now() + Duration::from_millis(timeout_ms),
            timeout_ms,
            live_output,
            cwd,
            _shell_snapshot: prepared_snapshot.and_then(|snapshot| snapshot.temporary),
        })
    }

    fn live_output_capture(&self) -> LiveOutputCapture {
        self.live_output.clone()
    }

    fn cancel_callback(&self) -> Arc<dyn Fn() + Send + Sync> {
        let terminator = Arc::clone(&self.terminator);
        Arc::new(move || terminator.terminate())
    }

    async fn wait_for(&mut self, foreground_wait: Duration) -> Result<ShellWait, ToolError> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            self.terminate_and_reap().await?;
            return Ok(ShellWait::TimedOut);
        }

        let wait_duration = foreground_wait.min(remaining);
        match self.wait_for_child_or_stop(wait_duration).await? {
            ChildWaitOutcome::Exited(status) => {
                self.child = None;
                // A raw background child can keep inherited pipes open after
                // the shell exits. End the process group so output collection
                // cannot outlive the command's lifecycle.
                self.terminator.terminate();
                Ok(ShellWait::Exited(status))
            }
            ChildWaitOutcome::Elapsed if foreground_wait >= remaining => {
                self.terminate_and_reap().await?;
                Ok(ShellWait::TimedOut)
            }
            ChildWaitOutcome::Elapsed => Ok(ShellWait::StillRunning),
            ChildWaitOutcome::Stopped => {
                let pid = self.terminator.pid;
                self.terminate_and_reap().await?;
                Err(ToolError::Execution(format!(
                    "command process group stopped (pid {pid}, Linux state T/t); this commonly means a background program attempted to read the controlling terminal (SIGTTIN). Managed background commands must use detached stdin"
                )))
            }
        }
    }

    async fn wait_for_child_or_stop(
        &mut self,
        wait_duration: Duration,
    ) -> Result<ChildWaitOutcome, ToolError> {
        let pid = self.terminator.pid;
        let observed = {
            let child = self.child_mut()?;
            tokio::select! {
                result = timeout(wait_duration, child.wait()) => Some(result),
                _ = wait_for_linux_process_stop(pid) => None,
            }
        };
        match observed {
            Some(Ok(Ok(status))) => Ok(ChildWaitOutcome::Exited(status)),
            Some(Ok(Err(error))) => Err(ToolError::Execution(format!(
                "failed to wait for command: {error}"
            ))),
            Some(Err(_)) => Ok(ChildWaitOutcome::Elapsed),
            None => Ok(ChildWaitOutcome::Stopped),
        }
    }

    async fn wait_for_output(
        mut self,
        command: &str,
        limits: OutputLimits,
    ) -> Result<ToolOutput, ToolError> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        match self.wait_for(remaining).await? {
            ShellWait::Exited(status) => finish_shell_command(self, status, command, limits).await,
            ShellWait::TimedOut => Err(command_timeout_error(self.timeout_ms)),
            ShellWait::StillRunning => {
                unreachable!("waiting for the remaining lifetime cannot background")
            }
        }
    }

    fn child_mut(&mut self) -> Result<&mut ManagedChild, ToolError> {
        self.child
            .as_mut()
            .ok_or_else(|| ToolError::Execution("shell process was already reaped".to_string()))
    }

    async fn terminate_and_reap(&mut self) -> Result<(), ToolError> {
        self.terminator.terminate();
        if let Some(mut child) = self.child.take() {
            child.wait().await.map_err(|error| {
                ToolError::Execution(format!("failed to reap command: {error}"))
            })?;
        }
        if let Some(stdout) = self.stdout.take() {
            let _ = stdout.await;
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.await;
        }
        Ok(())
    }
}

const MAX_ISOLATED_SHELL_SNAPSHOT_BYTES: u64 = 1024 * 1024;

struct PreparedShellSnapshot {
    path: PathBuf,
    temporary: Option<tempfile::NamedTempFile>,
}

struct ShellSnapshotSelection {
    path: Option<PathBuf>,
    requires_private_copy: bool,
}

fn select_shell_snapshot(
    snapshot: Option<&crate::ShellEnvironmentSnapshot>,
    verifier_isolation: bool,
    os_sandbox: Option<&crate::os_sandbox::OsSandboxSpec>,
) -> Result<ShellSnapshotSelection, ToolError> {
    let Some(snapshot) = snapshot else {
        return Ok(ShellSnapshotSelection {
            path: None,
            requires_private_copy: false,
        });
    };
    if verifier_isolation {
        return Ok(ShellSnapshotSelection {
            path: snapshot.verifier_ready_path(),
            requires_private_copy: false,
        });
    }

    let ready = snapshot.ready_path();
    if !shell_snapshot_is_denied(ready.as_deref(), os_sandbox)? {
        return Ok(ShellSnapshotSelection {
            path: ready,
            requires_private_copy: false,
        });
    }

    let path = snapshot.sandbox_ready_path().ok_or_else(|| {
        ToolError::Execution(
            "full shell snapshot is denied by the OS sandbox but its sanitized task-runtime snapshot is unavailable"
                .to_string(),
        )
    })?;
    Ok(ShellSnapshotSelection {
        path: Some(path),
        requires_private_copy: true,
    })
}

fn shell_snapshot_is_denied(
    snapshot_path: Option<&Path>,
    os_sandbox: Option<&crate::os_sandbox::OsSandboxSpec>,
) -> Result<bool, ToolError> {
    let (Some(snapshot_path), Some(os_sandbox)) = (snapshot_path, os_sandbox) else {
        return Ok(false);
    };
    let snapshot_path = snapshot_path.canonicalize().map_err(|error| {
        ToolError::Execution(format!(
            "failed to resolve shell snapshot `{}`: {error}",
            snapshot_path.display()
        ))
    })?;
    Ok(os_sandbox.deny_read.iter().any(|denied| {
        let denied = denied.canonicalize().unwrap_or_else(|_| denied.clone());
        snapshot_path.starts_with(denied)
    }))
}

fn ordinary_shell_snapshot_copy_root(
    copy_required: bool,
    cwd: &Path,
    os_sandbox: Option<&crate::os_sandbox::OsSandboxSpec>,
    temp_root: Option<&OsStr>,
) -> Result<Option<PathBuf>, ToolError> {
    if !copy_required {
        return Ok(None);
    }
    let os_sandbox = os_sandbox.ok_or_else(|| {
        ToolError::Execution(
            "private shell snapshot copy requested without an OS sandbox".to_string(),
        )
    })?;

    let declared_temp_root = temp_root.map(PathBuf::from).ok_or_else(|| {
        ToolError::Execution(
            "shell snapshot is denied by the OS sandbox and no private TMPDIR is available"
                .to_string(),
        )
    })?;
    if !declared_temp_root.is_absolute() {
        return Err(ToolError::Execution(
            "private shell snapshot TMPDIR must be absolute".to_string(),
        ));
    }
    let metadata = std::fs::symlink_metadata(&declared_temp_root).map_err(|error| {
        ToolError::Execution(format!(
            "failed to inspect private shell snapshot directory `{}`: {error}",
            declared_temp_root.display()
        ))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ToolError::Execution(format!(
            "private shell snapshot directory must be an ordinary directory: `{}`",
            declared_temp_root.display()
        )));
    }
    let temp_root = declared_temp_root.canonicalize().map_err(|error| {
        ToolError::Execution(format!(
            "failed to resolve private shell snapshot directory: {error}"
        ))
    })?;
    if temp_root != declared_temp_root {
        return Err(ToolError::Execution(format!(
            "private shell snapshot directory must not contain symlinked or non-canonical components: `{}`",
            declared_temp_root.display()
        )));
    }
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    if temp_root.starts_with(&cwd) || cwd.starts_with(&temp_root) {
        return Err(ToolError::Execution(
            "private shell snapshot directory must be disjoint from the workspace".to_string(),
        ));
    }
    let explicitly_writable = os_sandbox.rw_paths.iter().any(|path| {
        path.canonicalize()
            .is_ok_and(|resolved| resolved == temp_root)
    });
    if !explicitly_writable {
        return Err(ToolError::Execution(format!(
            "private shell snapshot directory is not an explicit sandbox write root: `{}`",
            temp_root.display()
        )));
    }
    let inaccessible = os_sandbox
        .deny_read
        .iter()
        .chain(&os_sandbox.readonly_paths)
        .any(|path| {
            let path = path.canonicalize().unwrap_or_else(|_| path.clone());
            temp_root.starts_with(path)
        });
    if inaccessible {
        return Err(ToolError::Execution(format!(
            "private shell snapshot directory is denied or read-only: `{}`",
            temp_root.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(ToolError::Execution(format!(
                "private shell snapshot directory must be owned by the current user and user-only: `{}`",
                temp_root.display()
            )));
        }
    }
    Ok(Some(temp_root))
}

fn shell_snapshot_for_spawn(
    snapshot_path: Option<&Path>,
    isolation_root: Option<&Path>,
) -> Result<Option<PreparedShellSnapshot>, ToolError> {
    let Some(snapshot_path) = snapshot_path else {
        return Ok(None);
    };
    let Some(copy_root) = isolation_root else {
        return Ok(Some(PreparedShellSnapshot {
            path: snapshot_path.to_path_buf(),
            temporary: None,
        }));
    };

    let metadata = std::fs::symlink_metadata(snapshot_path).map_err(|error| {
        ToolError::Execution(format!(
            "failed to inspect shell snapshot `{}`: {error}",
            snapshot_path.display()
        ))
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ToolError::Execution(format!(
            "shell snapshot must be a regular non-symlink file: `{}`",
            snapshot_path.display()
        )));
    }
    if metadata.len() > MAX_ISOLATED_SHELL_SNAPSHOT_BYTES {
        return Err(ToolError::Execution(format!(
            "shell snapshot exceeds {} bytes: `{}`",
            MAX_ISOLATED_SHELL_SNAPSHOT_BYTES,
            snapshot_path.display()
        )));
    }

    // A Landlock deny list may cover the configuration directory containing the
    // snapshot. Before applying the sandbox, copy it to a randomized O_EXCL tempfile
    // under the trusted private runtime root. Every invocation receives a new copy,
    // so a child that modifies its copy cannot contaminate later shells.
    let mut source = std::fs::File::open(snapshot_path).map_err(|error| {
        ToolError::Execution(format!(
            "failed to open shell snapshot `{}`: {error}",
            snapshot_path.display()
        ))
    })?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".kcoder-shell-")
        .suffix(".sh")
        .tempfile_in(copy_root)
        .map_err(|error| {
            ToolError::Execution(format!(
                "failed to create private shell snapshot in `{}`: {error}",
                copy_root.display()
            ))
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        temporary
            .as_file_mut()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                ToolError::Execution(format!(
                    "failed to secure private shell snapshot `{}`: {error}",
                    temporary.path().display()
                ))
            })?;
    }
    std::io::copy(&mut source, temporary.as_file_mut()).map_err(|error| {
        ToolError::Execution(format!(
            "failed to copy shell snapshot `{}` into `{}`: {error}",
            snapshot_path.display(),
            temporary.path().display()
        ))
    })?;
    temporary.as_file_mut().sync_all().map_err(|error| {
        ToolError::Execution(format!(
            "failed to flush private shell snapshot `{}`: {error}",
            temporary.path().display()
        ))
    })?;
    Ok(Some(PreparedShellSnapshot {
        path: temporary.path().to_path_buf(),
        temporary: Some(temporary),
    }))
}

enum ChildWaitOutcome {
    Exited(ExitStatus),
    Elapsed,
    Stopped,
}

#[cfg(target_os = "linux")]
async fn wait_for_linux_process_stop(pid: u32) {
    loop {
        if linux_process_is_stopped(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(not(target_os = "linux"))]
async fn wait_for_linux_process_stop(_pid: u32) {
    std::future::pending::<()>().await;
}

#[cfg(target_os = "linux")]
fn linux_process_is_stopped(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    stat.rsplit_once(") ")
        .and_then(|(_, fields)| fields.chars().next())
        .is_some_and(|state| matches!(state, 'T' | 't'))
}

impl Drop for RunningShell {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }
        self.terminator.terminate();
        let Some(mut child) = self.child.take() else {
            return;
        };
        let stdout = self.stdout.take();
        let stderr = self.stderr.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = child.wait().await;
                if let Some(stdout) = stdout {
                    let _ = stdout.await;
                }
                if let Some(stderr) = stderr {
                    let _ = stderr.await;
                }
            });
        } else {
            let _ = child.start_kill();
        }
    }
}

struct ProcessGroupTerminator {
    pid: u32,
    #[cfg(target_os = "linux")]
    process_scope: Option<String>,
    #[cfg(windows)]
    native_job: Option<crate::windows_sandbox::WindowsSandboxTerminator>,
    terminated: AtomicBool,
    cleaned_descendants: AtomicUsize,
}

impl ProcessGroupTerminator {
    fn new(pid: u32, _process_scope: Option<String>) -> Self {
        Self {
            pid,
            #[cfg(target_os = "linux")]
            process_scope: _process_scope,
            #[cfg(windows)]
            native_job: None,
            terminated: AtomicBool::new(false),
            cleaned_descendants: AtomicUsize::new(0),
        }
    }

    #[cfg(windows)]
    fn new_windows(pid: u32, native_job: crate::windows_sandbox::WindowsSandboxTerminator) -> Self {
        Self {
            pid,
            native_job: Some(native_job),
            terminated: AtomicBool::new(false),
            cleaned_descendants: AtomicUsize::new(0),
        }
    }

    fn cleaned_descendant_count(&self) -> usize {
        self.cleaned_descendants.load(Ordering::SeqCst)
    }

    fn terminate(&self) {
        if self.terminated.swap(true, Ordering::SeqCst) {
            return;
        }
        // Linux invocation scopes also cover descendants that called setsid,
        // double-forked, or otherwise escaped the original process group. Scan
        // before signalling the group so the user-visible result can report
        // how many invocation descendants were actually found and cleaned.
        #[cfg(target_os = "linux")]
        if let Some(scope) = self.process_scope.as_deref() {
            self.cleaned_descendants
                .store(terminate_linux_process_scope(scope), Ordering::SeqCst);
        }
        #[cfg(unix)]
        unsafe {
            let pid = self.pid as libc::pid_t;
            if libc::kill(-pid, libc::SIGKILL) != 0 {
                let _ = libc::kill(pid, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            if let Some(job) = &self.native_job {
                job.terminate();
                return;
            }
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

#[cfg(target_os = "linux")]
fn new_process_scope() -> String {
    let sequence = NEXT_PROCESS_SCOPE.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{timestamp}-{sequence}", std::process::id())
}

#[cfg(target_os = "linux")]
fn terminate_linux_process_scope(scope: &str) -> usize {
    use std::collections::HashSet;

    let marker = format!("{PROCESS_SCOPE_ENV}={scope}");
    let own_pid = std::process::id();
    let mut cleaned = HashSet::new();

    // A child may call setsid(2), double-fork, and be reparented before the
    // original shell exits. Process-group signalling cannot reach it, but the
    // per-invocation environment marker survives those transitions. Repeat the
    // scan so a descendant racing with the first SIGKILL cannot escape by
    // forking once more before its parent is stopped.
    for _ in 0..3 {
        let mut found = false;
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return cleaned.len();
        };
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            if pid == own_pid {
                continue;
            }
            let Ok(environment) = std::fs::read(entry.path().join("environ")) else {
                continue;
            };
            if !environment
                .split(|byte| *byte == 0)
                .any(|entry| entry == marker.as_bytes())
            {
                continue;
            }
            found = true;
            cleaned.insert(pid);
            unsafe {
                let _ = libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        if !found {
            break;
        }
        std::thread::yield_now();
    }
    cleaned.len()
}

impl Drop for ProcessGroupTerminator {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn finish_shell_command(
    mut running: RunningShell,
    status: ExitStatus,
    command: &str,
    limits: OutputLimits,
) -> Result<ToolOutput, ToolError> {
    let cwd = running.cwd.clone();
    let stdout = join_output_pipe(running.stdout.take(), "stdout").await?;
    let stderr = join_output_pipe(running.stderr.take(), "stderr").await?;
    let cleaned_descendants = running.terminator.cleaned_descendant_count();
    format_shell_output(
        status,
        stdout,
        stderr,
        command,
        &cwd,
        limits,
        cleaned_descendants,
    )
}

fn command_timeout_error(timeout_ms: u64) -> ToolError {
    ToolError::Execution(format!("command timed out after {timeout_ms} ms"))
}

fn format_shell_output(
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    command: &str,
    cwd: &Path,
    limits: OutputLimits,
    cleaned_descendants: usize,
) -> Result<ToolOutput, ToolError> {
    let body = format_process_output(&stdout, &stderr, &limits);
    let lifecycle_warning = shell_lifecycle_warning(command, cleaned_descendants);
    let head_sigpipe = is_head_limited_sigpipe(command, &status, &body);
    let command_succeeded = status.success() || head_sigpipe;
    let failure_evidence = masked_failure_evidence(command, &body, command_succeeded);
    let is_error = !command_succeeded || !failure_evidence.is_empty();
    let result = format_bash_result(&status, head_sigpipe, &failure_evidence, cwd, &body);
    let text = limits.truncate(&match lifecycle_warning {
        Some(warning) => format!("{warning}\n\n{result}"),
        None => result,
    });
    Ok(ToolOutput {
        content: vec![kcoder_types::ContentBlock::Text { text }],
        is_error,
        execution_metadata: vec![crate::ToolExecutionMetadata::Process {
            exit_code: status.code(),
            signal: exit_status_signal(&status),
            cwd: cwd.to_path_buf(),
        }],
        user_context: Vec::new(),
    })
}

#[cfg(unix)]
fn exit_status_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_status_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

fn shell_lifecycle_warning(command: &str, cleaned_descendants: usize) -> Option<String> {
    let trimmed = command.trim_end();
    let trailing_background = trimmed.ends_with('&') && !trimmed.ends_with("&&");
    let detached_launch = trailing_background
        || command.split_whitespace().any(|raw| {
            let token = raw.trim_matches(|ch: char| "'\";|()".contains(ch));
            let program = token.rsplit('/').next().unwrap_or(token);
            token == "&" || matches!(program, "nohup" | "setsid" | "disown")
        });
    if cleaned_descendants == 0 && !detached_launch {
        return None;
    }

    let cleanup = if cleaned_descendants == 0 {
        "The command used shell daemonization syntax; descendants cannot outlive this Bash invocation."
            .to_string()
    } else {
        format!(
            "Bash cleaned {cleaned_descendants} descendant process(es) when the shell command finished."
        )
    };
    Some(format!(
        "Warning: {cleanup} For a persistent server or watcher, keep the command in foreground form and call Bash with run_in_background=true plus an explicit total lifetime timeout; do not use `&`, `nohup`, `setsid`, or `disown`."
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShellInvocation {
    program: String,
    args: Vec<String>,
}

pub(crate) fn verifier_isolation_environment(
    root: &Path,
    workspace_root: Option<&Path>,
) -> Result<Vec<(OsString, OsString)>, ToolError> {
    let workspace_runtime = verifier_isolation_workspace_directory(root, workspace_root);
    let home = workspace_runtime.join("home");
    let cache = workspace_runtime.join("cache");
    let temp = workspace_runtime.join("tmp");
    let pip_cache = cache.join("pip");
    let npm_cache = cache.join("npm");
    let python_cache = cache.join("python");
    // Partition the entire home, cache, and temp environment by Candidate/Baseline
    // provenance, not only the Cargo target. Python, pip, npm, and tool configuration
    // caches can also change results on the other side.
    let cargo_target = cache.join("cargo-target");
    for directory in [
        &home,
        &cache,
        &temp,
        &pip_cache,
        &npm_cache,
        &python_cache,
        &cargo_target,
    ] {
        std::fs::create_dir_all(directory).map_err(|error| {
            ToolError::Execution(format!(
                "failed to prepare isolated verifier directory `{}`: {error}",
                directory.display()
            ))
        })?;
    }
    #[cfg(windows)]
    let null_config = OsString::from("NUL");
    #[cfg(not(windows))]
    let null_config = OsString::from("/dev/null");
    let mut environment = vec![
        ("HOME".into(), home.as_os_str().to_os_string()),
        (
            "KCODER_ISOLATED_HOME".into(),
            home.as_os_str().to_os_string(),
        ),
        ("XDG_CACHE_HOME".into(), cache.as_os_str().to_os_string()),
        (
            "KCODER_ISOLATED_CACHE".into(),
            cache.as_os_str().to_os_string(),
        ),
        ("TMPDIR".into(), temp.as_os_str().to_os_string()),
        (
            "KCODER_ISOLATED_TMP".into(),
            temp.as_os_str().to_os_string(),
        ),
        ("PIP_CACHE_DIR".into(), pip_cache.as_os_str().to_os_string()),
        (
            "KCODER_ISOLATED_PIP_CACHE".into(),
            pip_cache.as_os_str().to_os_string(),
        ),
        (
            "NPM_CONFIG_CACHE".into(),
            npm_cache.as_os_str().to_os_string(),
        ),
        (
            "KCODER_ISOLATED_NPM_CACHE".into(),
            npm_cache.as_os_str().to_os_string(),
        ),
        (
            "PYTHONPYCACHEPREFIX".into(),
            python_cache.as_os_str().to_os_string(),
        ),
        (
            "KCODER_ISOLATED_PYTHON_CACHE".into(),
            python_cache.as_os_str().to_os_string(),
        ),
        ("PYTHONNOUSERSITE".into(), "1".into()),
        ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
        ("PYTEST_ADDOPTS".into(), "-p no:cacheprovider".into()),
        (
            "KCODER_ISOLATED_PYTEST_ADDOPTS".into(),
            "-p no:cacheprovider".into(),
        ),
        ("PIP_REQUIRE_VIRTUALENV".into(), "1".into()),
        ("PIP_CONFIG_FILE".into(), null_config),
        (
            "CARGO_TARGET_DIR".into(),
            cargo_target.as_os_str().to_os_string(),
        ),
        ("GIT_OPTIONAL_LOCKS".into(), "0".into()),
    ];
    if let Some(workspace_root) = workspace_root {
        let trusted_python_path = std::env::var_os("KCODER_VERIFIER_PYTHONPATH_PREFIX");
        let verifier_python_path =
            verifier_python_path(workspace_root, trusted_python_path.as_deref())?;
        environment.push(("PYTHONPATH".into(), verifier_python_path.clone()));
        environment.push(("KCODER_ISOLATED_PYTHONPATH".into(), verifier_python_path));
        environment.push((
            "KCODER_VERIFIER_WORKSPACE".into(),
            workspace_root.as_os_str().to_os_string(),
        ));
    }
    Ok(environment)
}

fn verifier_isolation_workspace_directory(root: &Path, workspace_root: Option<&Path>) -> PathBuf {
    let namespace = workspace_root
        .map(|workspace| {
            let digest = format!(
                "{:x}",
                Sha256::digest(workspace.as_os_str().to_string_lossy().as_bytes())
            );
            digest[..16].to_string()
        })
        .unwrap_or_else(|| "default".to_string());
    root.join("workspaces").join(namespace)
}

fn verifier_python_path(
    workspace_root: &Path,
    trusted_prefix: Option<&OsStr>,
) -> Result<OsString, ToolError> {
    let mut python_paths = vec![workspace_root.to_path_buf()];
    if let Some(trusted_prefix) = trusted_prefix {
        python_paths.extend(std::env::split_paths(trusted_prefix));
    }
    std::env::join_paths(python_paths).map_err(|error| {
        ToolError::Execution(format!(
            "failed to construct isolated verifier PYTHONPATH: {error}"
        ))
    })
}

fn shell_invocation(
    preferred_shell: &str,
    command: &str,
    load_snapshot: bool,
    isolate_environment: bool,
) -> ShellInvocation {
    let bash = if shell_supports_pipefail(preferred_shell) {
        Some(preferred_shell.to_string())
    } else if Path::new("/bin/bash").exists() {
        Some("/bin/bash".to_string())
    } else {
        None
    };

    if let Some(program) = bash {
        let mut shell_options = vec!["-o".into(), "pipefail".into()];
        if verification_like_command(command) {
            shell_options.extend(["-o".into(), "errexit".into()]);
        }
        if load_snapshot {
            let bootstrap = if isolate_environment {
                ". \"$KCODER_SHELL_SNAPSHOT\" >/dev/null 2>&1 || true\n\
                 export HOME=\"$KCODER_ISOLATED_HOME\"\n\
                 export XDG_CACHE_HOME=\"$KCODER_ISOLATED_CACHE\"\n\
                 export TMPDIR=\"$KCODER_ISOLATED_TMP\"\n\
                 export PIP_CACHE_DIR=\"$KCODER_ISOLATED_PIP_CACHE\"\n\
                 export NPM_CONFIG_CACHE=\"$KCODER_ISOLATED_NPM_CACHE\"\n\
                 export PYTHONPYCACHEPREFIX=\"$KCODER_ISOLATED_PYTHON_CACHE\"\n\
                 export PYTHONPATH=\"$KCODER_ISOLATED_PYTHONPATH\"\n\
                 export PYTEST_ADDOPTS=\"$KCODER_ISOLATED_PYTEST_ADDOPTS\"\n\
                 export PYTHONNOUSERSITE=1 PIP_REQUIRE_VIRTUALENV=1\n\
                 eval -- \"$1\""
            } else {
                ". \"$KCODER_SHELL_SNAPSHOT\" >/dev/null 2>&1 || true\neval -- \"$1\""
            };
            shell_options.extend([
                "-c".into(),
                bootstrap.into(),
                "kcoder-shell".into(),
                command.into(),
            ]);
            return ShellInvocation {
                program,
                args: shell_options,
            };
        }
        shell_options.extend(["-c".into(), command.into()]);
        return ShellInvocation {
            program,
            args: shell_options,
        };
    }

    ShellInvocation {
        program: preferred_shell.to_string(),
        args: vec!["-c".into(), command.into()],
    }
}

fn default_bash_shell() -> String {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Ok(shell) = std::env::var("SHELL")
            && shell_supports_pipefail(&shell)
        {
            candidates.push(PathBuf::from(shell));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("Git/bin/bash.exe"));
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(program_files_x86).join("Git/bin/bash.exe"));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local_app_data).join("Programs/Git/bin/bash.exe"));
        }
        if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
            return path.to_string_lossy().into_owned();
        }
        "bash.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|shell| !shell.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

fn shell_supports_pipefail(shell: &str) -> bool {
    Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.contains("bash"))
        .unwrap_or_else(|| shell.contains("bash"))
}

fn format_bash_result(
    status: &ExitStatus,
    head_sigpipe: bool,
    failure_evidence: &[&'static str],
    cwd: &Path,
    body: &str,
) -> String {
    let mut text = if head_sigpipe {
        "exit_code: 0\nnote: shell reported exit_code 141 from SIGPIPE in a head-limited pipeline; treating the truncated output as successful.\n".to_string()
    } else {
        match status.code() {
            Some(code) => format!("exit_code: {code}\n"),
            None => "exit_code: null\n".to_string(),
        }
    };
    text.push_str(&format!(
        "workdir: {}\nworkdir_scope: invocation_only\n",
        cwd.display()
    ));
    if !failure_evidence.is_empty() {
        text.push_str(&format!(
            "failure_evidence: {}\n",
            failure_evidence.join(", ")
        ));
        text.push_str(
            "note: command exited 0, but output contains failure evidence; treating this tool result as an error.\n",
        );
    }
    text.push_str(body);
    text
}

fn is_head_limited_sigpipe(command: &str, status: &ExitStatus, body: &str) -> bool {
    matches!(status.code(), Some(141))
        && !body.trim().is_empty()
        && command_has_head_pipeline(command)
        && !verification_like_command(command)
}

fn command_has_head_pipeline(command: &str) -> bool {
    command.split('|').skip(1).any(|segment| {
        let trimmed = segment.trim_start().trim_start_matches(['(', '{', '!']);
        let first = trimmed
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(|c: char| matches!(c, '\'' | '"' | '`'));
        first == "head" || first.ends_with("/head")
    })
}

fn masked_failure_evidence(
    command: &str,
    _output_text: &str,
    command_succeeded: bool,
) -> Vec<&'static str> {
    if !command_succeeded
        || !verification_like_command(command)
        || !command_explicitly_masks_failure(command)
    {
        return Vec::new();
    }

    // Successful output may simply contain source printed by cat/read, so Error,
    // Traceback, or FAILED in the body does not prove that an earlier process failed.
    // Explicit failure suppression makes the exit code untrustworthy from syntax
    // alone and must be treated as an error even when the suppressed process emitted no text.
    vec!["explicit failure masking"]
}

fn command_explicitly_masks_failure(command: &str) -> bool {
    command_explicitly_masks_failure_inner(command, 0)
}

fn command_explicitly_masks_failure_inner(command: &str, depth: usize) -> bool {
    let syntax = shell_unquoted_syntax(command);
    let compact = syntax.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim();
    let invocations = shell_command_invocations(command);
    let syntax_invocations = shell_command_invocations(&syntax);

    if shell_has_unquoted_sequence(&syntax, "||")
        || split_unquoted_shell_segments(&syntax)
            .iter()
            .any(|segment| segment.trim_start().starts_with("! "))
        || syntax_invocations.iter().any(|invocation| {
            invocation.program.rsplit(['/', '\\']).next() == Some("set")
                && invocation.args.iter().any(|argument| argument == "+e")
        })
        || trimmed.ends_with("; true")
        || trimmed.ends_with("; /bin/true")
        || trimmed.ends_with("; :")
        || trimmed.ends_with("; exit 0")
    {
        return true;
    }

    // `bash -c 'pytest ... || true'` hides a control operator in an argument. Recurse
    // through at most four layers to cover common wrappers without allowing hostile nesting to consume the stack.
    depth < 4
        && invocations.iter().any(|invocation| {
            let program = invocation
                .program
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(invocation.program.as_str());
            matches!(program, "bash" | "sh" | "dash" | "zsh" | "ksh")
                && invocation
                    .args
                    .windows(2)
                    .find(|window| window[0] == "-c")
                    .is_some_and(|window| {
                        command_explicitly_masks_failure_inner(&window[1], depth + 1)
                    })
        })
}

fn command_may_mask_failure(command: &str) -> bool {
    let syntax = shell_unquoted_syntax(command);
    command_explicitly_masks_failure(command)
        || syntax
            .split([';', '\n'])
            .collect::<Vec<_>>()
            .windows(2)
            .any(|parts| parts[0].contains('|') && !parts[1].trim().is_empty())
}

/// Retain only unquoted text at the shell-syntax layer. Quoted bodies and comments
/// may contain source such as `|| true` or `set +e`; they do not show that the command suppresses failures.
fn shell_unquoted_syntax(command: &str) -> String {
    let mut syntax = String::with_capacity(command.len());
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    let mut comment = false;
    let mut at_word_start = true;

    for character in command.chars() {
        if comment {
            if character == '\n' {
                comment = false;
                syntax.push(character);
                at_word_start = true;
            } else {
                syntax.push(' ');
            }
            continue;
        }
        if escaped {
            syntax.push(' ');
            escaped = false;
            at_word_start = false;
            continue;
        }
        if character == '\\' && !single_quote {
            syntax.push(' ');
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => {
                single_quote = !single_quote;
                syntax.push(' ');
                at_word_start = false;
            }
            '"' if !single_quote => {
                double_quote = !double_quote;
                syntax.push(' ');
                at_word_start = false;
            }
            '#' if !single_quote && !double_quote && at_word_start => {
                comment = true;
                syntax.push(' ');
            }
            _character if single_quote || double_quote => syntax.push(' '),
            character => {
                syntax.extend(character.to_lowercase());
                at_word_start =
                    character.is_whitespace() || matches!(character, ';' | '|' | '&' | '(' | ')');
            }
        }
    }
    syntax
}

fn shell_has_unquoted_sequence(syntax: &str, needle: &str) -> bool {
    syntax
        .as_bytes()
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

pub(crate) fn test_like_command(command: &str) -> bool {
    !test_command_invocations(command).is_empty()
}

pub(crate) fn test_command_signature(command: &str) -> Option<String> {
    let invocation = test_command_invocations(command).into_iter().next()?;
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    let mut args = invocation.args.iter().map(String::as_str).peekable();
    let is_pytest = program == "pytest"
        || python_interpreter_program(program)
            && invocation
                .args
                .windows(2)
                .any(|window| window == ["-m", "pytest"]);
    let mut canonical_args = Vec::with_capacity(invocation.args.len());
    while let Some(arg) = args.next() {
        if is_pytest
            && arg == "-p"
            && args
                .peek()
                .is_some_and(|plugin| *plugin == "no:cacheprovider")
        {
            // A read-only baseline cannot write `.pytest_cache`. Disabling cacheprovider does
            // not change test selection or assertion semantics, so it may pair with the same
            // candidate test even when that test does not disable caching explicitly.
            args.next();
            continue;
        }
        canonical_args.push(arg);
    }
    Some(
        std::iter::once(program)
            .chain(canonical_args)
            .collect::<Vec<_>>()
            .join("\u{1f}"),
    )
}

pub(crate) fn verification_like_command(command: &str) -> bool {
    verification_like_command_inner(command, 0)
}

fn verification_like_command_inner(command: &str, depth: usize) -> bool {
    let invocations = shell_command_invocations(command);
    if test_like_command(command) {
        return true;
    }
    if invocations.iter().any(|invocation| {
        python_interpreter_program(&invocation.program)
            && invocation.args.iter().any(|arg| arg == "-c")
    }) {
        return true;
    }
    if depth < 4
        && invocations.iter().any(|invocation| {
            let program = invocation
                .program
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(invocation.program.as_str());
            matches!(program, "bash" | "sh" | "dash" | "zsh" | "ksh")
                && invocation
                    .args
                    .windows(2)
                    .find(|window| window[0] == "-c")
                    .is_some_and(|window| verification_like_command_inner(&window[1], depth + 1))
        })
    {
        return true;
    }
    let syntax = shell_unquoted_syntax(command);
    [
        "cargo check",
        "cargo build",
        "cargo clippy",
        "npm run build",
        "pnpm build",
        "yarn build",
        "tsc",
        "eslint",
    ]
    .iter()
    .any(|needle| syntax.contains(needle))
}

fn python_interpreter_program(program: &str) -> bool {
    let basename = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    let basename = basename.strip_suffix(".exe").unwrap_or(&basename);
    ["python", "pypy"].iter().any(|prefix| {
        basename.strip_prefix(prefix).is_some_and(|suffix| {
            suffix.is_empty()
                || suffix
                    .chars()
                    .all(|character| character.is_ascii_digit() || character == '.')
                    && suffix.chars().any(|character| character.is_ascii_digit())
        })
    })
}

/// Recognize only a grep/rg query without wrappers, control operators, or redirection.
/// Exit 1 with no output means no matches for such a command, not verification failure.
pub(crate) fn read_only_search_no_match_command(command: &str) -> bool {
    if shell_has_unquoted_control_operator(command)
        || shell_has_unquoted_redirection(command)
        || shell_has_command_substitution(command)
        || command_may_mask_failure(command)
    {
        return false;
    }
    let Some(words) = shell_words(command.trim()) else {
        return false;
    };
    let Some(program) = words.first() else {
        return false;
    };
    matches!(
        program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(program.as_str()),
        "grep" | "rg"
    )
}

/// Treat only directly executed inline Python checks as behavior probes. Text
/// searches, diffs, and ordinary inspection commands cannot prove that a candidate
/// patch changed runtime behavior.
pub(crate) fn behavior_probe_command(command: &str) -> bool {
    if test_like_command(command)
        || shell_has_unquoted_pipe(command)
        || command_may_mask_failure(command)
        || shell_has_unquoted_redirection(command)
        || dependency_mutation_command(command)
        || baseline_mutation_command(command)
    {
        return false;
    }
    let invocations = shell_command_invocations(command);
    if invocations.len() != 1 {
        return false;
    }
    let invocation = &invocations[0];
    if invocation.program.contains(['/', '\\']) {
        return false;
    }
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    python_interpreter_program(program)
        && invocation.args.first().is_some_and(|arg| arg == "-c")
        && invocation
            .args
            .get(1)
            .is_some_and(|code| behavior_probe_python_code_is_safe(code))
}

/// Behavioral-difference evidence must come from target API results, not candidate
/// or baseline source, paths, environments, or process fingerprints. This deliberately
/// fails closed: keywords cannot prove dynamic Python code is read-only, but known file,
/// reflection, evaluation, and process entry points can be rejected. Workspace
/// fingerprints and Landlock provide post-execution write defenses.
fn behavior_probe_python_code_is_safe(code: &str) -> bool {
    let normalized = code.to_ascii_lowercase();
    if normalized.trim().is_empty() {
        return false;
    }
    const FORBIDDEN: &[&str] = &[
        "pathlib",
        "read_text",
        "read_bytes",
        "write_text",
        "write_bytes",
        "open(",
        "io.open",
        "os.open",
        "os.getcwd",
        "os.getcwdb",
        "os.chdir",
        "os.environ",
        "getenv(",
        "__file__",
        "__code__",
        "inspect",
        "getsource",
        "linecache",
        "subprocess",
        "os.system",
        "os.popen",
        "shlex",
        "compile(",
        "eval(",
        "exec(",
        "globals(",
        "locals(",
        "vars(",
        "dir(",
        "getattr(",
        "setattr(",
        "delattr(",
        "__import__(",
        "importlib",
        "pkgutil",
        "sys.modules",
        "sys.path",
        "sys.argv",
        "sys.executable",
        "platform.",
        "socket",
        "requests",
        "urllib",
        "http.client",
        "tempfile",
        "shutil",
        "marshal",
    ];
    if FORBIDDEN.iter().any(|needle| normalized.contains(needle)) {
        return false;
    }

    // A sentinel may wrap only expected domain exceptions from the target API; it
    // cannot disguise missing dependencies, ABI problems, or other infrastructure
    // failures as behavioral differences. Apply a conservative lexical gate to inline
    // Python: imports must precede the try block, and broad, import, or process exceptions are rejected.
    if let Some(try_offset) = normalized.find("try:") {
        let guarded = &normalized[try_offset + "try:".len()..];
        if guarded.lines().any(|line| {
            let line = line.trim_start_matches([' ', '\t', ';']);
            line.starts_with("import ") || line.starts_with("from ")
        }) {
            return false;
        }
    }
    for clause in normalized.split("except").skip(1) {
        let header = clause.split(':').next().unwrap_or_default().trim();
        if header.is_empty()
            || [
                "exception",
                "baseexception",
                "importerror",
                "modulenotfounderror",
                "oserror",
                "timeouterror",
                "systemexit",
                "keyboardinterrupt",
            ]
            .iter()
            .any(|exception| header.contains(exception))
        {
            return false;
        }
    }
    true
}

pub(crate) fn behavior_probe_command_signature(command: &str) -> Option<String> {
    behavior_probe_command(command).then(|| command.trim().to_string())
}

/// Recognize the sole preparation operation a verifier may execute in a pristine baseline.
///
/// Return the exact signature of a typed recipe instead of generalizing it to an
/// arbitrary build shell. The command must directly invoke tracked Python
/// `setup.py build_ext --inplace`; only parallelism and rebuild behavior may vary.
/// Wrappers, environment assignments, path arguments, pipelines, redirection, and control operators are rejected.
pub(crate) fn verifier_native_build_command_signature(command: &str) -> Option<String> {
    if shell_has_unquoted_control_operator(command)
        || shell_has_unquoted_redirection(command)
        || shell_has_command_substitution(command)
        || command_may_mask_failure(command)
        || dependency_mutation_command(command)
    {
        return None;
    }
    let words = shell_words(command.trim())?;
    let program = words.first()?;
    if program.contains(['/', '\\']) || !python_interpreter_program(program) {
        return None;
    }
    let args = &words[1..];
    if !matches!(
        args.first().map(String::as_str),
        Some("setup.py" | "./setup.py")
    ) || args.get(1).map(String::as_str) != Some("build_ext")
    {
        return None;
    }

    let mut inplace = false;
    let mut index = 2usize;
    while let Some(argument) = args.get(index) {
        match argument.as_str() {
            "--inplace" => inplace = true,
            "--force" | "-f" | "--quiet" | "-q" => {}
            "-j" | "--parallel" => {
                index += 1;
                if !args.get(index).is_some_and(|value| {
                    value
                        .parse::<usize>()
                        .is_ok_and(|parallelism| parallelism > 0 && parallelism <= 64)
                }) {
                    return None;
                }
            }
            value
                if value.strip_prefix("-j").is_some_and(|parallelism| {
                    !parallelism.is_empty()
                        && parallelism
                            .parse::<usize>()
                            .is_ok_and(|parallelism| parallelism > 0 && parallelism <= 64)
                }) => {}
            value
                if value
                    .strip_prefix("--parallel=")
                    .is_some_and(|parallelism| {
                        parallelism
                            .parse::<usize>()
                            .is_ok_and(|parallelism| parallelism > 0 && parallelism <= 64)
                    }) => {}
            _ => return None,
        }
        index += 1;
    }
    inplace.then(|| command.trim().to_string())
}

fn verifier_native_build_execution_rejection(
    verifier_native_build: bool,
    run_in_background: bool,
) -> Option<String> {
    (run_in_background && verifier_native_build).then(|| {
        "Goal Pro verifier native build guard rejected background execution. Candidate and baseline preparation must each complete in the foreground so the machine gate can authenticate the raw exit code before any test or behavior probe runs."
            .to_string()
    })
}

/// Bash `workdir` is the sole source of verifier execution provenance. Commands
/// may not change directories again or point test selectors at absolute paths;
/// otherwise recorded Candidate/Baseline provenance would diverge from the actual execution directory.
fn verifier_workdir_command_rejection(command: &str) -> Option<String> {
    let invocations = shell_command_invocations(command);
    let dynamic_or_compound_shell = shell_has_command_substitution(command)
        || shell_has_unquoted_variable_expansion(command)
        || shell_has_unquoted_character(command, |character| {
            matches!(character, '(' | ')' | '{' | '}')
        })
        || invocations.iter().any(|invocation| {
            matches!(
                invocation.program.as_str(),
                "if" | "then"
                    | "elif"
                    | "else"
                    | "fi"
                    | "for"
                    | "while"
                    | "until"
                    | "case"
                    | "esac"
                    | "select"
                    | "function"
                    | "do"
                    | "done"
            )
        });
    let changes_directory = invocations.iter().any(|invocation| {
        let program = invocation
            .program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(invocation.program.as_str());
        matches!(program, "cd" | "pushd" | "popd" | "source" | "." | "eval")
            || (matches!(program, "bash" | "sh" | "dash" | "zsh" | "ksh")
                && invocation.args.iter().any(|argument| argument == "-c"))
    }) || split_unquoted_shell_segments(command)
        .iter()
        .any(|segment| {
            let Some(words) = shell_words(segment) else {
                return true;
            };
            let Some(first) = words.first() else {
                return false;
            };
            let program = first.rsplit(['/', '\\']).next().unwrap_or(first.as_str());
            program == "env"
                && words.iter().skip(1).any(|word| {
                    matches!(word.as_str(), "-C" | "--chdir") || word.starts_with("--chdir=")
                })
        });
    let escaping_test_selector = invocations
        .iter()
        .filter(|invocation| test_invocation(invocation))
        .any(test_invocation_escapes_workdir);
    let escaping_directory_option = split_unquoted_shell_segments(command)
        .iter()
        .any(|segment| {
            let Some(words) = shell_words(segment) else {
                return true;
            };
            words.windows(2).any(|window| {
                matches!(window[0].as_str(), "-C" | "--directory" | "--chdir")
                    && path_escapes_workdir(&window[1])
            }) || words.iter().any(|word| {
                ["--directory=", "--chdir="]
                    .iter()
                    .any(|prefix| word.strip_prefix(prefix).is_some_and(path_escapes_workdir))
            })
        });
    let protected_environment = verifier_overrides_protected_environment(command);
    if !dynamic_or_compound_shell
        && !changes_directory
        && !escaping_test_selector
        && !escaping_directory_option
        && !protected_environment
    {
        return None;
    }
    Some(
        "Goal Pro verifier workdir guard rejected this command before execution. The authenticated Candidate/Baseline origin comes only from the Bash `workdir` field; use one simple command without shell grouping, command/variable substitution, directory changes, source/eval or shell `-c` wrappers, escaping test selectors, or overrides of verifier runtime variables. Set `workdir` to the intended isolated repository and keep source/test paths relative."
            .to_string(),
    )
}

fn test_invocation_escapes_workdir(invocation: &ShellCommandInvocation) -> bool {
    const OUTPUT_PATH_OPTIONS: &[&str] = &[
        "--basetemp",
        "--junitxml",
        "--junit-xml",
        "--html",
        "--cov-report",
    ];
    if Path::new(&invocation.program).is_absolute() || path_escapes_workdir(&invocation.program) {
        return true;
    }
    let mut skip_output_value = false;
    for argument in &invocation.args {
        if skip_output_value {
            skip_output_value = false;
            continue;
        }
        if OUTPUT_PATH_OPTIONS.contains(&argument.as_str()) {
            skip_output_value = true;
            continue;
        }
        if OUTPUT_PATH_OPTIONS
            .iter()
            .any(|option| argument.starts_with(&format!("{option}=")))
        {
            continue;
        }
        let value = argument
            .split_once('=')
            .map_or(argument.as_str(), |(_, value)| value);
        if (Path::new(value).is_absolute() || path_escapes_workdir(value))
            && (!argument.starts_with('-')
                || [
                    "--rootdir",
                    "--confcutdir",
                    "--ignore",
                    "--ignore-glob",
                    "--deselect",
                    "--pyargs",
                ]
                .iter()
                .any(|option| argument.starts_with(option)))
        {
            return true;
        }
    }
    false
}

fn path_escapes_workdir(value: &str) -> bool {
    use std::path::Component;

    if value.is_empty() {
        return false;
    }
    let path = Path::new(value);
    if path.is_absolute() || value.starts_with("\\\\") || value.as_bytes().get(1) == Some(&b':') {
        return true;
    }
    let mut depth = 0usize;
    for component in path.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::ParentDir if depth == 0 => return true,
            Component::ParentDir => depth -= 1,
            Component::RootDir | Component::Prefix(_) => return true,
            Component::CurDir => {}
        }
    }
    false
}

fn verifier_overrides_protected_environment(command: &str) -> bool {
    const PROTECTED: &[&str] = &[
        "PATH",
        "HOME",
        "PWD",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONPYCACHEPREFIX",
        "PYTHONNOUSERSITE",
        "PYTHONDONTWRITEBYTECODE",
        "PYTEST_ADDOPTS",
        "PIP_CACHE_DIR",
        "PIP_CONFIG_FILE",
        "PIP_REQUIRE_VIRTUALENV",
        "NPM_CONFIG_CACHE",
        "CARGO_TARGET_DIR",
        "GIT_OPTIONAL_LOCKS",
        "KCODER_ISOLATED_HOME",
        "KCODER_ISOLATED_CACHE",
        "KCODER_ISOLATED_TMP",
        "KCODER_ISOLATED_PIP_CACHE",
        "KCODER_ISOLATED_NPM_CACHE",
        "KCODER_ISOLATED_PYTHON_CACHE",
        "KCODER_ISOLATED_PYTEST_ADDOPTS",
        "KCODER_ISOLATED_PYTHONPATH",
        "KCODER_VERIFIER_WORKSPACE",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "DYLD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "NODE_PATH",
        "RUBYLIB",
        "CLASSPATH",
    ];
    let protected = |name: &str| {
        PROTECTED
            .iter()
            .any(|protected| protected.eq_ignore_ascii_case(name))
    };
    let dynamic_name = |name: &str| {
        name.chars()
            .any(|character| matches!(character, '$' | '{' | '}' | '*' | '?' | '[' | ']'))
    };
    let verification_command = verification_like_command(command)
        || verifier_native_build_command_signature(command).is_some();
    split_unquoted_shell_segments(command)
        .iter()
        .any(|segment| {
            let Some(words) = shell_words(segment) else {
                return true;
            };
            if verification_command
                && words.iter().any(|word| {
                    word.split_once('=')
                        .is_some_and(|(name, _)| protected(name) || dynamic_name(name))
                        || word
                            .strip_prefix("-u")
                            .is_some_and(|name| !name.is_empty() && protected(name))
                })
            {
                return true;
            }
            let mut index = 0usize;
            while let Some(word) = words.get(index) {
                let Some((name, _)) = word.split_once('=') else {
                    break;
                };
                if protected(name) || dynamic_name(name) {
                    return true;
                }
                index += 1;
            }
            let Some(program) = words
                .get(index)
                .map(|word| word.rsplit(['/', '\\']).next().unwrap_or(word.as_str()))
            else {
                return false;
            };
            match program {
                "export" | "unset" => words.iter().skip(index + 1).any(|word| {
                    let name = word.split_once('=').map_or(word.as_str(), |(name, _)| name);
                    protected(name) || dynamic_name(name)
                }),
                "env" => {
                    let mut env_index = index + 1;
                    while let Some(word) = words.get(env_index) {
                        if matches!(word.as_str(), "-u" | "--unset") {
                            if words.get(env_index + 1).is_some_and(|name| protected(name)) {
                                return true;
                            }
                            env_index += 2;
                            continue;
                        }
                        if let Some(name) = word.strip_prefix("--unset=") {
                            if protected(name) {
                                return true;
                            }
                            env_index += 1;
                            continue;
                        }
                        if let Some((name, _)) = word.split_once('=') {
                            if protected(name) || dynamic_name(name) {
                                return true;
                            }
                            env_index += 1;
                            continue;
                        }
                        if word.starts_with('-') {
                            env_index += 1;
                            continue;
                        }
                        break;
                    }
                    false
                }
                _ => false,
            }
        })
}

pub(crate) fn test_command_has_narrow_scope(command: &str) -> bool {
    test_command_invocations(command)
        .iter()
        .any(test_invocation_has_narrow_scope)
}

fn test_invocation_has_narrow_scope(invocation: &ShellCommandInvocation) -> bool {
    if test_invocation_skips_execution(invocation) {
        return true;
    }
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    if program == "cargo" {
        let Some(test_command) = invocation
            .args
            .iter()
            .position(|arg| matches!(arg.as_str(), "test" | "nextest"))
        else {
            return false;
        };
        let mut skip_value = false;
        for token in invocation.args.iter().skip(test_command + 1) {
            if skip_value {
                skip_value = false;
                continue;
            }
            if matches!(
                token.as_str(),
                "-p" | "--package" | "--manifest-path" | "--features" | "--jobs" | "-j"
            ) {
                skip_value = true;
                continue;
            }
            if token == "--" {
                break;
            }
            if token == "--no-run" {
                return true;
            }
            if !token.starts_with('-') {
                return true;
            }
        }
        return false;
    }

    let args = if python_interpreter_program(program) {
        if let Some(pytest_module) = invocation
            .args
            .windows(2)
            .position(|window| window == ["-m", "pytest"])
        {
            &invocation.args[pytest_module + 2..]
        } else if let Some(unittest_module) = invocation
            .args
            .windows(2)
            .position(|window| window == ["-m", "unittest"])
        {
            // Here `-m` is Python's module-launch option, not a pytest marker.
            &invocation.args[unittest_module + 2..]
        } else if let Some(test_script) = invocation.args.iter().position(|arg| {
            arg.ends_with("/bin/test") || arg == "bin/test" || arg.ends_with("runtests.py")
        }) {
            &invocation.args[test_script + 1..]
        } else {
            invocation.args.as_slice()
        }
    } else {
        invocation.args.as_slice()
    };

    args.iter().any(|token| {
        token == "-k"
            || token.starts_with("-k=")
            || token == "--keyword"
            || token.starts_with("--keyword=")
            || token == "-x"
            || token == "--exitfirst"
            || token == "--maxfail"
            || token.starts_with("--maxfail=")
            || token == "-m"
            || token.starts_with("-m=")
            || token == "--deselect"
            || token.starts_with("--deselect=")
            || token == "--ignore"
            || token.starts_with("--ignore=")
            || token == "--ignore-glob"
            || token.starts_with("--ignore-glob=")
            || token == "--collect-only"
            || token == "--collectonly"
            || token == "--co"
            || token == "-co"
            || token == "--lf"
            || token == "--last-failed"
            || token == "--ff"
            || token == "--failed-first"
            || token == "--run"
            || token.starts_with("--run=")
            || token == "-run"
            || token == "-t"
            || token.starts_with("-t=")
            || token == "-g"
            || token == "--grep"
            || token.starts_with("--grep=")
            || token == "--filter"
            || token.starts_with("--filter=")
            || token.starts_with("-Dtest=")
            || token == "--tests"
            || token.starts_with("--tests=")
            || token == "testOnly"
            || token == "--only"
            || token.starts_with("--only=")
            || token == "--name"
            || token.starts_with("--name=")
            || token == "--testnamepattern"
            || token.starts_with("--testnamepattern=")
            || token == "--test-name-pattern"
            || token.starts_with("--test-name-pattern=")
            || token == "--test-skip-pattern"
            || token.starts_with("--test-skip-pattern=")
            || token.contains("::")
            || token
                .strip_prefix("--override-ini=")
                .is_some_and(|value| value.trim_start().starts_with("addopts="))
            || token.strip_prefix("-o").is_some_and(|value| {
                !value.is_empty() && value.trim_start().starts_with("addopts=")
            })
    }) || args.windows(2).any(|window| {
        matches!(window[0].as_str(), "-o" | "--override-ini")
            && window[1].trim_start().starts_with("addopts=")
    })
}

/// Reject commands that only collect, list, show help, or perform setup without
/// running test bodies. Such runner meta-commands often exit 0 but cannot serve as Goal Pro completion evidence.
pub(crate) fn test_command_skips_execution(command: &str) -> bool {
    shell_command_invocations(command)
        .iter()
        .filter(|invocation| test_invocation(invocation))
        .any(test_invocation_skips_execution)
}

fn test_invocation_skips_execution(invocation: &ShellCommandInvocation) -> bool {
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str())
        .to_ascii_lowercase();
    let args = invocation
        .args
        .iter()
        .map(|argument| argument.to_ascii_lowercase())
        .collect::<Vec<_>>();

    if args.iter().any(|argument| {
        matches!(
            argument.as_str(),
            "--collect-only"
                | "--collectonly"
                | "--co"
                | "-co"
                | "--no-run"
                | "--help"
                | "-h"
                | "--version"
                | "--fixtures"
                | "--fixtures-per-test"
                | "--setup-only"
                | "--setup-plan"
                | "--list"
                | "--list-tests"
                | "--listtests"
                | "--showconfig"
                | "--dry-run"
        )
    }) {
        return true;
    }

    if args
        .windows(2)
        .any(|window| window[0] == "-x" && window[1] == "test")
    {
        return true;
    }
    if args.iter().any(|argument| {
        matches!(
            argument.as_str(),
            "-dskiptests"
                | "-dskiptests=true"
                | "-dskipits"
                | "-dskipits=true"
                | "-dmaven.test.skip=true"
        ) || argument.starts_with("-list=")
    }) {
        return true;
    }

    (program == "cargo" && invocation.args.iter().any(|argument| argument == "-V"))
        || (program == "ctest" && args.iter().any(|argument| argument == "-n"))
        || ((program == "gradle" || program == "gradlew")
            && args.iter().any(|argument| argument == "-m"))
}

pub(crate) fn test_command_preserves_raw_exit(command: &str) -> bool {
    if shell_has_unquoted_pipe(command) || command_may_mask_failure(command) {
        return false;
    }
    let invocations = shell_command_invocations(command);
    let Some(last_test) = invocations
        .iter()
        .rposition(invocation_preserves_target_test_exit)
    else {
        return false;
    };
    // The ToolResult exit_code for `pytest; echo $?` belongs to echo, not pytest.
    // A leading `cd ... &&` is acceptable, but any command after the test invalidates original-exit-code evidence.
    last_test + 1 == invocations.len()
}

fn invocation_preserves_target_test_exit(invocation: &ShellCommandInvocation) -> bool {
    if test_invocation(invocation) {
        return true;
    }
    let Some(nested) = docker_exec_nested_command(invocation) else {
        return false;
    };
    match nested {
        DockerExecNestedCommand::Shell(command) => test_command_preserves_raw_exit(&command),
        DockerExecNestedCommand::Direct(command) => test_invocation(&command),
    }
}

pub(crate) fn verifier_test_command_rejection(
    command: &str,
    minimum_scope: Option<GoalProTestScope>,
    require_raw_exit_code: bool,
) -> Option<String> {
    if !test_like_command(command) {
        return None;
    }
    if require_raw_exit_code && !test_command_preserves_raw_exit(command) {
        return Some(
            "Goal Pro verifier test guard rejected this command before execution because a pipe, failure-masking operator, or trailing command would hide the test process's original exit status. Run the test command directly in this tool call; Bash already returns `exit_code`."
                .to_string(),
        );
    }
    if minimum_scope == Some(GoalProTestScope::TargetSuite)
        && test_command_has_narrow_scope(command)
    {
        return Some(
            "Goal Pro verifier test guard rejected this incomplete or narrowly selected command before execution. The configured `target_suite` scope does not accept fail-fast options (`-x`, `--exitfirst`, `--maxfail`), `-k`, markers, `::test`, test-name filters, or a single Cargo test filter. Run the affected target test module or suite to completion without those selectors."
                .to_string(),
        );
    }
    None
}

fn verifier_baseline_command_rejection(
    command: &str,
    invocation_cwd: &Path,
    baseline_root: Option<&Path>,
    allow_behavior_probe: bool,
) -> Option<String> {
    let baseline_root = baseline_root?;
    let invocations = shell_command_invocations(command);
    let test = invocations
        .iter()
        .find(|invocation| test_invocation(invocation));
    let runs_in_baseline = invocation_cwd.starts_with(baseline_root);
    let mentions_baseline = command.contains(&baseline_root.to_string_lossy().to_string());
    if !runs_in_baseline && !mentions_baseline {
        return None;
    }
    let behavior_probe = allow_behavior_probe && behavior_probe_command(command);
    let native_build = verifier_native_build_command_signature(command).is_some();
    if test.is_none() && !behavior_probe && !native_build {
        return Some(
            "Goal Pro verifier baseline guard rejected this command. The pristine baseline is available only for rerunning an actual test command, the exact same typed native build recipe used on the candidate, or, when configured, the exact same direct read-only `python -c` behavior probe; arbitrary inspection, copying, editing, archiving, filtering, and cleanup are forbidden."
                .to_string(),
        );
    }
    if mentions_baseline {
        return Some(if runs_in_baseline {
            "Goal Pro verifier baseline guard rejected a redundant shell-level baseline path. Keep the test selector relative to the pristine baseline workdir and run the exact same command used for the candidate."
                .to_string()
        } else {
            "Goal Pro verifier baseline guard rejected an absolute pristine-baseline path while the Bash workdir was not the baseline. Keep the test selector relative, set the Bash `workdir` field to the pristine baseline, and run the exact same command used for the candidate."
                .to_string()
        });
    }
    if runs_in_baseline && command.contains("kcoder-goal-worktree-") {
        return Some(
            "Goal Pro verifier baseline guard rejected this mixed candidate/baseline command. Run the exact candidate test and exact baseline test as separate Bash calls so their raw results can be paired."
                .to_string(),
        );
    }
    if !native_build && (baseline_mutation_command(command) || dependency_mutation_command(command))
    {
        return Some(
            "Goal Pro verifier baseline guard rejected a mutating baseline command. The engine-provided pristine baseline is read-only and may only run tests."
                .to_string(),
        );
    }
    None
}

fn shell_has_unquoted_redirection(command: &str) -> bool {
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            '<' | '>' if !single_quote && !double_quote => return true,
            _ => {}
        }
    }
    false
}

fn baseline_mutation_command(command: &str) -> bool {
    shell_command_invocations(command)
        .into_iter()
        .any(|invocation| {
            let program = invocation
                .program
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(invocation.program.as_str());
            let args = invocation.args.as_slice();
            matches!(
                program,
                "rm" | "mv"
                    | "cp"
                    | "mkdir"
                    | "rmdir"
                    | "touch"
                    | "truncate"
                    | "install"
                    | "patch"
                    | "tee"
                    | "chmod"
                    | "chown"
                    | "chgrp"
                    | "ln"
                    | "apply_patch"
            ) || program == "git" && git_invocation_mutates_workspace(args)
                || program == "sed" && args.iter().any(|arg| arg == "-i" || arg.starts_with("-i"))
                || shell_has_unquoted_output_redirection(command)
        })
}

fn test_invocation(invocation: &ShellCommandInvocation) -> bool {
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    // Windows resolves npm/pnpm/yarn through `.cmd`/`.bat` shims (execution
    // policy blocks the `.ps1` form) and full-path invocations carry `.exe`.
    let program = program
        .strip_suffix(".cmd")
        .or_else(|| program.strip_suffix(".exe"))
        .or_else(|| program.strip_suffix(".bat"))
        .unwrap_or(program);
    let args = invocation.args.as_slice();
    match program {
        // The program itself is a test runner.
        "pytest" | "py.test" | "tox" | "nox" | "ctest" | "phpunit" | "paratest" | "pest"
        | "rspec" | "prove" | "bats" | "jest" | "vitest" | "mocha" | "jasmine" | "ava" | "tape"
        | "tap" | "uvu" | "Invoke-Pester" => true,
        "cargo" => args
            .first()
            .is_some_and(|arg| matches!(arg.as_str(), "test" | "nextest")),
        _ if python_interpreter_program(program) => {
            args.windows(2)
                .any(|window| window == ["-m", "pytest"] || window == ["-m", "unittest"])
                || args.iter().any(|arg| {
                    arg.ends_with("/bin/test") || arg == "bin/test" || arg.ends_with("runtests.py")
                })
                // `python manage.py test` (Django) and `python setup.py test`
                // (legacy setuptools) are the standard Python test entries.
                || args.windows(2).any(|window| {
                    matches!(window[0].as_str(), "manage.py" | "setup.py") && window[1] == "test"
                })
        }
        "runtests.py" => true,
        "test" => invocation.program.ends_with("/bin/test"),
        "npm" | "pnpm" | "yarn" | "bun" => package_manager_test(args),
        "deno" => args.iter().any(|arg| arg == "test"),
        "make" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "check")),
        "go" => args.first().is_some_and(|arg| arg == "test"),
        "mvn" | "mvnw" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "verify")),
        "gradle" | "gradlew" => args
            .iter()
            .any(|arg| arg == "test" || arg.ends_with(":test")),
        "sbt" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "testOnly")),
        "bazel" | "bazelisk" => args.iter().any(|arg| arg == "test"),
        "lein" => args.iter().any(|arg| arg == "test"),
        "stack" => args.iter().any(|arg| arg == "test"),
        "cabal" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "v2-test")),
        "dotnet" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "vstest")),
        "swift" => args.iter().any(|arg| arg == "test"),
        "mix" => args.iter().any(|arg| arg == "test"),
        "dart" | "flutter" => args.iter().any(|arg| arg == "test"),
        "ninja" => args.iter().any(|arg| arg == "test"),
        "meson" => args.iter().any(|arg| arg == "test"),
        "zig" => args.iter().any(|arg| arg == "test"),
        "dune" => args.iter().any(|arg| arg == "runtest"),
        "nimble" => args.iter().any(|arg| arg == "test"),
        "crystal" => args.iter().any(|arg| arg == "spec"),
        "rebar3" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "eunit" | "ct" | "test")),
        "rake" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "spec")),
        "hatch" => args.iter().any(|arg| arg == "test"),
        "pdm" => args.iter().any(|arg| arg == "test"),
        "karma" => args.iter().any(|arg| arg == "start"),
        "cypress" => args.iter().any(|arg| arg == "run"),
        "playwright" => args.iter().any(|arg| arg == "test"),
        "ng" => args.iter().any(|arg| arg == "test"),
        "react-scripts" => args.iter().any(|arg| arg == "test"),
        "node" => node_test_invocation(args),
        "php" => args
            .iter()
            .any(|arg| arg.ends_with("phpunit") || arg.ends_with("pest")),
        // Wrappers that delegate to another command; classify what they run.
        "npx" | "pnpx" | "uv" | "poetry" | "pipenv" | "conda" | "bundle" | "mise" => {
            wrapper_test_invocation(args)
        }
        // Task runners that delegate to a named task.
        "just" | "task" | "nx" => task_runner_test(args),
        "lerna" | "turbo" => args
            .windows(2)
            .any(|window| window[0] == "run" && test_task_name(&window[1])),
        _ => false,
    }
}

/// npm/pnpm/yarn/bun run tests through the `test` script, the `run`/`exec`
/// subcommand with a test task name, or by directly invoking a bundled runner
/// binary (`yarn jest`). Installing a package must never look like a test.
fn package_manager_test(args: &[String]) -> bool {
    args.first().is_some_and(|arg| arg == "test")
        || args.windows(2).any(|window| {
            matches!(window[0].as_str(), "run" | "exec") && test_task_name(&window[1])
        })
        || args.first().is_some_and(|arg| test_runner_word(arg))
}

/// Wrappers such as `npx`, `uv run`, `poetry run`, and `bundle exec` execute
/// another command; classify every suffix of their arguments as a potential
/// invocation, mirroring the nested `docker exec` handling.
fn wrapper_test_invocation(args: &[String]) -> bool {
    for index in 0..args.len() {
        let invocation = ShellCommandInvocation {
            program: args[index].clone(),
            args: args[index + 1..].to_vec(),
        };
        if test_invocation(&invocation) {
            return true;
        }
    }
    false
}

/// Task runners such as `just`, `task`, and `nx` execute a named task; `test`
/// and `test:*` task names are test runs.
fn task_runner_test(args: &[String]) -> bool {
    args.first().is_some_and(|arg| test_task_name(arg))
        || args
            .windows(2)
            .any(|window| window[0] == "run" && test_task_name(&window[1]))
}

fn test_task_name(name: &str) -> bool {
    name == "test" || name.starts_with("test:")
}

/// Unambiguous test-runner program names, usable both as a program and as a
/// bare word inside a wrapper invocation (`yarn jest`, `npx playwright test`).
fn test_runner_word(word: &str) -> bool {
    matches!(
        word,
        "pytest"
            | "py.test"
            | "tox"
            | "nox"
            | "phpunit"
            | "paratest"
            | "pest"
            | "rspec"
            | "prove"
            | "bats"
            | "jest"
            | "vitest"
            | "mocha"
            | "jasmine"
            | "ava"
            | "tape"
            | "tap"
            | "uvu"
    )
}

/// `node --test` launches the built-in test runner; the flag must sit among
/// node's own options, before the first positional script path. Option values
/// (for example the `tap` in `--test-reporter tap`) are not scripts, so only a
/// path-like argument starts the script boundary. A plain `node <script>`
/// counts only when the script path follows the common JavaScript test-file
/// conventions.
fn node_test_invocation(args: &[String]) -> bool {
    args.iter()
        .take_while(|arg| !node_script_boundary(arg))
        .any(|arg| arg == "--test")
        || args.iter().any(|arg| node_test_script_argument(arg))
}

/// True for the first positional argument that looks like a script path;
/// anything after it belongs to the script, not to node.
fn node_script_boundary(argument: &str) -> bool {
    !argument.starts_with('-')
        && (argument.contains('/') || argument.contains('\\') || argument.contains('.'))
}

/// Recognize `test.js`, `*.test.js`, `*-test.js`, and `*.spec.js` (plus their
/// `.mjs`/`.cjs` forms) as JavaScript test scripts.
fn node_test_script_argument(argument: &str) -> bool {
    if argument.starts_with('-') {
        return false;
    }
    let name = argument.rsplit(['/', '\\']).next().unwrap_or(argument);
    let Some(stem) = name
        .strip_suffix(".js")
        .or_else(|| name.strip_suffix(".mjs"))
        .or_else(|| name.strip_suffix(".cjs"))
    else {
        return false;
    };
    stem == "test" || stem.ends_with(".test") || stem.ends_with("-test") || stem.ends_with(".spec")
}

fn shell_has_unquoted_pipe(command: &str) -> bool {
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            '|' if !single_quote && !double_quote => return true,
            _ => {}
        }
    }
    false
}

fn shell_has_unquoted_control_operator(command: &str) -> bool {
    shell_has_unquoted_character(command, |character| {
        matches!(character, ';' | '\n' | '|' | '&')
    })
}

fn shell_has_command_substitution(command: &str) -> bool {
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    let mut characters = command.chars().peekable();
    while let Some(character) = characters.next() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            '`' if !single_quote => return true,
            '$' if !single_quote && characters.peek() == Some(&'(') => return true,
            _ => {}
        }
    }
    false
}

fn shell_has_unquoted_variable_expansion(command: &str) -> bool {
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            '$' if !single_quote => return true,
            _ => {}
        }
    }
    false
}

fn shell_has_unquoted_character(command: &str, predicate: impl Fn(char) -> bool) -> bool {
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            character if !single_quote && !double_quote && predicate(character) => return true,
            _ => {}
        }
    }
    false
}

pub(crate) fn dependency_mutation_command(command: &str) -> bool {
    for invocation in shell_command_invocations(command) {
        let program = invocation
            .program
            .rsplit('/')
            .next()
            .unwrap_or(invocation.program.as_str());
        let remaining = invocation.args.as_slice();
        let has_action = |actions: &[&str]| {
            remaining
                .iter()
                .any(|candidate| actions.contains(&candidate.as_str()))
        };
        match program {
            "pip" | "pip3" | "pipx"
                if has_action(&["install", "uninstall", "inject", "upgrade"]) =>
            {
                return true;
            }
            "conda" | "mamba" | "micromamba"
                if has_action(&[
                    "install",
                    "uninstall",
                    "remove",
                    "update",
                    "upgrade",
                    "create",
                ]) =>
            {
                return true;
            }
            "uv" if has_action(&["install", "uninstall", "sync", "add", "remove", "lock"]) => {
                return true;
            }
            "poetry" | "pdm"
                if has_action(&["install", "update", "add", "remove", "sync", "lock"]) =>
            {
                return true;
            }
            "npm" | "pnpm" | "yarn"
                if has_action(&[
                    "install",
                    "i",
                    "ci",
                    "add",
                    "remove",
                    "uninstall",
                    "update",
                    "upgrade",
                ]) =>
            {
                return true;
            }
            "cargo" if has_action(&["install", "uninstall", "update"]) => return true,
            "gem" if has_action(&["install", "uninstall", "update"]) => return true,
            "bundle" | "bundler" if has_action(&["install", "update"]) => return true,
            "apt" | "apt-get" | "dnf" | "yum" | "apk" | "pacman" | "brew"
                if has_action(&[
                    "install",
                    "remove",
                    "uninstall",
                    "update",
                    "upgrade",
                    "add",
                    "del",
                ]) =>
            {
                return true;
            }
            _ if python_interpreter_program(program)
                && remaining.windows(2).any(|window| {
                    window[0] == "pip"
                        && matches!(window[1].as_str(), "install" | "uninstall" | "upgrade")
                }) =>
            {
                return true;
            }
            _ => {}
        }
    }
    false
}

#[cfg(test)]
pub(crate) fn workspace_mutation_command(command: &str) -> bool {
    if dependency_mutation_command(command) || shell_has_unquoted_output_redirection(command) {
        return true;
    }
    for invocation in shell_command_invocations(command) {
        let program = invocation
            .program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(invocation.program.as_str());
        let args = invocation.args.as_slice();
        match program {
            "rm" | "mv" | "cp" | "mkdir" | "rmdir" | "touch" | "truncate" | "install" | "patch"
            | "tee" | "chmod" | "chown" | "chgrp" | "ln" | "apply_patch" | "set-content"
            | "add-content" | "out-file" | "remove-item" | "move-item" | "copy-item"
            | "new-item" | "rename-item" | "clear-content" => {
                return true;
            }
            "sed" if args.iter().any(|arg| arg == "-i" || arg.starts_with("-i")) => {
                return true;
            }
            "perl" | "ruby"
                if args
                    .iter()
                    .any(|arg| arg == "-pi" || arg.starts_with("-pi")) =>
            {
                return true;
            }
            "git" if git_invocation_mutates_workspace(args) => return true,
            "cargo"
                if args.first().is_some_and(|arg| arg == "fmt")
                    && !args.iter().any(|arg| arg == "--check") =>
            {
                return true;
            }
            _ => {}
        }
    }
    false
}

fn git_invocation_mutates_workspace(args: &[String]) -> bool {
    let Some((index, command)) = args
        .iter()
        .enumerate()
        .find(|(_, arg)| !arg.starts_with('-'))
    else {
        return false;
    };
    if command == "stash" {
        return !matches!(
            args.get(index + 1).map(String::as_str),
            Some("list" | "show")
        );
    }
    matches!(
        command.as_str(),
        "add"
            | "apply"
            | "checkout"
            | "clean"
            | "commit"
            | "merge"
            | "mv"
            | "rebase"
            | "reset"
            | "restore"
            | "rm"
            | "switch"
    )
}

fn shell_has_unquoted_output_redirection(command: &str) -> bool {
    let characters = command.chars().collect::<Vec<_>>();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for (index, character) in characters.iter().copied().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            '>' if !single_quote && !double_quote => {
                let mut target_index = index + 1;
                if characters.get(target_index) == Some(&'>')
                    || characters.get(target_index) == Some(&'|')
                {
                    target_index += 1;
                }
                while characters
                    .get(target_index)
                    .is_some_and(|value| value.is_whitespace())
                {
                    target_index += 1;
                }
                if characters.get(target_index) == Some(&'&')
                    || characters.get(target_index) == Some(&'(')
                {
                    continue;
                }
                let target = characters[target_index..]
                    .iter()
                    .take_while(|value| !value.is_whitespace() && !matches!(value, ';' | '&' | '|'))
                    .collect::<String>()
                    .trim_matches(['\'', '"'])
                    .to_ascii_lowercase();
                if !matches!(
                    target.as_str(),
                    "/dev/null"
                        | "/dev/stdout"
                        | "/dev/stderr"
                        | "/proc/self/fd/1"
                        | "/proc/self/fd/2"
                        | "nul"
                        | "nul:"
                ) && !target.starts_with("/tmp/")
                    && !target.starts_with("$tmpdir/")
                    && !target.starts_with("${tmpdir}/")
                {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShellCommandInvocation {
    program: String,
    args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DockerExecNestedCommand {
    Shell(String),
    Direct(ShellCommandInvocation),
}

/// Extract the command actually run by `docker exec` or `podman exec`. Target
/// tests may live inside a task container while the host Bash exit code still
/// equals the container command's exit code. Auditing only the outer `docker`
/// would make machine gates misclassify a real pytest run as no test execution.
fn docker_exec_nested_command(
    invocation: &ShellCommandInvocation,
) -> Option<DockerExecNestedCommand> {
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    if !matches!(program, "docker" | "podman") || invocation.args.first()? != "exec" {
        return None;
    }

    let mut index = 1usize;
    while let Some(argument) = invocation.args.get(index) {
        if argument == "--" {
            index += 1;
            break;
        }
        if !argument.starts_with('-') || argument == "-" {
            break;
        }
        let consumes_value = matches!(
            argument.as_str(),
            "-e" | "--env" | "--env-file" | "--detach-keys" | "-u" | "--user" | "-w" | "--workdir"
        );
        index += 1;
        if consumes_value {
            index += 1;
        }
    }

    // Container name.
    index += 1;
    let nested_program = invocation.args.get(index)?.clone();
    let nested_args = invocation.args.get(index + 1..)?.to_vec();
    let basename = nested_program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(nested_program.as_str());
    if matches!(basename, "bash" | "sh" | "dash" | "zsh" | "ksh")
        && let Some(command_index) = nested_args
            .iter()
            .position(|argument| matches!(argument.as_str(), "-c" | "-lc"))
        && let Some(command) = nested_args.get(command_index + 1)
    {
        return Some(DockerExecNestedCommand::Shell(command.clone()));
    }

    Some(DockerExecNestedCommand::Direct(ShellCommandInvocation {
        program: nested_program,
        args: nested_args,
    }))
}

fn test_command_invocations(command: &str) -> Vec<ShellCommandInvocation> {
    test_command_invocations_inner(command, 0)
}

fn test_command_invocations_inner(command: &str, depth: usize) -> Vec<ShellCommandInvocation> {
    let mut tests = Vec::new();
    for invocation in shell_command_invocations(command) {
        if test_invocation(&invocation) {
            tests.push(invocation.clone());
        }
        if depth >= 4 {
            continue;
        }
        match docker_exec_nested_command(&invocation) {
            Some(DockerExecNestedCommand::Shell(command)) => {
                tests.extend(test_command_invocations_inner(&command, depth + 1));
            }
            Some(DockerExecNestedCommand::Direct(command)) if test_invocation(&command) => {
                tests.push(command);
            }
            _ => {}
        }
    }
    tests
}

/// Treat only the first command word after a shell control operator as a program,
/// avoiding false execution matches for `find -name install` or paths containing `patch`.
fn shell_command_invocations(command: &str) -> Vec<ShellCommandInvocation> {
    split_unquoted_shell_segments(command)
        .into_iter()
        .filter_map(|segment| shell_segment_invocation(&segment))
        .collect()
}

fn split_unquoted_shell_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            current.push(character);
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => {
                single_quote = !single_quote;
                current.push(character);
            }
            '"' if !single_quote => {
                double_quote = !double_quote;
                current.push(character);
            }
            ';' | '\n' | '|' | '&' if !single_quote && !double_quote => {
                if !current.trim().is_empty() {
                    segments.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if !current.trim().is_empty() {
        segments.push(current);
    }
    segments
}

fn shell_segment_invocation(segment: &str) -> Option<ShellCommandInvocation> {
    let tokens = shell_words(segment)?;
    let mut index = 0usize;
    while index < tokens.len()
        && (shell_assignment(&tokens[index]) || shell_redirection_token(&tokens[index]))
    {
        index += 1;
    }
    loop {
        let wrapper_token = tokens.get(index)?;
        let wrapper = wrapper_token
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(wrapper_token.as_str());
        match wrapper {
            "command" | "builtin" | "exec" | "nohup" => {
                index += 1;
                while tokens
                    .get(index)
                    .is_some_and(|token| token.starts_with('-'))
                {
                    index += 1;
                }
            }
            "env" => {
                index += 1;
                while let Some(token) = tokens.get(index) {
                    if shell_assignment(token) {
                        index += 1;
                        continue;
                    }
                    if matches!(token.as_str(), "-u" | "--unset" | "-C" | "--chdir") {
                        // These env options consume a value; do not mistake the variable name or directory for the program that follows.
                        index = index.saturating_add(2);
                        continue;
                    }
                    if token.starts_with("--unset=")
                        || token.starts_with("--chdir=")
                        || token.starts_with('-')
                    {
                        index += 1;
                        continue;
                    }
                    break;
                }
            }
            "timeout" => {
                index += 1;
                while tokens
                    .get(index)
                    .is_some_and(|token| token.starts_with('-'))
                {
                    index += 1;
                }
                // The first non-option timeout argument is the duration; the actual program follows it.
                index = index.saturating_add(1);
            }
            _ => break,
        }
    }
    let program = tokens.get(index)?.clone();
    Some(ShellCommandInvocation {
        program,
        args: tokens[index + 1..].to_vec(),
    })
}

/// Parse simple shell words for verifier auditing while preserving spaces inside
/// quotes and Python `-c` bodies. Fail closed on unclosed quotes; an earlier guard
/// continues to reject complex shell syntax.
pub(crate) fn shell_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            character if character.is_whitespace() && !single_quote && !double_quote => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if escaped || single_quote || double_quote {
        return None;
    }
    if !current.is_empty() {
        words.push(current);
    }
    Some(words)
}

fn shell_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.chars().enumerate().all(|(index, character)| {
            character == '_'
                || character.is_ascii_alphanumeric() && (index > 0 || !character.is_ascii_digit())
        })
}

fn shell_redirection_token(token: &str) -> bool {
    token.starts_with('<')
        || token.starts_with('>')
        || token
            .split_once(['<', '>'])
            .is_some_and(|(prefix, _)| prefix.chars().all(|character| character.is_ascii_digit()))
}

fn scoped_shell_command_is_read_only(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.contains('>')
        || trimmed.contains("$(")
        || trimmed.contains("${")
        || trimmed.contains(char::from(96))
        || trimmed.contains("<(")
        || trimmed.contains(">(")
        || trimmed.replace("&&", "").contains('&')
    {
        return false;
    }
    let normalized = trimmed.replace("&&", ";").replace("||", ";");
    normalized
        .split([';', '\n', '|'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .all(scoped_shell_segment_is_read_only)
}

/// Check that a restricted implementer's command is entirely within prefixes explicitly delegated by the parent orchestrator.
///
/// This is not a complete shell parser, so it fails closed on host output
/// redirection, command substitution, unclosed quotes, or unauthorized top-level
/// command segments. External commands receive single-quoted content without host
/// expansion; input redirection may pass an authorized staged file into a container.
pub(crate) fn scoped_shell_command_matches_allowed_prefixes(
    command: &str,
    allowed_prefixes: &[String],
) -> bool {
    if allowed_prefixes.is_empty() {
        return false;
    }
    let Some(segments) = delegated_shell_segments(command) else {
        return false;
    };
    !segments.is_empty()
        && segments.iter().all(|segment| {
            scoped_shell_segment_is_read_only(segment)
                || allowed_prefixes
                    .iter()
                    .any(|prefix| shell_segment_has_literal_prefix(segment, prefix))
        })
}

fn shell_segment_has_literal_prefix(segment: &str, prefix: &str) -> bool {
    let segment = segment.trim();
    let prefix = prefix.trim();
    !prefix.is_empty()
        && (segment == prefix
            || segment
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.chars().next().is_some_and(char::is_whitespace)))
}

fn delegated_shell_segments(command: &str) -> Option<Vec<String>> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    let characters = command.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    while index < characters.len() {
        let character = characters[index];
        if escaped {
            current.push(character);
            escaped = false;
            index += 1;
            continue;
        }
        if character == '\\' && !single_quote {
            current.push(character);
            escaped = true;
            index += 1;
            continue;
        }
        match character {
            '\'' if !double_quote => {
                single_quote = !single_quote;
                current.push(character);
            }
            '"' if !single_quote => {
                double_quote = !double_quote;
                current.push(character);
            }
            '`' if !single_quote => return None,
            '$' if !single_quote
                && characters
                    .get(index + 1)
                    .is_some_and(|next| matches!(next, '(' | '{')) =>
            {
                return None;
            }
            '>' if !single_quote && !double_quote => return None,
            '<' if !single_quote
                && !double_quote
                && characters.get(index + 1).is_some_and(|next| *next == '(') =>
            {
                return None;
            }
            ';' | '|' | '&' | '\n' if !single_quote && !double_quote => {
                if !current.trim().is_empty() {
                    segments.push(std::mem::take(&mut current));
                }
                if matches!(character, '|' | '&')
                    && characters
                        .get(index + 1)
                        .is_some_and(|next| *next == character)
                {
                    index += 1;
                }
            }
            _ => current.push(character),
        }
        index += 1;
    }
    if escaped || single_quote || double_quote {
        return None;
    }
    if !current.trim().is_empty() {
        segments.push(current);
    }
    Some(segments)
}

fn scoped_shell_segment_is_read_only(segment: &str) -> bool {
    let tokens = shell_tokens(segment);
    let Some((command_index, command)) = tokens
        .iter()
        .enumerate()
        .find(|(_, token)| !token.contains('='))
    else {
        return true;
    };
    if command_index != 0 {
        // Environment assignments can inject dynamic libraries or redirect
        // tool behavior, so scoped inspection does not accept them.
        return false;
    }
    let args = &tokens[1..];
    match command.as_str() {
        "pwd" | "ls" | "cat" | "head" | "tail" | "wc" | "cut" | "stat" | "du" | "df" | "which"
        | "whereis" | "realpath" | "readlink" | "dirname" | "basename" | "printf" | "echo"
        | "grep" => true,
        "rg" => !args.iter().any(|arg| {
            arg == "--pre" || arg.starts_with("--pre=") || arg.starts_with("--pre-glob")
        }),
        "find" => !args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "-delete"
                    | "-exec"
                    | "-execdir"
                    | "-ok"
                    | "-okdir"
                    | "-fprint"
                    | "-fprint0"
                    | "-fprintf"
                    | "-fls"
            )
        }),
        _ => false,
    }
}

fn shell_tokens(command: &str) -> Vec<String> {
    command
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '{' | '}'))
        .map(|token| token.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | ',')))
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background::BackgroundJobEvent;
    use crate::{BackgroundJobSpawner, SpawnError};
    use kcoder_state::AppState;
    use std::collections::HashMap;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;

    #[test]
    fn bash_fallback_timeout_is_five_minutes() {
        assert_eq!(DEFAULT_TIMEOUT_MS, 300_000);
    }

    #[test]
    fn verifier_dependency_guard_detects_common_environment_mutations() {
        for command in [
            "pip install -e .",
            "python -m pip uninstall pytest -y",
            "/root/miniconda3/bin/conda install sphinx",
            "uv sync",
            "npm ci",
            "cargo install cargo-nextest",
            "apt-get update",
        ] {
            assert!(dependency_mutation_command(command), "{command}");
        }
        for command in [
            "pytest tests",
            "python -m pytest tests",
            "cargo test --workspace",
            "npm test",
            "git diff -- tests",
            "find . -name pip -o -name install",
            "printf '%s\\n' 'pip install'",
        ] {
            assert!(!dependency_mutation_command(command), "{command}");
        }
        assert!(dependency_mutation_command(
            "cd project && /usr/bin/env PYTHONNOUSERSITE=1 python -m pip install -e ."
        ));
    }

    #[test]
    fn verifier_test_evidence_rejects_filters_and_narrow_selectors() {
        assert!(!test_command_preserves_raw_exit("pytest tests | tail -20"));
        assert!(!test_command_preserves_raw_exit("pytest tests || true"));
        assert!(test_command_preserves_raw_exit("pytest tests -q"));
        assert!(test_command_preserves_raw_exit(
            "env -u PYTHONPATH python -m pytest tests -q"
        ));
        assert!(test_like_command(
            "env --unset=PYTHONPATH python -m pytest tests -q"
        ));
        assert!(test_like_command("python -m unittest discover -s tests"));
        assert!(test_command_preserves_raw_exit(
            "python -m unittest discover -s tests"
        ));
        assert!(test_command_preserves_raw_exit(
            "cd tests && python runtests.py --parallel 1 2>/dev/null"
        ));
        assert!(!test_command_preserves_raw_exit(
            "pytest tests 2>/dev/null; echo $?"
        ));
        assert!(!test_like_command("rg pytest docs && echo pytest"));
        assert!(test_command_has_narrow_scope("pytest tests -k issue_123"));
        assert!(test_command_has_narrow_scope("pytest tests -x"));
        assert!(test_command_has_narrow_scope(
            "python -m pytest tests --exitfirst"
        ));
        assert!(test_command_has_narrow_scope("pytest tests --maxfail=1"));
        assert!(test_command_has_narrow_scope("pytest tests --maxfail 2"));
        assert!(!test_command_has_narrow_scope(
            "python -m pytest xarray/tests -q"
        ));
        assert!(!test_command_has_narrow_scope(
            "python3 -m pytest xarray/tests/test_dataset.py -q"
        ));
        assert!(!test_command_has_narrow_scope(
            "env -u PYTHONPATH python -m pytest xarray/tests -q"
        ));
        assert!(test_command_has_narrow_scope(
            "python -m pytest -m slow xarray/tests"
        ));
        assert!(test_command_has_narrow_scope("pytest -m slow xarray/tests"));
        assert!(test_command_has_narrow_scope(
            "pytest tests/test_x.py::test_case"
        ));
        assert!(test_command_has_narrow_scope(
            "cargo test -p crate_name one_test"
        ));
        assert!(test_command_has_narrow_scope("cargo test --no-run"));
        assert!(test_command_has_narrow_scope(
            "python -m pytest tests --collect-only"
        ));
        assert!(test_command_has_narrow_scope(
            "python -m pytest tests --ignore tests/test_required.py"
        ));
        assert!(test_command_has_narrow_scope(
            "python -m pytest tests --ignore-glob='*required*'"
        ));
        assert!(test_command_has_narrow_scope(
            "python -m pytest tests -o addopts='-k passing'"
        ));
        assert!(test_command_has_narrow_scope(
            "python -m pytest tests --override-ini=addopts='-m smoke'"
        ));
        for command in [
            "python -m pytest --version tests",
            "pytest --help tests",
            "pytest --setup-only tests",
            "pytest --fixtures tests",
            "cargo test -- --list",
            "./gradlew test --dry-run",
            "mvn test -DskipTests=true",
        ] {
            assert!(test_command_skips_execution(command), "{command}");
            assert!(test_command_has_narrow_scope(command), "{command}");
        }
        assert!(!test_command_skips_execution("pytest -v tests"));
        assert!(!test_command_has_narrow_scope(
            "cargo test -p crate_name --tests"
        ));
        assert!(
            verifier_test_command_rejection(
                "pytest tests 2>/dev/null; echo $?",
                Some(GoalProTestScope::TargetSuite),
                true,
            )
            .unwrap()
            .contains("original exit status")
        );
        assert!(
            verifier_test_command_rejection(
                "pytest tests/test_x.py::test_case",
                Some(GoalProTestScope::TargetSuite),
                true,
            )
            .unwrap()
            .contains("narrowly selected")
        );
        assert!(
            verifier_test_command_rejection(
                "pytest tests -q",
                Some(GoalProTestScope::TargetSuite),
                true,
            )
            .is_none()
        );
        assert_eq!(
            test_command_signature("python -m pytest tests/checkers -q"),
            test_command_signature(
                "PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider tests/checkers -q"
            )
        );
    }

    #[test]
    fn node_test_commands_are_recognized_as_target_tests() {
        // The built-in runner flag and the common JS test-file conventions both
        // count; a Goal Pro verifier that runs them must not be rejected with
        // "no target test command in its own session".
        for command in [
            "node --test",
            "node --test tests/app.test.js",
            "node --test-reporter tap --test spec/",
            "node test.js",
            "node ./tests/unit.test.mjs",
            "node src/widget.spec.js",
            "node C:/repo/workspace/test.js",
        ] {
            assert!(test_like_command(command), "{command}");
            assert!(test_command_preserves_raw_exit(command), "{command}");
            assert!(!test_command_has_narrow_scope(command), "{command}");
        }
        // Plain scripts, eval probes, and flags passed through to a script are
        // not test commands.
        for command in [
            "node server.js",
            "node -e \"require('./tests/app.test.js')\"",
            "node app.js --test",
            "node --version",
            "node run-tests-helper.js",
        ] {
            assert!(!test_like_command(command), "{command}");
        }
    }

    #[test]
    fn direct_test_runner_programs_are_recognized() {
        for command in [
            "jest",
            "vitest run",
            "mocha spec/",
            "jasmine",
            "ava",
            "tape test/*.js",
            "phpunit tests/Unit",
            "vendor/bin/phpunit --testsuite unit",
            "rspec spec/",
            "prove -l t/",
            "bats test/",
            "Invoke-Pester -Path tests",
        ] {
            assert!(test_like_command(command), "{command}");
        }
        for command in ["node server.js", "php index.php", "bundle install"] {
            assert!(!test_like_command(command), "{command}");
        }
    }

    #[test]
    fn subcommand_test_runners_are_recognized() {
        for command in [
            "dotnet test",
            "dotnet vstest tests/bin/app.dll",
            "swift test",
            "mix test",
            "dart test",
            "flutter test",
            "sbt test",
            "bazel test //...",
            "lein test",
            "stack test",
            "cabal test",
            "ninja -C build test",
            "meson test -C build",
            "zig build test",
            "dune runtest",
            "nimble test",
            "crystal spec",
            "rebar3 eunit",
            "rake test",
            "rake spec",
            "hatch test",
            "pdm test",
            "deno test",
            "deno task test",
            "playwright test",
            "cypress run",
            "ng test",
            "react-scripts test",
            "karma start",
            "python manage.py test",
            "python setup.py test",
            "php vendor/bin/phpunit",
        ] {
            assert!(test_like_command(command), "{command}");
        }
        for command in [
            "dotnet build",
            "swift build",
            "mix deps.get",
            "flutter pub get",
            "bazel build //...",
            "ninja -C build",
            "crystal build src/app.cr",
            "rake db:migrate",
            "deno run server.ts",
            "cypress open",
            "playwright install",
            "python manage.py runserver",
            "php artisan serve",
        ] {
            assert!(!test_like_command(command), "{command}");
        }
    }

    #[test]
    fn wrapper_and_task_runner_test_commands_are_recognized() {
        for command in [
            "npx jest",
            "npx playwright test",
            "npx mocha spec/",
            "uv run pytest -q",
            "poetry run pytest",
            "pipenv run pytest",
            "conda run pytest",
            "bundle exec rspec",
            "mise x -- pytest",
            "yarn jest",
            "pnpm vitest run",
            "npm run test",
            "npm run test:unit",
            "yarn run test",
            "pnpm run test",
            "bun run test",
            "just test",
            "task test",
            "nx test app",
            "lerna run test",
            "turbo run test",
        ] {
            assert!(test_like_command(command), "{command}");
        }
        // Installing or running a package must never look like a test.
        for command in [
            "npm install jest",
            "npm i vitest",
            "yarn add jest",
            "pnpm add vitest",
            "npx playwright install",
            "npx cowsay hello",
            "uv run server.js",
            "bundle exec rake db:migrate",
            "just deploy",
            "task build",
            "lerna run build",
            "turbo run build",
            "npm run build",
        ] {
            assert!(!test_like_command(command), "{command}");
        }
    }

    #[test]
    fn windows_cmd_wrapped_test_runners_are_recognized() {
        // Windows resolves npm/pnpm/yarn through .cmd/.bat shims (execution
        // policy blocks the .ps1 form) and full-path invocations carry .exe.
        for command in [
            "npm.cmd test",
            "npm test",
            "yarn.cmd test",
            "\"C:/Program Files/nodejs/node.exe\" --test",
        ] {
            assert!(test_like_command(command), "{command}");
        }
        assert!(
            !test_like_command("npm.cmd install"),
            "npm install is not a test"
        );
    }

    #[test]
    fn ecosystem_test_name_filters_are_narrow_scope() {
        for command in [
            "node --test --test-name-pattern=win",
            "node --test --test-skip-pattern slow",
            "jest -t \"login flow\"",
            "vitest -t=widget",
            "mocha -g \"api\"",
            "mocha --grep api",
            "playwright test --grep smoke",
            "go test -run TestParser ./...",
            "mvn -Dtest=AppTest test",
            "gradle test --tests com.app.AppTest",
            "sbt testOnly com.app.AppTest",
            "dotnet test --filter FullyQualifiedName~AppTest",
            "phpunit --filter testLogin",
            "bats --filter \"login\" test/",
            "mix test --only integration",
            "flutter test --name login",
        ] {
            assert!(test_command_has_narrow_scope(command), "{command}");
        }
        for command in [
            "node --test tests/app.test.js",
            "node test.js",
            "jest",
            "mocha spec/",
            "go test ./...",
            "mvn test",
            "gradle test",
            "dotnet test",
            "phpunit tests/Unit",
            "mix test",
            "flutter test",
        ] {
            assert!(!test_command_has_narrow_scope(command), "{command}");
        }
    }

    #[test]
    fn verifier_baseline_guard_allows_only_separate_read_only_test_runs() {
        let candidate = Path::new("/tmp/candidate/workspace");
        let baseline = Path::new("/tmp/baseline/workspace");
        assert!(
            verifier_baseline_command_rejection(
                "python -m pytest tests -q",
                baseline,
                Some(baseline),
                false,
            )
            .is_none()
        );
        assert!(
            verifier_baseline_command_rejection(
                "git -C /tmp/baseline/workspace diff",
                candidate,
                Some(baseline),
                false,
            )
            .unwrap()
            .contains("actual test")
        );
        assert!(
            verifier_baseline_command_rejection(
                "cd /tmp/baseline/workspace && python -m pytest tests -q",
                candidate,
                Some(baseline),
                false,
            )
            .unwrap()
            .contains("workdir")
        );
        assert!(
            verifier_baseline_command_rejection(
                "python -m pytest /tmp/baseline/workspace/tests/test_dataset.py -q",
                candidate,
                Some(baseline),
                false,
            )
            .unwrap()
            .contains("workdir was not the baseline")
        );
        assert!(
            verifier_baseline_command_rejection(
                "python -m pytest /tmp/baseline/workspace/tests/test_dataset.py -q",
                baseline,
                Some(baseline),
                false,
            )
            .unwrap()
            .contains("selector relative")
        );
        assert!(
            verifier_baseline_command_rejection(
                "git apply /tmp/kcoder-goal-worktree-candidate/workspace/fix.patch && pytest tests",
                baseline,
                Some(baseline),
                false,
            )
            .unwrap()
            .contains("mixed candidate/baseline")
        );
        assert!(
            verifier_baseline_command_rejection(
                "touch changed && pytest tests",
                baseline,
                Some(baseline),
                false,
            )
            .unwrap()
            .contains("mutating baseline")
        );
    }

    #[test]
    fn verifier_native_build_guard_accepts_only_typed_in_place_setuptools_builds() {
        for command in [
            "python setup.py build_ext --inplace",
            "python3 setup.py build_ext --inplace -j 4",
            "python3.11 ./setup.py build_ext --parallel=2 --inplace",
        ] {
            assert!(
                verifier_native_build_command_signature(command).is_some(),
                "{command}"
            );
        }

        for command in [
            "python setup.py build_ext",
            "python setup.py build_ext --inplace && touch tests/test_bad.py",
            "python setup.py build_ext --inplace > build.log",
            "/usr/bin/python3 setup.py build_ext --inplace",
            "python /tmp/setup.py build_ext --inplace",
            "python setup.py build_ext --inplace --build-lib /tmp/out",
            "python -m pip install -e .",
            "env -C /tmp python setup.py build_ext --inplace",
        ] {
            assert!(
                verifier_native_build_command_signature(command).is_none(),
                "{command}"
            );
        }

        let baseline = Path::new("/tmp/baseline/workspace");
        assert!(
            verifier_baseline_command_rejection(
                "python setup.py build_ext --inplace -j 4",
                baseline,
                Some(baseline),
                true,
            )
            .is_none()
        );
        assert!(
            verifier_native_build_execution_rejection(true, true,)
                .unwrap()
                .contains("foreground")
        );
        assert!(verifier_native_build_execution_rejection(false, true).is_none());
    }

    #[test]
    fn verifier_workdir_guard_rejects_shell_level_directory_changes_and_absolute_selectors() {
        for command in [
            "cd /tmp/original-workspace && python -m pytest tests -q",
            "pushd ../original && pytest tests -q",
            "env --chdir=/tmp/original pytest tests -q",
            "python -m pytest /tmp/original/tests/test_case.py -q",
            "pytest ../original/tests -q",
            "make -C ../original test",
            "source switch-dir.sh && pytest tests -q",
            "eval 'cd ../original' && pytest tests -q",
            "PYTHONPATH=../original pytest tests -q",
            "PYTEST_ADDOPTS='-k one_case' pytest tests -q",
            "env -u PYTHONPATH pytest tests -q",
            "../venv/bin/python -m pytest tests -q",
            "/usr/bin/python -m pytest tests -q",
            "/tmp/original-workspace/bin/test tests -q",
            "(cd ../original && pytest tests -q)",
            "f(){ cd ../original; }; f; pytest tests -q",
            "if cd ../original; then pytest tests -q; fi",
            "pytest \"$(realpath ../original/tests)\" -q",
            "P=../original pytest \"$P/tests\" -q",
            "env \"$(printf 'PYTHONPATH=../original')\" pytest tests -q",
            "env PYTHON${EMPTY}PATH=../original pytest tests -q",
            "HOME=/root pytest tests -q",
            "TMPDIR=/tmp pytest tests -q",
            "CARGO_TARGET_DIR=/tmp/target cargo test",
            "KCODER_ISOLATED_HOME=/root pytest tests -q",
        ] {
            assert!(
                verifier_workdir_command_rejection(command).is_some(),
                "{command}"
            );
        }

        for command in [
            "python -m pytest tests -q",
            "MPLBACKEND=Agg python -m pytest tests -q",
            "python -m pytest tests -q --basetemp=/tmp/kcoder-runtime",
            "python -m pytest tests -q --junitxml=/tmp/kcoder-runtime/results.xml",
            "python -c 'from app import behavior; assert behavior()'",
            "python setup.py build_ext --inplace -j 4",
        ] {
            assert!(
                verifier_workdir_command_rejection(command).is_none(),
                "{command}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn verifier_native_builds_candidate_and_baseline_separately_then_refreezes_baseline() {
        if !crate::os_sandbox::landlock_supported() {
            eprintln!("landlock unavailable; skipping confinement test");
            return;
        }
        let python = "python3";
        if std::process::Command::new(python)
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let root = tempfile::tempdir_in("/dev/shm").unwrap();
        let candidate = root.path().join("candidate");
        let baseline = root.path().join("baseline");
        let runtime = root.path().join("runtime");
        let candidate_runtime = verifier_isolation_workspace_directory(&runtime, Some(&candidate));
        let baseline_runtime = verifier_isolation_workspace_directory(&runtime, Some(&baseline));
        for workspace in [&candidate, &baseline] {
            std::fs::create_dir_all(workspace.join("package")).unwrap();
            std::fs::write(
                workspace.join("setup.py"),
                "import pathlib\npathlib.Path('package/_native.test.so').write_bytes(pathlib.Path('source.txt').read_bytes())\n",
            )
            .unwrap();
        }
        std::fs::write(
            baseline.join("setup.py"),
            format!(
                "import pathlib\nfor target in [{:?}, {:?}]:\n try:\n  pathlib.Path(target).write_text('escaped')\n except OSError:\n  pass\npathlib.Path('package/_native.test.so').write_bytes(pathlib.Path('source.txt').read_bytes())\n",
                candidate.join("baseline-write-escape"),
                candidate_runtime.join("baseline-write-escape"),
            ),
        )
        .unwrap();
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(candidate.join("source.txt"), "candidate").unwrap();
        std::fs::write(baseline.join("source.txt"), "baseline").unwrap();

        let sandbox = crate::Sandbox::new(
            &candidate,
            kcoder_types::SandboxConfig {
                enabled: true,
                allowed_paths: vec![
                    candidate.display().to_string(),
                    baseline.display().to_string(),
                    runtime.display().to_string(),
                ],
                ..kcoder_types::SandboxConfig::default()
            },
        )
        .with_readonly_paths(vec![baseline.clone()])
        .with_runtime_write_path(runtime.clone())
        .without_shared_dev_cache_writes();
        let command = format!("{python} setup.py build_ext --inplace");
        assert!(verifier_native_build_command_signature(&command).is_some());

        for path in [&candidate_runtime, &baseline_runtime] {
            std::fs::create_dir_all(path).unwrap();
        }
        for (workspace, spec) in [
            (
                &candidate,
                sandbox
                    .os_spec_for_verifier_invocation(Some(&candidate), &candidate_runtime)
                    .unwrap()
                    .expect("candidate sandbox spec"),
            ),
            (
                &baseline,
                sandbox
                    .os_spec_for_verifier_invocation(Some(&baseline), &baseline_runtime)
                    .unwrap()
                    .expect("baseline preparation sandbox spec"),
            ),
        ] {
            let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(workspace)));
            let running = RunningShell::spawn(
                "/bin/bash".to_string(),
                &command,
                workspace.to_path_buf(),
                5_000,
                limits.clone(),
                ShellSpawnPolicy {
                    isolation_root: Some(&runtime),
                    isolation_workspace_root: Some(workspace),
                    os_sandbox: Some(spec),
                    ..ShellSpawnPolicy::default()
                },
            )
            .unwrap();
            let output = running.wait_for_output(&command, limits).await.unwrap();
            assert!(!output.is_error, "{}", output_text(&output));
        }

        assert_eq!(
            std::fs::read(candidate.join("package/_native.test.so")).unwrap(),
            b"candidate"
        );
        assert_eq!(
            std::fs::read(baseline.join("package/_native.test.so")).unwrap(),
            b"baseline"
        );
        assert!(!candidate.join("baseline-write-escape").exists());
        assert!(!candidate_runtime.join("baseline-write-escape").exists());

        let blocked = format!("{python} -c 'open(\"should-stay-blocked\", \"w\").write(\"x\")'");
        for (workspace, runtime_namespace) in [
            (&candidate, &candidate_runtime),
            (&baseline, &baseline_runtime),
        ] {
            let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(workspace)));
            let running = RunningShell::spawn(
                "/bin/bash".to_string(),
                &blocked,
                workspace.clone(),
                5_000,
                limits.clone(),
                ShellSpawnPolicy {
                    isolation_root: Some(&runtime),
                    isolation_workspace_root: Some(workspace),
                    os_sandbox: sandbox
                        .os_spec_for_verifier_invocation(None, runtime_namespace)
                        .unwrap(),
                    ..ShellSpawnPolicy::default()
                },
            )
            .unwrap();
            let output = running.wait_for_output(&blocked, limits).await.unwrap();
            assert!(output.is_error, "{}", output_text(&output));
            assert!(!workspace.join("should-stay-blocked").exists());
        }
    }

    #[test]
    fn verifier_baseline_guard_only_allows_safe_behavior_probe_when_configured() {
        let baseline = Path::new("/tmp/baseline/workspace");
        let probe = "python -c 'from app import behavior; assert behavior()'";
        assert!(behavior_probe_command(probe));
        assert!(
            verifier_baseline_command_rejection(probe, baseline, Some(baseline), false)
                .unwrap()
                .contains("baseline guard rejected")
        );
        assert!(
            verifier_baseline_command_rejection(probe, baseline, Some(baseline), true).is_none()
        );

        for unsafe_probe in [
            "/usr/bin/python -c 'assert behavior()'",
            "python -c 'assert behavior()' | tail -1",
            "python -c 'assert behavior()' || true",
            "python -c 'assert behavior()' > result.txt",
            "python -m pip install package",
            "rg 'fixed text' src",
            "python -c 'try:\n import missing_native\nexcept ImportError:\n raise AssertionError(\"KCODER_BEHAVIOR_DELTA\") from None'",
            "python -c 'from app import behavior\ntry:\n behavior()\nexcept Exception:\n raise AssertionError(\"KCODER_BEHAVIOR_DELTA\") from None'",
        ] {
            assert!(!behavior_probe_command(unsafe_probe), "{unsafe_probe}");
            assert!(
                verifier_baseline_command_rejection(unsafe_probe, baseline, Some(baseline), true,)
                    .is_some(),
                "{unsafe_probe}"
            );
        }
    }

    #[test]
    fn behavior_probe_rejects_source_environment_and_mutation_fingerprints() {
        let valid = "python -c 'from pkg.api import normalize; actual = normalize(\"x\"); assert actual == \"y\", actual'";
        assert!(behavior_probe_command(valid));

        for unsafe_probe in [
            "python -c 'from pathlib import Path; assert \"fixed\" in Path(\"app.py\").read_text()'",
            "python -c 'from pathlib import Path; Path(\"marker\").write_text(\"x\")'",
            "python -c 'open(\"marker\", \"w\").write(\"x\")'",
            "python -c 'import os; assert \"baseline\" not in os.getcwd()'",
            "python -c 'import os; assert os.environ.get(\"MODE\") == \"candidate\"'",
            "python -c 'import inspect; from pkg import api; assert \"fix\" in inspect.getsource(api)'",
            "python -c 'from pkg import api; assert api.__code__.co_argcount == 2'",
            "python -c 'from pkg import api; assert \"candidate\" in api.__file__'",
            "python -c 'import sys; sys.modules[\"optional_dependency\"] = stub'",
            "python -c 'import subprocess; assert subprocess.run([\"true\"]).returncode == 0'",
            "python -c '__import__(\"pathlib\").Path(\"app.py\").read_text()'",
            "python -c 'eval(\"assert True\")'",
        ] {
            assert!(!behavior_probe_command(unsafe_probe), "{unsafe_probe}");
        }
    }

    #[test]
    fn behavior_probe_allows_in_memory_pickle_round_trip() {
        let probe = "python -c 'import pickle; from pkg.api import value; blob = pickle.dumps(value()); assert pickle.loads(blob) == value()'";
        let baseline = Path::new("/tmp/baseline/workspace");

        assert!(behavior_probe_command(probe));
        assert!(
            verifier_baseline_command_rejection(probe, baseline, Some(baseline), true).is_none()
        );
    }

    #[test]
    fn verifier_workspace_guard_detects_test_file_edits() {
        assert!(workspace_mutation_command(
            "sed -i 's/old/new/' tests/test_issue.py"
        ));
        assert!(!workspace_mutation_command("python -c 'assert 1 + 1 == 2'"));
        assert!(workspace_mutation_command("git checkout -- tests"));
        assert!(!workspace_mutation_command("git diff -- tests"));
        assert!(!workspace_mutation_command("pytest tests"));
        for command in [
            "find . -name patch -o -name install",
            "ls -la tests/patch fixtures/install",
            "cd src && git diff --stat && git diff -- tests",
            "pytest tests 2>/dev/null; echo $?",
            "git log --all --oneline 2>/dev/null | head -10; git stash list",
        ] {
            assert!(!workspace_mutation_command(command), "{command}");
        }
        assert!(workspace_mutation_command(
            "cd src && git diff --stat; touch tests/changed.py"
        ));
        assert!(workspace_mutation_command("printf x > tests/changed.py"));
        assert!(!workspace_mutation_command(
            "pytest tests > /tmp/verifier-output.log 2>/dev/null"
        ));
    }

    #[test]
    fn no_match_search_exemption_accepts_only_one_unredirected_grep_or_rg() {
        for command in [
            "grep -rn 'py:class' sphinx/util/typing.py",
            "rg --hidden 'needle;still-pattern' src",
            "rg '$(literal)' src",
            "/usr/bin/grep needle file.txt",
        ] {
            assert!(read_only_search_no_match_command(command), "{command}");
        }
        for command in [
            "git diff --check",
            "grep needle file.txt 2>/dev/null",
            "grep needle file.txt; echo $?",
            "grep needle file.txt | head",
            "cd src && rg needle",
            "env MODE=read rg needle src",
            "python -c 'print(1)'",
            "grep \"$(touch changed)\" file.txt",
            "rg \"`touch changed`\" file.txt",
        ] {
            assert!(!read_only_search_no_match_command(command), "{command}");
        }
    }

    #[test]
    fn isolated_verifier_environment_uses_private_process_paths() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let environment = verifier_isolation_environment(root.path(), Some(&workspace)).unwrap();
        let values = environment
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();

        assert_eq!(
            values.get(&OsString::from("PYTHONNOUSERSITE")),
            Some(&"1".into())
        );
        assert_eq!(
            values.get(&OsString::from("PIP_REQUIRE_VIRTUALENV")),
            Some(&"1".into())
        );
        assert_eq!(
            values.get(&OsString::from("PYTEST_ADDOPTS")),
            Some(&"-p no:cacheprovider".into())
        );
        assert!(Path::new(values.get(&OsString::from("HOME")).unwrap()).starts_with(root.path()));
        assert!(Path::new(values.get(&OsString::from("TMPDIR")).unwrap()).starts_with(root.path()));
        let python_path = values.get(&OsString::from("PYTHONPATH")).unwrap();
        let paths = std::env::split_paths(python_path).collect::<Vec<_>>();
        assert_eq!(paths.first(), Some(&workspace));
        assert_eq!(
            values.get(&OsString::from("KCODER_ISOLATED_PYTHONPATH")),
            Some(python_path)
        );

        let cargo_target = values
            .get(&OsString::from("CARGO_TARGET_DIR"))
            .expect("candidate Cargo target directory");
        assert!(Path::new(cargo_target).starts_with(root.path().join("workspaces")));
        assert!(Path::new(cargo_target).ends_with("cache/cargo-target"));

        let baseline_workspace = root.path().join("baseline");
        let baseline_values =
            verifier_isolation_environment(root.path(), Some(&baseline_workspace))
                .unwrap()
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>();
        for variable in [
            "HOME",
            "TMPDIR",
            "XDG_CACHE_HOME",
            "PIP_CACHE_DIR",
            "NPM_CONFIG_CACHE",
            "PYTHONPYCACHEPREFIX",
        ] {
            assert_ne!(
                baseline_values.get(&OsString::from(variable)),
                values.get(&OsString::from(variable)),
                "candidate and baseline must not share {variable}"
            );
        }
        assert_ne!(
            baseline_values.get(&OsString::from("CARGO_TARGET_DIR")),
            Some(cargo_target),
            "candidate and baseline must not share compiled Cargo artifacts"
        );

        let repeated_values = verifier_isolation_environment(root.path(), Some(&workspace))
            .unwrap()
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            repeated_values.get(&OsString::from("CARGO_TARGET_DIR")),
            Some(cargo_target),
            "the same verifier workspace must use a stable Cargo target directory"
        );
    }

    #[test]
    fn verifier_python_path_uses_only_workspace_and_explicit_trusted_prefix() {
        let workspace = Path::new("/tmp/task-workspace");
        let trusted = std::env::join_paths([
            Path::new("/opt/kcoder/python-isolation"),
            Path::new("/opt/kcoder/second-prefix"),
        ])
        .unwrap();

        let python_path = verifier_python_path(workspace, Some(&trusted)).unwrap();
        let paths = std::env::split_paths(&python_path).collect::<Vec<_>>();

        assert_eq!(
            paths,
            vec![
                workspace.to_path_buf(),
                PathBuf::from("/opt/kcoder/python-isolation"),
                PathBuf::from("/opt/kcoder/second-prefix"),
            ]
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn bash_preserves_standard_windows_profile_environment() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = BashTool
            .call(
                serde_json::json!({
                    "command": "test -n \"$APPDATA\" && test -n \"$ProgramData\" && test -n \"$PSModulePath\" && printf WINDOWS_ENV_OK"
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

    #[test]
    fn scoped_shell_policy_is_fail_closed() {
        assert!(scoped_shell_command_is_read_only(
            "rg needle src | head -n 5"
        ));
        assert!(!scoped_shell_command_is_read_only("cargo test"));
        assert!(!scoped_shell_command_is_read_only("printf x>outside.txt"));
        assert!(!scoped_shell_command_is_read_only(
            "ruby -e 'File.write(%q{x}, %q{y})'"
        ));
        assert!(!scoped_shell_command_is_read_only("dd if=/dev/null of=x"));
        assert!(!scoped_shell_command_is_read_only("find . -exec rm {} +"));
        assert!(!scoped_shell_command_is_read_only(
            "rg --pre 'sh mutate.sh' needle"
        ));
        assert!(!scoped_shell_command_is_read_only(
            "LD_PRELOAD=./mutate.so rg needle"
        ));
        assert!(!scoped_shell_command_is_read_only(
            "sort -o outside.txt input"
        ));
    }

    #[test]
    fn delegated_shell_prefix_requires_every_safe_top_level_segment() {
        let prefixes = vec!["docker exec -i exact-container".to_string()];
        assert!(scoped_shell_command_matches_allowed_prefixes(
            "docker exec -i exact-container python3 - < staging.py",
            &prefixes,
        ));
        assert!(scoped_shell_command_matches_allowed_prefixes(
            "pwd && docker exec -i exact-container python3 /tmp/staging.py",
            &prefixes,
        ));
        assert!(!scoped_shell_command_matches_allowed_prefixes(
            "docker exec -i other-container python3 - < staging.py",
            &prefixes,
        ));
        assert!(!scoped_shell_command_matches_allowed_prefixes(
            "docker exec -i exact-container python3 /tmp/staging.py; touch escaped",
            &prefixes,
        ));
        assert!(!scoped_shell_command_matches_allowed_prefixes(
            "docker exec -i exact-container true > escaped",
            &prefixes,
        ));
        assert!(!scoped_shell_command_matches_allowed_prefixes(
            "docker exec -i exact-container echo $(touch escaped)",
            &prefixes,
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_scope_honors_exact_delegated_shell_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("explicitly-authorized");
        let command = format!("touch {}", target.display());
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_allowed_write_paths(vec![tmp.path().join("staging.py").display().to_string()])
            .with_allowed_shell_prefixes(vec![command.clone()]);
        let output = BashTool
            .call(serde_json::json!({"command": command}), &ctx)
            .await
            .unwrap();

        assert!(!output.is_error);
        assert!(target.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn filesystem_root_write_scope_allows_implementer_shell_execution() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("shell-created");
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_allowed_write_paths(vec!["/".to_string()]);
        let output = BashTool
            .call(
                serde_json::json!({
                    "command": format!("touch {}", target.display())
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(!output.is_error);
        assert!(target.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn filesystem_root_write_scope_does_not_unblock_read_only_roles() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("must-not-exist");
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_allowed_write_paths(vec!["/".to_string()])
            .with_block_shell_file_mutation(true);
        let output = BashTool
            .call(
                serde_json::json!({
                    "command": format!("touch {}", target.display())
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(output.is_error);
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_write_scope_keeps_implementer_shell_fail_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("inside-scope");
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_allowed_write_paths(vec![tmp.path().display().to_string()]);
        let output = BashTool
            .call(
                serde_json::json!({
                    "command": format!("touch {}", target.display())
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(output.is_error);
        assert!(!target.exists());
    }

    #[derive(Default)]
    struct FakeBackgroundJobManager {
        spawned: Mutex<Vec<String>>,
    }

    impl BackgroundJobSpawner for FakeBackgroundJobManager {
        fn spawn(
            &self,
            description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            self.spawned.lock().unwrap().push(description);
            Ok("job-bash".to_string())
        }

        fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BackgroundJobEvent> {
            let (_, rx) = tokio::sync::broadcast::channel(1);
            rx
        }

        fn abort(&self, _id: &str) -> bool {
            false
        }
    }

    struct ExecutingBackgroundJobManager {
        outputs: Mutex<HashMap<String, oneshot::Receiver<ToolOutput>>>,
        cancellations: Mutex<HashMap<String, Arc<dyn Fn() + Send + Sync>>>,
        events: tokio::sync::broadcast::Sender<BackgroundJobEvent>,
    }

    impl Default for ExecutingBackgroundJobManager {
        fn default() -> Self {
            let (events, _) = tokio::sync::broadcast::channel(16);
            Self {
                outputs: Mutex::new(HashMap::new()),
                cancellations: Mutex::new(HashMap::new()),
                events,
            }
        }
    }

    impl ExecutingBackgroundJobManager {
        async fn output(&self, id: &str) -> ToolOutput {
            let receiver = self.outputs.lock().unwrap().remove(id).unwrap();
            receiver.await.unwrap()
        }
    }

    impl BackgroundJobSpawner for ExecutingBackgroundJobManager {
        fn spawn(
            &self,
            description: String,
            work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            self.spawn_cancellable(description, work, Arc::new(|| {}), max_concurrent)
        }

        fn spawn_cancellable(
            &self,
            _description: String,
            work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            cancel: Arc<dyn Fn() + Send + Sync>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            let id = format!("job-{}", self.outputs.lock().unwrap().len() + 1);
            let (tx, rx) = oneshot::channel();
            let event_tx = self.events.clone();
            let event_id = id.clone();
            let _ = self.events.send(BackgroundJobEvent::Started {
                id: id.clone(),
                description: "test command".to_string(),
                continuation: false,
            });
            tokio::spawn(async move {
                let output = work.await;
                let _ = event_tx.send(BackgroundJobEvent::Completed {
                    id: event_id,
                    output: output.clone(),
                });
                let _ = tx.send(output);
            });
            self.outputs.lock().unwrap().insert(id.clone(), rx);
            self.cancellations
                .lock()
                .unwrap()
                .insert(id.clone(), cancel);
            Ok(id)
        }

        fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BackgroundJobEvent> {
            self.events.subscribe()
        }

        fn abort(&self, id: &str) -> bool {
            if let Some(cancel) = self.cancellations.lock().unwrap().remove(id) {
                cancel();
                true
            } else {
                false
            }
        }

        fn promote_to_background(&self, _id: &str) -> Result<(), SpawnError> {
            Ok(())
        }
    }

    fn output_text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn native_windows_sandbox_allows_workspace_write_and_blocks_outside_write() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let inside_file = workspace.join("inside.txt");
        let outside = tempfile::Builder::new()
            .prefix("kcoder-sandbox-outside-")
            .tempdir_in(dirs::home_dir().unwrap())
            .unwrap();
        let outside_file = outside.path().join("escaped.txt");
        let command = format!(
            "$ErrorActionPreference='Continue'; Set-Content -LiteralPath '{}' -Value inside; & cmd.exe /d /s /c 'echo escaped>\"{}\"'",
            inside_file.display(),
            outside_file.display()
        );
        let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(&workspace)));
        let running = RunningShell::spawn(
            "powershell.exe".to_string(),
            &command,
            workspace.clone(),
            5_000,
            limits.clone(),
            ShellSpawnPolicy {
                os_sandbox: Some(crate::os_sandbox::OsSandboxSpec {
                    backend: crate::os_sandbox::OsSandboxBackend::WindowsRestrictedToken,
                    rw_paths: vec![workspace],
                    readonly_paths: Vec::new(),
                    deny_read: Vec::new(),
                }),
                ..Default::default()
            },
        )
        .expect("native Windows sandbox should start");
        let outcome = running.wait_for_output(&command, limits).await;

        assert!(
            inside_file.exists(),
            "workspace write should be allowed; command outcome: {outcome:?}"
        );
        let escaped = outside_file.exists();
        let _ = std::fs::remove_file(&outside_file);
        assert!(
            !escaped,
            "a nested child must inherit the restricted token and be unable to write outside"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn native_windows_sandbox_rejects_unenforceable_denied_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(tmp.path())));
        let result = RunningShell::spawn(
            "cmd.exe".to_string(),
            "exit 0",
            tmp.path().to_path_buf(),
            1_000,
            limits,
            ShellSpawnPolicy {
                os_sandbox: Some(crate::os_sandbox::OsSandboxSpec {
                    backend: crate::os_sandbox::OsSandboxBackend::WindowsRestrictedToken,
                    rw_paths: vec![tmp.path().to_path_buf()],
                    readonly_paths: Vec::new(),
                    deny_read: vec![tmp.path().join("secret")],
                }),
                ..Default::default()
            },
        );

        match result {
            Err(ToolError::SandboxDenied { reason, .. }) => {
                assert!(reason.contains("denied_paths"), "{reason}");
                assert!(reason.contains("refusing"), "{reason}");
            }
            _ => panic!("unenforceable Windows deny-read policy must fail closed"),
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn native_windows_sandbox_timeout_kills_descendant_processes() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let marker = workspace.join("descendant-survived.txt");
        let script = workspace.join("descendant.ps1");
        std::fs::write(
            &script,
            format!(
                "Start-Sleep -Milliseconds 1500; Set-Content -LiteralPath '{}' -Value survived",
                marker.display()
            ),
        )
        .unwrap();
        let command = format!(
            "Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-File','{}'); Start-Sleep -Seconds 10",
            script.display()
        );
        let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(&workspace)));
        let running = RunningShell::spawn(
            "powershell.exe".to_string(),
            &command,
            workspace.clone(),
            1_000,
            limits.clone(),
            ShellSpawnPolicy {
                os_sandbox: Some(crate::os_sandbox::OsSandboxSpec {
                    backend: crate::os_sandbox::OsSandboxBackend::WindowsRestrictedToken,
                    rw_paths: vec![workspace],
                    readonly_paths: Vec::new(),
                    deny_read: Vec::new(),
                }),
                ..Default::default()
            },
        )
        .expect("native Windows sandbox should start");

        let started = std::time::Instant::now();
        let outcome = running.wait_for_output(&command, limits).await;
        assert!(outcome.is_err(), "command should time out: {outcome:?}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "Job Object termination should not hang while inherited pipes remain open"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(
            !marker.exists(),
            "the sandbox Job Object must terminate descendants when the root times out"
        );
    }

    #[tokio::test]
    async fn short_bash_command_completes_in_foreground() {
        let manager = Arc::new(ExecutingBackgroundJobManager::default());
        let tmp = tempfile::tempdir().unwrap();
        // This test validates foreground completion for a short command, not 100 ms
        // scheduling precision. Concurrent workspace tests can saturate the executor
        // and make an exited process cross an overly narrow budget before observation.
        let foreground_budget_ms = 2_000;
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_background_job_manager(manager)
            .with_bash_foreground_budget_ms(foreground_budget_ms);

        let output = BashTool
            .call(
                serde_json::json!({"command": "printf foreground", "timeout": 1000}),
                &ctx,
            )
            .await
            .unwrap();

        assert!(output_text(&output).contains("foreground"));
        assert!(!output_text(&output).contains("task_id"));
    }

    #[tokio::test]
    async fn foreground_budget_moves_same_running_command_to_background() {
        let manager = Arc::new(ExecutingBackgroundJobManager::default());
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_background_job_manager(manager.clone())
            .with_bash_foreground_budget_ms(20);

        let output = BashTool
            .call(
                serde_json::json!({
                    "command": "printf before; sleep 0.08; printf after",
                    "timeout": 1000
                }),
                &ctx,
            )
            .await
            .unwrap();
        let started: Value = serde_json::from_str(&output_text(&output)).unwrap();
        assert_eq!(started["automatically_backgrounded"], true);
        assert_eq!(started["foreground_budget_ms"], 20);

        let completed = manager.output(started["task_id"].as_str().unwrap()).await;
        let text = output_text(&completed);
        assert!(text.contains("before"));
        assert!(text.contains("after"));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn verifier_test_waits_for_raw_exit_instead_of_auto_backgrounding() {
        let manager = Arc::new(ExecutingBackgroundJobManager::default());
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("bin")).unwrap();
        std::fs::write(
            tmp.path().join("bin/test"),
            "#!/bin/sh\nsleep 0.08\nprintf '1 passed\\n'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            tmp.path().join("bin/test"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_background_job_manager(manager)
            .with_bash_foreground_budget_ms(20)
            .with_verifier_test_policy(Some(GoalProTestScope::TargetSuite), true);

        let output = BashTool
            .call(
                serde_json::json!({
                    "command": "./bin/test tests",
                    "timeout": 1000
                }),
                &ctx,
            )
            .await
            .unwrap();

        let text = output_text(&output);
        assert!(text.starts_with("exit_code: 0\n"), "{text}");
        assert!(text.contains("1 passed"), "{text}");
        assert!(!text.contains("automatically_backgrounded"), "{text}");
    }

    #[tokio::test]
    async fn explicit_background_returns_before_command_finishes() {
        let manager = Arc::new(ExecutingBackgroundJobManager::default());
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_background_job_manager(manager.clone());
        let started_at = Instant::now();

        let output = BashTool
            .call(
                serde_json::json!({
                    "command": "sleep 0.15; printf done",
                    "timeout": 1000,
                    "run_in_background": true
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(started_at.elapsed() < Duration::from_millis(100));
        let started: Value = serde_json::from_str(&output_text(&output)).unwrap();
        let completed = manager.output(started["task_id"].as_str().unwrap()).await;
        assert!(output_text(&completed).contains("done"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn explicit_background_command_receives_detached_stdin() {
        let manager = Arc::new(ExecutingBackgroundJobManager::default());
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_background_job_manager(manager.clone());

        let output = BashTool
            .call(
                serde_json::json!({
                    "command": "readlink /proc/$$/fd/0",
                    "timeout": 1000,
                    "run_in_background": true
                }),
                &ctx,
            )
            .await
            .unwrap();
        let started: Value = serde_json::from_str(&output_text(&output)).unwrap();
        let completed = manager.output(started["task_id"].as_str().unwrap()).await;

        assert!(!completed.is_error, "{}", output_text(&completed));
        assert!(
            output_text(&completed).contains("/dev/null"),
            "managed background stdin must be detached: {}",
            output_text(&completed)
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn stopped_background_process_is_detected_and_failed() {
        let manager = Arc::new(ExecutingBackgroundJobManager::default());
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_background_job_manager(manager.clone());

        let output = BashTool
            .call(
                serde_json::json!({
                    "command": "kill -STOP 0",
                    "timeout": 3000,
                    "run_in_background": true
                }),
                &ctx,
            )
            .await
            .unwrap();
        let started: Value = serde_json::from_str(&output_text(&output)).unwrap();
        let completed = tokio::time::timeout(
            Duration::from_secs(2),
            manager.output(started["task_id"].as_str().unwrap()),
        )
        .await
        .expect("stopped process should be detected without waiting for command timeout");
        let text = output_text(&completed);

        assert!(completed.is_error, "{text}");
        assert!(text.contains("process group stopped"), "{text}");
        assert!(text.contains("state T/t"), "{text}");
        assert!(text.contains("SIGTTIN"), "{text}");
    }

    #[tokio::test]
    async fn background_command_keeps_original_total_timeout() {
        let manager = Arc::new(ExecutingBackgroundJobManager::default());
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_background_job_manager(manager.clone());

        let output = BashTool
            .call(
                serde_json::json!({
                    "command": "sleep 60",
                    "timeout": 80,
                    "run_in_background": true
                }),
                &ctx,
            )
            .await
            .unwrap();
        let started: Value = serde_json::from_str(&output_text(&output)).unwrap();
        let completed = manager.output(started["task_id"].as_str().unwrap()).await;

        assert!(completed.is_error);
        assert!(output_text(&completed).contains("timed out after 80 ms"));
    }

    #[tokio::test]
    async fn shell_output_capture_is_bounded_while_pipes_are_drained() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_output_limits(1024, 512, 512);

        let output = BashTool
            .call(
                serde_json::json!({
                    "command": "printf HEAD_MARK; head -c 200000 /dev/zero | tr '\\0' x; printf TAIL_MARK",
                    "timeout": 2000
                }),
                &ctx,
            )
            .await
            .unwrap();
        let text = output_text(&output);

        assert!(text.contains("exceeded size limit"));
        assert!(text.contains("HEAD_MARK"));
        assert!(text.ends_with("TAIL_MARK"));
        assert!(text.len() <= 1024);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_exit_cleans_descendants_that_keep_pipes_open() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_path = tmp.path().join("descendant.pid");
        let command = format!(
            "sh -c 'echo $$ > {}; sleep 60' & while [ ! -s {} ]; do sleep 0.01; done",
            pid_path.display(),
            pid_path.display()
        );
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let started = Instant::now();
        let output = BashTool
            .call(
                serde_json::json!({"command": command, "timeout": 2000}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        let text = output_text(&output);
        assert!(text.contains("Warning: Bash cleaned"), "{text}");
        assert!(text.contains("run_in_background=true"), "{text}");

        let pid = tokio::fs::read_to_string(pid_path)
            .await
            .unwrap()
            .trim()
            .parse::<libc::pid_t>()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while unsafe { libc::kill(pid, 0) == 0 } {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("shell descendants should be reaped after the shell exits");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn shell_exit_cleans_setsid_descendant_outside_process_group() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_path = tmp.path().join("setsid-descendant.pid");
        let command = format!(
            "setsid sh -c 'echo $$ > \"$1\"; exec sleep 60' sh {} </dev/null >/dev/null 2>&1 & \
             while [ ! -s {} ]; do sleep 0.01; done",
            pid_path.display(),
            pid_path.display()
        );
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let output = BashTool
            .call(
                serde_json::json!({"command": command, "timeout": 2000}),
                &ctx,
            )
            .await
            .unwrap();
        let text = output_text(&output);
        assert!(text.contains("Warning: Bash cleaned"), "{text}");
        assert!(text.contains("`setsid`"), "{text}");

        let pid = tokio::fs::read_to_string(&pid_path)
            .await
            .unwrap()
            .trim()
            .parse::<libc::pid_t>()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while unsafe { libc::kill(pid, 0) == 0 } {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("setsid descendant should be reaped after the shell exits");
    }

    #[test]
    fn detached_shell_launches_receive_persistent_lifecycle_guidance() {
        for command in [
            "server &",
            "server&",
            "/usr/bin/nohup server",
            "setsid server",
            "server; disown",
        ] {
            let warning = shell_lifecycle_warning(command, 0).unwrap();
            assert!(warning.contains("run_in_background=true"), "{warning}");
            assert!(warning.contains("explicit total lifetime"), "{warning}");
        }
        assert!(shell_lifecycle_warning("cargo test", 0).is_none());
    }

    #[tokio::test]
    async fn bash_background_returns_task_id_without_polling_command() {
        let manager = Arc::new(FakeBackgroundJobManager::default());
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_background_job_manager(manager.clone());
        let tool = BashTool;

        let output = tool
            .call(
                serde_json::json!({
                    "command": "echo should-not-run-inline",
                    "description": "slow shell work",
                    "run_in_background": true
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
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["task_id"], "job-bash");
        assert_eq!(value["task_type"], "bash");
        assert_eq!(value["status"], "running");
        assert!(
            manager.spawned.lock().unwrap()[0]
                .starts_with(crate::background::TOOL_BACKGROUND_TASK_PREFIX)
        );
    }

    #[tokio::test]
    async fn bash_description_reflects_bypass_and_headless_context() {
        let tool = BashTool;
        let ctx = crate::ToolDescriptionContext {
            permission_mode: crate::ToolPermissionMode::Bypass,
            is_non_interactive: true,
            active_skills: Vec::new(),
            available_tools: Default::default(),
        };

        let description = tool.description_for_model(None, &ctx).await;

        assert!(description.contains("bypasses normal approval prompts"));
        assert!(description.contains("non-interactive/headless"));
        assert!(description.contains("Each bash call starts from the session directory"));
        assert!(description.contains("cd` only affects that one command"));
        assert!(description.contains("large producers piped into `head`"));
    }

    #[test]
    fn shell_invocation_uses_pipefail_for_bash() {
        let invocation = shell_invocation("/bin/bash", "false | true", false, false);

        assert_eq!(invocation.program, "/bin/bash");
        assert_eq!(
            invocation.args,
            vec!["-o", "pipefail", "-c", "false | true"]
        );
    }

    #[test]
    fn shell_invocation_loads_ready_snapshot_in_same_shell() {
        if !Path::new("/bin/bash").exists() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let snapshot = temp.path().join("snapshot.sh");
        std::fs::write(
            &snapshot,
            "export SNAPSHOT_VALUE=ready\nsnapshot_function() { printf function-ok; }\n",
        )
        .unwrap();
        let invocation = shell_invocation(
            "/bin/bash",
            "printf '%s ' \"$SNAPSHOT_VALUE\"; snapshot_function",
            true,
            false,
        );
        let output = std::process::Command::new(invocation.program)
            .args(invocation.args)
            .env("KCODER_SHELL_SNAPSHOT", snapshot)
            .output()
            .unwrap();

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "ready function-ok");
    }

    #[test]
    fn isolated_shell_snapshot_is_copied_into_private_runtime() {
        let source_root = tempfile::tempdir().unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        let source = source_root.path().join("snapshot.sh");
        std::fs::write(&source, "export PATH=/task/python/bin:/usr/bin\n").unwrap();

        let visible = shell_snapshot_for_spawn(Some(&source), Some(runtime_root.path()))
            .unwrap()
            .unwrap();

        assert!(visible.path.starts_with(runtime_root.path()));
        assert_ne!(visible.path, source);
        assert_eq!(
            std::fs::read(&visible.path).unwrap(),
            std::fs::read(&source).unwrap()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&visible.path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn isolated_shell_snapshot_never_follows_a_precreated_target_symlink() {
        use std::os::unix::fs::symlink;

        let source_root = tempfile::tempdir().unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        let outside_root = tempfile::tempdir().unwrap();
        let source = source_root.path().join("snapshot.sh");
        std::fs::write(&source, "export PATH=/task/python/bin:/usr/bin\n").unwrap();
        let outside = outside_root.path().join("outside.txt");
        std::fs::write(&outside, "do-not-overwrite").unwrap();
        let trap = runtime_root
            .path()
            .join(format!("shell-snapshot-{}-1.sh", std::process::id()));
        symlink(&outside, &trap).unwrap();

        let visible = shell_snapshot_for_spawn(Some(&source), Some(runtime_root.path()))
            .unwrap()
            .unwrap();

        assert_ne!(visible.path, trap);
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "do-not-overwrite"
        );
        assert!(
            std::fs::symlink_metadata(&trap)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(
            !std::fs::symlink_metadata(&visible.path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn isolated_shell_loads_path_from_the_private_snapshot_copy() {
        use std::os::unix::fs::PermissionsExt;

        let source_root = tempfile::tempdir().unwrap();
        let runtime_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let task_bin = source_root.path().join("task-bin");
        std::fs::create_dir(&task_bin).unwrap();
        let task_python = task_bin.join("task-python");
        std::fs::write(&task_python, "#!/bin/sh\nprintf task-python-ready\n").unwrap();
        std::fs::set_permissions(&task_python, std::fs::Permissions::from_mode(0o755)).unwrap();
        let snapshot = source_root.path().join("snapshot.sh");
        std::fs::write(
            &snapshot,
            format!("export PATH='{}':/usr/bin:/bin\n", task_bin.display()),
        )
        .unwrap();

        let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(workspace.path())));
        let running = RunningShell::spawn(
            "/bin/bash".to_string(),
            "task-python",
            workspace.path().to_path_buf(),
            1_000,
            limits.clone(),
            ShellSpawnPolicy {
                snapshot_path: Some(&snapshot),
                snapshot_copy_root: None,
                isolation_root: Some(runtime_root.path()),
                isolation_workspace_root: Some(workspace.path()),
                os_sandbox: None,
            },
        )
        .unwrap();
        // Spawn already copied the snapshot into the private runtime root. Removing
        // the original proves that the child no longer depends on a configuration
        // directory path that the verifier cannot read.
        std::fs::remove_file(&snapshot).unwrap();

        let output = running
            .wait_for_output("task-python", limits)
            .await
            .unwrap();

        assert!(!output.is_error, "{}", output_text(&output));
        assert!(output_text(&output).contains("task-python-ready"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn ordinary_sandbox_shell_restores_a_snapshot_below_deny_read() {
        use std::os::unix::fs::PermissionsExt as _;

        if !crate::os_sandbox::landlock_supported() {
            eprintln!("landlock unavailable; skipping confinement test");
            return;
        }
        let root = tempfile::tempdir_in("/dev/shm").unwrap();
        let config_root = root.path().join("private-config");
        let workspace = root.path().join("workspace");
        let private_temp = root.path().join("private-tmp");
        let task_bin = root.path().join("task-bin");
        for directory in [&config_root, &workspace, &private_temp, &task_bin] {
            std::fs::create_dir(directory).unwrap();
        }
        std::fs::set_permissions(&private_temp, std::fs::Permissions::from_mode(0o700)).unwrap();
        let task_python = task_bin.join("python");
        std::fs::write(
            &task_python,
            "#!/bin/sh\nprintf '%s\\n' task-python-ready\n",
        )
        .unwrap();
        std::fs::set_permissions(&task_python, std::fs::Permissions::from_mode(0o755)).unwrap();
        let snapshot = config_root.join("task.sh");
        std::fs::write(
            &snapshot,
            "export DEEPSEEK_API_KEY='provider-secret-sentinel'\n\
             snapshot_secret_function() { printf leaked-function; }\n\
             alias snapshot_secret_alias='printf leaked-alias'\n",
        )
        .unwrap();
        let sandbox_snapshot = config_root.join("task.sandbox.sh");
        let sandbox_source = crate::shell_snapshot::sandbox_snapshot_source([
            (
                OsString::from("PATH"),
                OsString::from(format!("{}:/usr/bin:/bin", task_bin.display())),
            ),
            (
                OsString::from("VIRTUAL_ENV"),
                OsString::from("/task/python"),
            ),
            (
                OsString::from("PYTHONPATH"),
                OsString::from("/task/workspace:/harness/bootstrap"),
            ),
            (OsString::from("PYTHONNOUSERSITE"), OsString::from("1")),
            (
                OsString::from("PIP_REQUIRE_VIRTUALENV"),
                OsString::from("1"),
            ),
            (OsString::from("HOME"), OsString::from("/task/home")),
            (
                OsString::from("XDG_CACHE_HOME"),
                OsString::from("/task/cache"),
            ),
            (
                OsString::from("PIP_CACHE_DIR"),
                OsString::from("/task/cache/pip"),
            ),
            (
                OsString::from("SWE_BENCH_BASE_SITE_PACKAGES"),
                OsString::from("/shared/site-packages"),
            ),
            (
                OsString::from("SWE_BENCH_PRIVATE_SITE_PACKAGES"),
                OsString::from("/task/private-site-packages"),
            ),
            (
                OsString::from("DEEPSEEK_API_KEY"),
                OsString::from("provider-secret-sentinel"),
            ),
        ]);
        std::fs::write(&sandbox_snapshot, sandbox_source).unwrap();
        let snapshots = crate::ShellEnvironmentSnapshot::from_paths_for_test(
            Some(snapshot.clone()),
            None,
            Some(sandbox_snapshot.clone()),
        );
        let mut rw_paths = vec![workspace.clone(), private_temp.clone()];
        if Path::new("/dev/null").exists() {
            rw_paths.push(PathBuf::from("/dev/null"));
        }
        let sandbox = crate::os_sandbox::OsSandboxSpec {
            backend: crate::os_sandbox::OsSandboxBackend::Landlock,
            rw_paths,
            readonly_paths: Vec::new(),
            deny_read: vec![config_root.clone()],
        };
        let selection = select_shell_snapshot(Some(&snapshots), false, Some(&sandbox)).unwrap();
        assert_eq!(selection.path.as_deref(), Some(sandbox_snapshot.as_path()));
        assert!(selection.requires_private_copy);
        let copy_root = ordinary_shell_snapshot_copy_root(
            selection.requires_private_copy,
            &workspace,
            Some(&sandbox),
            Some(private_temp.as_os_str()),
        )
        .unwrap()
        .expect("a denied snapshot must use the explicit private temp root");
        let command = format!(
            "python; printf 'PYTHONPATH=%s\\nHOME=%s\\nCACHE=%s\\nBASE=%s\\nPRIVATE=%s\\nSECRET=%s\\n' \
             \"$PYTHONPATH\" \"$HOME\" \"$XDG_CACHE_HOME\" \
             \"$SWE_BENCH_BASE_SITE_PACKAGES\" \"$SWE_BENCH_PRIVATE_SITE_PACKAGES\" \
             \"${{DEEPSEEK_API_KEY-unset}}\"; \
             if grep -Fq provider-secret-sentinel \"$KCODER_SHELL_SNAPSHOT\"; \
             then echo COPIED_SECRET; exit 7; else echo COPIED_CLEAN; fi; \
             if type snapshot_secret_function >/dev/null 2>&1; \
             then echo FUNCTION_VISIBLE; exit 8; else echo FUNCTION_ABSENT; fi; \
             if alias snapshot_secret_alias >/dev/null 2>&1; \
             then echo ALIAS_VISIBLE; exit 9; else echo ALIAS_ABSENT; fi; \
             if cat '{}' >/dev/null 2>&1; then echo ORIGINAL_VISIBLE; exit 9; \
             else echo ORIGINAL_DENIED; fi",
            snapshot.display()
        );
        let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(&workspace)));
        let running = RunningShell::spawn(
            "/bin/bash".to_string(),
            &command,
            workspace.clone(),
            2_000,
            limits.clone(),
            ShellSpawnPolicy {
                snapshot_path: selection.path.as_deref(),
                snapshot_copy_root: Some(&copy_root),
                isolation_root: None,
                isolation_workspace_root: None,
                os_sandbox: Some(sandbox),
            },
        )
        .unwrap();
        let copied_snapshot = running
            ._shell_snapshot
            .as_ref()
            .expect("ordinary sandbox shell must own a temporary snapshot")
            .path()
            .to_path_buf();
        let copied_mode = std::fs::metadata(&copied_snapshot)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert!(copied_snapshot.starts_with(&private_temp));
        assert_eq!(copied_mode, 0o600);
        let copied_source = std::fs::read_to_string(&copied_snapshot).unwrap();
        assert!(!copied_source.contains("provider-secret-sentinel"));
        assert!(!copied_source.contains("DEEPSEEK_API_KEY"));
        assert!(!copied_source.contains("snapshot_secret_function"));
        assert!(!copied_source.contains("snapshot_secret_alias"));

        let output = running.wait_for_output(&command, limits).await.unwrap();
        let text = output_text(&output);
        assert!(!output.is_error, "{text}");
        assert!(text.contains("task-python-ready"), "{text}");
        assert!(
            text.contains("PYTHONPATH=/task/workspace:/harness/bootstrap"),
            "{text}"
        );
        assert!(text.contains("HOME=/task/home"), "{text}");
        assert!(text.contains("CACHE=/task/cache"), "{text}");
        assert!(text.contains("BASE=/shared/site-packages"), "{text}");
        assert!(
            text.contains("PRIVATE=/task/private-site-packages"),
            "{text}"
        );
        assert!(text.contains("SECRET=unset"), "{text}");
        assert!(text.contains("COPIED_CLEAN"), "{text}");
        assert!(text.contains("FUNCTION_ABSENT"), "{text}");
        assert!(text.contains("ALIAS_ABSENT"), "{text}");
        assert!(text.contains("ORIGINAL_DENIED"), "{text}");
        assert!(
            snapshot.is_file(),
            "the trusted source snapshot must remain intact"
        );
        assert!(
            !copied_snapshot.exists(),
            "the per-invocation snapshot must be removed after the shell exits"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn isolated_shell_keeps_swe_bench_dependency_roots_for_python_bootstrap() {
        let python = Path::new("/usr/bin/python3");
        if !python.exists() {
            return;
        }

        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let bootstrap = root.path().join("bootstrap");
        let base_site = root.path().join("base-site-packages");
        let private_site = root.path().join("private-site-packages");
        let runs_root = root.path().join("runs");
        for directory in [
            &workspace,
            &bootstrap,
            &base_site,
            &private_site,
            &runs_root,
        ] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(
            bootstrap.join("sitecustomize.py"),
            r#"import os, sys
for name in ('SWE_BENCH_BASE_SITE_PACKAGES', 'SWE_BENCH_PRIVATE_SITE_PACKAGES'):
    for value in os.environ.get(name, '').split(os.pathsep):
        if value:
            sys.path.append(value)
"#,
        )
        .unwrap();
        std::fs::write(base_site.join("base_dependency.py"), "ORIGIN = 'base'\n").unwrap();
        std::fs::write(
            private_site.join("private_dependency.py"),
            "ORIGIN = 'private'\n",
        )
        .unwrap();

        let snapshot = root.path().join("verifier-snapshot.sh");
        std::fs::write(
            &snapshot,
            format!(
                "export PATH='/usr/bin:/bin'\n\
                 export SWE_BENCH_BASE_SITE_PACKAGES='{}'\n\
                 export SWE_BENCH_PRIVATE_SITE_PACKAGES='{}'\n\
                 export SWE_BENCH_RUNS_ROOT='{}'\n",
                base_site.display(),
                private_site.display(),
                runs_root.display(),
            ),
        )
        .unwrap();

        let isolated_python_path =
            std::env::join_paths([workspace.as_path(), bootstrap.as_path()]).unwrap();
        let invocation = shell_invocation(
            "/bin/bash",
            "/usr/bin/python3 -c 'import base_dependency, private_dependency, os; print(base_dependency.ORIGIN, private_dependency.ORIGIN, os.environ[\"SWE_BENCH_RUNS_ROOT\"])'",
            true,
            true,
        );
        let output = std::process::Command::new(invocation.program)
            .args(invocation.args)
            .env_clear()
            .env("KCODER_SHELL_SNAPSHOT", &snapshot)
            .env("KCODER_ISOLATED_HOME", root.path().join("home"))
            .env("KCODER_ISOLATED_CACHE", root.path().join("cache"))
            .env("KCODER_ISOLATED_TMP", root.path().join("tmp"))
            .env("KCODER_ISOLATED_PIP_CACHE", root.path().join("pip-cache"))
            .env("KCODER_ISOLATED_NPM_CACHE", root.path().join("npm-cache"))
            .env(
                "KCODER_ISOLATED_PYTHON_CACHE",
                root.path().join("python-cache"),
            )
            .env("KCODER_ISOLATED_PYTHONPATH", isolated_python_path)
            .env("KCODER_ISOLATED_PYTEST_ADDOPTS", "")
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            format!("base private {}", runs_root.display())
        );
    }

    #[test]
    fn ordinary_shell_uses_the_original_ready_snapshot() {
        let source_root = tempfile::tempdir().unwrap();
        let source = source_root.path().join("snapshot.sh");
        std::fs::write(&source, "export SNAPSHOT_VALUE=ready\n").unwrap();

        let prepared = shell_snapshot_for_spawn(Some(&source), None)
            .unwrap()
            .unwrap();
        assert_eq!(prepared.path, source);
        assert!(prepared.temporary.is_none());
    }

    #[test]
    fn successful_verification_allows_expected_failure_output() {
        let evidence = masked_failure_evidence(
            "python bin/test assumptions",
            "stdout:\ntest_issue_6275 FAILED\nTraceback (most recent call last):\nAssertionError\n3 expected failures\n",
            true,
        );

        assert!(evidence.is_empty());
    }

    #[test]
    fn masked_failure_evidence_marks_explicitly_ignored_assertion() {
        let evidence = masked_failure_evidence(
            "python3 -c 'assert False' || true",
            "stdout:\nTraceback (most recent call last):\nAssertionError\n",
            true,
        );

        assert_eq!(evidence, vec!["explicit failure masking"]);
    }

    #[test]
    fn successful_pipeline_does_not_treat_read_only_source_text_as_failure() {
        let command = "/usr/bin/python3.12 -c 'print(1)' 2>&1 | tail -5; \
                       echo rc=0; printf '%s\n' 'except ValueError:' \
                       'Traceback (most recent call last)' | head -60";
        let evidence = masked_failure_evidence(
            command,
            "stdout:\n1\nrc=0\nexcept ValueError:\nTraceback (most recent call last)\n",
            true,
        );

        assert!(verification_like_command(command));
        assert!(command_may_mask_failure(command));
        assert!(!command_explicitly_masks_failure(command));
        assert!(evidence.is_empty());
    }

    #[test]
    fn versioned_python_inline_commands_are_verification_like() {
        for command in [
            "/usr/bin/python3.12 -c 'print(1)'",
            "/opt/python3.8 -c 'print(1)'",
            "pypy3.10 -c 'print(1)'",
        ] {
            assert!(verification_like_command(command), "{command}");
        }
    }

    #[test]
    fn docker_exec_pytest_is_authenticated_as_a_raw_target_test() {
        for command in [
            "docker exec task python -m pytest tests -q",
            "docker exec -w /app task bash -lc 'cd /tests && python -m pytest test_outputs.py -v'",
            "podman exec --workdir /app task sh -c 'pytest tests -q'",
        ] {
            assert!(test_like_command(command), "{command}");
            assert!(verification_like_command(command), "{command}");
            assert!(test_command_preserves_raw_exit(command), "{command}");
        }
    }

    #[test]
    fn docker_exec_test_policy_sees_nested_filters_and_failure_masks() {
        let narrow = "docker exec task bash -lc 'python -m pytest tests -k one_case'";
        assert!(test_command_has_narrow_scope(narrow));

        for command in [
            "docker exec task bash -lc 'python -m pytest tests | tail -20'",
            "docker exec task bash -lc 'python -m pytest tests || true'",
            "docker exec task bash -lc 'python -m pytest tests; echo done'",
        ] {
            assert!(test_like_command(command), "{command}");
            assert!(!test_command_preserves_raw_exit(command), "{command}");
        }
    }

    #[test]
    fn explicit_mask_is_rejected_even_without_failure_text() {
        assert_eq!(
            masked_failure_evidence(
                "python3 -c 'import sys; sys.exit(7)' >/dev/null 2>&1 || true",
                "(no output)",
                true,
            ),
            vec!["explicit failure masking"]
        );
    }

    #[test]
    fn quoted_or_commented_mask_words_are_not_shell_failure_masks() {
        for command in [
            "rg '|| true' app.py",
            "printf '%s' 'set +e'",
            "python3 -c 'print(\"|| true; set +e\")'",
            "printf '%s' \"! pytest\"",
            "rg pattern app.py # || true; set +e",
        ] {
            assert!(!command_explicitly_masks_failure(command), "{command}");
        }
        assert!(!command_may_mask_failure(
            "python3 -c 'print(\"a | b; still source\")'"
        ));
    }

    #[test]
    fn unquoted_and_nested_shell_fallbacks_are_failure_masks() {
        for command in [
            "python3 -c 'assert False' || /bin/true",
            "python3 -c 'assert False' || echo ignored",
            "! python3 -c 'assert False'",
            "set +e; python3 -c 'assert False'; exit 0",
            "bash -c 'python3 -c \"assert False\" || true'",
        ] {
            assert!(command_explicitly_masks_failure(command), "{command}");
        }
        assert!(verification_like_command(
            "bash -c 'python3 -c \"assert False\" || true'"
        ));
    }

    #[test]
    fn ordinary_shell_fallback_is_not_global_failure_evidence() {
        let command = "command -v optional-tool || echo missing";
        assert!(command_explicitly_masks_failure(command));
        assert!(!verification_like_command(command));
        assert!(masked_failure_evidence(command, "missing", true).is_empty());

        assert!(!verification_like_command(
            "printf '%s' 'cargo check || true'"
        ));
    }

    #[tokio::test]
    async fn bash_keeps_successful_expected_failure_test_as_success() {
        let output = run_shell_command(
            "/bin/bash".to_string(),
            "printf '%s\\n' 'test_issue_6275 FAILED' 'Traceback (most recent call last):' 'AssertionError' '3 expected failures' # python bin/test assumptions"
                .to_string(),
            PathBuf::from("/tmp"),
            10_000,
            OutputLimits::from_context(&ToolContext::new(AppState::new("/tmp"))),
        )
        .await
        .unwrap();

        assert!(!output.is_error, "{}", output_text(&output));
        assert!(output_text(&output).starts_with("exit_code: 0\n"));
    }

    #[test]
    fn formatted_bash_result_exposes_exit_code() {
        let invocation = shell_invocation(&default_bash_shell(), "exit 7", false, false);
        let status = std::process::Command::new(invocation.program)
            .args(invocation.args)
            .status()
            .unwrap();

        let text = format_bash_result(&status, false, &[], Path::new("/tmp"), "(no output)");

        assert!(text.starts_with("exit_code: 7\n"));
    }

    #[tokio::test]
    async fn bash_pipefail_marks_masked_pipeline_failure() {
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let output = run_shell_command(
            "/bin/bash".to_string(),
            "false | true".to_string(),
            PathBuf::from("/tmp"),
            10_000,
            OutputLimits::from_context(&ToolContext::new(AppState::new("/tmp"))),
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

        assert!(output.is_error);
        assert!(text.starts_with("exit_code: 1\n"));
    }

    #[tokio::test]
    async fn bash_verification_chain_does_not_hide_pipeline_failure_behind_echo() {
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let output = run_shell_command(
            "/bin/bash".to_string(),
            "/usr/bin/python3 -c 'import sys; sys.exit(7)' | true; echo 'init ok'".to_string(),
            PathBuf::from("/tmp"),
            10_000,
            OutputLimits::from_context(&ToolContext::new(AppState::new("/tmp"))),
        )
        .await
        .unwrap();

        assert!(output.is_error, "{}", output_text(&output));
        assert!(output_text(&output).starts_with("exit_code: 7\n"));
        assert!(!output_text(&output).contains("init ok"));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn versioned_python_pipeline_failure_stops_before_trailing_echo() {
        use std::os::unix::fs::symlink;

        if !std::path::Path::new("/bin/bash").exists()
            || !std::path::Path::new("/usr/bin/python3").exists()
        {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let python = temp.path().join("python3.12");
        // Point to a stable ELF executable to avoid ETXTBSY when a busy parallel test executes a script immediately after writing it.
        symlink("/usr/bin/python3", &python).unwrap();
        let command = format!(
            "{} -c 'import sys; sys.exit(7)' 2>&1 | tail -5; echo should-not-run",
            python.display()
        );

        let output = run_shell_command(
            "/bin/bash".to_string(),
            command,
            temp.path().to_path_buf(),
            10_000,
            OutputLimits::from_context(&ToolContext::new(AppState::new(temp.path()))),
        )
        .await
        .unwrap();
        let text = output_text(&output);

        assert!(output.is_error, "{text}");
        assert!(text.starts_with("exit_code: 7\n"), "{text}");
        assert!(!text.contains("should-not-run"), "{text}");
    }

    #[tokio::test]
    async fn successful_verification_can_print_error_words_from_read_only_source() {
        if !std::path::Path::new("/bin/bash").exists()
            || !std::path::Path::new("/usr/bin/python3").exists()
        {
            return;
        }
        let command = "/usr/bin/python3 -c 'print(1)' 2>&1 | tail -5; \
                       echo rc=0; printf '%s\\n' 'except ValueError:' \
                       'Traceback (most recent call last)' | head -60";
        let output = run_shell_command(
            "/bin/bash".to_string(),
            command.to_string(),
            PathBuf::from("/tmp"),
            10_000,
            OutputLimits::from_context(&ToolContext::new(AppState::new("/tmp"))),
        )
        .await
        .unwrap();
        let text = output_text(&output);

        assert!(!output.is_error, "{text}");
        assert!(text.starts_with("exit_code: 0\n"), "{text}");
        assert!(!text.contains("failure_evidence:"), "{text}");
    }

    #[tokio::test]
    async fn bash_business_denial_text_remains_an_ordinary_process_failure() {
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }

        for stream in ["", " >&2"] {
            let command = format!(
                "printf '%s\\n' 'Access Denied.' 'Invalid password format.'{stream}; exit 23"
            );
            let output = run_shell_command(
                "/bin/bash".to_string(),
                command,
                PathBuf::from("/tmp"),
                10_000,
                OutputLimits::from_context(&ToolContext::new(AppState::new("/tmp"))),
            )
            .await
            .expect("目标程序的普通拒绝文本不能被识别成沙箱拒绝");
            let text = output_text(&output);

            assert!(output.is_error, "{text}");
            assert!(text.starts_with("exit_code: 23\n"), "{text}");
            assert!(text.contains("Access Denied."), "{text}");
            assert!(text.contains("Invalid password format."), "{text}");
        }
    }

    #[tokio::test]
    async fn bash_result_reports_actual_workdir_and_non_persistent_scope() {
        let temp = tempfile::tempdir().unwrap();
        let output = run_shell_command(
            default_bash_shell(),
            "pwd".to_string(),
            temp.path().to_path_buf(),
            10_000,
            OutputLimits::from_context(&ToolContext::new(AppState::new(temp.path()))),
        )
        .await
        .unwrap();
        let text = output_text(&output);

        assert!(
            text.contains(&format!("workdir: {}", temp.path().display())),
            "{text}"
        );
        assert!(text.contains("workdir_scope: invocation_only"), "{text}");
    }

    #[tokio::test]
    async fn bash_workdir_is_machine_reported_and_sandbox_checked() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("candidate");
        let baseline = root.path().join("baseline");
        let outside = root.path().join("outside");
        for path in [&workspace, &baseline, &outside] {
            std::fs::create_dir_all(path).unwrap();
        }
        let sandbox = Arc::new(crate::Sandbox::new(
            &workspace,
            kcoder_types::SandboxConfig {
                enabled: true,
                allowed_paths: vec![baseline.display().to_string()],
                ..Default::default()
            },
        ));
        let ctx = ToolContext::new(AppState::new(&workspace)).with_sandbox(sandbox);

        let output = BashTool
            .call(
                serde_json::json!({"command": "pwd", "workdir": baseline}),
                &ctx,
            )
            .await
            .unwrap();
        let text = output_text(&output);
        assert!(
            text.contains(&format!("workdir: {}", baseline.display())),
            "{text}"
        );
        assert!(text.contains(&baseline.display().to_string()), "{text}");

        let denied = BashTool
            .call(
                serde_json::json!({"command": "pwd", "workdir": outside}),
                &ctx,
            )
            .await;
        assert!(matches!(denied, Err(ToolError::SandboxDenied { .. })));
    }

    #[tokio::test]
    async fn bash_head_limited_sigpipe_is_treated_as_success() {
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        let output = run_shell_command(
            "/bin/bash".to_string(),
            "yes | head -5".to_string(),
            PathBuf::from("/tmp"),
            10_000,
            OutputLimits::from_context(&ToolContext::new(AppState::new("/tmp"))),
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

        assert!(!output.is_error);
        assert!(text.starts_with("exit_code: 0\n"));
        assert!(text.contains("SIGPIPE"));
    }
}
