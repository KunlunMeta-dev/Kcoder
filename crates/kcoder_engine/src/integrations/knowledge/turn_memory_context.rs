//! Reviewed memory data in the ordinary system prompt, authorized by the accepted turn.
use crate::QueryEngine;
use anyhow::{Result, ensure};
use std::sync::Arc;

/// Native implementations recheck the original State, accepted receipt and live source authority.
/// This is not serializable and no request text can construct it.
pub trait NativeReviewedMemoryTurnContext: Send + Sync {
    fn system_prompt(&self, engine: &QueryEngine) -> Result<Option<String>>;
    /// Preparation metadata is a locator only; consumers must authorize any body read separately.
    fn snapshot_id(&self) -> Option<&str> {
        None
    }
}

impl QueryEngine {
    /// Bind only this engine value; peer/new task values must not inherit another turn's source.
    pub fn with_native_reviewed_memory_turn_context(
        mut self,
        binding: Arc<dyn NativeReviewedMemoryTurnContext>,
    ) -> Result<Self> {
        ensure!(
            self.native_reviewed_memory_turn
                .as_ref()
                .is_none_or(|current| Arc::ptr_eq(current, &binding)),
            "MEMORY_TURN_CONTEXT_ALREADY_BOUND"
        );
        self.native_reviewed_memory_turn = Some(binding);
        Ok(self)
    }

    pub(crate) fn has_native_reviewed_memory_turn_context(&self) -> bool {
        self.native_reviewed_memory_turn.is_some()
    }
    pub fn native_reviewed_memory_snapshot_id(&self) -> Option<&str> {
        self.native_reviewed_memory_turn
            .as_ref()
            .and_then(|binding| binding.snapshot_id())
    }

    /// Recheck before any Provider request; the returned text is never added to the transcript.
    pub(crate) fn native_reviewed_memory_system_prompt(&self) -> Result<Option<String>> {
        let Some(binding) = &self.native_reviewed_memory_turn else {
            return Ok(None);
        };
        binding
            .system_prompt(self)
            .map_err(|_| anyhow::anyhow!("MEMORY_TURN_CONTEXT_UNAVAILABLE"))
    }
}
