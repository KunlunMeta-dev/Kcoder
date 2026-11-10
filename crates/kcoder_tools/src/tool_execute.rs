//! Stable execution envelope; Engine resolves it before actual permission/Hooks.
use crate::{Tool, ToolContext, ToolError, ToolOutput};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolExecuteInput {
    /// Exact deferred name returned by tool_search in this thread.
    pub tool_name: String,
    /// Tool arguments matching the schema in the latest ordinary discovery message.
    pub arguments: Value,
}

#[derive(Debug)]
pub struct ToolExecuteTool;

#[async_trait]
impl Tool for ToolExecuteTool {
    fn name(&self) -> String {
        "tool_execute".into()
    }
    fn description(&self) -> String {
        "Execute one deferred native feature, plugin or MCP tool previously discovered by tool_search in this KWorker thread. \
         Pass its exact registered tool_name and arguments matching the schema supplied in an \
         ordinary discovery message. This fixed entry keeps the native tool list unchanged. \
         Only previously discovered and currently authorized native feature, plugin or MCP tools may be invoked; no arbitrary command, \
         unknown name, nested tool_execute or same-batch search-and-execute is accepted. \
         Execution uses the real tool's schema, permissions, Hooks and cancellation rules. \
         Search again after restart, schema/source change or eviction from the bounded selection. \
         Do not retry an action with an unknown execution outcome without authoritative \
         reconciliation. Every search result is deferred, so this tool is its only route; a tool \
         the request already attaches is called directly through its own definition."
            .into()
    }
    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(ToolExecuteInput))
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    async fn call(&self, _: Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
        Err(ToolError::Execution(
            "tool_execute requires the owning Engine's request-bound dispatcher".into(),
        ))
    }
}
