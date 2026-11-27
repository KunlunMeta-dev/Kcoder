//! Office-specific Provider projection; State history and the native tool prefix remain intact.
#[path = "history_call.rs"]
mod history_call;
use anyhow::{Result, ensure};
use async_trait::async_trait;
use history_call::OfficeHistoryCall;
use kcoder_tools::ToolSource;
use kcoder_types::{ContentBlock, Message, SharedMessages, integrations::office::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(test)]
#[path = "native_projection_tests.rs"]
mod tests;

pub struct NativeOfficeToolProjectionRequest<'a> {
    pub session_id: &'a str,
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub original_input: &'a Value,
    pub input_sha256: &'a str,
}
/// Only the authenticated Office factory installs this authority. Resolving
/// reads the exact private native receipt and current source grants, not a
/// marker embedded in model or imported conversation text.
#[async_trait]
pub trait NativeOfficeToolProjectionAuthority: Send + Sync {
    /// Only the current native Core Workflow owner may contribute a child's
    /// bounded tools. Presentation and ordinary child inheritance grant nothing.
    fn native_core_workflow_child(
        &self,
        _state: &kcoder_state::AppState,
    ) -> Option<NativeCoreWorkflowOfficeChildCapability> {
        None
    }
    async fn resolve(
        &self,
        request: &NativeOfficeToolProjectionRequest<'_>,
    ) -> Result<Option<NativeOfficeToolProjection>>;
}
/// One non-serializable current-child capability, shared by discovery,
/// registry contribution and the native Office service boundary.
pub struct NativeCoreWorkflowOfficeChildCapability {
    state: kcoder_state::AppStateLifecycleIdentity,
    attempt: kcoder_types::TurnAttemptIdentity,
    tools: kcoder_tools::ToolRegistry,
}
impl NativeCoreWorkflowOfficeChildCapability {
    pub fn capture_native_owner(
        state: &kcoder_state::AppState,
        tools: kcoder_tools::ToolRegistry,
    ) -> Result<Self> {
        let expected = [
            "AutomationSourceRead",
            "OfficeDocument",
            "tool_execute",
            "tool_search",
        ];
        let mut names = tools.names();
        names.sort();
        ensure!(names == expected, "NATIVE_OFFICE_WORKFLOW_TOOLS_INVALID");
        ensure!(
            tools.get("OfficeDocument").is_some_and(|tool| {
                let actual: &dyn std::any::Any = tool.as_ref();
                actual.is::<kcoder_tools::integrations::office::OfficeDocumentTool>()
            }),
            "NATIVE_OFFICE_WORKFLOW_TOOLS_INVALID"
        );
        Ok(Self {
            state: state.inspection_lifecycle_identity(),
            attempt: state
                .current_history_attempt_identity()
                .ok_or_else(|| anyhow::anyhow!("NATIVE_OFFICE_WORKFLOW_ACCEPTED_REQUIRED"))?,
            tools,
        })
    }
    pub fn verify_current(&self, state: &kcoder_state::AppState) -> bool {
        self.state.matches(state)
            && state.current_history_attempt_identity().as_ref() == Some(&self.attempt)
    }
    pub(crate) fn tools(
        &self,
        state: &kcoder_state::AppState,
    ) -> Result<kcoder_tools::ToolRegistry> {
        ensure!(
            self.verify_current(state),
            "NATIVE_OFFICE_WORKFLOW_OWNER_CHANGED"
        );
        Ok(self.tools.clone())
    }
}
/// Native-only resolution result; intentionally has no Deserialize implementation.
pub struct NativeOfficeToolProjection {
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub original_source: ToolSource,
    pub input_sha256: String,
    pub operation_id: String,
    pub canonical_source: OfficeCanonicalSourceDescriptor,
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OfficeNativeProjectionStats {
    pub projected_calls: usize,
    pub original_input_bytes: usize,
    pub projected_input_bytes: usize,
    pub unmatched_office_calls: usize,
}

pub fn office_tool_input_sha256(input: &Value) -> Result<String> {
    fn normalized(input: &Value, depth: usize) -> Result<Value> {
        ensure!(depth <= 64, "OFFICE_PROJECTION_INPUT_INVALID");
        Ok(match input {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, value)| Ok((key.clone(), normalized(value, depth + 1)?)))
                    .collect::<Result<std::collections::BTreeMap<_, _>>>()?
                    .into_iter()
                    .collect(),
            ),
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|value| normalized(value, depth + 1))
                    .collect::<Result<_>>()?,
            ),
            other => other.clone(),
        })
    }
    let bytes = serde_json::to_vec(&normalized(input, 0)?)?;
    ensure!(
        bytes.len() <= 2 * 1024 * 1024,
        "OFFICE_PROJECTION_INPUT_TOO_LARGE"
    );
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

