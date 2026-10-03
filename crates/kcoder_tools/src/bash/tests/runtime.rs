use super::*;

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
    let ctx =
        ToolContext::new(AppState::new(tmp.path())).with_background_job_manager(manager.clone());
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
    let ctx =
        ToolContext::new(AppState::new(tmp.path())).with_background_job_manager(manager.clone());

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
    let ctx =
        ToolContext::new(AppState::new(tmp.path())).with_background_job_manager(manager.clone());

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
    let ctx =
        ToolContext::new(AppState::new(tmp.path())).with_background_job_manager(manager.clone());

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
    let ctx =
        ToolContext::new(AppState::new(tmp.path())).with_background_job_manager(manager.clone());
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
