//! Imported provenance requires a fresh round trip to the original Native source for every access.
use super::{
    delivery::{PeerDeliveryAuthorizationResolver, PeerDeliveryResolutionError},
    router_store::{IncomingPeerOperation, verify_peer_attestation},
    service::PeerMessageService,
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_app_protocol::cross_session_router::{
    PeerRouterCheckOriginalParams, PeerRouterHistoryAccess,
};
use kcoder_engine::peer_message_runtime::PeerMessageCall;
use kcoder_state::{
    AppState, AppStateLifecycleIdentity,
    cross_session_messages::CrossSessionMessageRecord,
    peer_agent_history::{PeerHistoryAccess, PeerMessageAuthorization},
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Only an actual parent/device transport owner implements this boundary.
/// Selectors and signatures remain facts; every call rechecks the real target,
/// weak kernel lease, lifecycle, current wake policy and live transport grant.
#[async_trait]
pub(crate) trait OriginalSourceVerifier: Send + Sync {
    fn target_address(&self) -> &kcoder_types::session_address::SessionAddressV1;
    /// Identity mapping facts only. Device implementations must use their
    /// actual enrollment; physical equality alone never authorizes a principal.
    fn validate_destination_identity(
        &self,
        identity: &kcoder_app_protocol::cross_session_router::PeerRouterIdentityV1,
    ) -> Result<()>;
    async fn verify_original(
        &self,
        call: &PeerMessageCall,
        params: PeerRouterCheckOriginalParams,
    ) -> Result<kcoder_app_protocol::cross_session_router::PeerRouterOperationV1>;
}

pub(crate) struct RoutedPeerDeliveryResolver {
    service: Arc<PeerMessageService>,
    target: Arc<dyn OriginalSourceVerifier>,
    local: Arc<dyn PeerDeliveryAuthorizationResolver>,
}
impl RoutedPeerDeliveryResolver {
    pub(crate) fn new(
        service: Arc<PeerMessageService>,
        target: Arc<dyn OriginalSourceVerifier>,
        local: Arc<dyn PeerDeliveryAuthorizationResolver>,
    ) -> Self {
        Self {
            service,
            target,
            local,
        }
    }
}
fn immutable_record_matches(a: &CrossSessionMessageRecord, b: &CrossSessionMessageRecord) -> bool {
    a.source == b.source
        && a.intent == b.intent
        && a.receipt.message_id == b.receipt.message_id
        && a.created_at_ms == b.created_at_ms
        && a.namespace_id == b.namespace_id
        && a.sequence == b.sequence
}
fn validate_import(
    service: &PeerMessageService,
    record: &CrossSessionMessageRecord,
    verifier: &dyn OriginalSourceVerifier,
) -> Result<IncomingPeerOperation> {
    let incoming = validate_cold_import(service, record, verifier.target_address())?;
    verifier.validate_destination_identity(&incoming.destination_identity)?;
    Ok(incoming)
}

/// Immutable binding checks shared with the actual passive restore owner.
/// These checks never replace its fresh private Source round trip.
pub(crate) fn validate_cold_import(
    service: &PeerMessageService,
    record: &CrossSessionMessageRecord,
    destination: &kcoder_types::session_address::SessionAddressV1,
) -> Result<IncomingPeerOperation> {
    let source = record
        .source
        .address
        .as_ref()
        .context("peer_remote_original_address_required")?;
    let authority = service.authority()?;
    let incoming = authority
        .store()?
        .read_incoming(source, &record.intent.client_message_id)?
        .context("peer_remote_original_provenance_unknown")?;
    verify_peer_attestation(&incoming.attestation, &incoming.source_identity)?;
    let claims = &incoming.attestation.claims;
    let identity = service.identity()?;
    ensure!(
        incoming.destination_identity.target_id == identity.target_id
            && incoming.destination_identity.workspace_id == identity.workspace_id
            && incoming.destination_identity.public_key == identity.public_key
            && incoming.destination_identity.identity_epoch == identity.identity_epoch
            && claims.source_address == *source
            && claims.source_address.thread_id == record.source.thread_id
            && record.intent.target_address.as_ref() == Some(&claims.destination)
            && identity.contains(&claims.destination)
            && claims.destination.thread_id == record.intent.target_thread_id
            && &claims.destination == destination
            && claims.client_message_id == record.intent.client_message_id
            && claims.mode == record.intent.mode
            && claims.expected_turn_id == record.intent.expected_turn_id
            && claims.reply_to_message_id == record.intent.reply_to_message_id
            && claims.body_sha256 == format!("{:x}", Sha256::digest(record.intent.text.as_bytes()))
            && record.source.principal_id
                == format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&(
                        "kcoder.peer-message.source.v1",
                        &incoming.source_identity.target_id,
                        &incoming.source_identity.identity_epoch,
                    ))?)
                ),
        "peer_remote_original_binding_changed"
    );
    Ok(incoming)
}
struct RoutedPeerAuthority {
    service: Arc<PeerMessageService>,
    target: Arc<dyn OriginalSourceVerifier>,
    call: PeerMessageCall,
    original: CrossSessionMessageRecord,
}
#[async_trait]
impl PeerMessageAuthorization for RoutedPeerAuthority {
    async fn check_current(
        &self,
        access: PeerHistoryAccess,
        target: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        self.call.verify_current_owner()?;
        ensure!(
            self.call.state().shares_state_with(target)
                && self.call.owner().same_lifecycle(owner)
                && immutable_record_matches(&self.original, record),
            "peer_remote_target_or_operation_changed"
        );
        // These are immutable provenance reads, not saved permission verdicts.
        // Every check below issues a new private Gateway -> original Native check.
        let incoming = validate_import(&self.service, record, self.target.as_ref())?;
        let access = match access {
            PeerHistoryAccess::Observe => PeerRouterHistoryAccess::Observe,
            PeerHistoryAccess::Append => PeerRouterHistoryAccess::Append,
            PeerHistoryAccess::Wake => PeerRouterHistoryAccess::Wake,
        };
        let params = PeerRouterCheckOriginalParams {
            attestation: incoming.attestation.clone(),
            access,
            message: Some(
                kcoder_app_protocol::cross_session_router::PeerRouterMessageV1 {
                    reply_to_message_id: record.intent.reply_to_message_id.clone(),
                    client_message_id: record.intent.client_message_id.clone(),
                    mode: record.intent.mode,
                    expected_turn_id: record.intent.expected_turn_id.clone(),
                    text: record.intent.text.clone(),
                },
            ),
        };
        let observed = self.target.verify_original(&self.call, params).await?;
        verify_peer_attestation(&observed.attestation, &incoming.source_identity)?;
        let claims = &incoming.attestation.claims;
        ensure!(
            observed.attestation == incoming.attestation
                && observed.operation_id == claims.operation_id
                && observed.source_address == claims.source_address
                && observed.destination == claims.destination
                && observed.body_sha256 == claims.body_sha256
                && observed.stage
                    != kcoder_app_protocol::cross_session_router::PeerRouterStageV1::Prepared,
            "peer_remote_fresh_operation_mismatch"
        );
        self.call.verify_current_owner()?;
        ensure!(
            validate_import(&self.service, record, self.target.as_ref())? == incoming,
            "peer_remote_original_scope_changed"
        );
        Ok(())
    }
}
#[async_trait]
impl PeerDeliveryAuthorizationResolver for RoutedPeerDeliveryResolver {
    async fn resolve(
        &self,
        call: &PeerMessageCall,
        record: &CrossSessionMessageRecord,
    ) -> std::result::Result<Arc<dyn PeerMessageAuthorization>, PeerDeliveryResolutionError> {
        let result = (|| -> Result<bool> {
            call.verify_current_owner()?;
            ensure!(
                self.target.target_address().thread_id == call.state().session_id(),
                "peer_remote_actual_target_changed"
            );
            let source = record
                .source
                .address
                .as_ref()
                .context("peer_remote_original_address_required")?;
            // A shared physical profile is not evidence that this message
            // used its local transport. Imported provenance keeps its actual
            // Gateway/device route, including current revocation checks.
            let authority = self.service.authority()?;
            if authority
                .store()?
                .read_incoming(source, &record.intent.client_message_id)?
                .is_some()
            {
                return Ok(false);
            }
            ensure!(
                self.service.identity()?.contains(source),
                "peer_remote_original_provenance_unknown"
            );
            let local = self.service.verify_local_origin(record)?;
            ensure!(
                local.stage
                    != kcoder_app_protocol::cross_session_router::PeerRouterStageV1::Prepared,
                "peer_local_original_dispatch_unknown"
            );
            Ok(true)
        })();
        match result {
            Ok(true) => self.local.resolve(call, record).await,
            Ok(false) => {
                let authority = Arc::new(RoutedPeerAuthority {
                    service: self.service.clone(),
                    target: self.target.clone(),
                    call: call.clone(),
                    original: record.clone(),
                });
                authority
                    .check_current(
                        PeerHistoryAccess::Observe,
                        call.state(),
                        call.owner(),
                        record,
                    )
                    .await
                    .map_err(|error| PeerDeliveryResolutionError::Unavailable {
                        code: if super::delivery::claimed_validation::is_temporary_read_contention(
                            &error,
                        ) {
                            "peer_provider_start_original_read_busy"
                        } else {
                            "peer_remote_current_source_unavailable"
                        },
                    })?;
                Ok(authority)
            }
            Err(error) => Err(PeerDeliveryResolutionError::Unavailable {
                code: if super::delivery::claimed_validation::is_temporary_read_contention(&error) {
                    "peer_provider_start_original_read_busy"
                } else {
                    "peer_remote_current_target_unavailable"
                },
            }),
        }
    }
}

#[cfg(test)]
#[path = "remote_delivery/tests.rs"]
mod tests;
