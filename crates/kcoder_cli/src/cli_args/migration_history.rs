//! Terminal operations are explicit choices over immutable historical evidence.
use super::{MigrationResourceArgs, MigrationSourceArg};
use clap::{Args, Parser};
use std::path::PathBuf;
#[path = "migration_reinterpretation.rs"]
mod reinterpretation;
pub use reinterpretation::HistoryReinterpretAction;
#[path = "migration_local_attachment.rs"]
mod local_attachment;
pub use local_attachment::{HistoryLocalAction, HistoryLocalBindings, HistoryLocalSelection};

#[derive(Debug, Clone, Args)]
pub struct HistorySelection {
    #[arg(long, value_enum)]
    pub source: MigrationSourceArg,
    /// Explicit product data directory, e.g. ~/.claude or ~/.codex.
    #[arg(long, value_name = "DIRECTORY")]
    pub source_root: PathBuf,
}

#[derive(Debug, Clone, Parser)]
pub enum HistoryAction {
    /// Explicitly supplement a historical local reference using the existing owned upload RPC.
    LocalAttachment {
        #[command(subcommand)]
        action: HistoryLocalAction,
    },
    /// Explicitly derive a new interpretation from an already archived job.
    Reinterpret {
        #[command(subcommand)]
        action: HistoryReinterpretAction,
    },
    /// Discover ten source sessions per page, without creating a session or job.
    Scan {
        #[command(flatten)]
        selection: HistorySelection,
        #[arg(long, default_value_t = 0)]
        page: u32,
    },
    /// Freeze one explicitly selected source; use run to archive and normalize it.
    Select {
        #[command(flatten)]
        selection: HistorySelection,
        #[arg(long)]
        source_session_id: String,
        /// Required when the same Codex session has more than one physical rollout.
        #[arg(long)]
        source_artifact_id: Option<String>,
        /// Select a Claude subagent explicitly; omission selects a main conversation.
        #[arg(long)]
        source_agent_id: Option<String>,
        /// Stable UUID for creation, retries and later recovery.
        #[arg(long)]
        request_id: String,
        #[command(flatten)]
        resources: MigrationResourceArgs,
    },
    /// List target-owned archive jobs, at most ten per page.
    Jobs {
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Read one durable archive job.
    Read {
        #[arg(long)]
        job_id: String,
    },
    /// Archive/normalize a selected job. Resume requires the latest sequence explicitly.
    Run {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        expected_sequence: u64,
        #[arg(long)]
        resume_job: bool,
    },
    /// Request cancellation without claiming that already committed data was undone.
    Cancel {
        #[arg(long)]
        job_id: String,
    },
    /// Read an inert archive or selected branch page; no old tool can execute.
    Page {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        view_id: Option<String>,
        #[arg(long, default_value_t = 0)]
        cursor: u64,
    },
    /// Read a bounded page of blocks belonging to one record.
    Blocks {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        view_id: Option<String>,
        #[arg(long)]
        record: u64,
        #[arg(long, default_value_t = 0)]
        cursor: u32,
    },
    /// Read at most 64 KiB of text. Reuse only returned nextOffset values.
    Text {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        view_id: Option<String>,
        #[arg(long)]
        record: u64,
        #[arg(long)]
        block: u32,
        #[arg(long, default_value_t = 0)]
        offset: u64,
    },
    /// Search decoded archive or selected-branch bodies without executing historical tools.
    Search {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        view_id: Option<String>,
        #[arg(long)]
        query: String,
        #[arg(long)]
        case_sensitive: bool,
        /// Page to reach within this command's single authenticated connection.
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u16).range(0..=1000))]
        page: u16,
        #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u8).range(1..=10))]
        limit: u8,
        /// Read one hit on this page (1-based) before closing the same connection.
        #[arg(long, value_parser = clap::value_parser!(u8).range(1..=10))]
        read_hit: Option<u8>,
        #[arg(long, default_value_t = 0, requires = "read_hit", value_parser = clap::value_parser!(u16).range(0..=1000))]
        body_page: u16,
    },
    /// Build the current branch and correlate recorded tools, without replaying them.
    Branch {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        related_job_id: Vec<String>,
        /// Resume a stopped branch with its latest sequence.
        #[arg(long)]
        resume_sequence: Option<u64>,
        /// Resume stopped tool correlation with its latest sequence.
        #[arg(long)]
        tools_resume_sequence: Option<u64>,
    },
    /// Read branch and tool-correlation progress.
    BranchRead {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        view_id: String,
    },
    /// Request cancellation of branch preparation and tool correlation.
    BranchCancel {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        view_id: String,
    },
    /// Inspect recorded tool correlation, at most ten entries per page.
    Tools {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        view_id: String,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// Check a branch's inert context compilation. Does not create a native session.
    Check {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        view_id: String,
        #[command(flatten)]
        local: HistoryLocalBindings,
    },
    /// Explicitly create an idle KCoder session after current-model compatibility checks.
    Continue {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        view_id: String,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        settings_template: Option<String>,
        #[command(flatten)]
        local: HistoryLocalBindings,
    },
    /// Read the durable continuation receipt, including an unknown publication outcome.
    ContinuationRead {
        #[arg(long)]
        job_id: String,
    },
    /// Explicitly resume a continuation using its latest durable sequence.
    ContinuationResume {
        #[arg(long)]
        job_id: String,
        #[arg(long)]
        expected_sequence: u64,
    },
    /// Request continuation cancellation; a publication may already have committed.
    ContinuationCancel {
        #[arg(long)]
        job_id: String,
    },
    /// Find the immutable external-history origin associated with a native session.
    Source {
        #[arg(long)]
        thread_id: String,
    },
}
