//! Verify remote Office source references against the original native journal without replay.
use crate::NativeRemoteJournal;
use anyhow::{Context, Result, ensure};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_state::integrations::core::remote_delegations::NativeRemoteStage;
use kcoder_types::integrations::office::{OfficeCanonicalInputIdentity, OfficeResourceRef};
use sha2::{Digest, Sha256};

/// Exact paired operation/session provenance. This only reads already-published
/// native facts; it never starts a peer or promotes Partial business validation.
pub fn validate_office_source_refs(
    native: &NativeIntegrationContext,
    sources: &[OfficeResourceRef],
) -> Result<Vec<OfficeCanonicalInputIdentity>> {
    let remote = sources
        .iter()
        .filter(|source| matches!(source.kind.as_str(), "remote_operation" | "acp_session"))
        .collect::<Vec<_>>();
    let native_results = sources
        .iter()
        .filter(|source| source.kind == "native_remote_artifact")
        .collect::<Vec<_>>();
    if remote.is_empty() {
        ensure!(
            native_results.is_empty(),
            "REMOTE_OFFICE_SOURCE_PAIR_REQUIRED"
        );
        return Ok(Vec::new());
    }
    ensure!(remote.len() == 2, "REMOTE_OFFICE_SOURCE_PAIR_REQUIRED");
    ensure!(
        native_results.len() <= 1,
        "REMOTE_OFFICE_SOURCE_PAIR_REQUIRED"
    );
    let operation = remote
        .iter()
        .find(|source| source.kind == "remote_operation")
        .context("REMOTE_OFFICE_SOURCE_PAIR_REQUIRED")?;
    let session = remote
        .iter()
        .find(|source| source.kind == "acp_session")
        .context("REMOTE_OFFICE_SOURCE_PAIR_REQUIRED")?;
    operation.validate()?;
    session.validate()?;
    let original = NativeRemoteJournal::read(native, &operation.id)?
        .context("REMOTE_OFFICE_ORIGINAL_OPERATION_REQUIRED")?;
    ensure!(
        original.intent_sha256 == operation.revision,
        "REMOTE_OFFICE_INTENT_CHANGED"
    );
    let recipient = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&original.recipient_identity)?)
    );
    ensure!(
        session.revision == recipient,
        "REMOTE_OFFICE_RECIPIENT_CHANGED"
    );
    ensure!(
        original.stages.get(&NativeRemoteStage::Session) == Some(&kcoder_state::integrations::core::remote_delegations::NativeRemoteStageState::Received)
            && original.stages.get(&NativeRemoteStage::Prompt) == Some(&kcoder_state::integrations::core::remote_delegations::NativeRemoteStageState::Received)
            && original.stages.get(&NativeRemoteStage::OutputTransfer) == Some(&kcoder_state::integrations::core::remote_delegations::NativeRemoteStageState::Received)
            && original.safe_receipts.get(&NativeRemoteStage::Session).and_then(|receipt| receipt["sessionId"].as_str()) == Some(session.id.as_str()),
        "REMOTE_OFFICE_ORIGINAL_OUTPUT_UNCONFIRMED"
    );
    for source in &native_results {
        source.validate()?;
        if let Some(manifest) = &original.endpoint_manifest {
            ensure!(
                source.id == manifest.id && source.revision == crate::digest(manifest)?,
                "REMOTE_ENDPOINT_MANIFEST_CHANGED"
            );
        }
        let receipt = &original
            .safe_receipts
            .get(&NativeRemoteStage::OutputTransfer)
            .context("REMOTE_OFFICE_ORIGINAL_OUTPUT_UNCONFIRMED")?["nativeArtifact"];
        ensure!(
            receipt["id"].as_str() == Some(source.id.as_str())
                && receipt["manifestSha256"].as_str() == Some(source.revision.as_str())
                && receipt["revision"]
                    .as_u64()
                    .is_some_and(|revision| revision > 0),
            "REMOTE_OFFICE_ORIGINAL_OUTPUT_UNCONFIRMED"
        );
    }
    native.verify()?;
    remote
        .into_iter()
        .chain(native_results)
        .map(|source| {
            let value = OfficeCanonicalInputIdentity {
                reference: source.clone(),
                sha256: source.revision.clone(),
            };
            value.validate()?;
            Ok(value)
        })
        .collect()
}
