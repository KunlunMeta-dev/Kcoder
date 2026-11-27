//! The real local receiver can own a cold Source permission reader without
//! pretending to be a private Gateway parent or retaining another Engine.
use super::*;
use crate::peer_sessions::BoundPeerSource;
use kcoder_engine::QueryEngine;
use kcoder_types::session_address::SessionAddressV1;
use std::sync::Weak;

pub(crate) struct LocalNativeColdPeerSourceVerifier {
    receiver: Weak<BoundPeerSource>,
    receiver_address: SessionAddressV1,
    inner: NativeColdPeerSourceVerifier,
}
impl LocalNativeColdPeerSourceVerifier {
    /// Capture only at the actual LocalHost installation boundary. The factory
    /// retains its original SettingsLoader/Cli and actual host contribution;
    /// source history never supplies a factory, profile or caller identity.
    pub(crate) fn capture(
        receiver_engine: &QueryEngine,
        receiver: &Arc<BoundPeerSource>,
        factory: AppServerEngineFactory,
    ) -> Result<Arc<Self>> {
        let receiver_address = receiver.address()?;
        let service = receiver.service().clone();
        let workspace = receiver_engine.state.cwd();
        ensure!(
            receiver.state().shares_state_with(&receiver_engine.state)
                && receiver.owner().try_matches(&receiver_engine.state) == Some(true)
                && receiver_address.thread_id == receiver_engine.session_id()
                && receiver_engine.is_independent_discovery_session()
                && service.workspace_matches(&workspace)
                && dunce::canonicalize(factory.continuation_workspace())?
                    == dunce::canonicalize(&workspace)?
                && dunce::canonicalize(factory.profile_paths()?.config_dir)?
                    == dunce::canonicalize(service.profile_path())?,
            "peer_local_cold_source_factory_owner_changed"
        );
        let history = receiver_engine
            .state
            .history_path()
            .context("peer_local_cold_source_history_unavailable")?
            .parent()
            .map(std::path::Path::to_owned);
        ensure!(
            history.is_some(),
            "peer_local_cold_source_history_unavailable"
        );
        // The existing core performs original operation/history/lease binding
        // and fresh configuration checks. The weak real LocalHost replaces
        // only its management-capture boundary, never those checks.
        let inner = NativeColdPeerSourceVerifier {
            service,
            factory,
            workspace,
            storage: receiver_engine.client_storage_root(),
            history,
        };
        let verifier = Arc::new(Self {
            receiver: Arc::downgrade(receiver),
            receiver_address,
            inner,
        });
        verifier.current_owner()?;
        Ok(verifier)
    }

    fn current_owner(&self) -> Result<Arc<BoundPeerSource>> {
        let receiver = self
            .receiver
            .upgrade()
            .context("peer_local_cold_source_owner_closed")?;
        ensure!(
            Arc::ptr_eq(receiver.service(), &self.inner.service)
                && receiver.address()? == self.receiver_address
                && receiver
                    .state()
                    .history_path()
                    .as_deref()
                    .and_then(std::path::Path::parent)
                    == self.inner.history.as_deref()
                && self
                    .inner
                    .service
                    .workspace_matches(&receiver.state().cwd()),
            "peer_local_cold_source_owner_changed"
        );
        Ok(receiver)
    }
}
impl ColdPeerSourceVerifier for LocalNativeColdPeerSourceVerifier {
    fn check_current(
        &self,
        operation: &PeerRouterOperationV1,
        message: &PeerRouterMessageV1,
        _access: PeerRouterHistoryAccess,
    ) -> Result<()> {
        self.current_owner()?;
        self.inner.check_original_current(operation, message)?;
        self.current_owner()?;
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "local_owner/tests.rs"]
mod tests;
