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
}

impl MessageCommitConfirmation {
    pub(crate) fn committed(receipt: Option<NativeHistoryRowReceipt>) -> Self {
        Self {
            outcome: MessageCommitOutcome::Committed,
            receipt,
        }
    }

    pub(crate) fn ephemeral() -> Self {
        Self {
            outcome: MessageCommitOutcome::Ephemeral,
            receipt: None,
        }
    }

    pub(crate) fn outcome(&self) -> MessageCommitOutcome {
        self.outcome
    }

    pub(crate) fn take_receipt(&mut self) -> Option<NativeHistoryRowReceipt> {
        self.receipt.take()
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
