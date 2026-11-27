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
    /// Arguments matching the schema in the latest discovery message.
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
        "Run one deferred plugin, MCP or native-feature tool that tool_search returned in this \
         thread: its exact registered tool_name plus arguments matching the schema from that discovery \
         message. Only previously discovered, currently authorized tools are accepted; no unknown name, \
         arbitrary command, nested tool_execute or same-batch search-and-execute. The real tool's schema, \
         permissions, Hooks and cancellation apply. Tools attached directly to the request are called \
         through their own definitions. Search again after a restart, schema/source change or eviction. \
         Never retry an action with an unknown outcome without authoritative reconciliation."
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
