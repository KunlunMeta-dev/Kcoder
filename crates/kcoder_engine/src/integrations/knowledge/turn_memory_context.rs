//! Per-accepted-turn Runtime material projected into detached Provider requests.
use crate::QueryEngine;
use anyhow::{Result, ensure};
use kcoder_types::{Message, MessageOrigin, SharedMessages};
use std::sync::Arc;

/// Native implementations recheck the original State, accepted receipt and live source authority.
/// This is not serializable and no request text can construct it.
pub trait NativeReviewedMemoryTurnContext: Send + Sync {
    fn runtime_message(&self, engine: &QueryEngine) -> Result<Option<Message>>;
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

    /// Run before token accounting and Provider send. State and the fixed system/tool prefix stay intact.
    pub(crate) fn project_native_reviewed_memory_request(
        &self,
        messages: &mut SharedMessages,
    ) -> Result<()> {
        let Some(binding) = &self.native_reviewed_memory_turn else {
            return Ok(());
        };
        let message = binding
            .runtime_message(self)
            .map_err(|_| anyhow::anyhow!("MEMORY_TURN_CONTEXT_UNAVAILABLE"))?;
        if let Some(message) = message {
            ensure!(
                message.origin() == MessageOrigin::Runtime
                    && matches!(message, Message::User { .. }),
                "MEMORY_TURN_INVALID_RUNTIME_MATERIAL"
            );
            // Equality only deduplicates presentation; all authority came from the binding above.
            if !messages.iter().any(|existing| existing == &message) {
                messages.push(message);
            }
        }
        Ok(())
    }
}
