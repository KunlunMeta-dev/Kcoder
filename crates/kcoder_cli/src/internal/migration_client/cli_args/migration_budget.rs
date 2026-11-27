//! Policy controls name the original accounting owner and never start migration work.
use anyhow::{Result, ensure};
use clap::{Args, Subcommand, ValueEnum};
use kcoder_types::migration_resource::MigrationResourceLimits;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum MigrationBudgetScope {
    Batch,
    History,
}

#[derive(Debug, Clone, Args)]
pub struct MigrationBudgetLimits {
    #[arg(long, value_name = "BYTES")]
    pub max_total_bytes: u64,
    #[arg(long, value_name = "FILES")]
    pub max_payload_files: u32,
    #[arg(long, value_name = "BYTES")]
    pub min_free_bytes: u64,
    #[arg(long, value_name = "NODES")]
    pub min_free_file_nodes: u32,
}
impl MigrationBudgetLimits {
    pub fn native(&self) -> Result<MigrationResourceLimits> {
        let limits = MigrationResourceLimits {
            max_total_bytes: self.max_total_bytes,
            max_payload_files: self.max_payload_files,
            min_free_bytes: self.min_free_bytes,
            min_free_file_nodes: self.min_free_file_nodes,
        };
        ensure!(limits.is_supported(), "migration_invalid_resource_limits");
        Ok(limits)
    }
}

#[derive(Debug, Clone, Args)]
pub struct MigrationBudgetOwner {
    #[arg(long, value_enum)]
    pub scope: MigrationBudgetScope,
    #[arg(long)]
    pub job_id: String,
    /// Original batch plan; never infer one from a history child.
    #[arg(long, required_if_eq("scope", "batch"))]
    pub plan_id: Option<String>,
}

#[derive(Debug, Clone, Subcommand)]
pub enum MigrationBudgetAction {
    /// Read policy, usage and an optional original request receipt without modifying them.
    Read {
        #[arg(long, value_enum)]
        scope: MigrationBudgetScope,
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Explicitly raise the original policy. This does not resume or clear cancellation.
    Increase {
        #[command(flatten)]
        owner: MigrationBudgetOwner,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        expected_policy_revision: u64,
        #[command(flatten)]
        limits: MigrationBudgetLimits,
        #[arg(long)]
        confirm: bool,
    },
    /// Explicitly attach accounting to a legacy job; born or parent-owned ledgers cannot reset.
    Attach {
        #[command(flatten)]
        owner: MigrationBudgetOwner,
        #[arg(long)]
        expected_sequence: u64,
        #[command(flatten)]
        limits: MigrationBudgetLimits,
        #[arg(long)]
        confirm: bool,
    },
}
