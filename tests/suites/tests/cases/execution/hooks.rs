use kcoder_hooks::{
    HookCommand, HookEffect, HookEvent, HookInput, HookMatcher, HookOutcome, HookRegistry,
    execute_hooks, matches_pattern,
};
use serde_json::json;
use std::time::{Duration, Instant};

#[test]
fn hook_matcher_handles_exact_alternation_and_regex() {
    assert!(matches_pattern("Bash", "Bash|Read"));
    assert!(matches_pattern("tool:write", "^tool:(read|write)$"));
    assert!(!matches_pattern("Edit", "Bash|Read"));
}

fn registry(commands: Vec<HookCommand>) -> HookRegistry {
    HookRegistry::from_matchers(vec![(
        HookEvent::PreToolUse,
        HookMatcher {
            matcher: Some("bash".to_string()),
            hooks: commands,
            source: None,
        },
    )])
}

#[cfg(unix)]
fn successful_command() -> (&'static str, &'static str) {
    (
        "bash",
        "cat > hook-input.json; printf marker > hook-marker.txt; printf '%s' '{\"systemMessage\":\"hook-ok\"}'",
    )
}

#[cfg(windows)]
fn successful_command() -> (&'static str, &'static str) {
    (
        "powershell.exe",
        "$HookInput = [Console]::In.ReadToEnd(); [IO.File]::WriteAllText('hook-input.json', $HookInput, [Text.UTF8Encoding]::new($false)); Set-Content -NoNewline hook-marker.txt marker; @{ systemMessage = 'hook-ok' } | ConvertTo-Json -Compress",
    )
}

#[cfg(unix)]
fn timeout_command() -> (&'static str, &'static str) {
    ("bash", "sleep 5")
}

#[cfg(windows)]
fn timeout_command() -> (&'static str, &'static str) {
    ("powershell.exe", "Start-Sleep -Seconds 5")
}

#[cfg(unix)]
fn credential_error_command() -> (&'static str, &'static str) {
    (
        "bash",
        "printf 'OPENAI_API_KEY=sk-suite-secret\\n' >&2; exit 7",
    )
}

#[cfg(windows)]
fn credential_error_command() -> (&'static str, &'static str) {
    (
        "powershell.exe",
        "[Console]::Error.WriteLine('OPENAI_API_KEY=sk-suite-secret'); exit 7",
    )
}

fn command(shell: &str, command: &str, timeout: u64) -> HookCommand {
    HookCommand::Command {
        shell: shell.to_string(),
        command: command.to_string(),
        if_rule: None,
        timeout,
        async_hook: false,
    }
}

#[tokio::test]
async fn command_hook_uses_input_cwd_creates_marker_and_returns_structured_output() {
    let temporary = tempfile::tempdir().unwrap();
    let (shell, script) = successful_command();
    let registry = registry(vec![command(shell, script, 5)]);
    let input = HookInput::new(
        HookEvent::PreToolUse,
        "bash",
        json!({"command": "cargo test"}),
    )
    .with_extra("cwd", json!(temporary.path()));

    let results = tokio::time::timeout(Duration::from_secs(10), execute_hooks(&registry, input))
        .await
        .expect("成功 hook 必须在 10 秒内结束");

    assert_eq!(results.len(), 1);
    assert!(matches!(
        &results[0].outcome,
        HookOutcome::Effects(effects)
            if matches!(effects.as_slice(), [HookEffect::Message { text, is_error: false }] if text == "hook-ok")
    ));
    assert_eq!(
        std::fs::read_to_string(temporary.path().join("hook-marker.txt")).unwrap(),
        "marker"
    );
    let captured: serde_json::Value =
        serde_json::from_slice(&std::fs::read(temporary.path().join("hook-input.json")).unwrap())
            .unwrap();
    assert_eq!(captured["event"], "pre_tool_use");
    assert_eq!(captured["hook_event_name"], "PreToolUse");
    assert_eq!(captured["query"], "bash");
    assert_eq!(captured["data"]["command"], "cargo test");
}

#[tokio::test]
async fn command_hooks_enforce_one_second_timeout_and_redact_stderr_credentials() {
    let temporary = tempfile::tempdir().unwrap();
    let (timeout_shell, timeout_script) = timeout_command();
    let (error_shell, error_script) = credential_error_command();
    let registry = registry(vec![
        command(timeout_shell, timeout_script, 1),
        command(error_shell, error_script, 5),
    ]);
    let input = HookInput::new(HookEvent::PreToolUse, "bash", json!({"command": "test"}))
        .with_extra("cwd", json!(temporary.path()));

    let started = Instant::now();
    let results = tokio::time::timeout(Duration::from_secs(10), execute_hooks(&registry, input))
        .await
        .expect("超时 hook 必须在外层 10 秒期限内结束");
    assert!(started.elapsed() < Duration::from_secs(5));

    assert_eq!(results.len(), 2);
    assert!(matches!(
        &results[0].outcome,
        HookOutcome::Error(message) if message.contains("timed out after 1 seconds")
    ));
    match &results[1].outcome {
        HookOutcome::Error(message) => {
            assert!(message.contains("[redacted]"));
            assert!(!message.contains("sk-suite-secret"));
            assert!(!message.contains("OPENAI_API_KEY=sk-suite-secret"));
        }
        other => panic!("应返回脱敏后的 command error，实际为 {other:?}"),
    }
}
