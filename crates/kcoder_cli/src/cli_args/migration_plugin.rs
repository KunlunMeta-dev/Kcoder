//! Plugin selectors contain public source facts or exact local operation watermarks.
use super::MigrationSourceArg;
use clap::{Args, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Clone, Args)]
pub struct MigrationPluginSourceArgs {
    #[arg(long, value_enum)]
    pub source: MigrationSourceArg,
    #[arg(long, value_name = "DIRECTORY")]
    pub source_home: PathBuf,
    #[arg(long, value_name = "DIRECTORY")]
    pub source_config_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Subcommand)]
pub enum MigrationPluginAction {
    /// Read one page of the explicitly selected account's plugin candidates.
    Discover {
        #[command(flatten)]
        source: MigrationPluginSourceArgs,
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u16).range(0..=1024))]
        page: u16,
    },
    /// Fix one exact public name/scope/version selection under a caller-owned request ID.
    Prepare {
        #[command(flatten)]
        source: MigrationPluginSourceArgs,
        #[arg(long)]
        name: String,
        #[arg(long)]
        scope: String,
        /// Match this exact installed version; omission matches a missing version, never latest.
        #[arg(long)]
        installed_version: Option<String>,
        /// Actual installation identifier name; this does not rewrite the manifest display title.
        #[arg(long)]
        target_name: Option<String>,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        confirm: bool,
    },
    /// Read at most ten persisted Native operations; this never repeats a capture.
    Records {
        #[arg(long)]
        cursor: Option<String>,
    },
    Read {
        #[arg(long)]
        operation_id: String,
    },
    /// Copy the fixed package; retain its original source until first publication. Ready is static.
    Capture {
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        expected_sequence: u64,
        #[arg(long)]
        confirm: bool,
    },
    /// Acknowledge the exact cancellation watermark without copying or publishing.
    Resume {
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    Cancel {
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    /// Retire only an unclaimed operation's unchanged output.
    Undo {
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        expected_sequence: u64,
        #[arg(long)]
        confirm: bool,
    },
}

#[derive(Debug, Clone)]
pub struct MigrationPluginBinding {
    pub operation_id: String,
    pub sequence: u64,
}
impl std::str::FromStr for MigrationPluginBinding {
    type Err = &'static str;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (id, sequence) = value
            .split_once(':')
            .ok_or("plugin_migration_invalid_binding")?;
        let parsed = uuid::Uuid::parse_str(id).map_err(|_| "plugin_migration_invalid_binding")?;
        if parsed.to_string() != id {
            return Err("plugin_migration_invalid_binding");
        }
        Ok(Self {
            operation_id: id.into(),
            sequence: sequence
                .parse()
                .map_err(|_| "plugin_migration_invalid_binding")?,
        })
    }
}
