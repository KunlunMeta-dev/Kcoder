//! Monotonic original owned-process cleanup facts. These never grant execution or task completion.
use super::*;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteOwnerCleanupObservation {
    pub owned_pid: u32,
    pub confirmed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteEndpointCleanupObservation {
    pub endpoint_instance_id: String,
    pub confirmed: bool,
}
impl NativeRemoteDelegationStore {
    /// The caller must hold its sealed original frame-owner cleanup receipt.
    /// Cross-host endpoints are never converted into local process identifiers.
    pub fn record_endpoint_cleanup(
        &self,
        operation: &str,
        endpoint: &str,
        confirmed: bool,
    ) -> Result<()> {
        label(endpoint)?;
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(operation)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            ensure!(
                record.owner_cleanup.is_none()
                    && record
                        .stages
                        .get(&NativeRemoteStage::Spawn)
                        .and_then(|stage| stage.safe_receipt.as_ref())
                        .is_some_and(|receipt| receipt["ownedEndpointInstanceId"] == endpoint
                            && receipt.get("ownedPid").is_none()),
                "REMOTE_ORIGINAL_ENDPOINT_CHANGED"
            );
            if let Some(old) = &record.endpoint_cleanup {
                ensure!(
                    old.endpoint_instance_id == endpoint && (!old.confirmed || confirmed),
                    "REMOTE_ORIGINAL_CLEANUP_CHANGED"
                );
                if old.confirmed == confirmed {
                    return Ok(());
                }
            }
            record.endpoint_cleanup = Some(NativeRemoteEndpointCleanupObservation {
                endpoint_instance_id: endpoint.into(),
                confirmed,
            });
            record.revision = next(record.revision)?;
            ledger.revision = next(ledger.revision)?;
            Ok(())
        })
    }
    /// The native caller must supply the actual sealed original-connection
    /// cleanup receipt; a PID or JSON marker is never authority to stop work.
    pub fn record_owner_cleanup(
        &self,
        operation: &str,
        owned_pid: u32,
        confirmed: bool,
    ) -> Result<()> {
        ensure!(owned_pid > 0, "REMOTE_ORIGINAL_OWNER_REQUIRED");
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(operation)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            ensure!(
                record
                    .stages
                    .get(&NativeRemoteStage::Spawn)
                    .and_then(|stage| stage.safe_receipt.as_ref())
                    .and_then(|receipt| receipt["ownedPid"].as_u64())
                    == Some(u64::from(owned_pid)),
                "REMOTE_ORIGINAL_OWNER_CHANGED"
            );
            if let Some(previous) = &record.owner_cleanup {
                ensure!(
                    previous.owned_pid == owned_pid && (!previous.confirmed || confirmed),
                    "REMOTE_ORIGINAL_CLEANUP_CHANGED"
                );
                if previous.confirmed == confirmed {
                    return Ok(());
                }
            }
            record.owner_cleanup = Some(NativeRemoteOwnerCleanupObservation {
                owned_pid,
                confirmed,
            });
            record.revision = next(record.revision)?;
            ledger.revision = next(ledger.revision)?;
            Ok(())
        })
    }
}
