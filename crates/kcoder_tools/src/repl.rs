use crate::background::{
    ForegroundWaitOutcome, ManagedForegroundJob, wait_for_foreground_completion,
};
use crate::process::{
    CapturedOutput, LiveOutputCapture, OutputLimits, OutputStream,
    configure_isolated_process_environment, read_output_pipe_bounded,
};
use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::debug;

/// Execute code in a REPL environment backed by a system interpreter.
///
/// JavaScript/TypeScript code runs via `bun` or `node`; Python code runs via
/// `python3` or `python`. Shell snippets run via PowerShell on Windows and
/// `bash` on Unix-like systems. The tool captures stdout/stderr and returns
/// them as the result.
#[derive(Debug, Default)]
pub struct REPLTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct REPLInput {
    /// Script source for batch operations and programmatic control flow. JavaScript/Python expressions are not echoed; use console.log(...) or print(...) to produce output.
    pub code: String,
    /// Optional language hint. Supported: "javascript", "js", "python", and
    /// "shell". On Windows, "shell" means PowerShell. On Unix-like systems,
    /// "shell" means bash. When omitted the language is inferred from the code
    /// shebang or defaults to JavaScript.
    #[serde(default)]
    pub language: Option<String>,
    /// Optional timeout in seconds. Defaults to 60.
    #[serde(default = "default_timeout_seconds")]
    pub timeout: u64,
}

fn default_timeout_seconds() -> u64 {
    60
}

#[async_trait]
impl Tool for REPLTool {
    fn name(&self) -> String {
        "REPL".to_string()
    }

