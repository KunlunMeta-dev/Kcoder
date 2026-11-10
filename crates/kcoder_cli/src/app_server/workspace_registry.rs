//! Workspace registry: extracted from the app-server connection boundary.

use super::*;

pub(super) fn client_worktree_store(engine: &QueryEngine) -> ClientWorktreeStore {
    ClientWorktreeStore::from_client_storage_root(
        engine.client_storage_root(),
        engine.durable_client_storage_root().is_some(),
    )
}

pub(super) fn client_workspace_store(engine: &QueryEngine) -> ClientWorkspaceStore {
    ClientWorkspaceStore::from_client_storage_root(engine.client_storage_root())
}

pub(super) use kcoder_cli_storage::session_lease::{
    DeferredSessionLeaseWitness, NativeSessionLeaseWitness,
};

#[cfg(test)]
#[path = "workspace_registry/work_record_acceptance_gap_tests.rs"]
mod work_record_acceptance_gap_tests;
