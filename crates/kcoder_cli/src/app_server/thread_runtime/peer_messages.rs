//! Runtime-owned source endpoints; a refresh replaces facts, never cached authorization.
use super::*;
use crate::{
    app_server::session_messages::service::PeerMessageService,
    peer_sessions::{BoundPeerSource, PeerSourceEndpoint},
};

impl ThreadRuntime {
    pub(super) fn refresh_peer_source(
        &mut self,
        service: &Arc<PeerMessageService>,
        bridge: Option<&Arc<super::super::session_messages::backchannel::PeerRouterBackchannel>>,
    ) {
        let allowed = !self.ephemeral
            && self.engine.is_independent_discovery_session()
            && service.policy().is_ok_and(|policy| policy.enabled);
        if !allowed {
            if let Some(endpoint) = &self.peer_source
                && let Ok(source) = endpoint.source()
            {
                source.revoke();
            }
            return;
        }
        let result = (|| -> anyhow::Result<()> {
            let lease = self.lease.native_witness()?;
            if let Some(endpoint) = &self.peer_source {
                endpoint.refresh(&self.engine, lease)?;
            } else {
                let bound = BoundPeerSource::capture(&self.engine, service.clone(), lease)?;
                self.peer_source = Some(PeerSourceEndpoint::bind(bound)?);
            }
            let target = self
                .peer_source
                .as_ref()
                .context("peer_source_binding_unavailable")?
                .source()?;
            crate::peer_sessions::turn_retirement::bind(
                &mut self.lease,
                &self.engine,
                Some(&target),
            );
            if self.local_peer_hosts {
                crate::peer_sessions::install_local_target_hosts(
                    &mut self.engine,
                    &target,
                    self.lease.native_witness()?,
                )?;
                if let Some(scheduler) = &self.background_followup_scheduler {
                    scheduler.replace_engine(&self.engine, self.lease.target())?;
                }
                return Ok(());
            }
            let receiver = if let Some(bridge) =
                bridge.filter(|bridge| bridge.available() && service.has_private_parent())
            {
                let caller = Arc::new(
                    super::super::session_messages::backchannel::PeerTargetBackchannel::capture(
                        bridge.clone(),
                        service.clone(),
                        &self.engine,
                        self.lease.native_witness()?,
                    )?,
                );
                target.set_target_verifier(caller.clone())?;
                let resolver=Arc::new(super::super::session_messages::remote_delivery::RoutedPeerDeliveryResolver::new(service.clone(),caller,crate::peer_sessions::local_delivery_resolver(target)));
                Arc::new(
                    super::super::session_messages::delivery::DestinationPeerMessageDriver::new(
                        self.engine.state.clone(),
                        self.engine.state.inspection_lifecycle_identity(),
                        self.lease.native_witness()?,
                        service.mailbox()?,
                        resolver,
                    )?,
                ) as Arc<dyn kcoder_engine::peer_message_runtime::PeerMessageHost>
            } else {
                crate::peer_sessions::destination_host(
                    &self.engine,
                    service.clone(),
                    self.lease.native_witness()?,
                    target,
                )?
            };
            self.engine = self.engine.clone().with_peer_message_host(receiver);
            if let Some(scheduler) = &self.background_followup_scheduler {
                scheduler.replace_engine(&self.engine, self.lease.target())?;
            }
            Ok(())
        })();
        if result.is_err() {
            if let Some(endpoint) = &self.peer_source
                && let Ok(source) = endpoint.source()
            {
                source.revoke();
            }
            tracing::warn!(
                code = "peer_source_binding_unavailable",
                "Peer source requires reconciliation"
            );
        }
    }
}
impl ThreadManager {
    pub(in crate::app_server) fn peer_read_backchannel(
        &self,
    ) -> Option<Arc<super::super::session_messages::backchannel::PeerRouterBackchannel>> {
        self.peer_bridge.clone()
    }
    pub(in crate::app_server) fn configure_peer_services(
        &mut self,
        service: Arc<PeerMessageService>,
        bridge: Option<Arc<super::super::session_messages::backchannel::PeerRouterBackchannel>>,
    ) {
        for runtime in self.runtimes.values_mut() {
            runtime.refresh_peer_source(&service, bridge.as_ref());
        }
        self.peer_service = Some(service);
        self.peer_bridge = bridge;
    }
}
