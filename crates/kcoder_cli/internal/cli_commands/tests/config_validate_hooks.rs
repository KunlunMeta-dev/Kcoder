use clap::Parser;
use kcoder_cli_commands::cli_args::{Cli, ConfigAction};
use kcoder_cli_commands::entry_modes::run_config;
use kcoder_config::{CONFIG_DIR_ENV, SettingsLoader};

// One test per binary: it mutates the process-wide config directory variable.
#[tokio::test]
async fn config_validate_reports_malformed_hook_rules_and_accepts_warnings() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let ambient_config = temp.path().join("ambient-config");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&ambient_config).unwrap();
    std::fs::write(ambient_config.join("settings.json"), "{}").unwrap();
    std::fs::create_dir_all(workspace.join(".kcoder")).unwrap();
    unsafe { std::env::set_var(CONFIG_DIR_ENV, &ambient_config) };
    let cli = Cli::try_parse_from(["kcoder"]).unwrap();
    let loader = SettingsLoader::new(&workspace).with_config_dir(&config);

    // A valid sibling plus a malformed action whose value must not be echoed.
    std::fs::write(
        config.join("settings.json"),
        r#"{"hooks": {"PreToolUse": [
            {"matcher": "bash", "hooks": [{"type": "command", "command": "/usr/bin/true"}]},
            {"matcher": "write", "hooks": [{"type": "command", "command": "curl -H TOKEN=needle", "timeout": "soon"}]}
        ]}}"#,
    )
    .unwrap();
    let error = run_config(ConfigAction::Validate, &loader, &cli, &workspace)
        .await
        .expect_err("a malformed hook rule must fail validation");
    let message = format!("{error:#}");
    assert!(
        message.contains("invalid hook settings (1 error(s))"),
        "{message}"
    );
    assert!(
        message.contains("hooks.PreToolUse[1].hooks[0]"),
        "{message}"
    );
    assert!(message.contains("settings.json"), "{message}");
    assert!(!message.contains("needle"), "{message}");
    assert!(!message.contains("soon"), "{message}");

    // Untrusted project files are parsed too, and unknown events are errors.
    std::fs::write(config.join("settings.json"), "{}").unwrap();
    std::fs::write(
        workspace.join(".kcoder").join("settings.local.json"),
        r#"{"hooks": {"PreToolUze": [{"hooks": []}]}}"#,
    )
    .unwrap();
    let message = format!(
        "{:#}",
        run_config(ConfigAction::Validate, &loader, &cli, &workspace)
            .await
            .expect_err("an unknown hook event must fail validation")
    );
    assert!(message.contains("hooks.PreToolUze"), "{message}");
    assert!(message.contains("unknown hook event"), "{message}");

    // The unsupported agent `max_turns` field is only a warning.
    // An invalid ambient profile must not replace the host-selected source.
    std::fs::write(
        ambient_config.join("settings.json"),
        r#"{"hooks": {"AmbientOnlyUnknownEvent": []}}"#,
    )
    .unwrap();
    std::fs::write(
        workspace.join(".kcoder").join("settings.local.json"),
        r#"{"hooks": {"Stop": [{"hooks": [{"type": "agent", "instructions": "check", "model": "fixture", "max_turns": 4}]}]}}"#,
    )
    .unwrap();
    run_config(ConfigAction::Validate, &loader, &cli, &workspace)
        .await
        .expect("warnings must not fail validation");

    unsafe { std::env::remove_var(CONFIG_DIR_ENV) };
}
