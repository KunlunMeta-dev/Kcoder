//! Shared migration command arguments for the native CLI adapter.
use clap::{Parser, ValueEnum};
use std::path::PathBuf;
#[path = "cli_args/migration_budget.rs"]
pub mod migration_budget;
#[path = "../../cli_args/migration_guide.rs"]
mod migration_guide;
#[path = "../../cli_args/migration_history.rs"]
mod migration_history;
#[path = "../../cli_args/migration_plugin.rs"]
mod migration_plugin;
#[path = "../../cli_args/migration_remote_batch.rs"]
mod migration_remote_batch;
#[path = "cli_args/migration_resources.rs"]
pub mod migration_resources;
#[path = "../../cli_args/migration_transfer.rs"]
mod migration_transfer;
#[path = "../../cli_args/migration_transfer_guide.rs"]
mod migration_transfer_guide;
pub use migration_budget::{MigrationBudgetAction, MigrationBudgetScope};
pub use migration_guide::{MigrationGuideArgs, MigrationSettingsScope};
pub use migration_history::{
    HistoryAction, HistoryLocalAction, HistoryLocalBindings, HistoryLocalSelection,
    HistoryReinterpretAction, HistorySelection,
};
pub use migration_plugin::{
    MigrationPluginAction, MigrationPluginBinding, MigrationPluginSourceArgs,
};
pub use migration_remote_batch::{MigrationRemoteBatchArgs, RemoteBatchOperation};
pub use migration_resources::MigrationResourceArgs;
pub use migration_transfer::{
    AdoptionOperation, CopyOperation, MigrationTransferAction, MigrationTransferArgs,
    SessionOperation, TransferRequest,
};
pub use migration_transfer_guide::MigrationTransferGuideArgs;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum MigrationSourceArg {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, Parser)]
pub enum MigrationAction {
    /// Read or explicitly change the original migration storage policy without running work.
    Budget {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[command(subcommand)]
        action: MigrationBudgetAction,
    },
    /// Transfer explicitly selected sources through an existing authenticated Gateway.
    Transfer {
        #[command(flatten)]
        options: MigrationTransferArgs,
    },
    /// Inspect, prepare and recover a selected local plugin package without activating it.
    Plugin {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[command(subcommand)]
        action: MigrationPluginAction,
    },
    /// Select configuration and compatible assets, confirm a preview, or reopen a saved result.
    Configure {
        #[command(flatten)]
        options: MigrationGuideArgs,
    },
    /// Discover, archive, inspect and safely continue external conversation histories.
    History {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[command(subcommand)]
        action: HistoryAction,
    },
    /// Discover the selected account directories and freeze a durable batch inventory.
    BatchScan {
        #[arg(long, value_enum)]
        source: MigrationSourceArg,
        #[arg(long, value_name = "DIRECTORY")]
        source_home: PathBuf,
        #[arg(long, value_name = "DIRECTORY")]
        source_config_dir: Option<PathBuf>,
        #[arg(long, value_name = "DIRECTORY")]
        project: Option<PathBuf>,
        #[arg(long)]
        configuration_only: bool,
        #[command(flatten)]
        resources: MigrationResourceArgs,
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
    },
    /// Create a batch preview from bounded public JSON choices; never accept raw credentials.
    PlanBatch {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long, value_name = "FILE")]
        options: PathBuf,
    },
    /// List at most ten durable migration jobs in the selected profile.
    Records {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Read one page of a saved migration inventory and its resolved choices.
    Items {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long)]
        job_id: String,
        #[arg(long, default_value_t = 0)]
        page_index: usize,
        #[arg(long, default_value_t = false)]
        include_templates: bool,
    },
    /// Apply or reconcile an existing batch using its original identities and receipts.
    ApplyBatch {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        plan_id: String,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    /// Explicitly resume the same batch and historical children after reading its checkpoint.
    ResumeBatch {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        plan_id: String,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    /// Undo an existing batch, preserving user edits and later reuse references.
    RollbackBatch {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        plan_id: String,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    /// Record cancellation at the next safe boundary; never claim an automatic rollback.
    Cancel {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    /// Produce credential-free candidates; do not import or start source programs.
    Scan {
        #[arg(long, value_enum)]
        source: MigrationSourceArg,
        #[arg(long, value_name = "FILE")]
        config: PathBuf,
    },
    /// Preview and stage one Provider in an explicitly selected existing user profile.
    PlanProvider {
        #[arg(long, value_enum)]
        source: MigrationSourceArg,
        #[arg(long, value_name = "FILE")]
        config: PathBuf,
        #[arg(long)]
        item_id: String,
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long)]
        target_name: String,
        #[arg(long)]
        endpoint: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        context_window_tokens: u64,
        #[arg(long)]
        output_headroom_tokens: u64,
        #[arg(long)]
        max_output_tokens: u64,
    },
    /// Apply one staged Provider plan after checking its source and target revisions.
    ApplyProvider {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long, value_name = "FILE")]
        config: PathBuf,
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        plan_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    /// Undo an owned Provider import only if its target configuration is unchanged.
    RollbackProvider {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        plan_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    /// Read a migration journal without starting Agent execution.
    Status {
        #[arg(long, value_name = "DIRECTORY")]
        target_profile: PathBuf,
        #[arg(long)]
        job_id: String,
    },
}
