pub(crate) use kcoder_migration_client::cli_args::migration_budget::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_args::{Cli, Commands, MigrationAction};
    use clap::Parser;

    #[test]
    fn budget_read_has_no_implicit_mutation_or_plan_authority() {
        let parsed = Cli::try_parse_from([
            "kcoder",
            "migrate",
            "budget",
            "--target-profile",
            "owned",
            "read",
            "--scope",
            "history",
            "--job-id",
            "original",
        ])
        .unwrap();
        assert!(matches!(
            parsed.command,
            Some(Commands::Migrate {
                action: MigrationAction::Budget {
                    action: MigrationBudgetAction::Read {
                        scope: MigrationBudgetScope::History,
                        request_id: None,
                        ..
                    },
                    ..
                }
            })
        ));
    }

    #[test]
    fn budget_changes_require_a_complete_explicit_policy_and_original_batch_plan() {
        let mut args = vec![
            "kcoder",
            "migrate",
            "budget",
            "--target-profile",
            "owned",
            "increase",
            "--scope",
            "batch",
            "--job-id",
            "original",
            "--request-id",
            "request",
            "--expected-policy-revision",
            "0",
            "--max-total-bytes",
            "2097152",
            "--max-payload-files",
            "64",
            "--min-free-bytes",
            "1048576",
            "--min-free-file-nodes",
            "0",
        ];
        assert!(Cli::try_parse_from(&args).is_err());
        args.extend(["--plan-id", "original-plan"]);
        assert!(Cli::try_parse_from(&args).is_ok());
        let minimum_at = args
            .iter()
            .position(|value| *value == "--min-free-file-nodes")
            .unwrap();
        args.drain(minimum_at..minimum_at + 2);
        assert!(Cli::try_parse_from(&args).is_err());
        assert!(
            MigrationBudgetLimits {
                max_total_bytes: 0,
                max_payload_files: 64,
                min_free_bytes: 1048576,
                min_free_file_nodes: 0,
            }
            .native()
            .is_err()
        );
    }
}
