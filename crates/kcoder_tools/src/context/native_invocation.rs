//! Actual post-approval Native dispatch receipt. No name, metadata or JSON can construct an invocation.
use super::*;
use crate::Tool;
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_types::TurnAttemptIdentity;
use sha2::{Digest, Sha256};
use std::sync::Weak;

pub(super) struct NativeToolInvocation {
    tool: Weak<dyn Tool>,
    state: AppStateLifecycleIdentity,
    attempt: Option<TurnAttemptIdentity>,
    web_source_identity: Option<TurnAttemptIdentity>,
    call: String,
    input_sha256: String,
}
impl ToolContext {
    /// The Engine calls only after ordinary permissions, Hooks, sandbox and
    /// current Native dispatch authorization, immediately before this exact Tool.
    /// The weak object reference avoids a retained tool/backend/context cycle.
    pub fn with_native_tool_invocation(
        mut self,
        tool: &Arc<dyn Tool>,
        effective_input: &Value,
    ) -> Result<Self, ToolError> {
        let call = self
            .tool_call_id
            .clone()
            .ok_or_else(|| ToolError::Execution("NATIVE_TOOL_DISPATCH_CALL_REQUIRED".into()))?;
        let input_sha256 = input_hash(effective_input)
            .ok_or_else(|| ToolError::Execution("NATIVE_TOOL_DISPATCH_INPUT_UNAVAILABLE".into()))?;
        self.native_invocation = Some(Arc::new(NativeToolInvocation {
            tool: Arc::downgrade(tool),
            state: self.state.inspection_lifecycle_identity(),
            attempt: self.state.current_history_attempt_identity(),
            web_source_identity: self.native_web_source_identity.clone(),
            call,
            input_sha256,
        }));
        Ok(self)
    }
    /// Verify the actual native object/State epoch/attempt/call/final input.
    /// Direct Tool calls and a same-name MCP/plugin object cannot borrow this receipt.
    pub fn authorizes_native_tool_invocation<T: Tool>(
        &self,
        candidate: &T,
        effective_input: &Value,
    ) -> bool {
        let Some(receipt) = &self.native_invocation else {
            return false;
        };
        let Some(tool) = receipt.tool.upgrade() else {
            return false;
        };
        let object: &dyn std::any::Any = tool.as_ref();
        object
            .downcast_ref::<T>()
            .is_some_and(|actual| std::ptr::eq(actual, candidate))
            && receipt.state.matches(&self.state)
            && receipt.attempt == self.state.current_history_attempt_identity()
            && receipt.web_source_identity == self.native_web_source_identity
            && self.tool_call_id.as_deref() == Some(receipt.call.as_str())
            && !receipt.call.is_empty()
            && input_hash(effective_input).as_ref() == Some(&receipt.input_sha256)
    }
}
fn input_hash(value: &Value) -> Option<String> {
    serde_json::to_vec(value)
        .ok()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
}
