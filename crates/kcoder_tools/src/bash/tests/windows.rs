use super::*;

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
    let probe = crate::windows_process_test_support::DescendantProbe::new(&workspace);
    // Use the actual Windows Bash path and explicitly avoid PowerShell profiles.
    let command = format!(
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
        crate::windows_process_test_support::encoded_command(&probe.command(false)),
    );
    let limits = OutputLimits::from_context(&ToolContext::new(AppState::new(&workspace)));
    let running = RunningShell::spawn(
        default_bash_shell(),
        &command,
        workspace.clone(),
        8_000,
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

    let child = match probe.wait_started().await {
        Ok(child) => child,
        Err(error) => {
            (running.cancel_callback())();
            let diagnostic = running.wait_for_output(&command, limits).await;
            panic!("descendant must execute before timeout: {error}; owned parent: {diagnostic:?}");
        }
    };
    let started = std::time::Instant::now();
    let outcome = running.wait_for_output(&command, limits).await;
    assert!(
        matches!(&outcome, Err(ToolError::Execution(error)) if error.contains("timed out")),
        "command should time out: {outcome:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "Job Object termination should not hang while inherited pipes remain open"
    );
    child.assert_terminated();
    probe.assert_no_survival_marker();
}
