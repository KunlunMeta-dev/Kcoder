//! Preserve real host contributions across registry/cache refresh without enabling default hosts.
use super::*;
use kcoder_tools::session_discovery::ListSessionsTool;
use kcoder_tools::session_messages::{
    GetSessionMessageReceiptTool, ListSessionMessageReceiptsTool, SendSessionMessageTool,
    SessionMessagesHost,
};
use kcoder_tools::session_read::ReadSessionTool;

#[derive(Clone, Default)]
pub(super) struct SessionHostTools {
    pub(super) discovery: Option<ListSessionsTool>,
    /// Shares the discovery contribution; present only when the host verifies reads.
    pub(super) read: Option<ReadSessionTool>,
    pub(super) messages: Option<(
        SendSessionMessageTool,
        GetSessionMessageReceiptTool,
        ListSessionMessageReceiptsTool,
    )>,
}
fn install<T: kcoder_tools::Tool + Clone>(
    tools: &mut ToolRegistry,
    tool: &T,
    same: impl Fn(&T, &T) -> bool,
) -> Result<()> {
    let name = tool.name();
    if let Some(current) = tools.get(&name) {
        let value: &dyn std::any::Any = current.as_ref();
        if value
            .downcast_ref::<T>()
            .is_some_and(|current| same(current, tool))
        {
            return Ok(());
        }
        tools.replace_builtin(tool.clone())?;
    } else {
        tools
            .try_register(Arc::new(tool.clone()))
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    }
    Ok(())
}
impl QueryEngine {
    /// Disable only this runtime's session communication after a failed
    /// explicitly selected transport. Stored Peer restrictions are preserved.
    pub fn without_session_communication(mut self) -> Result<Self> {
        let names = self.session_host_tool_names(&self.tools);
        self.session_host_tools = SessionHostTools::default();
        self.peer_message_host = None;
        let tools = self.tools.filtered_out_by_patterns(&names);
        let subagent_tools = recover_read_lock(&self.subagent_tools, "subagent_tools")
            .filtered_out_by_patterns(&names);
        self.subagent_tools = Arc::new(RwLock::new(subagent_tools));
        Ok(self.with_turn_tools(tools))
    }
    pub fn with_session_messages_host(
        mut self,
        host: Arc<dyn SessionMessagesHost>,
    ) -> Result<Self> {
        self.session_host_tools.messages = Some((
            SendSessionMessageTool::new(host.clone()),
            GetSessionMessageReceiptTool::new(host.clone()),
            ListSessionMessageReceiptsTool::new(host),
        ));
        let tools = self.compose_session_host_tools(self.tools.clone())?;
        Ok(self.with_turn_tools(tools))
    }
    fn session_source_hosts_allowed(&self) -> bool {
        self.is_independent_discovery_session()
            && !self.terminal_verdict_turn.load(Ordering::Acquire)
            && self
                .verifier_vote_channel
                .try_read()
                .is_ok_and(|slot| slot.is_none())
            && self
                .review_vote_channel
                .try_read()
                .is_ok_and(|slot| slot.is_none())
    }
    pub(super) fn session_host_tool_names(&self, tools: &ToolRegistry) -> Vec<String> {
        let mut names = Vec::new();
        for (name, configured, kind) in [
            (
                "ListSessions",
                self.session_host_tools.discovery.is_some(),
                std::any::TypeId::of::<ListSessionsTool>(),
            ),
            (
                "ReadSession",
                self.session_host_tools.read.is_some(),
                std::any::TypeId::of::<ReadSessionTool>(),
            ),
            (
                "SendSessionMessage",
                self.session_host_tools.messages.is_some(),
                std::any::TypeId::of::<SendSessionMessageTool>(),
            ),
            (
                "GetSessionMessageReceipt",
                self.session_host_tools.messages.is_some(),
                std::any::TypeId::of::<GetSessionMessageReceiptTool>(),
            ),
            (
                "ListSessionMessageReceipts",
                self.session_host_tools.messages.is_some(),
                std::any::TypeId::of::<ListSessionMessageReceiptsTool>(),
            ),
        ] {
            if configured
                || tools
                    .get(name)
                    .is_some_and(|tool| tool.as_ref().type_id() == kind)
            {
                names.push(name.to_owned());
            }
        }
        names
    }
    pub(super) fn compose_session_host_tools(
        &self,
        mut tools: ToolRegistry,
    ) -> Result<ToolRegistry> {
        let names = self.session_host_tool_names(&tools);
        if names.is_empty() {
            return Ok(tools);
        }
        let settings = recover_read_lock(&self.settings, "settings");
        if !self.session_source_hosts_allowed()
            || !settings.model_capabilities.tools
            || matches!(
                settings.tools.profile,
                kcoder_config::ToolProfile::Nano | kcoder_config::ToolProfile::None
            )
        {
            return Ok(tools.filtered_out_by_patterns(&names));
        }
        if let Some(tool) = &self.session_host_tools.discovery
            && !ToolRegistry::name_is_disabled("ListSessions", &settings.tools.disabled)
        {
            install(&mut tools, tool, ListSessionsTool::same_contribution)?;
        }
        if let Some(tool) = &self.session_host_tools.read
            && !ToolRegistry::name_is_disabled("ReadSession", &settings.tools.disabled)
        {
            install(&mut tools, tool, ReadSessionTool::same_contribution)?;
        }
        if let Some((send, receipt, list)) = &self.session_host_tools.messages {
            if !ToolRegistry::name_is_disabled(
                "ListSessionMessageReceipts",
                &settings.tools.disabled,
            ) {
                install(
                    &mut tools,
                    list,
                    ListSessionMessageReceiptsTool::same_contribution,
                )?;
            }
            if !ToolRegistry::name_is_disabled("SendSessionMessage", &settings.tools.disabled) {
                install(&mut tools, send, SendSessionMessageTool::same_contribution)?;
            }
            if !ToolRegistry::name_is_disabled("GetSessionMessageReceipt", &settings.tools.disabled)
            {
                install(
                    &mut tools,
                    receipt,
                    GetSessionMessageReceiptTool::same_contribution,
                )?;
            }
        }
        Ok(tools.filtered_out_by_patterns(&settings.tools.disabled))
    }
    pub(super) fn recompose_session_host_tools(&self, tools: ToolRegistry) -> ToolRegistry {
        match self.compose_session_host_tools(tools.clone()) {
            Ok(tools) => tools,
            Err(_) => {
                tracing::warn!("session_host_tools_recomposition_failed");
                tools.filtered_out_by_patterns(&self.session_host_tool_names(&tools))
            }
        }
    }
    pub(super) fn filter_session_host_tools(&self, tools: ToolRegistry) -> ToolRegistry {
        let names = self.session_host_tool_names(&tools);
        if names.is_empty() {
            return tools;
        }
        let settings = recover_read_lock(&self.settings, "settings");
        if !self.session_source_hosts_allowed()
            || !settings.model_capabilities.tools
            || matches!(
                settings.tools.profile,
                kcoder_config::ToolProfile::Nano | kcoder_config::ToolProfile::None
            )
        {
            return tools.filtered_out_by_patterns(&names);
        }
        tools.filtered_out_by_patterns(&settings.tools.disabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use kcoder_tools::session_messages::{SessionMessageCall, SessionMessageSendError};
    struct Host;
    #[async_trait::async_trait]
    impl SessionMessagesHost for Host {
        async fn send(
            &self,
            _: SessionMessageCall,
            _: kcoder_types::cross_session_messages::AgentMessageIntent,
        ) -> std::result::Result<Value, SessionMessageSendError> {
            Ok(serde_json::json!({"status":"queued"}))
        }
        async fn receipt(
            &self,
            _: SessionMessageCall,
            _: Value,
        ) -> std::result::Result<Value, ToolError> {
            Ok(serde_json::json!({"status":"unknown"}))
        }
    }
    #[test]
    fn real_message_host_survives_cache_refresh_without_restoring_disabled_or_child_tools() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build_with_profile_directory();
        assert!(
            engine
                .active_tool_registry()
                .get("SendSessionMessage")
                .is_none()
        );
        let host = Arc::new(Host);
        let mut engine = engine.with_session_messages_host(host).unwrap();
        assert!(
            engine
                .active_tool_registry()
                .get("SendSessionMessage")
                .is_some()
        );
        assert!(
            engine
                .tool_definitions
                .iter()
                .any(|value| value.name == "GetSessionMessageReceipt")
        );
        assert!(
            engine
                .active_tool_registry()
                .get("ListSessionMessageReceipts")
                .is_some()
        );
        let marker = engine
            .session_host_tools
            .messages
            .as_ref()
            .unwrap()
            .0
            .clone();
        engine = engine.with_turn_tools(ToolRegistry::new());
        let current = engine
            .active_tool_registry()
            .get("SendSessionMessage")
            .unwrap();
        let any: &dyn std::any::Any = current.as_ref();
        assert!(
            any.downcast_ref::<SendSessionMessageTool>()
                .unwrap()
                .same_contribution(&marker)
        );
        for profile in [
            kcoder_config::ToolProfile::Nano,
            kcoder_config::ToolProfile::None,
        ] {
            recover_write_lock(&engine.settings, "settings")
                .tools
                .profile = profile;
            assert!(
                engine
                    .active_tool_registry()
                    .get("SendSessionMessage")
                    .is_none()
            );
            let empty = engine.clone().with_turn_tools(ToolRegistry::new());
            assert!(
                empty
                    .active_tool_registry()
                    .get("GetSessionMessageReceipt")
                    .is_none()
            );
        }
        recover_write_lock(&engine.settings, "settings")
            .tools
            .profile = kcoder_config::ToolProfile::Full;
        recover_write_lock(&engine.settings, "settings")
            .tools
            .disabled
            .push("SendSessionMessage".into());
        let refreshed = engine.with_turn_tools(ToolRegistry::new());
        assert!(
            refreshed
                .active_tool_registry()
                .get("SendSessionMessage")
                .is_none()
        );
        assert!(
            refreshed
                .active_tool_registry()
                .get("GetSessionMessageReceipt")
                .is_some()
        );
        let child = refreshed.with_agent_depth(1);
        assert!(
            child
                .active_tool_registry()
                .get("ListSessionMessageReceipts")
                .is_none()
        );
        assert!(
            child
                .active_tool_registry()
                .get("GetSessionMessageReceipt")
                .is_none()
        );
    }
}
