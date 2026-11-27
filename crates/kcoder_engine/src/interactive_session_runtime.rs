//! Interactive hosts refresh only their original session owner and contributions.
use super::*;

#[async_trait::async_trait]
pub trait InteractiveSessionLifecycle: Send + Sync {
    async fn refresh(&self, engine: QueryEngine) -> Result<QueryEngine>;
}

/// An opaque host bundle contains no Engine and grants no independent authority.
#[derive(Clone)]
pub struct SessionCommunicationBinding {
    owner: kcoder_state::AppStateLifecycleIdentity,
    tools: session_messages_runtime::SessionHostTools,
    peer: Option<Arc<dyn peer_message_runtime::PeerMessageHost>>,
}

impl SessionCommunicationBinding {
    pub fn matches(&self, engine: &QueryEngine) -> bool {
        self.owner.try_matches(&engine.state) == Some(true)
            && match (&self.tools.discovery, &engine.session_host_tools.discovery) {
                (Some(left), Some(right)) => left.same_contribution(right),
                (None, None) => true,
                _ => false,
            }
            && match (&self.tools.messages, &engine.session_host_tools.messages) {
                (
                    Some((left_send, left_get, left_list)),
                    Some((right_send, right_get, right_list)),
                ) => {
                    left_send.same_contribution(right_send)
                        && left_get.same_contribution(right_get)
                        && left_list.same_contribution(right_list)
                }
                (None, None) => true,
                _ => false,
            }
            && match (&self.peer, &engine.peer_message_host) {
                (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            }
    }
}

impl QueryEngine {
    pub fn with_interactive_session_lifecycle(
        mut self,
        lifecycle: Arc<dyn InteractiveSessionLifecycle>,
    ) -> Self {
        self.interactive_session_lifecycle = Some(lifecycle);
        self
    }

    pub async fn refresh_interactive_session_hosts(self) -> Result<Self> {
        match self.interactive_session_lifecycle.clone() {
            Some(lifecycle) => lifecycle.refresh(self).await,
            None => Ok(self),
        }
    }

    pub fn session_communication_binding(&self) -> SessionCommunicationBinding {
        SessionCommunicationBinding {
            owner: self.state.inspection_lifecycle_identity(),
            tools: self.session_host_tools.clone(),
            peer: self.peer_message_host.clone(),
        }
    }

    pub fn with_session_communication_binding(
        self,
        binding: &SessionCommunicationBinding,
    ) -> Result<Self> {
        anyhow::ensure!(
            binding.owner.try_matches(&self.state) == Some(true),
            "interactive_peer_binding_owner_changed"
        );
        if binding.matches(&self) {
            return Ok(self);
        }
        let mut engine = self.without_session_communication()?;
        engine.session_host_tools = binding.tools.clone();
        engine.peer_message_host = binding.peer.clone();
        let tools = engine.compose_session_host_tools(engine.tools.clone())?;
        Ok(engine.with_turn_tools(tools))
    }
}
