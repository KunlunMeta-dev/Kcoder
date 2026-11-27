//! Ordinary remote batch RPC uses the selected Gateway account and workspace.
use super::TransferRequest;
use clap::{Args, ValueEnum};

#[derive(Debug, Clone, Args)]
pub struct MigrationRemoteBatchArgs {
    /// Optional RPC marker environment reference for legacy development Gateways.
    #[arg(long)]
    pub rpc_token_env: Option<String>,
    #[arg(long)]
    pub target_id: String,
    /// Explicit path on the selected target; never a local profile fallback.
    #[arg(long)]
    pub workspace_path: Option<String>,
    #[arg(value_enum)]
    pub operation: RemoteBatchOperation,
    #[command(flatten)]
    pub request: TransferRequest,
    /// Wait on the original connection's read-only status after run, at most thirty minutes.
    #[arg(long,default_value_t=300,value_parser=clap::value_parser!(u64).range(1..=1800))]
    pub wait_seconds: u64,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum RemoteBatchOperation {
    Read,
    Items,
    Plan,
    Run,
    Cancel,
}
