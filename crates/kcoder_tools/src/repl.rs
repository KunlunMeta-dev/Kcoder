use crate::process::configure_isolated_process_environment;
use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
#[cfg(windows)]
use tokio::io::AsyncReadExt;
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
    /// The code to execute in the REPL.
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
            "Execute code in a sandboxed REPL environment with access to primitive tools. \
             Use for batch operations, complex multi-step file transformations, and programmatic control flow. \
             The script runs in the KCoder session's current working directory, not the process startup directory. \
             Shell snippets use {shell} on this platform."
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
            std::fs::set_permissions(temp_dir.path(), std::fs::Permissions::from_mode(0o700))
                .map_err(|e| {
                    ToolError::Execution(format!(
                        "failed to restrict repl temp dir permissions: {e}"
                    ))
                })?;
        }

        let file_name = format!("{}.{}.{}", self.name(), ulid::generate(), extension);
        let script_path = temp_dir.path().join(file_name);
        let script = prepare_repl_script(&language, &input.code);
        tokio::fs::write(&script_path, encode_repl_script(&language, &script))
            .await
            .map_err(|e| ToolError::Execution(format!("failed to write repl script: {}", e)))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| {
                    ToolError::Execution(format!("failed to restrict repl script permissions: {e}"))
                })?;
        }

        debug!(
            "running REPL script {:?} with {} (language={})",
            script_path, program, language
        );

        let cwd = ctx.state.cwd();
        let mut cmd = Command::new(&program);
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
            let mut stdout = child.stdout.take().ok_or_else(|| {
                ToolError::Execution("failed to capture sandboxed REPL stdout".to_string())
            })?;
            let mut stderr = child.stderr.take().ok_or_else(|| {
                ToolError::Execution("failed to capture sandboxed REPL stderr".to_string())
            })?;
            let stdout_reader = tokio::spawn(async move {
                let mut bytes = Vec::new();
                stdout.read_to_end(&mut bytes).await.map(|_| bytes)
            });
            let stderr_reader = tokio::spawn(async move {
                let mut bytes = Vec::new();
                stderr.read_to_end(&mut bytes).await.map(|_| bytes)
            });
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
            let stdout = stdout_reader
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("REPL stdout reader failed: {error}"))
                })?
                .map_err(|error| {
                    ToolError::Execution(format!("failed to read REPL stdout: {error}"))
                })?;
            let stderr = stderr_reader
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("REPL stderr reader failed: {error}"))
                })?
                .map_err(|error| {
                    ToolError::Execution(format!("failed to read REPL stderr: {error}"))
                })?;
            return finish_repl_output(ctx, status, stdout, stderr);
        }

        let child = cmd
            .spawn()
            .map_err(|e| ToolError::Execution(format!("failed to run REPL: {}", e)))?;
        let process_tree = child
            .id()
            .map(ReplProcessTreeTerminator::new)
            .ok_or_else(|| {
                ToolError::Execution("REPL process did not expose a process id".to_string())
            })?;
        let output_result =
            timeout(Duration::from_secs(input.timeout), child.wait_with_output()).await;

        let output = match output_result {
            Ok(Ok(out)) => {
                process_tree.disarm();
                out
            }
            Ok(Err(e)) => {
                return Err(ToolError::Execution(format!("failed to run REPL: {}", e)));
            }
            Err(_) => {
                process_tree.terminate();
                return Err(ToolError::Execution(format!(
                    "REPL execution timed out after {} seconds",
                    input.timeout
                )));
            }
        };

        finish_repl_output(ctx, output.status, output.stdout, output.stderr)
    }
}

fn finish_repl_output(
    ctx: &ToolContext,
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
) -> Result<ToolOutput, ToolError> {
    let stdout = String::from_utf8_lossy(&stdout).to_string();
    let stderr = String::from_utf8_lossy(&stderr).to_string();

    if !status.success() {
        let mut message = format!(
            "REPL exited with status {}\n",
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
        return Ok(ToolOutput::error(ctx.truncate(message.trim_end())));
    }

    let result = if stderr.is_empty() {
        stdout
    } else {
        format!("{}\nstderr:\n{}", stdout, stderr)
    };

    Ok(ToolOutput::text(ctx.truncate(&result)))
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
}

impl ReplProcessTreeTerminator {
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
        #[cfg(unix)]
        unsafe {
            let pid = self.pid as libc::pid_t;
            if libc::kill(-pid, libc::SIGKILL) != 0 {
                let _ = libc::kill(pid, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    fn disarm(&self) {
        self.finished.store(true, Ordering::SeqCst);
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
        let ctx = ToolContext::new(AppState::new(&workspace)).with_sandbox(sandbox);
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
