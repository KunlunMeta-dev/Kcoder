use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Output},
};

fn invoke(root: &Path, args: &[&str]) -> Output {
    let bin = root.join("owned-bin");
    std::fs::create_dir_all(&bin).unwrap();
    let binary = bin.join(if cfg!(windows) {
        "kcoder.exe"
    } else {
        "kcoder"
    });
    if !binary.exists() && std::fs::hard_link(env!("CARGO_BIN_EXE_kcoder"), &binary).is_err() {
        std::fs::copy(env!("CARGO_BIN_EXE_kcoder"), &binary).unwrap();
    }
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("KCODER_CONFIG_DIR", root.join("unused-profile"));
    #[cfg(windows)]
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.output().unwrap()
}

#[test]
fn migration_scan_is_read_only_and_filters_credentials_without_initializing_a_profile() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("settings.json");
    let content = include_str!("../../../kcoder_migration/tests/fixtures/claude-settings.json");
    std::fs::write(&source, content).unwrap();
    let result = invoke(
        root.path(),
        &[
            "migrate",
            "scan",
            "--source",
            "claude-code",
            "--config",
            source.to_str().unwrap(),
        ],
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let output = String::from_utf8(result.stdout).unwrap();
    assert!(!output.contains("SYNTHETIC_CREDENTIAL_CANARY_NOT_A_REAL_KEY"));
    let inventory: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(inventory["source"], "claude-code");
    assert_eq!(
        inventory["items"][0]["provider"]["apiFormat"],
        "anthropic_messages"
    );
    assert!(!root.path().join("unused-profile").exists());
    assert_eq!(std::fs::read_to_string(source).unwrap(), content);
}

#[test]
fn migration_errors_and_help_do_not_write_profiles_or_echo_bad_source_content() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("config.toml");
    std::fs::write(
        &source,
        "model = \"SYNTHETIC_CREDENTIAL_CANARY_NOT_A_REAL_KEY",
    )
    .unwrap();
    let result = invoke(
        root.path(),
        &[
            "migrate",
            "scan",
            "--source",
            "codex",
            "--config",
            source.to_str().unwrap(),
        ],
    );
    assert!(!result.status.success());
    assert!(
        !String::from_utf8_lossy(&result.stderr)
            .contains("SYNTHETIC_CREDENTIAL_CANARY_NOT_A_REAL_KEY")
    );
    assert!(!root.path().join("unused-profile").exists());
    let invalid = invoke(root.path(), &["migrate", "scan", "--source", "unknown"]);
    assert!(!invalid.status.success());
    assert!(!root.path().join("unused-profile").exists());
    let help = invoke(root.path(), &["migrate", "scan", "--help"]);
    assert!(help.status.success());
    assert!(!root.path().join("unused-profile").exists());
}

