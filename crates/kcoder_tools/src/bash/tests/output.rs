use super::*;

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
        let command =
            format!("printf '%s\\n' 'Access Denied.' 'Invalid password format.'{stream}; exit 23");
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
