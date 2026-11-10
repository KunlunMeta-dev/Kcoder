//! Remote delegation uses a native current-turn backend, never a model-supplied runner or grant.
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolSource, clean_schema, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
mod operation;
pub use operation::{RemoteOperationAction, RemoteOperationInput, RemoteOperationTool};

#[derive(Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteDelegateInput {
    pub peer_id: String,
    pub peer_revision: String,
    pub prompt: String,
    pub maximum_seconds: u32,
    /// Exact current Native Office input references; selectors grant no access.
    #[serde(default)]
    pub materials: Vec<kcoder_types::integrations::office::OfficeArtifactRef>,
}
impl RemoteDelegateInput {
    pub fn validate(&self) -> Result<(), ToolError> {
        let unique: std::collections::BTreeSet<_> = self
            .materials
            .iter()
            .map(|material| material.id.as_str())
            .collect();
        if self.materials.len() > 8
            || unique.len() != self.materials.len()
            || self.materials.iter().any(|material| {
                material.revision != 1
                    || material.id.is_empty()
                    || material.id.len() > 256
                    || material.id.chars().any(char::is_control)
            })
        {
            return Err(ToolError::InvalidInput("RemoteDelegate: materials must contain at most eight unique current Native Office input references at revision one".into()));
        }
        if self.peer_id.is_empty()
            || self.peer_id.len() > 128
            || self.peer_revision.len() != 64
            || !self
                .peer_revision
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.prompt.trim().is_empty()
            || self.prompt.len() > 48 * 1024
            || !(1..=1800).contains(&self.maximum_seconds)
        {
            return Err(ToolError::InvalidInput("RemoteDelegate: peerId/peerRevision must come from the current native catalog; prompt must contain 1..49152 bytes and maximumSeconds must be 1..1800".into()));
        }
        Ok(())
    }
}
#[async_trait]
pub trait RemoteDelegateBackend: Send + Sync {
    fn source_revision(&self) -> &str;
    fn catalog(&self, _actual: &ToolContext) -> Result<Value, ToolError> {
        Err(ToolError::Execution(
            "REMOTE_NATIVE_CATALOG_UNAVAILABLE".into(),
        ))
    }
    fn operation(
        &self,
        _input: RemoteOperationInput,
        _actual: &ToolContext,
    ) -> Result<Value, ToolError> {
        Err(ToolError::Execution(
            "REMOTE_NATIVE_OPERATION_UNAVAILABLE".into(),
        ))
    }
    async fn delegate(
        &self,
        input: RemoteDelegateInput,
        actual: &ToolContext,
    ) -> Result<Value, ToolError>;
}
pub struct RemoteCatalogTool {
    backend: Arc<dyn RemoteDelegateBackend>,
}
impl RemoteCatalogTool {
    pub fn new(backend: Arc<dyn RemoteDelegateBackend>) -> Self {
        Self { backend }
    }
}
#[async_trait]
impl Tool for RemoteCatalogTool {
    fn name(&self) -> String {
        "RemoteCatalog".into()
    }
    fn source(&self) -> ToolSource {
        ToolSource::NativeFeature {
            feature: "remotes".into(),
            tool: self.name(),
            revision: self.backend.source_revision().into(),
        }
    }
    fn description(&self) -> String {
        "Read the actual current Native profile's explicitly configured ACP peer IDs/revisions and declared limits. This does not bind a receiver, start a process/thread/model, approve tools, transfer files or establish business readiness. Use exact returned peerId/revision for RemoteDelegate; unknown identity/budget remains unknown.".into()
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({"type":"object","additionalProperties":false})
    }
    fn is_read_only(&self) -> bool {
        true
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        true
    }
    async fn call(&self, input: Value, actual: &ToolContext) -> Result<ToolOutput, ToolError> {
        if !input.as_object().is_some_and(serde_json::Map::is_empty) {
            return Err(ToolError::InvalidInput(
                "RemoteCatalog expects an empty object".into(),
            ));
        }
        if !actual.authorizes_native_tool_invocation(self, &input) {
            return Err(ToolError::Execution(
                "REMOTE_NATIVE_APPROVAL_RECEIPT_REQUIRED".into(),
            ));
        }
        let catalog = self.backend.catalog(actual)?;
        Ok(ToolOutput::text(serde_json::to_string(&catalog).map_err(
            |_| ToolError::Execution("REMOTE_NATIVE_CATALOG_UNAVAILABLE".into()),
        )?))
    }
}
pub struct RemoteDelegateTool {
    backend: Arc<dyn RemoteDelegateBackend>,
}
impl RemoteDelegateTool {
    pub fn new(backend: Arc<dyn RemoteDelegateBackend>) -> Result<Self, ToolError> {
        if backend.source_revision().is_empty() || backend.source_revision().len() > 256 {
            return Err(ToolError::Execution(
                "REMOTE_NATIVE_SOURCE_UNAVAILABLE".into(),
            ));
        }
        Ok(Self { backend })
    }
}
#[async_trait]
impl Tool for RemoteDelegateTool {
    fn name(&self) -> String {
        "RemoteDelegate".into()
    }
    fn source(&self) -> ToolSource {
        ToolSource::NativeFeature {
            feature: "remotes".into(),
            tool: self.name(),
            revision: self.backend.source_revision().into(),
        }
    }
    fn description(&self) -> String {
        "Delegate one frozen bounded prompt to an explicitly selected installed native ACP peer. Use the exact peerId and peerRevision returned by the current remote catalog. Optional materials select up to eight existing Native Office inputs by exact id/revision; paths, excerpts and model-supplied hashes cannot replace stored input bytes. Sending requires normal final approval and the receiver's independent material opt-in and byte limit. Native transfer rechecks complete bytes/SHA and all Reader pages; untrusted material text never grants permissions. The native host binds the actual accepted turn, original ToolCall, independent receiver identity, installation and budget. No command, environment, model or permission flag can grant authority. This is an ordered external action subject to the normal permission and Hook path. Receiver permissions are independent; external permission requests are never automatically approved. Cancellation owns only this delegation. A protocol stop is an observation and does not prove validated business completion. Preserve the returned original operationId: after disconnect, missing receipt or unknown outcome, read that operation; never launch another peer or repeat the prompt to guess whether it ran. Results require native controlled Reader/artifact validation.".into()
    }
    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(RemoteDelegateInput))
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    async fn call(&self, value: Value, actual: &ToolContext) -> Result<ToolOutput, ToolError> {
        if !actual.authorizes_native_tool_invocation(self, &value) {
            return Err(ToolError::Execution(
                "REMOTE_NATIVE_APPROVAL_RECEIPT_REQUIRED".into(),
            ));
        }
        let input: RemoteDelegateInput = parse_input(&value)?;
        input.validate()?;
        if actual.is_aborted() {
            return Err(ToolError::Aborted);
        }
        if actual.tool_call_id.as_ref().is_none_or(|id| id.is_empty()) {
            return Err(ToolError::Execution("REMOTE_NATIVE_CALL_REQUIRED".into()));
        }
        let result = self.backend.delegate(input, actual).await?;
        let unknown = result.get("state").and_then(Value::as_str) == Some("outcome_unknown");
        let mut output = ToolOutput::text(
            serde_json::to_string(&result)
                .map_err(|_| ToolError::Execution("REMOTE_RESULT_INVALID".into()))?,
        );
        output.is_error = unknown;
        Ok(output)
    }
}
#[cfg(test)]
mod tests;
