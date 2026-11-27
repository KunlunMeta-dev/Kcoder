//! Model-facing adapter for a dedicated Apps connection and durable widget receipts.
use anyhow::{Result, ensure};
use async_trait::async_trait;
use kcoder_tools::{Tool, ToolContext, ToolError, ToolExecutionMetadata, ToolOutput, ToolSource};
use kcoder_types::widgets::{WidgetIdentity, WidgetTurnBinding};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

pub struct McpPresentationTool {
    pub(super) inner: Arc<kcoder_mcp::McpTool>,
    pub(super) binding: WidgetTurnBinding,
    pub(super) session_directory: PathBuf,
    pub(super) owner: Arc<super::mcp_apps_runtime::AppConnection>,
}

impl McpPresentationTool {
    pub fn native_source_reader(
        &self,
    ) -> Result<Arc<kcoder_engine::integrations::core::NativeResourceReadAuthority>> {
        let raw = match self.inner.source() {
            ToolSource::Mcp { tool, .. } | ToolSource::Plugin { tool, .. } => tool,
            _ => anyhow::bail!("TASK_RESOURCE_NATIVE_SOURCE_REQUIRED"),
        };
        let reader = self.owner.resource_reader_for(
            &self.binding.turn_id,
            &self.binding.attempt_id,
            &raw,
        )?;
        ensure!(
            self.owner.live()
                && self.inner.app_authority_current()
                && reader.emitter().source() == &self.inner.source()
                && reader.emitter().tool().input_schema() == self.inner.input_schema(),
            "TASK_RESOURCE_APP_SOURCE_CHANGED"
        );
        Ok(reader)
    }
}

#[async_trait]
impl Tool for McpPresentationTool {
    fn name(&self) -> String {
        self.inner.name()
    }
    fn source(&self) -> ToolSource {
        self.inner.source()
    }
    fn is_model_visible(&self) -> bool {
        self.inner.is_model_visible()
    }
    fn is_app_visible(&self) -> bool {
        self.inner.is_app_visible()
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn description(&self) -> String {
        self.inner.description()
    }
    fn input_schema(&self) -> Value {
        self.inner.input_schema()
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let _lease = self.owner.lease.read().await;
        if !self.owner.live() {
            return Err(ToolError::InvalidInput(
                "MCP App connection was revoked".into(),
            ));
        }
        if ctx.state.session_id() != self.binding.thread_id {
            return Err(ToolError::InvalidInput(
                "MCP Apps adapter belongs to another conversation".into(),
            ));
        }
        let mut output = tokio::select! { biased;
            _ = self.owner.cancel.cancelled()=>return Err(ToolError::InvalidInput("MCP App connection was revoked".into())),
            output=self.inner.call(input, ctx)=>output?,
        };
        if !self.owner.live() {
            return Ok(output);
        }
        let mut metadata = Vec::new();
        for entry in std::mem::take(&mut output.execution_metadata) {
            match entry {
                ToolExecutionMetadata::McpApp(view) => {
                    let call = ctx
                        .tool_call_id
                        .as_deref()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| {
                            ToolError::InvalidInput(
                                "MCP App requires an owned tool call identity".into(),
                            )
                        })?;
                    let identity = WidgetIdentity {
                        thread_id: self.binding.thread_id.clone(),
                        turn_id: self.binding.turn_id.clone(),
                        attempt_id: self.binding.attempt_id.clone(),
                        tool_call_id: call.into(),
                    };
                    let title = bounded(
                        &format!("{} · {}", view.server_name, view.tool_name),
                        kcoder_types::widgets::WIDGET_TITLE_BYTES,
                    );
                    let summary = bounded(
                        &output
                            .content
                            .iter()
                            .filter_map(|block| match block {
                                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                        kcoder_types::widgets::WIDGET_SUMMARY_BYTES,
                    );
                    let committed = kcoder_state::widgets::WidgetStore::open(
                        &self.session_directory,
                        &self.binding.thread_id,
                    )
                    .and_then(|store| store.commit_mcp_app(identity, title, summary, view));
                    match committed {
                        Ok(reference)=>{
                            output.content.push(kcoder_types::ContentBlock::Text{text:format!("An inline MCP App was committed. Include ::kcoder-widget{{widget_id=\"{}\" revision={}}} on its own line in the final answer. Do not replay the tool call to recreate this view.",reference.widget_id,reference.revision)});
                            metadata.push(ToolExecutionMetadata::Widget(reference));
                        }
                        Err(_)=>output.content.push(kcoder_types::ContentBlock::Text{text:"The tool returned its result, but its inline view could not be retained. Do not repeat the external action to recreate the view.".into()}),
                    }
                }
                other => metadata.push(other),
            }
        }
        output.execution_metadata = metadata;
        Ok(output)
    }
}
fn bounded(value: &str, max: usize) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].into()
}
