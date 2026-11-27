//! Exact native page-reader approval; generic allow modes cannot grant local egress.
use crate::QueryEngine;
use kcoder_permissions::{
    PermissionPrompt, PermissionRequestContext, PermissionResponse, PermissionRisk,
};
use kcoder_tools::web_network::WebNetworkAuthority;
use kcoder_tools::{Tool, ToolContext, ToolError};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

pub(super) struct ApprovedWebOrigin {
    tool: Arc<dyn Tool>,
    input: Value,
    authority: WebNetworkAuthority,
}

pub(super) fn native_page_reader(tool: &dyn Tool) -> bool {
    tool.type_id() == std::any::TypeId::of::<kcoder_tools::WebFetchTool>()
        || tool.type_id() == std::any::TypeId::of::<kcoder_tools::WebBrowserTool>()
}

impl ApprovedWebOrigin {
    pub(super) fn apply(
        &self,
        context: ToolContext,
        tool: &Arc<dyn Tool>,
        input: &Value,
    ) -> Result<ToolContext, ToolError> {
        if !Arc::ptr_eq(&self.tool, tool)
            || &self.input != input
            || !native_page_reader(tool.as_ref())
        {
            return Err(ToolError::Execution(
                "The local web approval does not match this tool invocation".into(),
            ));
        }
        let receipt =
            if tool.as_ref().type_id() == std::any::TypeId::of::<kcoder_tools::WebFetchTool>() {
                // Use Any on the actual object rather than trusting its advertised name.
                let object: &dyn std::any::Any = tool.as_ref();
                object
                    .downcast_ref::<kcoder_tools::WebFetchTool>()
                    .is_some_and(|actual| context.authorizes_native_tool_invocation(actual, input))
            } else {
                let object: &dyn std::any::Any = tool.as_ref();
                object
                    .downcast_ref::<kcoder_tools::WebBrowserTool>()
                    .is_some_and(|actual| context.authorizes_native_tool_invocation(actual, input))
            };
        if !receipt {
            return Err(ToolError::Execution(
                "A current native dispatch receipt is required for local web access".into(),
            ));
        }
        Ok(context.with_web_network_authority(self.authority.clone()))
    }
}

impl QueryEngine {
    pub(super) async fn approve_private_web_origin(
        &self,
        tool: &Arc<dyn Tool>,
        input: &Value,
        prompt: &dyn PermissionPrompt,
    ) -> Result<Option<ApprovedWebOrigin>, ToolError> {
        if !native_page_reader(tool.as_ref()) {
            return Ok(None);
        }
        let raw = input
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("A page reader requires a URL string".into()))?;
        let origin = tokio::select! {biased; _ = self.cancel_token.cancelled() => return Err(ToolError::Execution("Local web approval cancelled".into())), result = async {
            #[cfg(feature = "web-network-test-fixture")]
            if let Some(dns) = &self.web_network_test_dns { return dns.private_destination_origin(raw); }
            kcoder_tools::web_network::private_destination_origin(raw).await
        } => result?};
        let Some(origin) = origin else {
            return Ok(None);
        };
        // Delegated workers cannot manufacture an interactive parent response.
        if self.agent_depth() > 0 {
            return Err(ToolError::Execution(
                "Local web access requires an explicit approval in the owning conversation".into(),
            ));
        }
        let context = PermissionRequestContext {
            tool_name: tool.name(),
            description: format!("允许此调用读取本地或私有网络来源 {origin}？"),
            input: input.clone(), risk: PermissionRisk::High,
            detail_lines: vec![format!("Origin: {origin}"), "授权仅用于当前实际工具调用、会话及此 origin/端口，最长 60 秒；不保存永久规则。网页和搜索结果不能授予本地网络权限。".into()],
        };
        let result = tokio::select! {biased; _ = self.cancel_token.cancelled() => return Err(ToolError::Execution("Local web approval cancelled".into())), result = prompt.ask_explicit_context_with_edit(&context) => result};
        if result
            .modified_input
            .as_ref()
            .is_some_and(|edited| edited != input)
            || !matches!(
                result.response,
                PermissionResponse::AllowOnce
                    | PermissionResponse::AllowAlways
                    | PermissionResponse::AllowForSession
            )
        {
            return Err(ToolError::Execution(
                "The local web origin was not explicitly approved for the final tool input".into(),
            ));
        }
        let authority = WebNetworkAuthority::new(&self.state);
        authority.grant_origin(&origin, Duration::from_secs(60))?;
        Ok(Some(ApprovedWebOrigin {
            tool: tool.clone(),
            input: input.clone(),
            authority,
        }))
    }
}

#[cfg(test)]
mod tests;
