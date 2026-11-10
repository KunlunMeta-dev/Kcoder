pub(crate) use kcoder_migration_client::cli_args::migration_resources::*;

#[cfg(test)]
mod tests {
    use super::super::{Cli, Commands, HistoryAction, MigrationAction};
    use super::*;
    use clap::Parser;
    use kcoder_types::migration_resource::{
        MAX_MIGRATION_RESOURCE_BYTES, MAX_MIGRATION_RESOURCE_FILES, MigrationResourceLimits,
    };

    fn parse_creation(arguments: &[&str]) -> MigrationResourceArgs {
        let cli = Cli::try_parse_from(arguments).unwrap();
        match cli.command.unwrap() {
            Commands::Migrate {
                action: MigrationAction::BatchScan { resources, .. },
            }
            | Commands::Migrate {
                action:
                    MigrationAction::History {
                        action: HistoryAction::Select { resources, .. },
                        ..
                    },
            } => resources,
            Commands::Migrate {
                action: MigrationAction::Configure { options },
            } => options.resources,
            _ => panic!("expected an initial creation command"),
        }
    }

    #[test]
    fn all_initial_creation_commands_parse_the_same_four_explicit_limits_and_omit_none() {
        for mut arguments in [
            vec![
                "kcoder",
                "migrate",
                "batch-scan",
                "--source",
                "codex",
                "--source-home",
                "/source",
                "--target-profile",
                "/target",
            ],
            vec![
                "kcoder",
                "migrate",
                "history",
                "--target-profile",
                "/target",
                "select",
                "--source",
                "codex",
                "--source-root",
                "/source",
                "--source-session-id",
                "session",
                "--request-id",
                "00000000-0000-0000-0000-000000000001",
            ],
            vec![
                "kcoder",
                "migrate",
                "configure",
                "--target-profile",
                "/target",
            ],
        ] {
            assert!(parse_creation(&arguments).limits().unwrap().is_none());
            arguments.extend([
                "--resource-max-total-bytes",
                "2097152",
                "--resource-max-payload-files",
                "13",
                "--resource-min-free-bytes",
                "1048576",
                "--resource-min-free-file-nodes",
                "0",
            ]);
            assert_eq!(
                parse_creation(&arguments).limits().unwrap().unwrap(),
                MigrationResourceLimits {
                    max_total_bytes: 2 * 1024 * 1024,
                    max_payload_files: 13,
                    min_free_bytes: 1024 * 1024,
                    min_free_file_nodes: 0,
                }
            );
        }
    }

    #[test]
    fn initial_limits_cannot_silently_replace_a_reopened_job_policy() {
        for flag in [
            "--resource-max-total-bytes",
            "--resource-max-payload-files",
            "--resource-min-free-bytes",
            "--resource-min-free-file-nodes",
        ] {
            assert_eq!(
                Cli::try_parse_from([
                    "kcoder",
                    "migrate",
                    "configure",
                    "--target-profile",
                    "/target",
                    "--job-id",
                    "original-job",
                    flag,
                    "1"
                ])
                .unwrap_err()
                .kind(),
                clap::error::ErrorKind::ArgumentConflict
            );
        }
    }

    #[test]
    fn omitted_initial_limits_keep_legacy_none_and_one_explicit_value_retains_other_native_defaults()
     {
        assert!(MigrationResourceArgs::default().limits().unwrap().is_none());
        let args = MigrationResourceArgs {
            resource_max_total_bytes: Some(2 * 1024 * 1024),
            ..Default::default()
        };
        let value = args.limits().unwrap().unwrap();
        assert_eq!(value.max_total_bytes, 2 * 1024 * 1024);
        assert_eq!(
            value.max_payload_files,
            MigrationResourceLimits::default().max_payload_files
        );
        assert_eq!(
            value.min_free_bytes,
            MigrationResourceLimits::default().min_free_bytes
        );
        assert_eq!(
            value.min_free_file_nodes,
            MigrationResourceLimits::default().min_free_file_nodes
        );
        assert_eq!(
            MigrationResourceArgs {
                resource_min_free_file_nodes: Some(0),
                ..Default::default()
            }
            .limits()
            .unwrap()
            .unwrap()
            .min_free_file_nodes,
            0
        );
    }

    #[test]
    fn unsupported_initial_limits_fail_before_creation_without_silently_clamping_or_dropping_fields()
     {
        for args in [
            MigrationResourceArgs {
                resource_max_total_bytes: Some(0),
                ..Default::default()
            },
            MigrationResourceArgs {
                resource_max_total_bytes: Some(MAX_MIGRATION_RESOURCE_BYTES + 1),
                ..Default::default()
            },
            MigrationResourceArgs {
                resource_max_payload_files: Some(0),
                ..Default::default()
            },
            MigrationResourceArgs {
                resource_max_payload_files: Some(MAX_MIGRATION_RESOURCE_FILES + 1),
                ..Default::default()
            },
            MigrationResourceArgs {
                resource_min_free_bytes: Some(0),
                ..Default::default()
            },
            MigrationResourceArgs {
                resource_min_free_file_nodes: Some(MAX_MIGRATION_RESOURCE_FILES + 1),
                ..Default::default()
            },
        ] {
            assert_eq!(
                args.limits().unwrap_err().to_string(),
                "migration_invalid_resource_limits"
            );
        }
    }
}
