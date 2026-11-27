//! Conditional admission requests go to the actual destination carrier. The
//! source never translates a status observation into a shared-queue write.
use super::super::target_admission::TargetAdmissionRequest;
use super::*;

pub(crate) fn admit_peer_target(
    service: &PeerMessageService,
    source: CrossSessionMessageSource,
    intent: AgentMessageIntent,
) -> Result<AgentMessageReceipt> {
    let request = TargetAdmissionRequest { source, intent };
    request.validate()?;
    service.require_enabled(false)?;
    let destination = request.intent.target_address.as_ref().unwrap();
    ensure!(
        service.identity()?.contains(destination),
        "peer_target_remote_route_required"
    );
    #[cfg(any(target_os = "linux", windows))]
    {
        #[cfg(target_os = "linux")]
        let response = linux::exchange(destination, None, Some(&request))?;
        #[cfg(windows)]
        let response = windows::exchange(destination, None, Some(&request))?;
        ensure!(
            response.operation.is_none()
                && response.status.is_none()
                && response.capabilities.is_none(),
            "peer_target_response_invalid"
        );
        let receipt = response
            .receipt
            .context("peer_target_admission_unavailable")?;
        ensure!(
            receipt.client_message_id == request.intent.client_message_id
                && receipt.target_thread_id == request.intent.target_thread_id
                && receipt.source_address == request.source.address
                && receipt.target_address == request.intent.target_address
                && receipt.reply_to_message_id == request.intent.reply_to_message_id,
            "peer_target_admission_receipt_changed"
        );
        service.require_enabled(false)?;
        Ok(receipt)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        anyhow::bail!("peer_target_native_carrier_unavailable")
    }
}
