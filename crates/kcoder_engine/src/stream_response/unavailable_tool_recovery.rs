//! Reject unsolicited model calls before tool events, previews or history exist.
use kcoder_types::ContentBlock;
use std::collections::HashSet;

pub(super) const REJECTION: &str =
    "A tool request unavailable in the current request was rejected before execution.";
pub(super) const FEEDBACK: &str = "Your previous response requested a tool absent from the tool definitions attached to that request. That call was not executed, and its arguments were discarded. Use only the current tool definitions, or explain why the task cannot proceed.";
pub(super) const EXHAUSTED: &str = "UNAVAILABLE_TOOL_RECOVERY_EXHAUSTED";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    None,
    Retry,
    Stop,
}

#[derive(Default)]
pub(super) struct UnavailableToolRecovery {
    rejected_indices: HashSet<usize>,
    recovered: bool,
}
impl UnavailableToolRecovery {
    pub(super) fn begin_attempt(&mut self) {
        self.rejected_indices.clear();
    }

    /// Names are from the immutable request, never the live backing registry.
    /// Do not retain the rejected name, arguments, call id or derived previews.
    pub(super) fn reject_block(
        &mut self,
        index: usize,
        block: &ContentBlock,
        enabled: bool,
        available: &HashSet<String>,
    ) -> bool {
        if self.rejected_indices.contains(&index) {
            return true;
        }
        if enabled
            && let ContentBlock::ToolUse { name, .. } = block
            && !available.contains(name)
        {
            self.rejected_indices.insert(index);
            return true;
        }
        false
    }

    pub(super) fn ignores(&self, index: usize) -> bool {
        self.rejected_indices.contains(&index)
    }

    pub(super) fn finish_response(&mut self) -> Action {
        if self.rejected_indices.is_empty() {
            return Action::None;
        }
        if std::mem::replace(&mut self.recovered, true) {
            Action::Stop
        } else {
            Action::Retry
        }
    }
}
