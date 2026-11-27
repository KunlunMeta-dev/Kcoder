//! Guided terminal selection requires no hand-authored JSON request documents.
use clap::Args;
use std::path::PathBuf;

#[derive(Debug, Clone, Args)]
pub struct MigrationTransferGuideArgs {
    /// Private local draft with selectors and explicitly chosen source roots; reopen this exact path after interruption.
    #[arg(long)]
    pub record: PathBuf,
    #[arg(long)]
    pub source_target: Option<String>,
    #[arg(long)]
    pub target: Option<String>,
    #[arg(long)]
    pub source_workspace: Option<String>,
    #[arg(long)]
    pub target_workspace: Option<String>,
    /// Explicit product root on the selected source host; never resolved on this client.
    #[arg(long)]
    pub source_directory: Option<String>,
    #[arg(long)]
    pub include_project: bool,
    #[arg(long)]
    pub include_history: bool,
    #[arg(long)]
    pub rpc_token_env: Option<String>,
    #[arg(long, hide = true)]
    pub jsonl: bool,
}
