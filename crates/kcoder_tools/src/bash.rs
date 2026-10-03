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

mod background;
use background::*;
mod execution;
use execution::*;
mod process_owner;
use process_owner::*;
mod sandbox_spawn;
use sandbox_spawn::*;
mod snapshot;
use snapshot::*;
mod output_capture;
use output_capture::*;
mod invocation;
use invocation::*;
mod isolation_environment;
pub(crate) use isolation_environment::verifier_isolation_environment;
use isolation_environment::*;
mod verification_policy;
// Preserve the original crate-visible helper path, also used by Bash test groups.
#[allow(unused_imports)]
pub(crate) use verification_policy::behavior_probe_command;
use verification_policy::*;
pub(crate) use verification_policy::{
    behavior_probe_command_signature, read_only_search_no_match_command,
    test_command_has_narrow_scope, test_command_preserves_raw_exit, test_command_signature,
    test_command_skips_execution, test_like_command, verification_like_command,
    verifier_native_build_command_signature, verifier_test_command_rejection,
};
mod command_classification;
pub(crate) use command_classification::dependency_mutation_command;
#[cfg(test)]
pub(crate) use command_classification::workspace_mutation_command;
use command_classification::*;
mod command_syntax;
use command_syntax::*;
pub(crate) use command_syntax::{scoped_shell_command_matches_allowed_prefixes, shell_words};

#[cfg(test)]
mod tests;