/// Root calls after reading the State snapshot and before Provider counting /
/// serialization. Only affected request payloads detach from shared history.
pub async fn project_native_office_tool_inputs(
    messages: &mut SharedMessages,
    session_id: &str,
    authority: &dyn NativeOfficeToolProjectionAuthority,
) -> Result<OfficeNativeProjectionStats> {
    let mut changes = Vec::new();
    let mut stats = OfficeNativeProjectionStats::default();
    for (message_index, message) in messages.iter().enumerate() {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for (block_index, block) in content.iter().enumerate() {
            let ContentBlock::ToolUse { id, name, input } = block else {
                continue;
            };
            let Some(call) = OfficeHistoryCall::parse(name, input) else {
                continue;
            };
            let sha = office_tool_input_sha256(call.arguments())?;
            let request = NativeOfficeToolProjectionRequest {
                session_id,
                tool_call_id: id,
                tool_name: "OfficeDocument",
                original_input: call.arguments(),
                input_sha256: &sha,
            };
            let Some(resolved) = authority.resolve(&request).await? else {
                stats.unmatched_office_calls += 1;
                continue;
            };
            resolved.canonical_source.validate()?;
            ensure!(
                resolved.session_id == session_id
                    && resolved.tool_call_id == *id
                    && resolved.tool_name == "OfficeDocument"
                    && resolved.input_sha256 == sha
                    && resolved.operation_id == resolved.canonical_source.operation_id
                    && resolved.canonical_source.task.thread_id == session_id,
                "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
            );
            ensure!(
                matches!(&resolved.original_source,ToolSource::NativeFeature{feature,tool,revision} if feature=="office"&&tool=="OfficeDocument"&&!revision.is_empty()),
                "OFFICE_NATIVE_PROJECTION_SOURCE_MISMATCH"
            );
            let descriptor = resolved.canonical_source;
            let projected = json!({"_storedOfficeGenerationSource":{"id":descriptor.id,"revision":descriptor.revision,"artifact":descriptor.artifact,"specificationSha256":descriptor.specification_sha256,"specificationBytes":descriptor.specification_bytes,"schemaRevision":descriptor.generator.schema_revision},"originalInputSha256":sha,"note":"Historical OfficeDocument call. Its complete original input remains in private native storage. This bounded reference is context only, not executable tool arguments or permission. Read the exact authorized canonical source only when needed."});
            let projected = call.project(projected);
            let before = serde_json::to_vec(input)?.len();
            let after = serde_json::to_vec(&projected)?.len();
            ensure!(after <= 4096, "OFFICE_NATIVE_PROJECTION_TOO_LARGE");
            stats.projected_calls += 1;
            stats.original_input_bytes = stats
                .original_input_bytes
                .checked_add(before)
                .ok_or_else(|| anyhow::anyhow!("OFFICE_PROJECTION_OVERFLOW"))?;
            stats.projected_input_bytes = stats
                .projected_input_bytes
                .checked_add(after)
                .ok_or_else(|| anyhow::anyhow!("OFFICE_PROJECTION_OVERFLOW"))?;
            changes.push((message_index, block_index, projected));
        }
    }
    for (message_index, block_index, projected) in changes {
        let Some(Message::Assistant { content, .. }) = messages.get_mut(message_index) else {
            anyhow::bail!("OFFICE_PROJECTION_INPUT_CHANGED")
        };
        let Some(ContentBlock::ToolUse { input, .. }) = content.get_mut(block_index) else {
            anyhow::bail!("OFFICE_PROJECTION_INPUT_CHANGED")
        };
        *input = projected;
    }
    if stats.projected_calls > 0 {
        // Historical usage anchors measured a different request body. Retain
        // their authoritative values in State, but estimate this detached view.
        let stale_usage = messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| {
                matches!(message, Message::Assistant { usage: Some(_), .. }).then_some(index)
            })
            .collect::<Vec<_>>();
        for index in stale_usage {
            if let Some(Message::Assistant { usage, .. }) = messages.get_mut(index) {
                *usage = None;
            }
        }
    }
    Ok(stats)
}
