//! Same-workspace admission retains original request identity before observing a new target.
use super::*;
use crate::app_server::{
    ThreadManager,
    session_discovery::session_directory::{
        AdmissionMetadata, BoundPeerSession, DirectorySourceView, SessionDirectory,
    },
};
use kcoder_cli_storage::session_lease::DeferredSessionLeaseWitness;
use kcoder_engine::QueryEngine;
use kcoder_tools::session_messages::SessionMessageSendError;
use std::fs::File;

#[derive(Debug)]
struct NotAdmitted(&'static str);
impl std::fmt::Display for NotAdmitted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for NotAdmitted {}
fn denied(code: &'static str) -> anyhow::Error {
    anyhow::Error::new(NotAdmitted(code))
}

fn rejection_code(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        match cause.to_string().as_str() {
            "peer_message_reply_unsupported" => return "peer_message_reply_unsupported",
            "peer_message_target_not_found" => return "peer_message_target_not_found",
            "peer_message_target_archived" => return "peer_message_target_archived",
            "peer_message_target_deleted" => return "peer_message_target_unavailable",
            "peer_message_target_protected" | "session_directory_controlled_source_unavailable" => {
                return "peer_message_target_unavailable";
            }
            "peer_message_target_mode_denied" | "peer_message_policy_denied" => {
                return "peer_message_mode_denied";
            }
            "peer_message_target_turn_changed" | "peer_message_target_turn_unavailable" => {
                return "peer_message_target_turn_changed";
            }
            "peer_source_owner_closed"
            | "peer_source_owner_changed"
            | "peer_source_permission_denied" => return "peer_message_source_unavailable",
            _ => {}
        }
    }
    "peer_message_destination_temporarily_unavailable"
}

pub(crate) fn local_send_error(error: anyhow::Error) -> SessionMessageSendError {
    if let Some(failure) = error.downcast_ref::<NotAdmitted>() {
        SessionMessageSendError::Rejected { code: failure.0 }
    } else {
        SessionMessageSendError::Unconfirmed {
            code: "peer_message_original_operation_unconfirmed",
        }
    }
}

