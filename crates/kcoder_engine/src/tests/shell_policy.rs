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
fn shell_tool_timeout_defaults_to_settings_and_is_injected() {
    let settings = Settings {
        tool_timeout_ms: 600_000,
        ..Settings::default()
    };
    let mut input = serde_json::json!({"command": "cargo test"});

    let timeout = effective_tool_timeout_ms("bash", &mut input, settings.tool_timeout_ms);

    assert_eq!(timeout, 600_000);
    assert_eq!(input["timeout"], serde_json::json!(600_000));
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
