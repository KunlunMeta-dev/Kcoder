use super::*;
use clap::Parser;

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
