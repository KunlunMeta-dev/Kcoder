//! Managed worktree storage, authorization against workspace roots, and Git lifecycle.

#[path = "comparison.rs"]
mod comparison;
#[path = "operations.rs"]
mod operations;
#[path = "registry.rs"]
mod registry;
#[path = "validation.rs"]
mod validation;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Digest as _;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

pub use comparison::{valid_comparison_text, validate_address, validate_comparison_registry};
pub use operations::{
    app_server_now_ms, authorized_worktree_source, managed_worktree_target_path, worktree_request,
};
pub use registry::{
    ClientManagedWorktree, ClientWorkspaceRecord, ClientWorkspaceState, ClientWorkspaceStore,
    ClientWorktreeConversation, ClientWorktreeState, ClientWorktreeStore, WorkspaceRuntimeLease,
    acquire_app_server_workspace_runtime_lease, safe_absolute_path, valid_git_object_id,
};
use registry::{ClientWorktreeArchivePreview, ClientWorktreeSnapshot};
pub use validation::{
    is_windows_reserved_basename, valid_artifact_id, validate_thread_id, validate_worktree_id,
};

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", sha2::Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod registry_tests;
