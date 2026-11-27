//! Collect bounded output and preserve exit, SIGPIPE, masked-failure, and lifecycle diagnostics.

use super::*;

pub(super) async fn finish_shell_command(
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

pub(super) fn command_timeout_error(timeout_ms: u64) -> ToolError {
    ToolError::Execution(format!("command timed out after {timeout_ms} ms"))
}

pub(super) fn format_shell_output(
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
pub(super) fn exit_status_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
pub(super) fn exit_status_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

pub(super) fn shell_lifecycle_warning(command: &str, cleaned_descendants: usize) -> Option<String> {
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

pub(super) fn format_bash_result(
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

pub(super) fn is_head_limited_sigpipe(command: &str, status: &ExitStatus, body: &str) -> bool {
    matches!(status.code(), Some(141))
        && !body.trim().is_empty()
        && command_has_head_pipeline(command)
        && !verification_like_command(command)
}

pub(super) fn command_has_head_pipeline(command: &str) -> bool {
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

pub(super) fn masked_failure_evidence(
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
