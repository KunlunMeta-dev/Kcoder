//! Public Gateway selectors are distinct from local profile and Native parent authority.
use clap::{Args, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Clone, Args)]
pub struct MigrationTransferArgs {
    /// Existing authenticated Gateway URL. Remote connections require HTTPS.
    #[arg(long)]
    pub gateway: String,
    /// Environment variable containing an existing Gateway account access token.
    #[arg(long, default_value = "KCODER_GATEWAY_ACCESS_TOKEN")]
    pub access_token_env: String,
    #[command(subcommand)]
    pub action: MigrationTransferAction,
}

#[derive(Debug, Clone, Subcommand)]
pub enum MigrationTransferAction {
    /// Select, transfer, reopen and explicitly publish sources through an interactive guide.
    Guide {
        #[command(flatten)]
        options: super::MigrationTransferGuideArgs,
    },
    /// Preview, explicitly publish or undo a saved batch on the selected remote target.
    Batch {
        #[command(flatten)]
        options: super::MigrationRemoteBatchArgs,
    },
    /// List accessible target IDs without exposing connection credentials.
    Targets {
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u16).range(0..=102))]
        page: u16,
    },
    /// Open, read or release one explicitly identified Gateway-owned session.
    Session {
        #[arg(value_enum)]
        operation: SessionOperation,
        #[command(flatten)]
        request: TransferRequest,
    },
    /// Discover sources or explicitly authorize a new source grant with --confirm.
    Query {
        #[command(flatten)]
        request: TransferRequest,
        /// Configuration discovery is paged by ten; history uses its native cursor.
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u16).range(0..=102))]
        page: u16,
    },
    /// Copy or reconcile one original request; Ready means received bytes, not publication.
    Copy {
        #[arg(value_enum)]
        operation: CopyOperation,
        #[command(flatten)]
        request: TransferRequest,
    },
    /// Read ten received items or explicitly prepare/recover an adoption preview.
    Adoption {
        #[arg(value_enum)]
        operation: AdoptionOperation,
        #[command(flatten)]
        request: TransferRequest,
    },
}

#[derive(Debug, Clone, Args)]
pub struct TransferRequest {
    /// At most 64 KiB of the operation's existing public JSON request schema.
    #[arg(long, value_name = "FILE")]
    pub input: PathBuf,
    /// Explicitly authorize this creation, mutation, cancellation, resume or release.
    #[arg(long)]
    pub confirm: bool,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum SessionOperation {
    Open,
    Read,
    Close,
}
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum CopyOperation {
    Run,
    Read,
    Cancel,
    TargetRead,
    TargetCancel,
    TargetResume,
    TargetFinish,
}
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum AdoptionOperation {
    Received,
    Prepare,
    Read,
    Resume,
    Cancel,
}
