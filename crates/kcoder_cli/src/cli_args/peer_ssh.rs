use clap::Parser;
use std::path::PathBuf;

#[derive(Clone, Debug, Parser)]
pub enum PeerSshAction {
    /// Explicitly initialize this profile's public peer identity without enabling communication.
    Prepare {
        #[arg(long)]
        confirm: bool,
    },
    /// Observe an existing profile identity and pin revision without writing.
    Observe,
    /// Apply one explicit pin/revoke transaction as the OS profile owner.
    Apply {
        #[arg(long)]
        confirm: bool,
        #[arg(long, conflicts_with = "command_stdin")]
        input: Option<PathBuf>,
        /// Read one bounded command from the management SSH stream, never an environment grant.
        #[arg(long, conflicts_with = "input")]
        command_stdin: bool,
    },
    /// Reconcile the receipt of the original operation without replaying its write.
    ReadReceipt {
        #[arg(long)]
        operation_id: String,
    },
}
