//! Owned terminal sessions, Git execution and bounded workspace filesystem operations.

#[path = "managed_worktrees/mod.rs"]
pub mod managed_worktrees;
#[path = "snapshots/mod.rs"]
pub mod snapshots;

#[path = "../../app_server/device_requests.rs"]
pub mod device_requests;
#[path = "git.rs"]
pub mod git;
#[path = "../../app_server/git_observation.rs"]
mod git_observation;

#[path = "../../app_server/terminal.rs"]
pub mod terminal;
#[path = "terminal_requests.rs"]
pub mod terminal_requests;
#[path = "../../app_server/workspace_fs.rs"]
pub mod workspace_fs;
#[path = "../../app_server/workspace_io.rs"]
pub mod workspace_io;
#[path = "../../app_server/workspace_revision.rs"]
pub mod workspace_revision;
#[path = "../../app_server/workspace_text_revision.rs"]
mod workspace_text_revision;
