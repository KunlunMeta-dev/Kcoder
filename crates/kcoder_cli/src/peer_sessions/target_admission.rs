//! Turn-bound queue admission executes on the actual target owner. IPC carries
//! immutable selectors and data; neither a saved status nor a JSON proof grants it.
use super::*;
use crate::app_server::session_messages::{
    remote_delivery::OriginalSourceVerifier, router_store::verify_peer_attestation,
};
use kcoder_app_protocol::cross_session_router::{
    PeerRouterCheckOriginalParams, PeerRouterHistoryAccess, PeerRouterMessageV1, PeerRouterStageV1,
};
use kcoder_engine::peer_message_runtime::PeerMessageCall;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TargetAdmissionRequest {
    pub source: CrossSessionMessageSource,
    pub intent: AgentMessageIntent,
}
impl TargetAdmissionRequest {
    pub(super) fn validate(&self) -> Result<()> {
        self.source.validate().map_err(anyhow::Error::msg)?;
        self.intent.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            self.source.address.is_some()
                && self.intent.target_address.is_some()
                && self.intent.expected_turn_id.is_some()
                && self.intent.mode == AgentMessageMode::EnqueueOnly,
            "peer_target_turn_admission_required"
        );
        Ok(())
    }
}

impl BoundPeerSource {
    pub(crate) fn set_target_verifier(
        &self,
        verifier: Arc<dyn OriginalSourceVerifier>,
    ) -> Result<()> {
        self.check_owner()?;
        ensure!(
            verifier.target_address() == &self.address()?,
            "peer_target_verifier_changed"
        );
        *self
            .target_verifier
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_target_verifier_busy"))? =
            Some(Arc::downgrade(&verifier));
        Ok(())
    }
    async fn verify_admission_source(
        self: &Arc<Self>,
        request: &TargetAdmissionRequest,
        admission: Option<&kcoder_engine::owned_turn::OwnedTurnAdmission>,
    ) -> Result<()> {
        self.check_owner()?;
        let source_address = request
            .source
            .address
            .as_ref()
            .context("peer_target_source_address_required")?;
        let service = self.service().clone();
        let incoming = service
            .authority()?
            .store()?
            .read_incoming(source_address, &request.intent.client_message_id)?;
        if let Some(incoming) = incoming {
            let verifier = self
                .target_verifier
                .lock()
                .map_err(|_| anyhow::anyhow!("peer_target_verifier_busy"))?
                .as_ref()
                .and_then(std::sync::Weak::upgrade)
                .context("peer_target_authenticated_route_required")?;
            verifier.validate_destination_identity(&incoming.destination_identity)?;
            verify_peer_attestation(&incoming.attestation, &incoming.source_identity)?;
            let claims = &incoming.attestation.claims;
            ensure!(
                claims.source_address == *source_address
                    && claims.destination == *request.intent.target_address.as_ref().unwrap()
                    && claims.client_message_id == request.intent.client_message_id
                    && claims.mode == request.intent.mode
                    && claims.expected_turn_id == request.intent.expected_turn_id
                    && claims.reply_to_message_id == request.intent.reply_to_message_id
                    && claims.body_sha256
                        == format!("{:x}", Sha256::digest(request.intent.text.as_bytes()))
                    && request.source.principal_id
                        == format!(
                            "{:x}",
                            Sha256::digest(serde_json::to_vec(&(
                                "kcoder.peer-message.source.v1",
                                &incoming.source_identity.target_id,
                                &incoming.source_identity.identity_epoch,
                            ))?)
                        ),
                "peer_target_original_binding_changed"
            );
            let call = if let Some(admission) = admission {
                PeerMessageCall::from_owned_turn(admission).map_err(anyhow::Error::msg)?
            } else {
                PeerMessageCall::observe_owner(self.state.clone(), self.owner.clone())
                    .map_err(anyhow::Error::msg)?
            };
            let operation = verifier
                .verify_original(
                    &call,
                    PeerRouterCheckOriginalParams {
                        attestation: incoming.attestation.clone(),
                        access: if admission.is_some() {
                            PeerRouterHistoryAccess::Append
                        } else {
                            PeerRouterHistoryAccess::Observe
                        },
                        message: Some(PeerRouterMessageV1 {
                            reply_to_message_id: request.intent.reply_to_message_id.clone(),
                            client_message_id: request.intent.client_message_id.clone(),
                            mode: request.intent.mode,
                            expected_turn_id: request.intent.expected_turn_id.clone(),
                            text: request.intent.text.clone(),
                        }),
                    },
                )
                .await?;
            ensure!(
                operation.attestation == incoming.attestation
                    && operation.stage != PeerRouterStageV1::Prepared,
                "peer_target_original_source_changed"
            );
            verifier.validate_destination_identity(&incoming.destination_identity)?;
            ensure!(
                service
                    .authority()?
                    .store()?
                    .read_incoming(source_address, &request.intent.client_message_id)?
                    .as_ref()
                    == Some(&incoming),
                "peer_target_original_route_changed"
            );
        } else {
            ensure!(
                service.message_source(&source_address.thread_id)? == request.source
                    && service.identity()?.contains(source_address),
                "peer_target_local_source_changed"
            );
            let address = source_address.clone();
            let check = OriginalSourceCheck::for_intent(&request.intent)?;
            let operation = tokio::task::spawn_blocking(move || {
                check_original_source(&service, &address, &check)
            })
            .await
            .context("peer_target_source_worker_unavailable")??;
            ensure!(
                operation.stage != PeerRouterStageV1::Prepared,
                "peer_target_source_dispatch_unknown"
            );
        }
        self.check_owner()?;
        Ok(())
    }
    pub(super) async fn admit_target(
        self: Arc<Self>,
        request: TargetAdmissionRequest,
    ) -> Result<AgentMessageReceipt> {
        request.validate()?;
        self.check_owner()?;
        ensure!(
            request.intent.target_address.as_ref() == Some(&self.address()?),
            "peer_target_destination_changed"
        );
        self.verify_admission_source(&request, None).await?;
        let existing = self
            .service()
            .mailbox()?
            .get_by_client_id(&request.source, &request.intent.client_message_id)?;
        if let Some(receipt) = existing {
            return Ok(receipt);
        }
        let expected = request.intent.expected_turn_id.as_deref().unwrap();
        let admission = match self.turns.try_admit_expected(expected) {
            Ok(admission) => Some(admission),
            Err("target_turn_changed" | "target_turn_closing" | "target_turn_owner_changed") => {
                None
            }
            Err(code) => anyhow::bail!(code),
        };
        self.verify_admission_source(&request, admission.as_ref())
            .await?;
        let target = self.clone();
        tokio::task::spawn_blocking(move || {
            target.check_owner()?;
            let settings = target.service().admission_settings()?;
            let queue = target.service().mailbox()?;
            queue.enqueue_with_admission(
                &request.source,
                request.intent,
                queue.revision()?,
                settings.message_ttl_seconds,
                || {
                    target.check_owner()?;
                    target.service().require_enabled(false)?;
                    if let Some(admission) = &admission {
                        admission.verify_current().map_err(anyhow::Error::msg)?;
                        ensure!(
                            admission.identity().thread_id == target.state.session_id(),
                            "peer_target_turn_owner_changed"
                        );
                        Ok(None)
                    } else {
                        Ok(Some("target_turn_changed"))
                    }
                },
            )
        })
        .await
        .context("peer_target_commit_worker_unavailable")?
    }
}
