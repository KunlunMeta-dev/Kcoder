//! Process-local result of the original input writer.
use super::NativeHistoryRowReceipt;

#[derive(Clone, Copy)]
pub(crate) enum MessageCommitOutcome {
    Committed,
    Ephemeral,
}

pub(crate) struct MessageCommitConfirmation {
    outcome: MessageCommitOutcome,
    receipt: Option<NativeHistoryRowReceipt>,
    user_reset: Option<crate::peer_wake_budget::FreshPeerUserAppend>,
}

impl MessageCommitConfirmation {
    pub(crate) fn committed(receipt: Option<NativeHistoryRowReceipt>) -> Self {
        Self {
            outcome: MessageCommitOutcome::Committed,
            receipt,
            user_reset: None,
        }
    }

    pub(crate) fn ephemeral() -> Self {
        Self {
            outcome: MessageCommitOutcome::Ephemeral,
            receipt: None,
            user_reset: None,
        }
    }

    pub(crate) fn outcome(&self) -> MessageCommitOutcome {
        self.outcome
    }

    pub(crate) fn take_receipt(&mut self) -> Option<NativeHistoryRowReceipt> {
        self.receipt.take()
    }
    pub(crate) fn with_user_reset(
        mut self,
        evidence: Option<crate::peer_wake_budget::FreshPeerUserAppend>,
    ) -> Self {
        self.user_reset = evidence;
        self
    }
    pub(crate) fn user_reset(&self) -> Option<&crate::peer_wake_budget::FreshPeerUserAppend> {
        self.user_reset.as_ref()
    }
}

impl std::fmt::Debug for MessageCommitConfirmation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MessageCommitConfirmation")
            .field("has_receipt", &self.receipt.is_some())
            .finish()
    }
}
