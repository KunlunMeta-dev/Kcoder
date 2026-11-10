//! Complete bytes from the authenticated original Receiver, never response text.
use super::authority_ssh::AcceptedSshRemoteAuthority;
use super::*;
use base64::Engine;
use kcoder_acp::outbound::{OutboundAcp, OwnedNativeFrameTransport};
use kcoder_types::integrations::{core::*, office::*};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

pub fn capture<'a>(
    authority: &'a Arc<AcceptedSshRemoteAuthority>,
    journal: &'a Arc<NativeRemoteJournal>,
    peer: &'a mut OutboundAcp,
    cancel: &'a CancellationToken,
) -> futures::future::BoxFuture<
    'a,
    Result<Option<super::receiver_results::OriginalReceiverOfficeResult>>,
> {
    Box::pin(capture_producer(authority, journal, peer, cancel))
}
async fn capture_producer(
    authority: &Arc<AcceptedSshRemoteAuthority>,
    journal: &Arc<NativeRemoteJournal>,
    peer: &mut OutboundAcp,
    cancel: &CancellationToken,
) -> Result<Option<super::receiver_results::OriginalReceiverOfficeResult>> {
    let receiver = authority.observed_receiver()?;
    let observe = authority.read_request(
        &format!("native-observe-{}", authority.operation()),
        NativeRemoteControlDataV1::ObserveOriginal,
    )?;
    let response = peer.read_owned_native_original(&observe, cancel).await?;
    let NativeRemoteReceiptDataV1::Receiver {
        accepted,
        outcome,
        cleanup_confirmed: _,
    } = authority.read_reply(&observe, response)?
    else {
        anyhow::bail!("REMOTE_RECEIVER_ORIGINAL_TERMINAL_REQUIRED")
    };
    ensure!(
        accepted == receiver && outcome == Some(NativeRemoteCallOutcomeV1::Completed),
        "REMOTE_RECEIVER_ORIGINAL_COMPLETION_REQUIRED"
    );
    journal.store().record_endpoint_receiver(authority.operation(),
        &kcoder_state::integrations::core::remote_delegations::NativeRemoteEndpointReceiverObservation {
            endpoint_instance_id:authority.frames().endpoint_instance_id().into(),accepted:accepted.clone(),outcome,cleanup_confirmed:false })?;
    let request = authority.read_request(
        &format!("native-manifest-{}", authority.operation()),
        NativeRemoteControlDataV1::ReadArtifactManifest(accepted.clone()),
    )?;
    let response = peer.read_owned_native_original(&request, cancel).await?;
    let manifest = match authority.read_reply(&request, response)? {
        NativeRemoteReceiptDataV1::ArtifactManifest { manifest } => *manifest,
        NativeRemoteReceiptDataV1::Diagnostic { code }
            if code == "REMOTE_OFFICE_RESULT_NOT_APPLICABLE" =>
        {
            return Ok(None);
        }
        _ => anyhow::bail!("REMOTE_RECEIVER_OFFICE_RESULT_REQUIRED"),
    };
    authority.bind_result_manifest(&manifest)?;
    journal.store().record_endpoint_manifest(
        authority.operation(),
        authority.frames().endpoint_instance_id(),
        &manifest,
    )?;
    let manifest_sha = super::launch::digest(&manifest)?;
    let reference = OfficeArtifactRef {
        id: manifest.id.clone(),
        revision: manifest.revision,
    };
    let mut bytes = Vec::with_capacity(manifest.bytes.try_into()?);
    while (bytes.len() as u64) < manifest.bytes {
        let offset = bytes.len() as u64;
        let request = authority.read_request(
            &format!("native-chunk-{}-{offset}", authority.operation()),
            NativeRemoteControlDataV1::ReadArtifactChunk(NativeRemoteArtifactChunkReadV1 {
                receiver_accepted: accepted.clone(),
                artifact: reference.clone(),
                manifest_sha256: manifest_sha.clone(),
                offset,
                maximum_bytes: NATIVE_REMOTE_MAX_CHUNK_BYTES,
            }),
        )?;
        let response = peer.read_owned_native_original(&request, cancel).await?;
        let NativeRemoteReceiptDataV1::ArtifactChunk {
            reference: actual,
            manifest_sha256,
            offset: actual_offset,
            total_bytes,
            bytes_base64,
            eof,
        } = authority.read_reply(&request, response)?
        else {
            anyhow::bail!("REMOTE_RECEIVER_OFFICE_CHUNK_REQUIRED")
        };
        ensure!(
            actual == reference
                && manifest_sha256 == manifest_sha
                && actual_offset == offset
                && total_bytes == manifest.bytes,
            "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
        );
        let chunk = base64::engine::general_purpose::STANDARD.decode(bytes_base64)?;
        ensure!(
            !chunk.is_empty()
                && chunk.len() as u64 <= NATIVE_REMOTE_MAX_CHUNK_BYTES
                && chunk.len() as u64 <= manifest.bytes - offset
                && eof == (offset + chunk.len() as u64 == manifest.bytes),
            "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
        );
        bytes.extend_from_slice(&chunk);
    }
    ensure!(
        bytes.len() as u64 == manifest.bytes
            && format!("{:x}", Sha256::digest(&bytes)) == manifest.sha256,
        "REMOTE_RECEIVER_OFFICE_RESULT_CHANGED"
    );
    authority.check_owned_native_observation(journal.context())?;
    Ok(Some(
        super::receiver_results::OriginalReceiverOfficeResult { manifest, bytes },
    ))
}
