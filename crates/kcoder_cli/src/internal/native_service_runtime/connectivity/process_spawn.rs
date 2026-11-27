//! Supervised child launch under the original scope fence.
use super::NativeConnectivityExitProof;
use anyhow::Result;
use kcoder_host_transport::process::{NativeConnectivityHostPaths, OwnedTree};
use std::{path::Path, sync::Arc};
use tokio::process::Child;

pub fn spawn_owned<'a>(
    paths: &'a NativeConnectivityHostPaths,
    data: &'a Path,
    scope_host: Option<&'a Arc<crate::scope_host::NativeScopeHostBootstrap>>,
) -> futures::future::BoxFuture<'a, Result<(Child, OwnedTree, NativeConnectivityExitProof)>> {
    Box::pin(spawn_owned_inner(paths, data, scope_host))
}

async fn spawn_owned_inner(
    paths: &NativeConnectivityHostPaths,
    data: &Path,
    scope_host: Option<&Arc<crate::scope_host::NativeScopeHostBootstrap>>,
) -> Result<(Child, OwnedTree, NativeConnectivityExitProof)> {
    let (child, tree) = kcoder_host_transport::process::spawn_owned(paths, data, &|command| {
        if let Some(scope_host) = scope_host {
            scope_host.inherit_scope_fence(command)?;
        }
        Ok(())
    })
    .await?;
    #[cfg(any(target_os = "linux", windows))]
    {
        let proof = match &tree {
            #[cfg(target_os = "linux")]
            OwnedTree::Linux(owner) => {
                NativeConnectivityExitProof::SupervisedStdio(owner.exit_handle())
            }
            #[cfg(windows)]
            OwnedTree::Windows(job) => NativeConnectivityExitProof::PrivateJob(job.exit_handle()),
        };
        Ok((child, tree, proof))
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    match tree {}
}
