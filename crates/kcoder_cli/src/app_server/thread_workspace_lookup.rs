//! Connection-owned blocking metadata reads. No model, restore or workspace write runs here.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::thread_workspace_lookup::{
    ThreadWorkspaceLookupParams, ThreadWorkspaceLookupResult,
};
use kcoder_thread_metadata::workspace_lookup::ProfileWorkspaceLookup;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct WorkspaceLookupHost {
    profile: Option<PathBuf>,
    processor: Arc<Mutex<Option<ProfileWorkspaceLookup>>>,
    jobs: JoinSet<()>,
    cancel: CancellationToken,
}
struct CancelRead(CancellationToken);
impl std::fmt::Debug for WorkspaceLookupHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceLookupHost")
            .finish_non_exhaustive()
    }
}
impl Drop for CancelRead {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
impl WorkspaceLookupHost {
    pub(super) async fn lookup(
        &mut self,
        profile: &Path,
        params: ThreadWorkspaceLookupParams,
    ) -> Result<ThreadWorkspaceLookupResult> {
        ensure!(
            !self.cancel.is_cancelled(),
            "THREAD_WORKSPACE_LOOKUP_CLOSED"
        );
        if let Some(original) = &self.profile {
            ensure!(
                original == profile,
                "THREAD_WORKSPACE_LOOKUP_PROFILE_CHANGED"
            );
        } else {
            self.profile = Some(profile.to_owned());
        }
        while self.jobs.try_join_next().is_some() {}
        ensure!(self.jobs.len() < 2, "THREAD_WORKSPACE_LOOKUP_BUSY");
        let profile = profile.to_owned();
        let processor = self.processor.clone();
        let cancellation = self.cancel.child_token();
        let _request = CancelRead(cancellation.clone());
        let (send, receive) = tokio::sync::oneshot::channel();
        self.jobs.spawn_blocking(move || {
            let result = (|| {
                ensure!(
                    !cancellation.is_cancelled(),
                    "THREAD_WORKSPACE_LOOKUP_CANCELLED"
                );
                let mut processor = processor
                    .lock()
                    .map_err(|_| anyhow::anyhow!("THREAD_WORKSPACE_LOOKUP_STATE_UNAVAILABLE"))?;
                if processor.is_none() {
                    *processor = Some(
                        ProfileWorkspaceLookup::capture(&profile)
                            .context("THREAD_WORKSPACE_LOOKUP_PROFILE_CAPTURE")?,
                    );
                }
                processor
                    .as_mut()
                    .unwrap()
                    .lookup(params, &cancellation)
                    .context("THREAD_WORKSPACE_LOOKUP_STORAGE_READ")
            })();
            let _ = send.send(result);
        });
        receive
            .await
            .context("THREAD_WORKSPACE_LOOKUP_WORKER_UNAVAILABLE")?
    }
    pub(super) async fn shutdown(&mut self) {
        self.cancel.cancel();
        // A started blocking reader cannot be aborted. The original host drains
        // its bounded work before releasing this connection's profile handles.
        while self.jobs.join_next().await.is_some() {}
        if let Ok(mut processor) = self.processor.lock() {
            *processor = None;
        }
    }
}
impl Drop for WorkspaceLookupHost {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.jobs.abort_all();
    }
}

pub(super) async fn dispatch(
    id: serde_json::Value,
    params: serde_json::Value,
    factory: &super::AppServerEngineFactory,
    outbound: &tokio::sync::mpsc::Sender<serde_json::Value>,
    state: &mut super::ConnectionState,
) -> Result<()> {
    let result = async {
        let params: ThreadWorkspaceLookupParams = serde_json::from_value(params)
            .map_err(|_| anyhow::anyhow!("THREAD_WORKSPACE_LOOKUP_PARAMS_INVALID"))?;
        // This is the startup loader's original profile, not a settings writer,
        // explicit read-only overlay, tool child source or request-provided path.
        ensure!(
            factory.peer_message_history_directory().is_some(),
            "THREAD_WORKSPACE_LOOKUP_HISTORY_UNAVAILABLE"
        );
        let paths = factory
            .profile_paths()
            .context("THREAD_WORKSPACE_LOOKUP_FACTORY_PATHS")?;
        let profile = kcoder_thread_metadata::workspace_lookup::original_profile_root(&paths)?;
        state.workspace_lookup.lookup(profile, params).await
    }
    .await;
    match result {
        Ok(value) => {
            let result = serde_json::to_value(value)?;
            ensure!(
                serde_json::to_vec(&result)?.len() <= 512 * 1024,
                "THREAD_WORKSPACE_LOOKUP_OUTPUT_LIMIT"
            );
            super::send(outbound, super::success_response(id, result)).await?;
        }
        Err(error) => {
            let code = if error.to_string() == "THREAD_WORKSPACE_LOOKUP_PARAMS_INVALID" {
                -32602
            } else {
                -32057
            };
            // Only a fixed diagnostic class crosses this boundary, never paths or OS text.
            let reason = match error.to_string().as_str() {
                "THREAD_WORKSPACE_LOOKUP_FACTORY_PATHS" => "factory_paths",
                "THREAD_WORKSPACE_LOOKUP_PROFILE_CAPTURE" => "profile_capture",
                "THREAD_WORKSPACE_LOOKUP_STORAGE_READ" => "storage_read",
                "THREAD_WORKSPACE_LOOKUP_HISTORY_UNAVAILABLE" => "history_unavailable",
                "THREAD_WORKSPACE_LOOKUP_PROFILE_UNAVAILABLE" => "profile_unavailable",
                "THREAD_WORKSPACE_LOOKUP_PROFILE_CHANGED" => "profile_changed",
                "THREAD_WORKSPACE_LOOKUP_CURSOR_STALE" => "cursor_stale",
                "THREAD_WORKSPACE_LOOKUP_PARAMS_INVALID" => "params_invalid",
                _ => "metadata_unavailable",
            };
            tracing::debug!(code = reason, "Native workspace lookup refused");
            super::send(
                outbound,
                super::error_response(id, code, "THREAD_WORKSPACE_LOOKUP_UNAVAILABLE"),
            )
            .await?;
        }
    }
    Ok(())
}
