use crate::background::{
    ForegroundWaitOutcome, ManagedForegroundJob, wait_for_foreground_completion,
    wait_with_foreground_budget,
};
use crate::process::{
    LiveOutputCapture, OutputLimits, OutputStream, join_output_pipe, read_output_pipe,
};
use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

/// Run Alibaba OpenCodeReview against the current repository.
#[derive(Debug, Default)]
pub struct OcrReviewTool;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OcrCommand {
    Review,
    Scan,
}

fn default_command() -> OcrCommand {
    OcrCommand::Review
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OcrOutputFormat {
    Text,
    Json,
}

impl OcrOutputFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Json => "json",
        }
    }
}

fn default_output_format() -> OcrOutputFormat {
    OcrOutputFormat::Text
}

fn default_foreground_timeout_seconds() -> u64 {
    std::env::var("KCODER_OCR_FOREGROUND_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(60)
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OcrInput {
    /// Review changed files or scan full files. Defaults to "review".
    #[serde(default = "default_command")]
    pub command: OcrCommand,
    /// Only preview the files that would be reviewed/scanned without calling the OCR LLM.
    #[serde(default)]
    pub preview: bool,
    /// Agent output is terse and suitable for model consumption. Human output includes progress.
    #[serde(default)]
    pub human_output: bool,
    /// Output format returned by the OCR CLI. Defaults to text.
    #[serde(default = "default_output_format")]
    pub format: OcrOutputFormat,
    /// Optional context or review requirement passed through to OCR.
    #[serde(default)]
    pub background: Option<String>,
    /// Optional OCR model override.
    #[serde(default)]
    pub model: Option<String>,
    /// OCR per-file task timeout in minutes. Also bounds the wrapper wall timeout.
    #[serde(default)]
    pub timeout_minutes: Option<u64>,
    /// Seconds to keep OCR in the foreground before offloading it to a background task.
    #[serde(default = "default_foreground_timeout_seconds")]
    pub foreground_timeout_seconds: u64,
    /// Maximum OCR tool rounds per file.
    #[serde(default)]
    pub max_tools: Option<u32>,
    /// Maximum OCR concurrent file tasks.
    #[serde(default)]
    pub concurrency: Option<u32>,
    /// Review mode: source ref for diff range.
    #[serde(default)]
    pub from: Option<String>,
    /// Review mode: target ref for diff range.
    #[serde(default)]
    pub to: Option<String>,
    /// Review mode: single commit hash or tag.
    #[serde(default)]
    pub commit: Option<String>,
    /// Scan mode: comma-separated repo-relative files or directories.
    #[serde(default)]
    pub path: Option<String>,
    /// Scan mode: comma-separated gitignore-style exclude patterns.
    #[serde(default)]
    pub exclude: Option<String>,
    /// Scan mode: skip per-file planning pass.
    #[serde(default)]
    pub no_plan: bool,
    /// Scan mode: skip deduplication.
    #[serde(default)]
    pub no_dedup: bool,
    /// Scan mode: skip project summary.
    #[serde(default)]
    pub no_summary: bool,
    /// Scan mode: batch strategy, one of none, by-language, by-directory.
    #[serde(default)]
    pub batch: Option<String>,
    /// Scan mode: cap total OCR token usage.
    #[serde(default)]
    pub max_tokens_budget: Option<u64>,
}

#[async_trait]
impl Tool for OcrReviewTool {
    fn name(&self) -> String {
        "ocr".to_string()
    }

    fn description(&self) -> String {
        "Run the installed OpenCodeReview (`ocr`) CLI from the KCoder session's current working directory. \
         Use this for an external AI code review of the current git diff or selected files. \
         Start with preview=true on large workspaces to see the review scope; a full review may take many minutes \
         and may send repository diffs or file contents to the OCR-configured LLM provider. \
         If a review is still running after foregroundTimeoutSeconds (default 60), KCoder returns a background task id; \
         inspect or cancel it through the corresponding job controls when attached."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(OcrInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let input: OcrInput = parse_input(&input)?;
        let binary = which::which("ocr").map_err(|_| {
            ToolError::Execution(
                "OpenCodeReview CLI `ocr` was not found in PATH. Install it or add it to PATH."
                    .to_string(),
            )
        })?;
        run_ocr_with_binary(&binary, input, ctx).await
    }
}

async fn run_ocr_with_binary(
    binary: &Path,
    input: OcrInput,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    let timeout_minutes = input.timeout_minutes.unwrap_or(10).clamp(1, 120);
    let args = build_ocr_args(&input, timeout_minutes)?;
    let wall_timeout = Duration::from_secs(timeout_minutes.saturating_add(1) * 60);
    let foreground_timeout = Duration::from_secs(
        input
            .foreground_timeout_seconds
            .clamp(1, wall_timeout.as_secs().max(1)),
    );
    let cwd = ctx.state.cwd();
    let process_cwd = ocr_process_cwd(&cwd);
    let limits = OutputLimits::from_context(ctx);

    let mut cmd = Command::new(binary);
    cmd.args(&args)
        .current_dir(&process_cwd)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("KCODER_OCR_TOOL", "1");
    #[cfg(unix)]
    cmd.process_group(0);
    configure_git_repository_environment(&mut cmd, &cwd);

    let mut child = spawn_ocr_command(&mut cmd)
        .await
        .map_err(|error| ToolError::Execution(format!("failed to run OpenCodeReview: {error}")))?;
    let process_tree = child
        .id()
        .map(OcrProcessTreeTerminator::new)
        .ok_or_else(|| {
            ToolError::Execution("OpenCodeReview process did not expose a process id".to_string())
        })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        ToolError::Execution("failed to capture OpenCodeReview stdout".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ToolError::Execution("failed to capture OpenCodeReview stderr".to_string())
    })?;
    let live_output = LiveOutputCapture::new(limits.clone());
    let stdout_reader = tokio::spawn(read_output_pipe(
        stdout,
        limits.clone(),
        Some((live_output.clone(), OutputStream::Stdout)),
    ));
    let stderr_reader = tokio::spawn(read_output_pipe(
        stderr,
        limits.clone(),
        Some((live_output.clone(), OutputStream::Stderr)),
    ));
    let wait: OcrWait = Box::pin(async move {
        let status = child.wait().await.map_err(|error| {
            ToolError::Execution(format!("failed to wait for OpenCodeReview: {error}"))
        })?;
        process_tree.disarm();
        let stdout = join_output_pipe(Some(stdout_reader), "stdout").await?;
        let stderr = join_output_pipe(Some(stderr_reader), "stderr").await?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    });
    let command = format!("ocr {}", shell_like_join(&args));

    if ctx.background_job_manager.is_none() {
        return Ok(wait_for_ocr_result(wait, wall_timeout, args, cwd, limits).await);
    }

    let events = ctx.subscribe_background_jobs()?;
    let description = crate::background::tool_background_description(
        "ocr",
        &format!("{} in {}", command, cwd.display()),
    );
    let background_args = args.clone();
    let background_cwd = cwd.clone();
    let task_id = ctx.spawn_foreground(description, async move {
        wait_for_ocr_result(wait, wall_timeout, background_args, background_cwd, limits).await
    })?;
    if let Some(path) = ctx.state.task(&task_id).and_then(|task| task.output_path) {
        live_output.attach(path).await;
    }
    let guard = ManagedForegroundJob::new(ctx, task_id.clone())?;
    let outcome = if foreground_timeout >= wall_timeout {
        wait_for_foreground_completion(ctx, &task_id, events).await?
    } else {
        wait_with_foreground_budget(ctx, &task_id, events, foreground_timeout).await?
    };
    match outcome {
        ForegroundWaitOutcome::Completed(output) => {
            guard.complete();
            Ok(output)
        }
        ForegroundWaitOutcome::TimedOut => {
            guard.promote_to_background()?;
            Ok(ocr_background_started_output(
                &task_id,
                &command,
                &cwd,
                foreground_timeout,
                wall_timeout,
            ))
        }
    }
}

async fn spawn_ocr_command(cmd: &mut Command) -> std::io::Result<tokio::process::Child> {
    const TEXT_BUSY_RETRIES: usize = 8;
    for attempt in 0..=TEXT_BUSY_RETRIES {
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(error) if is_text_file_busy(&error) && attempt < TEXT_BUSY_RETRIES => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("bounded OCR spawn retry always returns")
}

fn is_text_file_busy(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::ETXTBSY)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

fn configure_git_repository_environment(cmd: &mut Command, cwd: &Path) {
    let work_tree = ocr_process_cwd(cwd);
    let git_dir = work_tree.join(".git");
    if git_dir.is_dir() {
        // Windows canonicalizes mapped drives to UNC paths. OpenCodeReview's
        // repository discovery does not recognize verbatim UNC paths, but the
        // underlying Git commands accept the simplified UNC repository paths.
        cmd.env("GIT_DIR", git_dir).env("GIT_WORK_TREE", work_tree);
    }
}

fn ocr_process_cwd(cwd: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::path::{Component, Prefix};

        let mut components = cwd.components();
        if let Some(Component::Prefix(prefix)) = components.next()
            && let Prefix::VerbatimUNC(server, share) = prefix.kind()
        {
            let mut unc_root = OsString::from(r"\\");
            unc_root.push(server);
            unc_root.push(r"\");
            unc_root.push(share);
            let mut simplified = PathBuf::from(unc_root);
            for component in components {
                if !matches!(component, Component::RootDir) {
                    simplified.push(component.as_os_str());
                }
            }
            return simplified;
        }
    }

    dunce::simplified(cwd).to_path_buf()
}

struct OcrProcessTreeTerminator {
    pid: u32,
    finished: AtomicBool,
}

impl OcrProcessTreeTerminator {
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

impl Drop for OcrProcessTreeTerminator {
    fn drop(&mut self) {
        self.terminate();
    }
}

type OcrWait =
    Pin<Box<dyn std::future::Future<Output = Result<Output, ToolError>> + Send + 'static>>;

async fn wait_for_ocr_result(
    wait: OcrWait,
    wall_timeout: Duration,
    args: Vec<String>,
    cwd: std::path::PathBuf,
    limits: OutputLimits,
) -> ToolOutput {
    match timeout(wall_timeout, wait).await {
        Ok(result) => format_ocr_result(result, &args, &cwd, limits),
        Err(_) => ToolOutput::error(format!(
            "OpenCodeReview timed out after {} seconds. \
             Try `preview: true`, narrow scan `path`, lower `concurrency`, or run again with a larger timeout.",
            wall_timeout.as_secs()
        )),
    }
}

fn format_ocr_result(
    result: Result<Output, ToolError>,
    args: &[String],
    cwd: &Path,
    limits: OutputLimits,
) -> ToolOutput {
    let output = match result {
        Ok(output) => output,
        Err(error) => {
            return ToolOutput::error(format!("failed to run OpenCodeReview: {error}"));
        }
    };

    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    let mut text = format!(
        "OpenCodeReview command: ocr {}\nWorking directory: {}\nExit status: {}\n",
        shell_like_join(args),
        cwd.display(),
        format_ocr_exit_status(&output.status)
    );
    if !stdout.trim().is_empty() {
        text.push_str("\nstdout:\n");
        text.push_str(stdout.trim_end());
        text.push('\n');
    }
    if !stderr.trim().is_empty() {
        text.push_str("\nstderr:\n");
        text.push_str(stderr.trim_end());
        text.push('\n');
    }
    if output.status.success() {
        ToolOutput::text(limits.truncate(text.trim_end()))
    } else {
        ToolOutput::error(limits.truncate(text.trim_end()))
    }
}

fn format_ocr_exit_status(status: &ExitStatus) -> String {
    status
        .code()
        .map(|code| format!("exit code: {code}"))
        .unwrap_or_else(|| status.to_string())
}

fn ocr_background_started_output(
    task_id: &str,
    command: &str,
    cwd: &Path,
    foreground_timeout: Duration,
    wall_timeout: Duration,
) -> ToolOutput {
    ToolOutput::text(
        serde_json::json!({
            "task_id": task_id,
            "task_type": "ocr",
            "tool": "ocr",
            "status": "running",
            "command": command,
            "working_directory": cwd.display().to_string(),
            "foreground_timeout_seconds": foreground_timeout.as_secs(),
            "command_timeout_ms": wall_timeout.as_millis().min(u128::from(u64::MAX)) as u64,
            "next_action": format!(
                "OpenCodeReview is still running after {}s, so KCoder moved it to the background as `{task_id}`. Continue useful work. Use attached managed-job controls or the host for inspection/cancellation; otherwise rely on completion notifications.",
                foreground_timeout.as_secs()
            ),
        })
        .to_string(),
    )
}

fn build_ocr_args(input: &OcrInput, timeout_minutes: u64) -> Result<Vec<String>, ToolError> {
    validate_review_scan_exclusive(input)?;
    let mut args = Vec::new();
    match input.command {
        OcrCommand::Review => {
            args.push("review".to_string());
            if let Some(commit) = non_empty(&input.commit) {
                push_flag_value(&mut args, "--commit", commit);
            }
            if let Some(from) = non_empty(&input.from) {
                push_flag_value(&mut args, "--from", from);
            }
            if let Some(to) = non_empty(&input.to) {
                push_flag_value(&mut args, "--to", to);
            }
        }
        OcrCommand::Scan => {
            args.push("scan".to_string());
            if let Some(path) = non_empty(&input.path) {
                push_flag_value(&mut args, "--path", path);
            }
            if let Some(exclude) = non_empty(&input.exclude) {
                push_flag_value(&mut args, "--exclude", exclude);
            }
            if input.no_plan {
                args.push("--no-plan".to_string());
            }
            if input.no_dedup {
                args.push("--no-dedup".to_string());
            }
            if input.no_summary {
                args.push("--no-summary".to_string());
            }
            if let Some(batch) = non_empty(&input.batch) {
                validate_batch(batch)?;
                push_flag_value(&mut args, "--batch", batch);
            }
            if let Some(max_tokens_budget) = input.max_tokens_budget {
                push_flag_value(
                    &mut args,
                    "--max-tokens-budget",
                    &max_tokens_budget.to_string(),
                );
            }
        }
    }

    if input.preview {
        args.push("--preview".to_string());
    }
    push_flag_value(
        &mut args,
        "--audience",
        if input.human_output { "human" } else { "agent" },
    );
    push_flag_value(&mut args, "--format", input.format.as_str());
    push_flag_value(&mut args, "--timeout", &timeout_minutes.to_string());
    if let Some(background) = non_empty(&input.background) {
        push_flag_value(&mut args, "--background", background);
    }
    if let Some(model) = non_empty(&input.model) {
        push_flag_value(&mut args, "--model", model);
    }
    if let Some(max_tools) = input.max_tools {
        push_flag_value(&mut args, "--max-tools", &max_tools.to_string());
    }
    if let Some(concurrency) = input.concurrency {
        push_flag_value(&mut args, "--concurrency", &concurrency.to_string());
    }
    Ok(args)
}

fn validate_review_scan_exclusive(input: &OcrInput) -> Result<(), ToolError> {
    if input.command == OcrCommand::Review
        && (input.path.is_some()
            || input.exclude.is_some()
            || input.no_plan
            || input.no_dedup
            || input.no_summary
            || input.batch.is_some()
            || input.max_tokens_budget.is_some())
    {
        return Err(ToolError::InvalidInput(
            "scan-only fields require command=\"scan\"".to_string(),
        ));
    }
    if input.command == OcrCommand::Scan
        && (input.from.is_some() || input.to.is_some() || input.commit.is_some())
    {
        return Err(ToolError::InvalidInput(
            "review diff fields require command=\"review\"".to_string(),
        ));
    }
    Ok(())
}

fn validate_batch(batch: &str) -> Result<(), ToolError> {
    match batch {
        "none" | "by-language" | "by-directory" => Ok(()),
        _ => Err(ToolError::InvalidInput(
            "batch must be one of: none, by-language, by-directory".to_string(),
        )),
    }
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn push_flag_value(args: &mut Vec<String>, flag: &str, value: &str) {
    args.push(flag.to_string());
    args.push(value.to_string());
}

fn shell_like_join(args: &[String]) -> String {
    args.iter()
        .map(|arg| {
            if arg
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "-_./:=,".contains(ch))
            {
                arg.clone()
            } else {
                format!("'{}'", arg.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        output.push(ch);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background::BackgroundJobEvent;
    use crate::{BackgroundJobSpawner, SpawnError};
    use crate::{Tool, ToolContext};
    use kcoder_state::AppState;
    use kcoder_types::ContentBlock;
    use std::fs;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    struct FakeBackgroundJobManager {
        spawned: Mutex<Vec<String>>,
        completed: Arc<Mutex<Vec<String>>>,
        events: tokio::sync::broadcast::Sender<BackgroundJobEvent>,
    }

    impl Default for FakeBackgroundJobManager {
        fn default() -> Self {
            let (events, _) = tokio::sync::broadcast::channel(16);
            Self {
                spawned: Mutex::new(Vec::new()),
                completed: Arc::new(Mutex::new(Vec::new())),
                events,
            }
        }
    }

    impl BackgroundJobSpawner for FakeBackgroundJobManager {
        fn spawn(
            &self,
            description: String,
            work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            self.spawned.lock().unwrap().push(description);
            let completed = Arc::clone(&self.completed);
            let event_tx = self.events.clone();
            let _ = self.events.send(BackgroundJobEvent::Started {
                id: "job-ocr".to_string(),
                description: "test OCR".to_string(),
                continuation: false,
            });
            tokio::spawn(async move {
                let output = work.await;
                let text = output
                    .clone()
                    .content
                    .into_iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text),
                        _ => None,
                    })
                    .collect::<String>();
                completed.lock().unwrap().push(text);
                let _ = event_tx.send(BackgroundJobEvent::Completed {
                    id: "job-ocr".to_string(),
                    output,
                });
            });
            Ok("job-ocr".to_string())
        }

        fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BackgroundJobEvent> {
            self.events.subscribe()
        }

        fn abort(&self, _id: &str) -> bool {
            false
        }

        fn promote_to_background(&self, _id: &str) -> Result<(), SpawnError> {
            Ok(())
        }
    }

    #[test]
    fn review_preview_args_are_bounded_and_agent_friendly() {
        let input = OcrInput {
            command: OcrCommand::Review,
            preview: true,
            human_output: false,
            format: OcrOutputFormat::Json,
            background: Some("focus on regressions".to_string()),
            model: None,
            timeout_minutes: None,
            foreground_timeout_seconds: 60,
            max_tools: Some(12),
            concurrency: Some(2),
            from: Some("main".to_string()),
            to: Some("feature".to_string()),
            commit: None,
            path: None,
            exclude: None,
            no_plan: false,
            no_dedup: false,
            no_summary: false,
            batch: None,
            max_tokens_budget: None,
        };

        assert_eq!(
            build_ocr_args(&input, 7).unwrap(),
            vec![
                "review",
                "--from",
                "main",
                "--to",
                "feature",
                "--preview",
                "--audience",
                "agent",
                "--format",
                "json",
                "--timeout",
                "7",
                "--background",
                "focus on regressions",
                "--max-tools",
                "12",
                "--concurrency",
                "2",
            ]
        );
    }

    #[test]
    fn rejects_scan_fields_for_review() {
        let input = OcrInput {
            command: OcrCommand::Review,
            preview: false,
            human_output: false,
            format: OcrOutputFormat::Text,
            background: None,
            model: None,
            timeout_minutes: None,
            foreground_timeout_seconds: 60,
            max_tools: None,
            concurrency: None,
            from: None,
            to: None,
            commit: None,
            path: Some("src".to_string()),
            exclude: None,
            no_plan: false,
            no_dedup: false,
            no_summary: false,
            batch: None,
            max_tokens_budget: None,
        };

        assert!(build_ocr_args(&input, 10).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn ocr_process_cwd_simplifies_verbatim_unc_paths() {
        assert_eq!(
            ocr_process_cwd(Path::new(r"\\?\UNC\server\share\repo")),
            PathBuf::from(r"\\server\share\repo")
        );
    }

    #[tokio::test]
    async fn fake_ocr_binary_is_invoked_from_session_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp
            .path()
            .join(if cfg!(windows) { "ocr.cmd" } else { "ocr" });
        fs::create_dir(tmp.path().join(".git")).unwrap();
        let script = if cfg!(windows) {
            "@echo off\r\necho fake-ocr cwd=%CD% git-dir=%GIT_DIR% work-tree=%GIT_WORK_TREE% args=%*\r\n"
        } else {
            "#!/bin/sh\nprintf 'fake-ocr cwd=%s git-dir=%s work-tree=%s args=%s\\n' \"$PWD\" \"$GIT_DIR\" \"$GIT_WORK_TREE\" \"$*\"\n"
        };
        fs::write(&fake, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let input = OcrInput {
            command: OcrCommand::Scan,
            preview: true,
            human_output: false,
            format: OcrOutputFormat::Text,
            background: None,
            model: None,
            timeout_minutes: Some(1),
            foreground_timeout_seconds: 60,
            max_tools: None,
            concurrency: None,
            from: None,
            to: None,
            commit: None,
            path: Some("crates/kcoder_tools/src/ocr.rs".to_string()),
            exclude: None,
            no_plan: true,
            no_dedup: false,
            no_summary: true,
            batch: Some("none".to_string()),
            max_tokens_budget: Some(123),
        };

        let output = run_ocr_with_binary(&fake, input, &ctx).await.unwrap();
        let ContentBlock::Text { text } = &output.content[0] else {
            panic!("expected text output");
        };
        assert!(text.contains("fake-ocr cwd="));
        assert!(text.contains(&format!("git-dir={}", tmp.path().join(".git").display())));
        assert!(text.contains(&format!("work-tree={}", tmp.path().display())));
        assert!(text.contains("--path crates/kcoder_tools/src/ocr.rs"));
        assert!(text.contains("--no-plan"));
        assert!(text.contains("--no-summary"));
        assert!(text.contains("--max-tokens-budget 123"));
    }

    #[tokio::test]
    async fn slow_ocr_auto_moves_to_background_after_foreground_timeout() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp
            .path()
            .join(if cfg!(windows) { "ocr.cmd" } else { "ocr" });
        let script = if cfg!(windows) {
            "@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2; Write-Output 'slow review done'\"\r\n"
        } else {
            "#!/bin/sh\nsleep 2\nprintf 'slow review done\\n'\n"
        };
        fs::write(&fake, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_background_job_manager(manager.clone());
        let input = OcrInput {
            command: OcrCommand::Review,
            preview: false,
            human_output: false,
            format: OcrOutputFormat::Text,
            background: None,
            model: None,
            timeout_minutes: Some(1),
            foreground_timeout_seconds: 1,
            max_tools: None,
            concurrency: None,
            from: None,
            to: None,
            commit: None,
            path: None,
            exclude: None,
            no_plan: false,
            no_dedup: false,
            no_summary: false,
            batch: None,
            max_tokens_budget: None,
        };

        let started = Instant::now();
        let output = run_ocr_with_binary(&fake, input, &ctx).await.unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "ocr should be offloaded before the fake command finishes"
        );
        let ContentBlock::Text { text } = &output.content[0] else {
            panic!("expected text output");
        };
        let value: Value = serde_json::from_str(text).unwrap();
        assert_eq!(value["task_id"], "job-ocr");
        assert_eq!(value["tool"], "ocr");
        assert_eq!(value["status"], "running");
        assert_eq!(value["foreground_timeout_seconds"], 1);
        assert!(
            value["next_action"]
                .as_str()
                .unwrap()
                .contains("moved it to the background")
        );
        assert!(
            manager.spawned.lock().unwrap()[0]
                .starts_with(crate::background::TOOL_BACKGROUND_TASK_PREFIX)
        );

        let completed = tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if let Some(text) = manager.completed.lock().unwrap().first().cloned() {
                    break text;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("background OCR process should finish");
        assert!(completed.contains("slow review done"));
    }

    #[tokio::test]
    async fn tool_reports_missing_ocr_binary() {
        if which::which("ocr").is_ok() {
            return;
        }
        let ctx = ToolContext::new(AppState::new("."));
        let result = OcrReviewTool
            .call(serde_json::json!({"command":"review","preview":true}), &ctx)
            .await;
        if which::which("ocr").is_err() {
            assert!(matches!(result, Err(ToolError::Execution(_))));
        }
    }

    #[test]
    fn ocr_process_tree_guard_terminates_running_command() {
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

        let mut child = command.spawn().expect("spawn long-running OCR fixture");
        let guard = OcrProcessTreeTerminator::new(child.id());
        let started = Instant::now();
        drop(guard);
        child.wait().expect("reap OCR fixture");

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "dropping the OCR process-tree guard should stop the command promptly"
        );
    }

    #[test]
    fn ocr_exit_status_is_platform_neutral() {
        #[cfg(unix)]
        let status = std::process::Command::new("sh")
            .args(["-c", "exit 7"])
            .status()
            .expect("run Unix exit fixture");

        #[cfg(windows)]
        let status = std::process::Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "exit 7"])
            .status()
            .expect("run Windows exit fixture");

        assert_eq!(format_ocr_exit_status(&status), "exit code: 7");
    }
}
