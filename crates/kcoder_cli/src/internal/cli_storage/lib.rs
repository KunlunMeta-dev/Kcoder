//! Local App Server storage and bounded reads, independent of Engine.

use anyhow::Result;
use kcoder_config::PrivateDirectory;
use kcoder_workspace_resources::git;
use kcoder_workspace_resources::managed_worktrees::validate_thread_id;
use kcoder_workspace_resources::snapshots::snapshot_leases;
use std::path::Path;

#[path = "file_capture_validation.rs"]
pub mod file_capture_validation;
#[path = "../../app_server/history_refresh_processor.rs"]
pub mod history_refresh_processor;
#[path = "../../app_server/private_files.rs"]
pub mod private_files;
#[path = "review_validation.rs"]
pub mod review_validation;
#[path = "session_lease.rs"]
pub mod session_lease;
#[path = "../../app_server/storage_diagnostics.rs"]
pub mod storage_diagnostics;
#[path = "../../app_server/storage_scans.rs"]
pub mod storage_scans;
#[path = "../../app_server/thread_list_snapshots.rs"]
pub mod thread_list_snapshots;
#[path = "tracked_history_list.rs"]
pub mod tracked_history_list;
#[path = "../../app_server/transcript_artifact_journal.rs"]
pub mod transcript_artifact_journal;
#[path = "workspace_search.rs"]
pub mod workspace_search;

pub fn ensure_private_artifact_directory(path: &Path) -> Result<()> {
    PrivateDirectory::open_or_create(path)?;
    Ok(())
}