    fn description(&self) -> String {
        let shell = if cfg!(windows) { "PowerShell" } else { "bash" };
        format!(
            "Execute a script in a fresh interpreter process under the session sandbox policy; variables do not persist between calls. \
             Use for batch operations, complex multi-step file transformations, and programmatic control flow. \
             The script runs in the KCoder session's current working directory, not the process startup directory. \
             Only stdout/stderr are returned. JavaScript/TypeScript and Python do not automatically print a trailing expression: use console.log(JSON.stringify(value)) or print(value). Adding a semicolon or return does not print. Empty output can mean successful execution without printing; do not repeat side effects merely to obtain output. Shell snippets follow {shell} output semantics on this platform."
        )
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(REPLInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let input: REPLInput = parse_input(&input)?;
        let Some(manager) = ctx.background_job_manager.as_ref() else {
            return execute_repl(input, ctx, None).await;
        };
        let capture = LiveOutputCapture::new(OutputLimits::from_context(ctx));
        let run_capture = capture.clone();
        // Copy only the execution context; never retain a manager through its own job.
        let mut run_ctx = ToolContext::new(ctx.state.clone())
            .with_output_limits(
                ctx.max_output_bytes,
                ctx.output_head_bytes,
                ctx.output_tail_bytes,
            )
            .with_owned_command_program(ctx.owned_command_program.clone());
        run_ctx.sandbox = ctx.sandbox.clone();
        run_ctx.abort_token = ctx.abort_token.clone();
        // Keep the same execution future when a longer script needs managed progress.
        let mut execution =
            Box::pin(async move { execute_repl(input, &run_ctx, Some(run_capture)).await });
        tokio::select! {
            result = &mut execution => return result,
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
        let execution_error = std::sync::Arc::new(std::sync::Mutex::new(None));
        let job_error = execution_error.clone();
        let events = ctx.subscribe_background_jobs()?;
        let id = ctx.spawn_foreground(
            crate::background::tool_background_description("repl", "REPL"),
            async move {
                match execution.await {
                    Ok(output) => output,
                    Err(error) => {
                        let output = ToolOutput::error(error.to_string());
                        *job_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(error);
                        output
                    }
                }
            },
        )?;
        let guard = ManagedForegroundJob::new(ctx, id.clone())?;
        capture.report_progress_to(manager, &id);
        if let Some(path) = ctx.state.task(&id).and_then(|task| task.output_path) {
            capture.attach(path).await;
        }
        match wait_for_foreground_completion(ctx, &id, events).await? {
            ForegroundWaitOutcome::Completed(output) => {
                guard.complete();
                match execution_error
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take()
                {
                    Some(error) => Err(error),
                    None => Ok(output),
                }
            }
            ForegroundWaitOutcome::TimedOut => {
                unreachable!("REPL uses its own total execution deadline")
            }
        }
    }
}

async fn execute_repl(
    input: REPLInput,
    ctx: &ToolContext,
    live: Option<LiveOutputCapture>,
) -> Result<ToolOutput, ToolError> {
    if ctx.is_aborted() {
        return Err(ToolError::Aborted);
    }

    let language = detect_language(&input);
    let (program, args, extension) = resolve_interpreter(&language)?;

    if let Some(sandbox) = &ctx.sandbox {
        sandbox.check_shell().map_err(ToolError::Execution)?;
    }
    #[cfg(windows)]
    let os_sandbox = ctx.sandbox.as_ref().and_then(|sandbox| sandbox.os_spec());

    // Create the directory atomically with private permissions and keep
    // the guard alive for the whole call. TempDir removes both script and
    // directory on success, timeout, spawn failure, and every `?` path.
    let temp_dir = tempfile::Builder::new()
        .prefix("kcoder-repl-")
        .tempdir()
        .map_err(|e| ToolError::Execution(format!("failed to create repl temp dir: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp_dir.path(), std::fs::Permissions::from_mode(0o700)).map_err(
            |e| ToolError::Execution(format!("failed to restrict repl temp dir permissions: {e}")),
        )?;
    }

    let file_name = format!("REPL.{}.{}", ulid::generate(), extension);
    let script_path = temp_dir.path().join(file_name);
    let script = prepare_repl_script(&language, &input.code);
    tokio::fs::write(&script_path, encode_repl_script(&language, &script))
        .await
        .map_err(|e| ToolError::Execution(format!("failed to write repl script: {}", e)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o600)).map_err(
            |e| ToolError::Execution(format!("failed to restrict repl script permissions: {e}")),
        )?;
    }

    debug!(
        "running REPL script {:?} with {} (language={})",
        script_path, program, language
    );

    let cwd = ctx.state.cwd();
    let mut cmd = Command::new(&program);
    #[cfg(target_os = "linux")]
    if let Some(owner) = ctx.owned_command_program.as_deref() {
        cmd = Command::new(owner);
        cmd.arg(kcoder_process_supervisor::linux_stdio::INTERNAL_COMMAND_OWNER_V1)
            .arg(std::process::id().to_string())
            .arg(&program);
    }
    cmd.args(&args).arg(&script_path).current_dir(&cwd);
    configure_isolated_process_environment(&mut cmd, &cwd);
    if extension == "py" {
        // Windows Python otherwise inherits the legacy console code page
        // (often cp1252), which makes normal Unicode tool output fail to
        // encode before KCoder can capture it.
        cmd.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
    }
    cmd.env("KCODER_REPL", "1")
        .env("KCODER_REPL_CWD", &cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    #[cfg(windows)]
    if let Some(spec) = os_sandbox {
        let mut environment = crate::process::isolated_process_environment(&cwd);
        if extension == "py" {
            environment.push(("PYTHONUTF8".into(), "1".into()));
            environment.push(("PYTHONIOENCODING".into(), "utf-8".into()));
        }
        environment.push(("KCODER_REPL".into(), "1".into()));
        environment.push(("KCODER_REPL_CWD".into(), cwd.as_os_str().to_os_string()));
        let sandbox_args = args
            .iter()
            .map(Into::into)
            .chain(std::iter::once(script_path.as_os_str().to_os_string()))
            .collect::<Vec<_>>();
        let mut child = crate::windows_sandbox::spawn(
            std::ffi::OsStr::new(&program),
            &sandbox_args,
            &cwd,
            &environment,
            &spec,
        )
        .map_err(|reason| ToolError::SandboxDenied {
            reason,
            output: None,
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ToolError::Execution("failed to capture sandboxed REPL stdout".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ToolError::Execution("failed to capture sandboxed REPL stderr".to_string())
        })?;
        let mut readers = ReplOutputReaders::new(stdout, stderr, ctx, temp_dir.path(), live);
        let status = match timeout(Duration::from_secs(input.timeout), child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(error)) => {
                return Err(ToolError::Execution(format!(
                    "failed to run sandboxed REPL: {error}"
                )));
            }
            Err(_) => {
                child.terminate();
                let _ = child.wait().await;
                return Err(ToolError::Execution(format!(
                    "REPL execution timed out after {} seconds",
                    input.timeout
                )));
            }
        };
        // A background descendant can keep inherited pipes open after the
        // root exits. End the Job before collecting output.
        child.terminate();
        let (stdout, stderr) = readers.collect().await?;
        return finish_repl_output(ctx, status, stdout, stderr);
    }

    #[cfg(windows)]
    let mut windows_job = kcoder_process_supervisor::suspended_child::SuspendedChildJob::new()
        .map_err(|error| {
            ToolError::Execution(format!("cannot create REPL process job: {error}"))
        })?;
    #[cfg(windows)]
    cmd.creation_flags(kcoder_process_supervisor::suspended_child::SUSPENDED_CHILD_FLAGS);
    let mut child = cmd
        .spawn()
        .map_err(|e| ToolError::Execution(format!("failed to run REPL: {}", e)))?;
    #[cfg(windows)]
    {
        let handle = child
            .raw_handle()
            .ok_or_else(|| ToolError::Execution("REPL process handle unavailable".into()))?;
        // SAFETY: the unreaped suspended child owns the borrowed process handle.
        windows_job
            .assign_and_resume(unsafe { std::os::windows::io::BorrowedHandle::borrow_raw(handle) })
            .map_err(|error| {
                ToolError::Execution(format!("cannot assign REPL process job: {error}"))
            })?;
    }
    let process_tree = child
        .id()
        .map(ReplProcessTreeTerminator::new)
        .ok_or_else(|| {
            ToolError::Execution("REPL process did not expose a process id".to_string())
        })?;
    #[cfg(any(target_os = "linux", windows))]
    let mut process_tree = process_tree;
    #[cfg(windows)]
    {
        process_tree.windows_job = Some(windows_job);
    }
    #[cfg(target_os = "linux")]
    if ctx.owned_command_program.is_some() {
        process_tree.owner = Some(
            kcoder_process_supervisor::linux_stdio::StdioOwnerGuard::for_child(process_tree.pid)
                .map_err(|error| {
                    ToolError::Execution(format!("cannot bind REPL process owner: {error}"))
                })?,
        );
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ToolError::Execution("REPL stdout unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ToolError::Execution("REPL stderr unavailable".into()))?;
    let mut readers = ReplOutputReaders::new(stdout, stderr, ctx, temp_dir.path(), live);
    let execution = async {
        let status = child
            .wait()
            .await
            .map_err(|e| ToolError::Execution(format!("failed to run REPL: {e}")))?;
        process_tree.finish_after_exit();
        let (stdout, stderr) = readers.collect().await?;
        finish_repl_output(ctx, status, stdout, stderr)
    };
    tokio::select! {
        result = timeout(Duration::from_secs(input.timeout), execution) => match result {
            Ok(output) => output,
            Err(_) => {
                process_tree.terminate();
                let _ = child.wait().await;
                Err(ToolError::Execution(format!("REPL execution timed out after {} seconds", input.timeout)))
            }
        },
        _ = ctx.cancelled() => {
            process_tree.terminate();
            let _ = child.wait().await;
            Err(ToolError::Aborted)
        }
    }
}

struct ReplOutputReaders {
    stdout: tokio::task::JoinHandle<std::io::Result<CapturedOutput>>,
    stderr: tokio::task::JoinHandle<std::io::Result<CapturedOutput>>,
    stdout_spool: Option<tempfile::NamedTempFile>,
    stderr_spool: Option<tempfile::NamedTempFile>,
    spill_dir: std::path::PathBuf,
}

impl ReplOutputReaders {
    fn new(
        stdout: impl tokio::io::AsyncRead + Unpin + Send + 'static,
        stderr: impl tokio::io::AsyncRead + Unpin + Send + 'static,
        ctx: &ToolContext,
        temp_root: &std::path::Path,
        live: Option<LiveOutputCapture>,
    ) -> Self {
        let limits = OutputLimits::from_context(ctx);
        let make_spool = || {
            let file = (ctx.max_output_bytes > 0)
                .then(|| tempfile::NamedTempFile::new_in(temp_root).ok())
                .flatten();
            let writer = file
                .as_ref()
                .and_then(|file| file.as_file().try_clone().ok())
                .map(|file| {
                    tokio::io::BufWriter::with_capacity(64 * 1024, tokio::fs::File::from_std(file))
                });
            (file, writer)
        };
        let (stdout_spool, stdout_writer) = make_spool();
        let (stderr_spool, stderr_writer) = make_spool();
        Self {
            stdout: tokio::spawn(read_output_pipe_bounded(
                stdout,
                limits.clone(),
                live.clone().map(|capture| (capture, OutputStream::Stdout)),
                stdout_writer,
            )),
            stderr: tokio::spawn(read_output_pipe_bounded(
                stderr,
                limits,
                live.map(|capture| (capture, OutputStream::Stderr)),
                stderr_writer,
            )),
            stdout_spool,
            stderr_spool,
            spill_dir: crate::truncate::spill_dir_for_state(&ctx.state),
        }
    }

    async fn collect(&mut self) -> Result<(CapturedOutput, CapturedOutput), ToolError> {
        let (stdout, stderr) = tokio::try_join!(&mut self.stdout, &mut self.stderr)
            .map_err(|error| ToolError::Execution(format!("REPL output reader failed: {error}")))?;
        let mut stdout =
            stdout.map_err(|error| ToolError::Execution(format!("REPL stdout failed: {error}")))?;
        let stderr =
            stderr.map_err(|error| ToolError::Execution(format!("REPL stderr failed: {error}")))?;
        if (stdout.truncated || stderr.truncated) && stdout.spool_complete && stderr.spool_complete
        {
            let files = self
                .stdout_spool
                .as_ref()
                .zip(self.stderr_spool.as_ref())
                .and_then(|(out, err)| {
                    Some((
                        out.as_file().try_clone().ok()?,
                        err.as_file().try_clone().ok()?,
                    ))
                });
            if let Some((mut out, mut err)) = files {
                let directory = self.spill_dir.clone();
                stdout.full_output_path =
                    tokio::task::spawn_blocking(move || -> Option<std::path::PathBuf> {
                        use std::io::{Read, Seek};
                        out.rewind().ok()?;
                        err.rewind().ok()?;
                        let mut reader = std::io::Cursor::new(b"stdout:\n")
                            .chain(out)
                            .chain(std::io::Cursor::new(b"\nstderr:\n"))
                            .chain(err);
                        let name = format!("repl-{}.txt", uuid::Uuid::new_v4());
                        kcoder_config::PrivateDirectory::open_or_create(&directory)
                            .ok()?
                            .atomic_publish_from_reader(
                                std::ffi::OsStr::new(&name),
                                &mut reader,
                                false,
                                || Ok(None),
                            )
                            .ok()?;
                        Some(directory.join(name))
                    })
                    .await
                    .ok()
                    .flatten();
            }
        }
        Ok((stdout, stderr))
    }
}

impl Drop for ReplOutputReaders {
    fn drop(&mut self) {
        self.stdout.abort();
        self.stderr.abort();
    }
}

fn finish_repl_output(
    ctx: &ToolContext,
    status: ExitStatus,
    stdout: CapturedOutput,
    stderr: CapturedOutput,
) -> Result<ToolOutput, ToolError> {
    let truncated = stdout.truncated || stderr.truncated;
    let full_output_path = stdout
        .full_output_path
        .as_ref()
        .or(stderr.full_output_path.as_ref());
    let stdout = stdout.utf8_preview();
    let stderr = stderr.utf8_preview();
    let notice = if truncated {
        "[tool output exceeded size limit]\n"
    } else {
        ""
    };
    let render = |text: &str| {
        if !truncated {
            return ctx.truncate(text);
        }
        let trailer = full_output_path
            .as_ref()
            .map(|path| format!(" Full output at: {}.", path.display()));
        let text = if text.len() <= ctx.max_output_bytes {
            format!("{text}{}", trailer.as_deref().unwrap_or_default())
        } else {
            text.to_string()
        };
        crate::truncate::truncate_text_with_trailer(
            &text,
            ctx.max_output_bytes,
            ctx.output_head_bytes,
            ctx.output_tail_bytes,
            crate::truncate::TruncationReason::OutputTooLarge,
            trailer.as_deref(),
        )
        .text
    };

    if !status.success() {
        let mut message = format!(
            "{notice}REPL exited with status {}\n",
            format_repl_exit_status(&status)
        );
        if !stdout.is_empty() {
            message.push_str("stdout:\n");
            message.push_str(&stdout);
            message.push('\n');
        }
        if !stderr.is_empty() {
            message.push_str("stderr:\n");
            message.push_str(&stderr);
        }
        return Ok(ToolOutput::error(render(message.trim_end())));
    }

    let result = if stderr.is_empty() {
        stdout
    } else {
        format!("{}\nstderr:\n{}", stdout, stderr)
    };

    Ok(ToolOutput::text(render(&format!("{notice}{result}"))))
}

fn prepare_repl_script(_language: &str, code: &str) -> String {
    #[cfg(windows)]
    if matches!(_language, "shell" | "powershell" | "pwsh" | "ps1") {
        // Windows PowerShell 5.1 uses the active OEM code page when stdout is
        // redirected. Keep user code inside its own script block so a leading
        // param(...) remains valid after the UTF-8 preamble.
        return format!(
            "$KCoderUtf8 = [System.Text.UTF8Encoding]::new($false)\n\
             [Console]::OutputEncoding = $KCoderUtf8\n\
             $OutputEncoding = $KCoderUtf8\n\
             & {{\n{code}\n}}\n"
        );
    }
    code.to_string()
}

fn encode_repl_script(_language: &str, script: &str) -> Vec<u8> {
    #[cfg(windows)]
    if matches!(_language, "shell" | "powershell" | "pwsh" | "ps1") {
        // Windows PowerShell 5.1 treats UTF-8 script files without a BOM as
        // the active ANSI code page. The BOM is only for source decoding;
        // the runtime preamble still emits BOM-less UTF-8 to captured pipes.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(script.as_bytes());
        return bytes;
    }
    script.as_bytes().to_vec()
}

fn format_repl_exit_status(status: &ExitStatus) -> String {
    status
        .code()
        .map(|code| format!("exit code: {code}"))
        .unwrap_or_else(|| status.to_string())
}

struct ReplProcessTreeTerminator {
    pid: u32,
    finished: AtomicBool,
    #[cfg(target_os = "linux")]
    owner: Option<kcoder_process_supervisor::linux_stdio::StdioOwnerGuard>,
    #[cfg(windows)]
    windows_job: Option<kcoder_process_supervisor::suspended_child::SuspendedChildJob>,
}

impl ReplProcessTreeTerminator {
    fn new(pid: u32) -> Self {
        Self {
            pid,
            finished: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            owner: None,
            #[cfg(windows)]
            windows_job: None,
        }
    }

    fn terminate(&self) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(target_os = "linux")]
        if let Some(owner) = &self.owner {
            owner.request_stop();
            return;
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
            if let Some(job) = &self.windows_job {
                let _ = job.terminate();
                return;
            }
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    fn finish_after_exit(&self) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(target_os = "linux")]
        if self.owner.is_some() {
            return;
        }
        #[cfg(windows)]
        if let Some(job) = &self.windows_job {
            let _ = job.terminate();
        }
        // The root was reaped: never signal its numeric PID after that point.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL);
        }
    }
}

impl Drop for ReplProcessTreeTerminator {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn detect_language(input: &REPLInput) -> String {
    if let Some(lang) = &input.language {
        return lang.to_lowercase();
    }
    let trimmed = input.code.trim_start();
    if trimmed.starts_with("#!/usr/bin/env python") || trimmed.starts_with("#!/usr/bin/python") {
        return "python".to_string();
    }
    if trimmed.starts_with("#!/bin/bash") || trimmed.starts_with("#!/usr/bin/env bash") {
        return "bash".to_string();
    }
    if trimmed.starts_with("#!/bin/sh") {
        return "sh".to_string();
    }
    if trimmed.starts_with("#!/usr/bin/env pwsh")
        || trimmed.starts_with("#!/usr/bin/env powershell")
    {
        return "powershell".to_string();
    }
    "javascript".to_string()
}

fn resolve_interpreter(language: &str) -> Result<(String, Vec<String>, String), ToolError> {
    match language {
        "javascript" | "js" | "jsx" | "ts" | "typescript" => {
            if let Ok(path) = which::which("bun") {
                Ok((
                    path.to_string_lossy().to_string(),
                    vec!["run".to_string()],
                    "js".to_string(),
                ))
            } else if let Ok(path) = which::which("node") {
                Ok((
                    path.to_string_lossy().to_string(),
                    Vec::new(),
                    "js".to_string(),
                ))
            } else {
                Err(ToolError::Execution(
                    "no JavaScript interpreter found (tried bun, node)".to_string(),
                ))
            }
        }
        "python" | "py" => {
            for name in python_interpreter_candidates() {
                if let Ok(path) = which::which(name) {
                    return Ok((
                        path.to_string_lossy().to_string(),
                        Vec::new(),
                        "py".to_string(),
                    ));
                }
            }
            Err(ToolError::Execution(format!(
                "no Python interpreter found (tried {})",
                python_interpreter_candidates().join(", ")
            )))
        }
        "shell" => resolve_platform_shell_interpreter(),
        "bash" | "sh" => resolve_unix_shell_interpreter(),
        "powershell" | "pwsh" | "ps1" => resolve_windows_powershell_interpreter(),
        other => Err(ToolError::InvalidInput(format!(
            "unsupported REPL language: {}. Supported: {}",
            other,
            supported_repl_languages()
        ))),
    }
}

fn python_interpreter_candidates() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        // The official all-users installer exposes python.exe, while existing
        // Windows installations are also commonly reachable only through the
        // Python launcher (py.exe).
        &["python.exe", "py.exe", "python3.exe"]
    }
    #[cfg(not(windows))]
    {
        &["python3", "python"]
    }
}

fn resolve_platform_shell_interpreter() -> Result<(String, Vec<String>, String), ToolError> {
    if cfg!(windows) {
        resolve_windows_powershell_interpreter()
    } else {
        resolve_unix_shell_interpreter()
    }
}

fn resolve_unix_shell_interpreter() -> Result<(String, Vec<String>, String), ToolError> {
    if cfg!(windows) {
        return Err(ToolError::InvalidInput(
            "bash/sh REPL languages are not available on Windows. Use language \"shell\" or \"powershell\" for PowerShell.".to_string(),
        ));
    }
    if let Ok(path) = which::which("bash") {
        Ok((
            path.to_string_lossy().to_string(),
            Vec::new(),
            "sh".to_string(),
        ))
    } else {
        Err(ToolError::Execution("bash not found".to_string()))
    }
}

fn resolve_windows_powershell_interpreter() -> Result<(String, Vec<String>, String), ToolError> {
    if !cfg!(windows) {
        return Err(ToolError::InvalidInput(
            "PowerShell REPL language is not available by default on Unix-like platforms. Use language \"shell\" or \"bash\".".to_string(),
        ));
    }
    Ok((
        "powershell".to_string(),
        vec![
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
        ],
        "ps1".to_string(),
    ))
}

fn supported_repl_languages() -> &'static str {
    if cfg!(windows) {
        "javascript, python, shell, powershell"
    } else {
        "javascript, python, shell, bash, sh"
    }
}

