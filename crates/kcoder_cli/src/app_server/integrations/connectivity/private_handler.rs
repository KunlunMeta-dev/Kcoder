//! Handler contribution for an already authenticated owned target-parent pipe.
use super::{
    NativeConnectivityLeaseFacade, NativeConnectivityParent, NativeConnectivityReadyInput,
};
use anyhow::{Context, Result, ensure};
use kcoder_native_scope::NativeIntegrationContext;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcquireInput {
    path: PathBuf,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    store_mode: Option<String>,
    #[serde(default)]
    initialization_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseInput {
    lease_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyInput {
    path: PathBuf,
}

pub struct NativeConnectivityPrivateContribution<'a> {
    pub context: &'a NativeIntegrationContext,
    pub facade: &'a NativeConnectivityLeaseFacade,
    pub parent: Option<Arc<NativeConnectivityParent>>,
}
impl NativeConnectivityPrivateContribution<'_> {
    /// None means this contribution does not own that method, never permissive routing.
    pub fn handle(&self, method: &str, payload: Value) -> Result<Option<Value>> {
        if ![
            "private.store.acquireLease",
            "private.store.renewLease",
            "private.store.commitReady",
            "private.store.verify",
            "private.store.prepareSidecars",
            "private.store.releaseLease",
        ]
        .contains(&method)
        {
            return Ok(None);
        }
        let parent = self
            .parent
            .as_ref()
            .context("CONNECTIVITY_PRIVATE_PARENT_REQUIRED")?;
        let result = match method {
            "private.store.acquireLease" => {
                let input: AcquireInput = serde_json::from_value(payload)?;
                ensure!(
                    input.path == self.facade.private_data_path(self.context)?,
                    "CONNECTIVITY_PRIVATE_PATH_DENIED"
                );
                // PID and caller mode are diagnostic hints; only the actual native
                // owned process and durable bootstrap receipt choose authority/mode.
                let _ = input.pid;
                let reply = self.facade.acquire(self.context, Some(parent.clone()))?;
                if let Some(mode) = input.store_mode {
                    ensure!(
                        mode == reply.store_mode,
                        "CONNECTIVITY_BOOTSTRAP_MODE_MISMATCH"
                    );
                }
                if let Some(operation) = input.initialization_id {
                    ensure!(
                        operation == reply.initialization_id,
                        "CONNECTIVITY_INITIALIZATION_MISMATCH"
                    );
                }
                serde_json::to_value(reply)?
            }
            "private.store.renewLease" => {
                let input: LeaseInput = serde_json::from_value(payload)?;
                serde_json::to_value(self.facade.renew(
                    self.context,
                    Some(parent),
                    &input.lease_id,
                )?)?
            }
            "private.store.commitReady" => {
                let input: NativeConnectivityReadyInput = serde_json::from_value(payload)?;
                serde_json::to_value(self.facade.commit_ready(
                    self.context,
                    Some(parent),
                    &input,
                )?)?
            }
            "private.store.prepareSidecars" => {
                #[cfg(windows)]
                {
                    let input: LeaseInput = serde_json::from_value(payload)?;
                    self.facade.prepare_original_windows_sidecars(
                        self.context,
                        Some(parent),
                        &input.lease_id,
                    )?;
                    json!({"prepared":true})
                }
                #[cfg(not(windows))]
                anyhow::bail!("CONNECTIVITY_WINDOWS_BOOTSTRAP_REQUIRED")
            }
            "private.store.verify" => {
                let input: VerifyInput = serde_json::from_value(payload)?;
                let lease = self.facade.lease_for_parent(self.context, parent)?;
                self.facade.verify_private_path(
                    self.context,
                    Some(parent),
                    &lease.lease_id,
                    &input.path,
                )?;
                json!({"verified":true})
            }
            "private.store.releaseLease" => {
                let input: LeaseInput = serde_json::from_value(payload)?;
                let released = self
                    .facade
                    .release(self.context, Some(parent), &input.lease_id)?;
                json!({"releaseRequested":true,"released":released})
            }
            _ => return Ok(None),
        };
        Ok(Some(result))
    }
}
