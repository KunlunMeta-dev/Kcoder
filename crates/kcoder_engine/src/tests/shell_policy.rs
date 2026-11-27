#[test]
fn shell_snapshot_diff_reports_created_modified_and_deleted_paths() {
    let mut before = HashMap::new();
    before.insert(
        "modified.txt".to_string(),
        FileSnapshotEntry {
            len: 1,
            modified_ns: 10,
        },
    );
    before.insert(
        "deleted.txt".to_string(),
        FileSnapshotEntry {
            len: 2,
            modified_ns: 20,
        },
    );

    let mut after = HashMap::new();
    after.insert(
        "modified.txt".to_string(),
        FileSnapshotEntry {
            len: 3,
            modified_ns: 30,
        },
    );
    after.insert(
        "created.txt".to_string(),
        FileSnapshotEntry {
            len: 4,
            modified_ns: 40,
        },
    );

    let (paths, truncated) = changed_snapshot_paths(&before, &after);
    assert_eq!(
        paths,
        vec![
            "created.txt".to_string(),
            "deleted.txt".to_string(),
            "modified.txt".to_string()
        ]
    );
    assert!(!truncated);
}

#[test]
fn shell_file_change_tracking_skips_background_but_tracks_git_helpers() {
    assert!(should_track_shell_file_changes(
        "bash",
        &serde_json::json!({"command": "touch a"})
    ));
    assert!(!should_track_shell_file_changes(
        "bash",
        &serde_json::json!({"command": "touch a", "run_in_background": true})
    ));
    assert!(!should_track_shell_file_changes(
        "read",
        &serde_json::json!({"file_path": "a"})
    ));
    assert!(should_track_shell_file_changes(
        "bash",
        &serde_json::json!({"command": "git status"})
    ));
}

#[test]
fn shell_file_change_tracking_skips_proven_read_only_commands() {
    for (tool, command) in [
        ("bash", "pwd"),
        ("PowerShell", "Get-Content -LiteralPath notes.txt"),
        ("PowerShell", "Get-ChildItem . | Select-Object Name,Length"),
        ("PowerShell", "Test-Path -LiteralPath notes.txt"),
        ("PowerShell", "get-location; get-date"),
    ] {
        assert!(
            !should_track_shell_file_changes(tool, &serde_json::json!({"command": command})),
            "read-only inspection must not scan the workspace: {tool}: {command}"
        );
    }
}

#[test]
fn shell_file_change_tracking_keeps_powershell_mutations_and_unknown_commands() {
    for command in [
        "Set-Content notes.txt changed",
        "Get-Content source.txt | Set-Content notes.txt",
        "Get-ChildItem .; Remove-Item notes.txt",
        "Get-Content source.txt > notes.txt",
        "Write-Output (Remove-Item notes.txt)",
        "Write-Output (& { Remove-Item notes.txt })",
        "Get-EvilThing -Run payload",
        "python script.py",
        "git status",
    ] {
        assert!(
            should_track_shell_file_changes("PowerShell", &serde_json::json!({"command": command})),
            "mutation or unknown behavior must retain file tracking: {command}"
        );
    }
    assert!(should_track_shell_file_changes("PowerShell", &serde_json::json!({})));
    assert!(!should_track_shell_file_changes(
        "PowerShell",
        &serde_json::json!({"command": "Set-Content notes.txt changed", "run_in_background": true})
    ));
}

#[tokio::test]
#[ignore = "Creates an owned 6000-file workspace to measure metadata-scan overhead"]
async fn powershell_read_only_snapshot_overhead_measurement() {
    let workspace = tempfile::tempdir().unwrap();
    for index in 0..6000 {
        fs::write(workspace.path().join(format!("file-{index}.txt")), "fixture").unwrap();
    }
    let started = std::time::Instant::now();
    for _ in 0..2 {
        let snapshot = snapshot_files_async(workspace.path().to_path_buf()).await.unwrap();
        assert_eq!(snapshot.len(), 6000);
    }
    let old_scan_time = started.elapsed();
    let started = std::time::Instant::now();
    let input = serde_json::json!({"command": "Get-Content -LiteralPath file-0.txt"});
    let mut scan_count = 0;
    if should_track_shell_file_changes("PowerShell", &input) {
        for _ in 0..2 {
            snapshot_files_async(workspace.path().to_path_buf()).await.unwrap();
            scan_count += 1;
        }
    }
    let optimized_time = started.elapsed();
    assert_eq!(scan_count, 0);
    eprintln!(
        "snapshot-path measurement only; host={}; files=6000; old_scans=2; old_ms={:.3}; optimized_scans=0; optimized_ms={:.3}; not a PowerShell process benchmark",
        std::env::consts::OS,
        old_scan_time.as_secs_f64() * 1000.0,
        optimized_time.as_secs_f64() * 1000.0,
    );
}

#[test]
fn shell_tool_timeout_defaults_to_settings_and_is_injected() {
    let settings = Settings::default();
    for name in ["bash", "PowerShell"] {
        let mut input = serde_json::json!({"command": "cargo test"});

        let timeout = effective_tool_timeout_ms(
            name,
            &mut input,
            settings.tool_limits.execution_timeout_ms[name],
        );

        assert_eq!(timeout, 1_800_000);
        assert_eq!(input["timeout"], serde_json::json!(1_800_000));
    }
}

#[test]
fn blocking_agent_and_goal_verifier_tools_are_not_wrapped_in_generic_tool_timeout() {
    let settings = Settings::default();
    for name in ["spawn_agent", "explore_agent", "PlanAgent", "update_goal"] {
        let mut input = serde_json::json!({"message": "delegated task"});
        assert_eq!(
            effective_tool_timeout_ms(name, &mut input, settings.tool_timeout_ms),
            0
        );
    }
}

#[test]
fn shell_tool_timeout_honors_explicit_timeout_without_global_cap() {
    let settings = Settings {
        tool_timeout_ms: 120_000,
        ..Settings::default()
    };
    let mut input = serde_json::json!({"command": "cargo test", "timeout": 900000});

    let timeout = effective_tool_timeout_ms("bash", &mut input, settings.tool_timeout_ms);

    assert_eq!(timeout, 900_000);
    assert_eq!(input["timeout"], serde_json::json!(900_000));
}

#[test]
fn shell_tool_timeout_default_settings_do_not_cap_explicit_timeout() {
    let settings = Settings::default();
    let mut input = serde_json::json!({"command": "cargo test", "timeout": 120000});

    let timeout = effective_tool_timeout_ms("bash", &mut input, settings.tool_timeout_ms);

    assert_eq!(timeout, 120_000);
    assert_eq!(input["timeout"], serde_json::json!(120_000));
}
