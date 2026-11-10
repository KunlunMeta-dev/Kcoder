//! Resolve the stable envelope before entering the real tool's execution gate.
use super::*;
use crate::tool_search_runtime::DeferredToolsSnapshot;
use kcoder_tools::{ToolSource, tool_execute::ToolExecuteInput};

pub(super) struct ModelToolRegistry<'a> {
    pub native: &'a ToolRegistry,
    pub deferred: &'a DeferredToolsSnapshot,
    pub arrangement_mode: bool,
}

impl QueryEngine {
    pub(super) async fn execute_model_request_tool(
        &self,
        id: &str,
        name: &str,
        input: Value,
        prompt: &dyn PermissionPrompt,
        registry: ModelToolRegistry<'_>,
    ) -> Result<(
        ToolOutput,
        PermissionDecision,
        Option<Value>,
        Vec<EngineEvent>,
    )> {
        if name != "tool_execute" {
            return self
                .execute_tool_with_registry(
                    id,
                    name,
                    input,
                    prompt,
                    registry.native,
                    registry.arrangement_mode,
                )
                .await;
        }
        let rejected = |reason: String| {
            Ok((
                ToolOutput::error(reason),
                PermissionDecision::Deny,
                None,
                Vec::new(),
            ))
        };
        if !self.tool_search_enabled()
            || !registry
                .native
                .get("tool_execute")
                .is_some_and(|tool| tool.source() == ToolSource::Builtin)
            || registry.deferred.owner != self.state.session_id()
            || self.active_tool_registry().get("tool_execute").is_none()
        {
            return rejected("tool_execute is unavailable in this request".into());
        }
        if recover_read_lock(&self.permissions, "permissions").is_explicitly_denied(name, &input) {
            let reason = "tool_execute was denied by an explicit permission rule".to_string();
            return Ok((
                ToolOutput::error(&reason),
                PermissionDecision::Deny,
                None,
                vec![EngineEvent::ToolDenied {
                    id: id.into(),
                    name: name.into(),
                    reason,
                }],
            ));
        }
        let envelope: ToolExecuteInput = match kcoder_tools::parse_input(&input) {
            Ok(value) => value,
            Err(error) => return rejected(error.to_string()),
        };
        let Some(tool) = registry.deferred.tools.get(&envelope.tool_name) else {
            return rejected("tool_execute requires a tool discovered before this model request; search again and execute in a subsequent request".into());
        };
        let current = self.searchable_tools();
        let Some(live) = current.get(&envelope.tool_name) else {
            return rejected("The discovered tool is no longer permitted or registered".into());
        };
        let live_schema = crate::tool_schema_runtime::model_schema_for_tool_input(
            &live.name(),
            &live.input_schema(),
            &live.input_format(),
        );
        if matches!(tool.source(), ToolSource::Builtin)
            || !Arc::ptr_eq(&tool, &live)
            || registry.deferred.schemas.get(&envelope.tool_name) != Some(&live_schema)
        {
            return rejected(
                "The discovered tool source/schema changed; use tool_search again before execution"
                    .into(),
            );
        }
        // This is routing, not recursive execution under the envelope's gate.
        // Real schema validation, permission prompts, Hooks and cancellation run once.
        let target_registry = ToolRegistry::new().register_arc(tool);
        self.execute_tool_with_registry(
            id,
            &envelope.tool_name,
            envelope.arguments,
            prompt,
            &target_registry,
            registry.arrangement_mode,
        )
        .await
    }
}