struct Resident {
    engine: QueryEngine,
    owner: AppStateLifecycleIdentity,
    lease: DeferredSessionLeaseWitness,
}
/// Captured only by the actual manager. An excluded resident remains excluded
/// after original-CID reconciliation instead of falling back to its old history.
pub(crate) struct LocalTargetSnapshot(Result<Option<Resident>, &'static str>);
impl LocalTargetSnapshot {
    pub(in crate::app_server) fn capture(
        manager: &ThreadManager,
        storage: &Path,
        id: &str,
    ) -> Self {
        Self(Resident::capture(manager, storage, id).map_err(|error| rejection_code(&error)))
    }
}
impl Resident {
    fn capture(manager: &ThreadManager, storage: &Path, id: &str) -> Result<Option<Self>> {
        let Some(engine) = manager.engine(id) else {
            return Ok(None);
        };
        ensure!(
            !manager.is_ephemeral(id)
                && engine.is_independent_discovery_session()
                && engine.client_storage_root() == storage,
            "peer_message_target_protected"
        );
        let owner = engine
            .state
            .try_inspection_lifecycle_identity()
            .context("peer_message_target_busy")?;
        let lease = manager
            .lease(id)
            .and_then(|lease| lease.deferred_witness(&engine.session_lease_target()))
            .context("peer_message_target_owner_unavailable")?;
        Ok(Some(Self {
            engine,
            owner,
            lease,
        }))
    }
    fn verify(&self, service: &PeerMessageService, intent: &AgentMessageIntent) -> Result<()> {
        ensure!(
            self.owner.try_matches(&self.engine.state) == Some(true)
                && self.engine.is_independent_discovery_session()
                && service.workspace_matches(&self.engine.state.cwd())
                && self.engine.state.session_mode() == kcoder_state::SessionMode::Default
                && self.engine.state.channel_task_source().is_none()
                && self.engine.state.agent_definition().is_none(),
            "peer_message_target_protected"
        );
        self.lease
            .verify_target(&self.engine.session_lease_target())?;
        if let Some(expected) = &intent.expected_turn_id {
            ensure!(
                self.engine
                    .owned_turn_observer()
                    .current_identity()
                    .map_err(anyhow::Error::msg)?
                    .is_some_and(|current| current.turn_id == *expected),
                "peer_message_target_turn_changed"
            );
        }
        let metadata = crate::app_server::thread_metadata::read_thread_metadata(
            &self.engine,
            &self.engine.session_id(),
        )?;
        ensure!(
            metadata
                .as_ref()
                .and_then(|row| row.fields.get("archivedAt"))
                .and_then(Option::as_ref)
                .is_none(),
            "peer_message_target_archived"
        );
        Ok(())
    }
}

struct Target {
    bound: Option<BoundPeerSession>,
    resident: Option<Resident>,
    metadata: AdmissionMetadata,
    live: bool,
    _read_lease: Option<File>,
}
impl Target {
    fn capture(
        service: &PeerMessageService,
        view: &DirectorySourceView<'_>,
        intent: &AgentMessageIntent,
        snapshot: Option<LocalTargetSnapshot>,
    ) -> Result<Self> {
        let resident = snapshot
            .map(|snapshot| snapshot.0.map_err(anyhow::Error::msg))
            .transpose()?
            .flatten();
        let live = if resident.is_none() {
            match crate::peer_sessions::endpoint::read_peer_status(
                service,
                intent
                    .target_address
                    .as_ref()
                    .context("peer_message_target_address_required")?,
            ) {
                Ok(row) => {
                    ensure!(row.archived_at.is_none(), "peer_message_target_archived");
                    ensure!(
                        row.allowed_modes.contains(&intent.mode),
                        "peer_message_target_mode_denied"
                    );
                    if intent.reply_to_message_id.is_some() {
                        let capabilities = crate::peer_sessions::endpoint::read_peer_capabilities(
                            service,
                            intent.target_address.as_ref().unwrap(),
                        )?;
                        ensure!(capabilities.iter().any(|name| name == kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_MESSAGE_REPLIES_V1),
                            "peer_message_reply_unsupported");
                    }
                    if let Some(expected) = &intent.expected_turn_id {
                        ensure!(
                            row.active_turn_id.as_ref() == Some(expected),
                            "peer_message_target_turn_changed"
                        );
                    }
                    true
                }
                Err(error) if error.is::<crate::peer_sessions::OriginalSourceUnavailable>() => {
                    false
                }
                Err(error) => return Err(error),
            }
        } else {
            false
        };
        let bound = SessionDirectory::default().lookup_bound_metadata_view(
            view,
            &intent.target_thread_id,
            resident.is_some() || live,
        )?;
        ensure!(
            bound.is_some() || resident.is_some() || live,
            "peer_message_target_not_found"
        );
        let metadata = SessionDirectory::lock_admission_metadata(view, &intent.target_thread_id)?;
        let mut target = Self {
            bound,
            resident,
            metadata,
            live,
            _read_lease: None,
        };
        target.verify(service, view, intent)?;
        if target.resident.is_none() && !target.live {
            let bound = target
                .bound
                .as_ref()
                .context("peer_message_target_unavailable")?;
            match bound.admission_read_lease(view) {
                Ok(lease) => {
                    target._read_lease = lease;
                    ensure!(
                        intent.expected_turn_id.is_none(),
                        "peer_message_target_turn_unavailable"
                    );
                }
                Err(error)
                    if error.downcast_ref::<std::io::Error>().is_some_and(|error| {
                        error.kind() == std::io::ErrorKind::WouldBlock
                            || matches!(error.raw_os_error(), Some(32 | 33))
                    }) =>
                {
                    // A live writer cannot be reinterpreted as a cold target on IPC failure.
                    target.verify_live(service, intent)?;
                    target.live = true;
                }
                Err(error) => return Err(error),
            }
        }
        target.verify(service, view, intent)?;
        Ok(target)
    }
    fn verify_live(&self, service: &PeerMessageService, intent: &AgentMessageIntent) -> Result<()> {
        let address = intent
            .target_address
            .as_ref()
            .context("peer_message_target_address_required")?;
        let row = crate::peer_sessions::endpoint::read_peer_status(service, address)?;
        ensure!(
            row.archived_at.is_none() && row.allowed_modes.contains(&intent.mode),
            "peer_message_target_mode_denied"
        );
        if let Some(expected) = &intent.expected_turn_id {
            ensure!(
                row.active_turn_id.as_ref() == Some(expected),
                "peer_message_target_turn_changed"
            );
        }
        Ok(())
    }
    fn verify(
        &self,
        service: &PeerMessageService,
        view: &DirectorySourceView<'_>,
        intent: &AgentMessageIntent,
    ) -> Result<()> {
        view.verify()?;
        ensure!(
            self.metadata
                .verify(view)?
                .as_ref()
                .and_then(|row| row.fields.get("archivedAt"))
                .and_then(Option::as_ref)
                .is_none(),
            "peer_message_target_archived"
        );
        if self.resident.is_none() && !self.live {
            ensure!(
                service.cold_target_modes()?.contains(&intent.mode),
                "peer_message_target_mode_denied"
            );
        }
        if let Some(resident) = &self.resident {
            resident.verify(service, intent)?;
        }
        if let Some(bound) = &self.bound {
            let metadata = bound.metadata(view)?;
            ensure!(
                metadata.session_mode() == kcoder_state::SessionMode::Default
                    && !metadata.has_native_subagent_outbox()
                    && metadata.channel_task_source().is_none()
                    && metadata.agent_definition().is_none(),
                "peer_message_target_protected"
            );
            ensure!(
                bound
                    .client_metadata(view)?
                    .as_ref()
                    .and_then(|row| row.fields.get("archivedAt"))
                    .and_then(Option::as_ref)
                    .is_none(),
                "peer_message_target_archived"
            );
            ensure!(
                kcoder_state::read_session_history_deletion(&bound.history_path(), &service.cwd)?
                    .is_none(),
                "peer_message_target_deleted"
            );
            bound.verify(view)?;
            if let Some(lease) = &self._read_lease {
                bound.verify_admission_read_lease(view, lease)?;
            }
        }
        Ok(())
    }
}

/// Bounded wait for the source's own history writer. An append holds the
/// mutation lock exclusively only for its write, and a send normally runs while
/// the sender's turn is persisting; one failed try-lock is not an unknown send.
const SOURCE_HISTORY_WRITER_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
const SOURCE_HISTORY_WRITER_POLL: std::time::Duration = std::time::Duration::from_millis(5);

fn source_history_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string() == "peer_source_history_writer_busy")
        && error.chain().any(|cause| {
            cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
        })
}

