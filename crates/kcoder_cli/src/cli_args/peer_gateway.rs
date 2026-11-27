use clap::Parser;

#[derive(Debug, Clone, Parser)]
pub enum PeerGatewayAction {
    /// Pair this profile with a Gateway; the credential is entered without echo.
    Pair {
        #[arg(long)]
        gateway: String,
        #[arg(long, value_parser = ["auto", "keyring", "file"])]
        store: Option<String>,
        /// Read the pairing credential from bounded piped stdin.
        #[arg(long)]
        code_stdin: bool,
        /// Legacy compatibility flag; HTTP is accepted regardless of this option.
        #[arg(long, hide = true)]
        allow_insecure: bool,
    },
    /// Show non-secret enrollment metadata without connecting or writing.
    Status {
        #[arg(long, hide = true)]
        allow_insecure: bool,
    },
    /// Rotate this device credential, reconciling the original pending rotation.
    Refresh {
        #[arg(long, hide = true)]
        allow_insecure: bool,
    },
    /// Revoke this device at the original Gateway, then remove local credentials.
    Revoke {
        #[arg(long, hide = true)]
        allow_insecure: bool,
    },
    /// Explicitly remove local credentials; this does not revoke a remote grant.
    Forget {
        #[arg(long)]
        confirm: bool,
    },
}
