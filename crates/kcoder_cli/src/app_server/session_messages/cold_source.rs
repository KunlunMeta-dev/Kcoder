//! A native management owner rechecks an original cold source without running it.
use super::{
    router_rpc::ColdPeerSourceVerifier, router_store::verify_peer_attestation,
    service::PeerMessageService,
};
use crate::app_server::{
    engine_factory::AppServerEngineFactory,
    session_discovery::session_directory::{DirectorySourceView, SessionDirectory},
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::cross_session_router::{
    PeerRouterHistoryAccess, PeerRouterMessageV1, PeerRouterOperationV1, PeerRouterStageV1,
};
use kcoder_cli_storage::session_lease::SessionLease;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::PathBuf, sync::Arc};
mod local_owner;
pub(crate) use local_owner::LocalNativeColdPeerSourceVerifier;

pub(crate) struct NativeColdPeerSourceVerifier {
    service: Arc<PeerMessageService>,
    factory: AppServerEngineFactory,
    workspace: PathBuf,
    storage: PathBuf,
    history: Option<PathBuf>,
}
impl NativeColdPeerSourceVerifier {
    pub(crate) fn capture(
        service: Arc<PeerMessageService>,
        factory: AppServerEngineFactory,
        workspace: PathBuf,
        storage: PathBuf,
        history: Option<PathBuf>,
    ) -> Result<Self> {
        ensure!(
            service.can_prepare_private_services() && service.workspace_matches(&workspace),
            "peer_cold_source_native_owner_required"
        );
        Ok(Self {
            service,
            factory,
            workspace,
            storage,
            history,
        })
    }

    fn check_original_current(
        &self,
        operation: &PeerRouterOperationV1,
        message: &PeerRouterMessageV1,
    ) -> Result<()> {
        let claims = &operation.attestation.claims;
        let identity = self.service.identity()?;
        ensure!(
            identity.contains(&operation.source_address)
                && operation.stage != PeerRouterStageV1::Prepared,
            "peer_cold_source_original_dispatch_required"
        );
        verify_peer_attestation(&operation.attestation, &identity)?;
        let intent = message.clone().into_intent(operation.destination.clone());
        intent.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            intent.client_message_id == claims.client_message_id
                && intent.mode == claims.mode
                && intent.expected_turn_id == claims.expected_turn_id
                && intent.reply_to_message_id == claims.reply_to_message_id
                && format!("{:x}", Sha256::digest(intent.text.as_bytes())) == claims.body_sha256,
            "peer_cold_source_frozen_intent_changed"
        );
        self.service.require_enabled(false)?;
        let authority = self.service.authority()?;
        let store = authority.store()?;
        let original = store
            .read_operation(&operation.operation_id)?
            .context("peer_cold_source_original_operation_missing")?;
        ensure!(
            original.attestation == operation.attestation
                && original.stage != PeerRouterStageV1::Prepared,
            "peer_cold_source_original_operation_changed"
        );
        let reference = store
            .read_source_history(&operation.operation_id)?
            .context("peer_cold_source_original_history_unobserved")?;
        ensure!(
            reference.thread_id() == operation.source_address.thread_id,
            "peer_cold_source_original_history_changed"
        );
        // This closure is a current Native authority check, not a saved allow.
        let verify = || self.service.require_enabled(false);
        let binding = format!("peer-cold-source-{}", operation.operation_id);
        let view = DirectorySourceView::from_host(
            &self.workspace,
            &self.storage,
            self.history.as_deref(),
            &binding,
            &verify,
        )?;
        let bound = SessionDirectory::default()
            .lookup_bound_view(&view, &operation.source_address.thread_id, &HashSet::new())?
            .context("peer_cold_source_history_unavailable")?;
        ensure!(
            bound.observation().archived_at.is_none(),
            "peer_cold_source_archived"
        );
        let path = bound.history_path();
        ensure!(
            path == reference.history_path(),
            "peer_cold_source_history_path_changed"
        );
        // Only a truly stopped owner can use this path. An active or denied
        // source retains its original kernel lease and cannot be bypassed.
        let original_lease = reference
            .native_session_lease_identity()
            .context("peer_cold_source_native_lease_unobserved")?;
        let lease = SessionLease::acquire_observed_history(&path, original_lease)?;
        let witness = lease.native_witness()?;
        witness.verify_target(&path)?;
        kcoder_state::verify_peer_source_history_reference(&path, &reference)?;
        let metadata = bound.metadata(&view)?;
        let client = bound.client_metadata(&view)?;
        let creation_mode = client
            .as_ref()
            .and_then(|metadata| metadata.fields.get("permissionModeAtCreation"))
            .map(|value| {
                value
                    .as_ref()
                    .context("peer_cold_source_permission_baseline_unavailable")
                    .and_then(|value| {
                        serde_json::from_value::<kcoder_config::PermissionMode>(
                            serde_json::Value::String(value.clone()),
                        )
                        .map_err(Into::into)
                    })
            })
            .transpose()?;
        let template = client
            .as_ref()
            .and_then(|metadata| metadata.fields.get("settingsTemplate"))
            .and_then(Option::as_ref)
            .map(|value| {
                serde_json::from_str::<kcoder_types::settings_templates::SettingsTemplateBinding>(
                    value,
                )
            })
            .transpose()?;
        // The real factory assembles the same current configuration precedence
        // as resume, without creating an Engine, writer, Hook or model request.
        self.factory
            .current_peer_source_permissions(&metadata, template.as_ref(), creation_mode)?
            .check_send(&intent)?;
        witness.verify_target(&path)?;
        kcoder_state::verify_peer_source_history_reference(&path, &reference)?;
        bound.verify(&view)?;
        ensure!(
            bound
                .client_metadata(&view)?
                .as_ref()
                .and_then(|metadata| metadata.fields.get("archivedAt"))
                .and_then(Option::as_ref)
                .is_none(),
            "peer_cold_source_archived"
        );
        self.service.require_enabled(false)?;
        ensure!(
            store
                .read_operation(&operation.operation_id)?
                .is_some_and(|current| current.attestation == operation.attestation
                    && current.stage != PeerRouterStageV1::Prepared),
            "peer_cold_source_original_operation_changed"
        );
        Ok(())
    }
}
impl ColdPeerSourceVerifier for NativeColdPeerSourceVerifier {
    fn check_current(
        &self,
        operation: &PeerRouterOperationV1,
        message: &PeerRouterMessageV1,
        _access: PeerRouterHistoryAccess,
    ) -> Result<()> {
        ensure!(
            self.service.has_private_parent(),
            "peer_cold_source_native_owner_required"
        );
        self.check_original_current(operation, message)
    }
}

#[cfg(test)]
#[path = "cold_source/tests.rs"]
mod tests;
