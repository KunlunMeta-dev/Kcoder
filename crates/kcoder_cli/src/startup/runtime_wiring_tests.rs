use super::*;
use clap::Parser;

#[test]
fn startup_diagnostics_use_typed_configuration_boundaries_without_classifying_raw_messages() {
    let unknown = startup_settings_error(anyhow::anyhow!("settings_parse_failed"));
    assert_eq!(unknown.to_string(), "settings_parse_failed");
    let known = startup_settings_error(anyhow::anyhow!("private source bytes").context(
        kcoder_config::SettingsLoadFailure::new(kcoder_config::SettingsLoadFailureKind::Parse),
    ));
    assert_eq!(
        known.to_string(),
        "KCoder configuration requires correction in settings"
    );
    assert!(!format!("{known:?}").contains("private source bytes"));
}

#[test]
fn management_profile_selection_keeps_the_original_draft_while_execution_stays_strict() {
    let cli = Cli::parse_from(["kcoder", "--profile", "CaseSensitive", "app-server"]);
    let settings: Settings = serde_json::from_value(serde_json::json!({"providers":{"CaseSensitive":{
        "api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:1/v1","default_model":""}}})).unwrap();
    let mut strict = settings.clone();
    assert!(apply_cli_settings_overrides(&mut strict, &cli).is_err());
    let mut management = settings;
    apply_cli_settings_overrides_for_management(&mut management, &cli).unwrap();
    assert_eq!(management.active_provider.as_deref(), Some("CaseSensitive"));
    assert_eq!(management.model, "");
    assert_eq!(management.context_window_tokens, None);
    assert_eq!(management.context_output_headroom, None);
    assert!(management.model_execution_readiness().is_err());
}

#[test]
fn explicit_builtin_transport_readiness_does_not_restore_or_inherit_a_catalog_profile() {
    let cli = Cli::parse_from([
        "kcoder",
        "--provider",
        "openai",
        "--model",
        "explicit-model",
        "app-server",
    ]);
    let mut settings = Settings {
        context_window_tokens: Some(32768),
        context_output_headroom: Some(1024),
        max_tokens: Some(1024),
        ..Settings::default()
    };
    apply_cli_settings_overrides_for_management(&mut settings, &cli).unwrap();
    assert!(settings.providers.is_empty());
    assert_eq!(settings.api_format, None);
    let kind = cli_provider_kind(&cli, None, &settings).unwrap();
    assert!(model_configuration::execution_readiness(&settings, kind).is_ok());
    settings.context_window_tokens = None;
    assert_eq!(
        model_configuration::execution_readiness(&settings, kind)
            .unwrap_err()
            .code(),
        "model_limits_missing"
    );
}

#[test]
fn source_only_launch_remains_separate_and_cannot_downgrade_an_inherited_account_parent() {
    let cli = Cli::parse_from(["kcoder", "app-server", "--migration-source-parent-local-v1"]);
    let root = std::path::Path::new("/owned-profile");
    let source = migration_source_launch(cli.command.as_ref(), root, None)
        .unwrap()
        .unwrap();
    assert!(matches!(
        source.parent,
        kcoder_app_protocol::RetentionParentLaunchV1::LocalOs
    ));
    assert_eq!(source.account_root, root);
    assert!(!source.optional && source.revocation_verifier.is_none());
    let account = app_server::RetentionLaunchConfiguration {
        parent: kcoder_app_protocol::RetentionParentLaunchV1::VerifiedAccount {
            principal_id: "owned-principal".into(),
            uid: 0,
        },
        account_root: root.into(),
        optional: true,
        revocation_verifier: None,
    };
    assert!(migration_source_launch(cli.command.as_ref(), root, Some(&account)).is_err());
    let ordinary = Cli::parse_from(["kcoder", "app-server"]);
    assert!(
        migration_source_launch(ordinary.command.as_ref(), root, Some(&account))
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        account.parent,
        kcoder_app_protocol::RetentionParentLaunchV1::VerifiedAccount { .. }
    ));
}

#[test]
fn invalid_project_instructions_fail_dev_startup_before_creating_workspace_metadata() {
    for invalid_encoding in [true, false] {
        let workspace = tempfile::tempdir().unwrap();
        let guide = workspace.path().join("AGENTS.md");
        if invalid_encoding {
            std::fs::write(&guide, [0xff]).unwrap();
        } else {
            std::fs::File::create(&guide)
                .unwrap()
                .set_len((kcoder_config::MAX_PROJECT_MD_FILE_BYTES + 1) as u64)
                .unwrap();
        }
        let mut cli = Cli::parse_from(["kcoder"]);
        cli.cwd = Some(workspace.path().to_path_buf());
        cli.command = Some(Commands::TuiDev {
            scenario: TuiDevScenario::FullTurn,
        });
        let result = build_tui_dev_engine(
            &cli,
            &mut Settings::default(),
            TuiDevScenario::FullTurn,
            workspace.path().join("settings.json"),
        );
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("invalid guide must stop startup"),
        };
        assert!(error.to_string().contains(if invalid_encoding {
            "project_instruction_encoding"
        } else {
            "project_instruction_limit"
        }));
        assert!(!workspace.path().join(".kcoder").exists());
        assert_eq!(std::fs::read_dir(workspace.path()).unwrap().count(), 1);
    }
}
