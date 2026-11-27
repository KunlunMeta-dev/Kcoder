//! Route the actual App action through its retained source and receipt.

use async_trait::async_trait;
use kcoder_app_protocol::{McpAppOperationStatus as Status, McpAppReadParams};
use kcoder_mcp_app_storage::ledger::OperationStore;
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolSource};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

pub struct AppActionTool {
    inner: Arc<kcoder_mcp::McpTool>,
    session: PathBuf,
    binding: McpAppReadParams,
    operation: String,
    source_reader: Arc<kcoder_engine::integrations::core::NativeResourceReadAuthority>,
}
impl AppActionTool {
    pub fn new(
        inner: Arc<kcoder_mcp::McpTool>,
        session: PathBuf,
        binding: McpAppReadParams,
        operation: String,
        source_reader: Arc<kcoder_engine::integrations::core::NativeResourceReadAuthority>,
    ) -> Self {
        Self {
            inner,
            session,
            binding,
            operation,
            source_reader,
        }
    }
}

#[async_trait]
impl Tool for AppActionTool {
    fn name(&self) -> String {
        self.inner.name()
    }
    fn source(&self) -> ToolSource {
        self.inner.source()
    }
    fn description(&self) -> String {
        self.inner.description()
    }
    fn input_schema(&self) -> Value {
        self.inner.input_schema()
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn is_model_visible(&self) -> bool {
        false
    }
    fn is_app_visible(&self) -> bool {
        true
    }
    async fn call(
        &self,
        input: Value,
        ctx: &ToolContext,
    ) -> std::result::Result<ToolOutput, ToolError> {
        self.source_reader
            .authorize_app_callback()
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let checked_context = self.source_reader.with_app_callback_context(ctx.clone());
        let ctx = &checked_context;
        let store = OperationStore::open(&self.session)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        store
            .transition(
                &self.binding,
                &self.operation,
                Status::Executing,
                None,
                None,
            )
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        // Persist the authoritative raw result before returning through Engine. A
        // transport loss keeps Executing/Unknown and cannot cause another dispatch.
        let result = self
            .inner
            .call_app_result(input, ctx)
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        let value =
            serde_json::to_value(result).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        store
            .transition(
                &self.binding,
                &self.operation,
                Status::Completed,
                Some(value),
                None,
            )
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        Ok(ToolOutput::text(
            "MCP App operation completed; its authoritative receipt is retained",
        ))
    }
}
