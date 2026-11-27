//! Explicit terminal selection and transfer use the same durable historical upload operations.
use clap::{Args, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Clone, Args)]
pub struct HistoryLocalSelection {
    #[arg(long)]
    pub job_id: String,
    #[arg(long)]
    pub view_id: Option<String>,
    #[arg(long)]
    pub position: u64,
    #[arg(long)]
    pub block: u32,
    #[arg(long)]
    pub tool_item_index: Option<u32>,
}
#[derive(Debug, Clone, Args)]
pub struct HistoryLocalBindings {
    /// Exact Ready binding JSON returned by local-attachment read/run, repeated explicitly.
    #[arg(long, requires = "confirm_local_attachments")]
    pub local_attachment_binding: Vec<String>,
    #[arg(long, requires = "local_attachment_binding")]
    pub confirm_local_attachments: bool,
}
#[derive(Debug, Clone, Subcommand)]
pub enum HistoryLocalAction {
    /// Build the existing typed tool-result directory; no source tool executes.
    Catalog {
        #[command(flatten)]
        selection: HistoryLocalSelection,
        #[arg(long)]
        resume_sequence: Option<u64>,
    },
    /// Read the existing directory checkpoint before explicitly resuming an interrupted build.
    CatalogRead {
        #[command(flatten)]
        selection: HistoryLocalSelection,
    },
    /// Read ten entries from the existing typed tool-result directory.
    Items {
        #[command(flatten)]
        selection: HistoryLocalSelection,
        #[arg(long)]
        cursor: Option<u32>,
    },
    /// Freeze the historical reference before selecting any local file.
    Prepare {
        #[command(flatten)]
        selection: HistoryLocalSelection,
        #[arg(long)]
        request_id: String,
    },
    /// Read up to ten existing operations for this exact historical selection.
    List {
        #[command(flatten)]
        selection: HistoryLocalSelection,
        #[arg(long)]
        cursor: Option<String>,
    },
    Read {
        #[arg(long)]
        operation_id: String,
    },
    /// Upload bounded parts only. Finish and run are separate explicit operations.
    Upload {
        #[command(flatten)]
        selection: HistoryLocalSelection,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        expected_sequence: u64,
        #[arg(long)]
        file: PathBuf,
        #[arg(long, required = true)]
        confirm: bool,
    },
    Resume {
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    Finish {
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    /// expected-sequence is the nested localJob.state.sequence, not the upload sequence.
    Run {
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    Cancel {
        #[arg(long)]
        operation_id: String,
    },
    /// Explicitly output one authenticated bounded content chunk as base64 JSON.
    Chunk {
        #[arg(long)]
        binding: String,
        #[arg(long, default_value_t = 0)]
        offset: u64,
        #[arg(long, default_value_t=262144, value_parser=clap::value_parser!(u32).range(1..=262144))]
        limit: u32,
        #[arg(long, required = true)]
        confirm: bool,
    },
}