impl PeerMessageService {
    /// Local admission runs on a blocking worker, so it may sleep between
    /// shared-lock attempts. Every other error, and a writer that stays busy
    /// past the bound, still fails this send without dispatching it.
    fn record_source_history_waiting_for_writer(
        &self,
        store: &super::super::router_store::NativePeerRouterStore,
        operation_id: &str,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
    ) -> Result<()> {
        let deadline = std::time::Instant::now() + SOURCE_HISTORY_WRITER_WAIT;
        loop {
            match self.record_source_history_from_state(store, operation_id, source, owner) {
                Err(error)
                    if source_history_writer_busy(&error)
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(SOURCE_HISTORY_WRITER_POLL);
                }
                result => return result,
            }
        }
    }
    pub fn prepare_local(
        &self,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
        authority: &dyn LocalPeerSourceAuthorization,
        storage: &Path,
        intent: AgentMessageIntent,
    ) -> Result<AgentMessageReceipt> {
        self.prepare_local_inner(source, owner, authority, storage, intent, None)
    }
    #[cfg(test)]
    pub(in crate::app_server) fn prepare_local_in_manager(
        &self,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
        authority: &dyn LocalPeerSourceAuthorization,
        storage: &Path,
        intent: AgentMessageIntent,
        manager: &ThreadManager,
    ) -> Result<AgentMessageReceipt> {
        let snapshot = LocalTargetSnapshot::capture(manager, storage, &intent.target_thread_id);
        self.prepare_local_with_snapshot(source, owner, authority, storage, intent, snapshot)
    }
    pub(crate) fn prepare_local_with_snapshot(
        &self,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
        authority: &dyn LocalPeerSourceAuthorization,
        storage: &Path,
        intent: AgentMessageIntent,
        snapshot: LocalTargetSnapshot,
    ) -> Result<AgentMessageReceipt> {
        self.prepare_local_inner(source, owner, authority, storage, intent, Some(snapshot))
    }
    fn prepare_local_inner(
        &self,
        source: &AppState,
        owner: &AppStateLifecycleIdentity,
        authority: &dyn LocalPeerSourceAuthorization,
        storage: &Path,
        mut intent: AgentMessageIntent,
        snapshot: Option<LocalTargetSnapshot>,
    ) -> Result<AgentMessageReceipt> {
        self.require_enabled(false)?;
        ensure!(
            self.workspace_matches(&source.cwd()) && owner.try_matches(source) == Some(true),
            "peer_message_source_changed"
        );
        authority.check_current(source, owner, &intent)?;
        let native_source = self.message_source(&source.session_id())?;
        let source_address = native_source
            .address
            .as_ref()
            .context("peer_message_source_address_required")?;
        let target = intent
            .target_address
            .get_or_insert_with(|| SessionAddressV1 {
                target_id: source_address.target_id.clone(),
                workspace_id: source_address.workspace_id.clone(),
                thread_id: intent.target_thread_id.clone(),
            });
        ensure!(
            target.target_id == source_address.target_id
                && target.workspace_id == source_address.workspace_id,
            "peer_message_remote_route_required"
        );
        ensure!(target != source_address, "peer_message_self_target");
        intent.validate().map_err(anyhow::Error::msg)?;
        let operation_id = Self::operation_id(source_address, &intent.client_message_id)?;
        let native_authority = self.authority()?;
        let store = native_authority.store()?;
        let original = store.read_operation(&operation_id)?;
        if let Some(operation) = &original {
            let claims = &operation.attestation.claims;
            if claims.source_address != *source_address
                || claims.destination != *intent.target_address.as_ref().unwrap()
                || claims.client_message_id != intent.client_message_id
                || claims.mode != intent.mode
                || claims.expected_turn_id != intent.expected_turn_id
                || claims.reply_to_message_id != intent.reply_to_message_id
                || claims.body_sha256 != format!("{:x}", Sha256::digest(intent.text.as_bytes()))
            {
                return Err(denied("peer_message_original_intent_conflict"));
            }
            super::super::router_store::verify_peer_attestation(
                &operation.attestation,
                &self.identity()?,
            )?;
        }
        let queue = self.mailbox()?;
        if let Some(binding) =
            queue.get_receipt_binding_by_client_id(&native_source, &intent.client_message_id)?
        {
            ensure!(
                original.is_some(),
                "peer_message_original_operation_missing"
            );
            if binding.intent_sha256
                != format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&(&native_source, &intent))?)
                )
            {
                return Err(denied("peer_message_original_intent_conflict"));
            }
            return Ok(binding.receipt);
        }
        ensure!(
            original
                .as_ref()
                .is_none_or(|operation| operation.receipt.is_none()),
            "peer_message_original_receipt_unconfirmed"
        );
        let before_admission = |error: anyhow::Error| {
            if original.is_none() {
                let code = rejection_code(&error);
                denied(code).context(error)
            } else {
                error
            }
        };
        self.require_enabled(intent.mode == AgentMessageMode::WakeIfIdle)
            .map_err(before_admission)?;
        let view = DirectorySourceView::from_state(source, owner, storage);
        let target = Target::capture(self, &view, &intent, snapshot).map_err(before_admission)?;
        let settings = self.admission_settings().map_err(before_admission)?;
        let mut source_write_started = false;
        let mut prepare = || -> Result<()> {
            target.verify(self, &view, &intent)?;
            authority.check_current(source, owner, &intent)?;
            self.require_enabled(intent.mode == AgentMessageMode::WakeIfIdle)?;
            source_write_started = true;
            self.prepare_source_operation(&operation_id, source_address.clone(), &intent)
                .context("peer_local_prepare_source")?;
            self.record_source_history_waiting_for_writer(store, &operation_id, source, owner)
                .context("peer_local_source_history")?;
            store
                .mark_dispatching(&operation_id)
                .context("peer_local_mark_dispatch")?;
            Ok(())
        };
        // Never hold the mailbox transaction while opening the source store:
        // namespace loading has the opposite (router -> mailbox) lock order.
        let prepared = prepare();
        let result = prepared.and_then(|()| {
            if intent.expected_turn_id.is_some() {
                crate::peer_sessions::endpoint::admit_peer_target(
                    self,
                    native_source.clone(),
                    intent.clone(),
                )
            } else {
                queue
                    .enqueue_with_admission(
                        &native_source,
                        intent.clone(),
                        queue.revision()?,
                        settings.message_ttl_seconds,
                        || {
                            target.verify(self, &view, &intent)?;
                            authority.check_before_queue_commit(source, owner, &intent)?;
                            self.require_enabled(intent.mode == AgentMessageMode::WakeIfIdle)?;
                            Ok(None)
                        },
                    )
                    .context("peer_local_enqueue")
            }
        });
        let receipt = result.map_err(|error| {
            if !source_write_started {
                before_admission(error)
            } else {
                error
            }
        })?;
        store
            .record_receipt(&operation_id, receipt.clone())
            .context("peer_local_record_receipt")?;
        Ok(receipt)
    }
}
