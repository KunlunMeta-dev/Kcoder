//! Evidence collection for an already admitted turn.

#[path = "../../app_server/live_file_progress.rs"]
pub mod live_file_progress;
#[path = "../../app_server/native_file_progress.rs"]
mod native_file_progress;
pub use kcoder_cli_storage::private_files;
#[path = "../../app_server/turn_file_capture.rs"]
pub mod turn_file_capture;
#[path = "../../app_server/turn_observation_storage.rs"]
pub mod turn_observation_storage;
#[path = "../../app_server/turn_review_evidence.rs"]
pub mod turn_review_evidence;
#[path = "../../app_server/worktree_artifacts.rs"]
pub mod worktree_artifacts;

pub use kcoder_cli_storage::private_files::error_is_not_found;