#[test]
fn relative_migration_selection_respects_the_explicit_cli_working_directory() {
    let root = tempfile::tempdir().unwrap();
    let selected = root.path().join("selected");
    std::fs::create_dir(&selected).unwrap();
    std::fs::write(
        selected.join("settings.json"),
        r#"{"model":"correct-source"}"#,
    )
    .unwrap();
    std::fs::write(
        root.path().join("settings.json"),
        r#"{"model":"wrong-source"}"#,
    )
    .unwrap();
    let result = invoke(
        root.path(),
        &[
            "--cwd",
            selected.to_str().unwrap(),
            "migrate",
            "scan",
            "--source",
            "claude-code",
            "--config",
            "settings.json",
        ],
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let inventory: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(inventory["items"][0]["provider"]["model"], "correct-source");
    assert!(!root.path().join("unused-profile").exists());
}

#[test]
fn provider_plan_apply_and_status_use_native_settings_without_agent_bootstrap() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("selected-profile");
    std::fs::create_dir(&profile).unwrap();
    let source = root.path().join("settings.json");
    let content = r#"{"model":"source-model","env":{"ANTHROPIC_BASE_URL":"https://example.invalid","ANTHROPIC_API_KEY":"SYNTHETIC_MIGRATION_SECRET"}}"#;
    std::fs::write(&source, content).unwrap();
    let scan = invoke(
        root.path(),
        &[
            "migrate",
            "scan",
            "--source",
            "claude-code",
            "--config",
            source.to_str().unwrap(),
        ],
    );
    assert!(scan.status.success());
    let inventory: Value = serde_json::from_slice(&scan.stdout).unwrap();
    let id = inventory["items"][0]["preview"]["id"].as_str().unwrap();
    let planned = invoke(
        root.path(),
        &[
            "migrate",
            "plan-provider",
            "--source",
            "claude-code",
            "--config",
            source.to_str().unwrap(),
            "--item-id",
            id,
            "--target-profile",
            profile.to_str().unwrap(),
            "--target-name",
            "ImportedClaude",
            "--context-window-tokens",
            "128000",
            "--output-headroom-tokens",
            "8192",
            "--max-output-tokens",
            "8192",
        ],
    );
    assert!(
        planned.status.success(),
        "{}",
        String::from_utf8_lossy(&planned.stderr)
    );
    assert!(!profile.join("settings.json").exists());
    let job: Value = serde_json::from_slice(&planned.stdout).unwrap();
    assert!(job.get("sourceBinding").is_none());
    assert!(job["providerPlans"][0].get("expectedRevision").is_none());
    assert!(job["providerPlans"][0].get("targetId").is_none());
    assert!(!String::from_utf8_lossy(&planned.stdout).contains(root.path().to_str().unwrap()));
    let fingerprint =
        kcoder_migration::source::SourceDocument::read_selected_configuration(&source)
            .unwrap()
            .revision();
    assert!(!String::from_utf8_lossy(&planned.stdout).contains(&fingerprint));
    let sequence = job["sequence"].to_string();
    let args = [
        "migrate",
        "apply-provider",
        "--target-profile",
        profile.to_str().unwrap(),
        "--config",
        source.to_str().unwrap(),
        "--job-id",
        job["jobId"].as_str().unwrap(),
        "--plan-id",
        job["providerPlans"][0]["planId"].as_str().unwrap(),
        "--expected-sequence",
        &sequence,
    ];
    // A changed source is rejected before target publication.
    std::fs::write(&source, format!("{content}\n")).unwrap();
    let changed = invoke(root.path(), &args);
    assert!(!changed.status.success());
    assert!(String::from_utf8_lossy(&changed.stderr).contains("migration_source_changed"));
    assert!(!profile.join("settings.json").exists());
    std::fs::write(&source, content).unwrap();
    let applied = invoke(root.path(), &args);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    let completed: Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(completed["status"], "completed_with_issues");
    assert_eq!(
        completed["inventory"]["items"][0]["preview"]["status"],
        "committed"
    );
    assert!(!String::from_utf8_lossy(&applied.stdout).contains("SYNTHETIC_MIGRATION_SECRET"));
    let settings_path = profile.join("settings.json");
    let bytes = std::fs::read(&settings_path).unwrap();
    let settings = kcoder_config::read_settings_file(&settings_path).unwrap();
    // A fresh profile ships no Provider; the import records the unchanged
    // empty selection explicitly instead of selecting itself.
    assert_eq!(settings["active_provider"], Value::Null);
    assert!(settings.get("active_provider").is_some());
    assert_eq!(
        settings["providers"]["ImportedClaude"]["default_model"],
        "source-model"
    );
    assert!(!String::from_utf8_lossy(&bytes).contains("SYNTHETIC_MIGRATION_SECRET"));
    let repeated = invoke(root.path(), &args);
    assert!(repeated.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&repeated.stdout).unwrap(),
        completed
    );
    assert_eq!(std::fs::read(&settings_path).unwrap(), bytes);
    let status = invoke(
        root.path(),
        &[
            "migrate",
            "status",
            "--target-profile",
            profile.to_str().unwrap(),
            "--job-id",
            job["jobId"].as_str().unwrap(),
        ],
    );
    assert!(status.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&status.stdout).unwrap(),
        completed
    );
    assert_eq!(std::fs::read_to_string(&source).unwrap(), content);
    assert!(!root.path().join("unused-profile").exists());
    let committed_sequence = completed["sequence"].to_string();
    let rollback = invoke(
        root.path(),
        &[
            "migrate",
            "rollback-provider",
            "--target-profile",
            profile.to_str().unwrap(),
            "--job-id",
            job["jobId"].as_str().unwrap(),
            "--plan-id",
            job["providerPlans"][0]["planId"].as_str().unwrap(),
            "--expected-sequence",
            &committed_sequence,
        ],
    );
    assert!(
        rollback.status.success(),
        "{}",
        String::from_utf8_lossy(&rollback.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&rollback.stdout).unwrap()["status"],
        "rolled_back"
    );
    assert_eq!(
        kcoder_config::read_settings_file(&settings_path).unwrap(),
        serde_json::json!({})
    );
}
