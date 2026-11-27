//! Local guided configuration uses the same native migration journals as explicit commands.
use super::{MigrationResourceArgs, MigrationSourceArg};
use clap::Args;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum MigrationSettingsScope {
    User,
    CurrentWorkspace,
}

#[derive(Debug, Clone, Args)]
pub struct MigrationGuideArgs {
    #[arg(long, value_name = "DIRECTORY")]
    pub target_profile: PathBuf,
    /// Reopen this exact durable inventory or plan, without discovering a replacement source.
    #[arg(long, conflicts_with_all = ["source", "source_home", "source_config_dir", "project", "target_scope", "resource_max_total_bytes", "resource_max_payload_files", "resource_min_free_bytes", "resource_min_free_file_nodes"])]
    pub job_id: Option<String>,
    #[arg(long, value_enum)]
    pub source: Option<MigrationSourceArg>,
    #[arg(long, value_name = "DIRECTORY")]
    pub source_home: Option<PathBuf>,
    #[arg(long, value_name = "DIRECTORY")]
    pub source_config_dir: Option<PathBuf>,
    #[arg(long, value_name = "DIRECTORY")]
    pub project: Option<PathBuf>,
    /// Choose settings destination independently of the source --project directory.
    #[arg(long, value_enum)]
    pub target_scope: Option<MigrationSettingsScope>,
    #[command(flatten)]
    pub resources: MigrationResourceArgs,
    #[arg(long)]
    pub configuration_only: bool,
    /// Explicitly select historical files into the same configuration/asset batch.
    #[arg(long, conflicts_with_all = ["configuration_only", "job_id"])]
    pub include_history: bool,
    /// Explicitly discover static model-authored notes, requiring a separate target mapping.
    #[arg(long, conflicts_with_all = ["configuration_only", "job_id"])]
    pub include_memory: bool,
    /// Explicitly preserve Agent/Hook definitions as inert pending assets, never executable policies.
    #[arg(long, conflicts_with_all = ["configuration_only", "job_id"])]
    pub include_definitions: bool,
    /// Explicitly review and copy selected local plugins before the unified batch preview.
    #[arg(long, conflicts_with_all = ["configuration_only", "job_id"])]
    pub include_plugins: bool,
    /// Bind an exact Ready unclaimed local plugin operation; never select the latest implicitly.
    #[arg(long = "plugin-operation", value_name = "UUID:SEQUENCE", conflicts_with_all = ["configuration_only", "job_id"])]
    pub plugin_operations: Vec<String>,
    /// Private terminal-host transport; prompts must be answered with their current identity.
    #[arg(long, hide = true)]
    pub jsonl: bool,
}
