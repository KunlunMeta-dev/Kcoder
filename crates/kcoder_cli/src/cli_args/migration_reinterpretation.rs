use clap::Parser;

#[derive(Debug, Clone, Parser)]
pub enum HistoryReinterpretAction {
    /// Read the source identity and current parser capability without changing any job.
    Preview {
        #[arg(long)]
        source_job_id: String,
    },
    /// Confirm a new job. Follow with normal history run/read/cancel to operate it.
    Create {
        #[arg(long)]
        source_job_id: String,
        #[arg(long)]
        expected_source_sequence: u64,
        /// Stable UUID; retrying this identity reads the same accepted job.
        #[arg(long)]
        request_id: String,
        #[arg(long, required = true)]
        confirm: bool,
    },
}
