//! Authenticated endpoint observations are not local TurnAttemptStore capabilities.
use super::*;
use kcoder_types::integrations::{
    core::{NativeRemoteAcceptedFactsV1, NativeRemoteCallOutcomeV1},
    office::OfficeArtifactManifest,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteEndpointReceiverObservation {
    pub endpoint_instance_id: String,
    pub accepted: NativeRemoteAcceptedFactsV1,
    pub outcome: Option<NativeRemoteCallOutcomeV1>,
    pub cleanup_confirmed: bool,
}
fn validate(record: &Record, receiver: &NativeRemoteEndpointReceiverObservation) -> Result<()> {
    label(&receiver.endpoint_instance_id)?;
    for id in [
        &receiver.accepted.identity.thread_id,
        &receiver.accepted.identity.turn_id,
        &receiver.accepted.identity.attempt_id,
    ] {
        label(id)?;
    }
    for sha in [
        &receiver.accepted.accepted_input_sha256,
        &receiver.accepted.accepted_receipt_sha256,
        &receiver.accepted.receiver_settings_sha256,
    ] {
        ensure!(
            sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "REMOTE_ENDPOINT_RECEIVER_HASH_INVALID"
        );
    }
    receiver
        .accepted
        .receiver_scope
        .as_ref()
        .context("REMOTE_ENDPOINT_RECEIVER_SCOPE_REQUIRED")?
        .validate()?;
    ensure!(
        record.stages.contains_key(&NativeRemoteStage::Prompt)
            && record
                .stages
                .get(&NativeRemoteStage::Spawn)
                .and_then(|stage| stage.safe_receipt.as_ref())
                .is_some_and(|receipt| receipt["ownedEndpointInstanceId"]
                    == receiver.endpoint_instance_id
                    && receipt.get("ownedPid").is_none())
            && record
                .stages
                .get(&NativeRemoteStage::BindOriginal)
                .and_then(|stage| stage.safe_receipt.as_ref())
                .is_some_and(|receipt| receipt["data"]["receiverSettingsSha256"]
                    == receiver.accepted.receiver_settings_sha256),
        "REMOTE_ENDPOINT_RECEIVER_BINDING_CHANGED"
    );
    // Owner cleanup is independent of task outcome. The captured Native host
    // verifies its actual owner receipt before recording this fact; cleanup
    // neither completes the receiver task nor settles unknown model charges.
    Ok(())
}
pub(super) fn validate_record(record: &Record) -> Result<()> {
    if let Some(receiver) = &record.endpoint_receiver {
        validate(record, receiver)?;
    }
    if let Some(manifest) = &record.endpoint_manifest {
        let receiver = record
            .endpoint_receiver
            .as_ref()
            .context("REMOTE_ENDPOINT_RECEIVER_REQUIRED")?;
        validate_manifest(receiver, manifest)?;
    }
    Ok(())
}
fn validate_manifest(
    receiver: &NativeRemoteEndpointReceiverObservation,
    manifest: &OfficeArtifactManifest,
) -> Result<()> {
    manifest.validate()?;
    let scope = receiver
        .accepted
        .receiver_scope
        .as_ref()
        .context("REMOTE_ENDPOINT_RECEIVER_SCOPE_REQUIRED")?;
    ensure!(
        receiver.outcome == Some(NativeRemoteCallOutcomeV1::Completed)
            && manifest.owner == IntegrationOwner::from(scope)
            && manifest.task.thread_id == receiver.accepted.identity.thread_id
            && manifest.task.turn_id == receiver.accepted.identity.turn_id
            && manifest.task.run_id.is_none(),
        "REMOTE_ENDPOINT_MANIFEST_OWNER_CHANGED"
    );
    Ok(())
}
impl NativeRemoteDelegationStore {
    /// Only the original Native caller, holding its authenticated endpoint,
    /// records these wire observations. They authorize no receiver actions.
    pub fn record_endpoint_receiver(
        &self,
        operation: &str,
        observed: &NativeRemoteEndpointReceiverObservation,
    ) -> Result<()> {
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(operation)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            validate(record, observed)?;
            if let Some(old) = &record.endpoint_receiver {
                ensure!(
                    old.endpoint_instance_id == observed.endpoint_instance_id
                        && old.accepted == observed.accepted
                        && (!old.cleanup_confirmed || observed.cleanup_confirmed)
                        && old.outcome.is_none_or(|outcome| outcome
                            == NativeRemoteCallOutcomeV1::OutcomeUnknown
                            || observed.outcome == Some(outcome)),
                    "REMOTE_ENDPOINT_RECEIVER_CHANGED"
                );
                if old == observed {
                    return Ok(());
                }
            }
            record.endpoint_receiver = Some(observed.clone());
            record.revision = next(record.revision)?;
            ledger.revision = next(ledger.revision)?;
            Ok(())
        })
    }
    pub fn record_endpoint_manifest(
        &self,
        operation: &str,
        endpoint: &str,
        manifest: &OfficeArtifactManifest,
    ) -> Result<()> {
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(operation)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            let receiver = record
                .endpoint_receiver
                .as_ref()
                .context("REMOTE_ENDPOINT_RECEIVER_REQUIRED")?;
            ensure!(
                receiver.endpoint_instance_id == endpoint,
                "REMOTE_ORIGINAL_ENDPOINT_CHANGED"
            );
            validate_manifest(receiver, manifest)?;
            if let Some(old) = &record.endpoint_manifest {
                ensure!(old == manifest, "REMOTE_ENDPOINT_MANIFEST_CHANGED");
                return Ok(());
            }
            record.endpoint_manifest = Some(manifest.clone());
            record.revision = next(record.revision)?;
            ledger.revision = next(ledger.revision)?;
            Ok(())
        })
    }
}