mod ulid {
    /// Generate a short, collision-resistant identifier without adding a dependency.
    pub fn generate() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("{:013x}{:08x}", ts, n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;

    fn text_from_output(output: ToolOutput) -> String {
        output
            .content
            .into_iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn detects_bash_from_shebang() {
        let input = REPLInput {
            code: "#!/usr/bin/env bash\necho hi".to_string(),
            language: None,
            timeout: default_timeout_seconds(),
        };

        assert_eq!(detect_language(&input), "bash");
    }

    #[test]
    fn detects_powershell_from_shebang() {
        let input = REPLInput {
            code: "#!/usr/bin/env pwsh\nWrite-Output hi".to_string(),
            language: None,
            timeout: default_timeout_seconds(),
        };

        assert_eq!(detect_language(&input), "powershell");
    }

    #[test]
    fn python_interpreter_candidates_match_platform_conventions() {
        if cfg!(windows) {
            assert_eq!(
                python_interpreter_candidates(),
                &["python.exe", "py.exe", "python3.exe"]
            );
        } else {
            assert_eq!(python_interpreter_candidates(), &["python3", "python"]);
        }
    }

    #[tokio::test]
    async fn javascript_requires_explicit_printing() {
        if resolve_interpreter("javascript").is_err() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        for (code, expected) in [
            ("JSON.stringify({ok:true})", ""),
            ("JSON.stringify({ok:true});", ""),
            ("console.log(JSON.stringify({ok:true}));", "{\"ok\":true}"),
        ] {
            let output = REPLTool
                .call(
                    serde_json::json!({"language":"javascript","code":code,"timeout":5}),
                    &ctx,
                )
                .await
                .unwrap();
            assert_eq!(text_from_output(output).trim(), expected);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exited_repl_does_not_wait_for_descendant_output_pipes() {
        let root = tempfile::tempdir().unwrap();
        let context = ToolContext::new(AppState::new(root.path()));
        let output = tokio::time::timeout(
            Duration::from_secs(2),
            REPLTool.call(
                serde_json::json!({
                    "language": "shell", "code": "sleep 10 & printf REPL_ROOT_DONE", "timeout": 5
                }),
                &context,
            ),
        )
        .await
        .expect("exited script must close its owned descendant pipes")
        .unwrap();
        assert!(!output.is_error);
        assert!(text_from_output(output).contains("REPL_ROOT_DONE"));
    }

    #[tokio::test]
    async fn bounded_repl_capture_retains_the_complete_output_artifact() {
        let root = tempfile::tempdir().unwrap();
        let context =
            ToolContext::new(AppState::new(root.path())).with_output_limits(1024, 200, 200);
        let payload = format!(
            "HEAD{}MIDDLE_EXACT{}TAIL",
            "你".repeat(2048),
            "好".repeat(2048)
        );
        let code = if cfg!(windows) {
            format!("Write-Output '{payload}'")
        } else {
            format!("printf '%s' '{payload}'")
        };
        let result = REPLTool
            .call(
                serde_json::json!({"language":"shell","code":code,"timeout":5}),
                &context,
            )
            .await
            .unwrap();
        assert!(!result.is_error);
        let text = text_from_output(result);
        assert!(text.len() <= 1024);
        assert!(
            !text.contains('\u{fffd}'),
            "valid UTF-8 must not break at capture boundaries"
        );
        assert!(!text.contains("MIDDLE_EXACT"));
        let directory = crate::truncate::spill_dir_for_state(&context.state);
        let artifacts = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(
            artifacts.len(),
            1,
            "only the complete log should be published"
        );
        assert!(text.contains(&artifacts[0].display().to_string()));
        let full = std::fs::read_to_string(&artifacts[0]).unwrap();
        assert!(
            full.contains(&payload),
            "middle bytes must not be lost by bounded capture"
        );
    }

    #[tokio::test]
    async fn shell_repl_output_uses_context_truncation_limits() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_output_limits(120, 30, 20);
        let payload = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
        let code = if cfg!(windows) {
            format!("'{}'", payload)
        } else {
            format!("printf '%s' '{}'", payload)
        };
        let output = REPLTool
            .call(
                serde_json::json!({
                    "language": "shell",
                    "code": code,
                    "timeout": 5
                }),
                &ctx,
            )
            .await
            .unwrap();

        let text = text_from_output(output);
        assert!(text.contains("tool output exceeded size limit"));
        assert!(text.len() <= 120, "truncated output exceeded cap: {text}");
    }

    #[tokio::test]
    async fn repl_runs_in_session_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let code = if cfg!(windows) {
            "[System.IO.Directory]::GetCurrentDirectory()".to_string()
        } else {
            "pwd".to_string()
        };

        let output = REPLTool
            .call(
                serde_json::json!({
                    "language": "shell",
                    "code": code,
                    "timeout": 5
                }),
                &ctx,
            )
            .await
            .unwrap();

        let text = text_from_output(output);
        assert!(
            text.contains(tmp.path().to_str().unwrap()),
            "REPL output did not include session cwd: {text}"
        );
    }

    #[tokio::test]
    async fn shell_repl_uses_isolated_platform_environment() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        unsafe {
            std::env::set_var("KCODER_REPL_TEST_SECRET", "must-not-leak");
        }
        let code = if cfg!(windows) {
            "$secret = if ([string]::IsNullOrEmpty($env:KCODER_REPL_TEST_SECRET)) { 'unset' } else { $env:KCODER_REPL_TEST_SECRET }; Write-Output \"secret=$secret\"; Write-Output \"appdata=$(-not [string]::IsNullOrEmpty($env:APPDATA))\"; Write-Output \"repl=$env:KCODER_REPL\"; Write-Output \"pwd=$env:PWD\""
        } else {
            "printf 'secret=%s\\nhome=%s\\nrepl=%s\\npwd=%s\\n' \"${KCODER_REPL_TEST_SECRET-unset}\" \"${HOME-unset}\" \"$KCODER_REPL\" \"$PWD\""
        };

        let output = REPLTool
            .call(
                serde_json::json!({
                    "language": "shell",
                    "code": code,
                    "timeout": 5
                }),
                &ctx,
            )
            .await
            .unwrap();
        unsafe {
            std::env::remove_var("KCODER_REPL_TEST_SECRET");
        }

        let text = text_from_output(output);
        assert!(text.contains("secret=unset"), "{text}");
        if cfg!(windows) {
            assert!(text.contains("appdata=True"), "{text}");
        } else {
            assert!(text.contains("home=unset"), "{text}");
        }
        assert!(text.contains("repl=1"), "{text}");
        assert!(
            text.contains(&format!("pwd={}", tmp.path().display())),
            "{text}"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn shell_repl_uses_native_windows_sandbox() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let inside = workspace.join("inside.txt");
        let outside = tempfile::Builder::new()
            .prefix("kcoder-sandbox-outside-")
            .tempdir_in(dirs::home_dir().unwrap())
            .unwrap();
        let escaped = outside.path().join("escaped.txt");
        let sandbox = std::sync::Arc::new(crate::Sandbox::new(
            &workspace,
            kcoder_types::SandboxConfig {
                enabled: true,
                ..Default::default()
            },
        ));
        let ctx = ToolContext::new(AppState::new(&workspace)).with_sandbox(sandbox);
        let code = format!(
            "$ErrorActionPreference='Continue'; Set-Content -LiteralPath '{}' -Value inside; & cmd.exe /d /s /c 'echo escaped>\"{}\"'",
            inside.display(),
            escaped.display()
        );

        let output = REPLTool
            .call(
                serde_json::json!({ "language": "shell", "code": code, "timeout": 5 }),
                &ctx,
            )
            .await
            .expect("sandboxed REPL should start");

        assert!(
            inside.exists(),
            "REPL should write inside the workspace: {output:?}"
        );
        let escaped_exists = escaped.exists();
        let _ = std::fs::remove_file(&escaped);
        assert!(
            !escaped_exists,
            "REPL child escaped the workspace: {output:?}"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn native_windows_repl_job_closes_background_descendant_pipes() {
        windows_repl_closes_descendant_pipes(true).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn regular_windows_repl_job_closes_background_descendant_pipes() {
        windows_repl_closes_descendant_pipes(false).await;
    }

    #[cfg(windows)]
    async fn windows_repl_closes_descendant_pipes(sandboxed: bool) {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let marker = workspace.join("repl-descendant-survived.txt");
        let script = workspace.join("repl-descendant.ps1");
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
        let ctx = ToolContext::new(AppState::new(&workspace));
        let ctx = if sandboxed {
            ctx.with_sandbox(sandbox)
        } else {
            ctx
        };
        let code = format!(
            "Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-File','{}')",
            script.display()
        );

        let result = tokio::time::timeout(
            Duration::from_secs(5),
            REPLTool.call(
                serde_json::json!({ "language": "shell", "code": code, "timeout": 5 }),
                &ctx,
            ),
        )
        .await;
        assert!(
            result.is_ok(),
            "REPL output pipe remained open after root exit"
        );
        assert!(result.unwrap().is_ok());
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(
            !marker.exists(),
            "REPL background descendant escaped its Job"
        );
    }

    #[tokio::test]
    async fn shell_repl_preserves_unicode_output() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let code = if cfg!(windows) {
            "Write-Output '昆仑 REPL 你好'"
        } else {
            "printf '%s\\n' '昆仑 REPL 你好'"
        };

        let output = REPLTool
            .call(
                serde_json::json!({"language": "shell", "code": code, "timeout": 5}),
                &ctx,
            )
            .await
            .unwrap();

        assert!(text_from_output(output).contains("昆仑 REPL 你好"));
    }

    #[tokio::test]
    async fn python_repl_preserves_unicode_output() {
        if resolve_interpreter("python").is_err() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let output = REPLTool
            .call(
                serde_json::json!({
                    "language": "python",
                    "code": "print('昆仑 Python 你好')",
                    "timeout": 5
                }),
                &ctx,
            )
            .await
            .unwrap();

        let text = text_from_output(output);
        assert!(text.contains("昆仑 Python 你好"), "{text}");
    }

    #[tokio::test]
    async fn repl_nonzero_exit_status_is_platform_neutral() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let code = "exit 7";

        let output = REPLTool
            .call(
                serde_json::json!({"language": "shell", "code": code, "timeout": 5}),
                &ctx,
            )
            .await
            .unwrap();

        assert!(output.is_error);
        assert!(text_from_output(output).contains("REPL exited with status exit code: 7"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn repl_temp_script_is_private_and_cleaned_after_success() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = REPLTool
            .call(
                serde_json::json!({
                    "language": "shell",
                    "code": "printf 'script=%s\\ndir=%s\\nfile=%s\\n' \"$0\" \"$(stat -c %a \"$(dirname \"$0\")\")\" \"$(stat -c %a \"$0\")\"",
                    "timeout": 5
                }),
                &ctx,
            )
            .await
            .unwrap();
        let text = text_from_output(output);
        let script = text
            .lines()
            .find_map(|line| line.strip_prefix("script="))
            .expect("script path in REPL output");

        assert!(text.lines().any(|line| line == "dir=700"), "{text}");
        assert!(text.lines().any(|line| line == "file=600"), "{text}");
        assert!(
            !std::path::Path::new(script).exists(),
            "{script} was not removed"
        );
        assert!(
            !std::path::Path::new(script)
                .parent()
                .expect("script parent")
                .exists(),
            "REPL temp directory was not removed"
        );
    }

    #[test]
    fn repl_process_tree_guard_terminates_running_command() {
        #[cfg(unix)]
        let mut command = {
            let mut command = std::process::Command::new("sh");
            command.arg("-c").arg("sleep 30");
            std::os::unix::process::CommandExt::process_group(&mut command, 0);
            command
        };

        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", "ping 127.0.0.1 -n 31 >NUL"]);
            command
        };

        let mut child = command.spawn().expect("spawn long-running REPL fixture");
        let guard = ReplProcessTreeTerminator::new(child.id());
        let started = std::time::Instant::now();
        drop(guard);
        child.wait().expect("reap REPL fixture");

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "dropping the REPL process-tree guard should stop the command promptly"
        );
    }
}
