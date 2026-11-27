//! Main-provider logical request diagnostics; summary calls have a separate lifecycle.

use crate::EngineEvent;
use kcoder_state::{AppState, RecoveryCapture, RecoveryDecision, RecoveryOutcome};

#[derive(Default)]
pub(super) struct RecoveryRecord {
    capture: Option<RecoveryCapture>,
    invocation: u64,
}

impl RecoveryRecord {
    pub(super) async fn ensure_started(&mut self, state: &AppState) {
        if self.capture.is_none() {
            self.invocation = 0;
            self.capture = Some(state.begin_recovery_record().await);
        }
    }

    pub(super) fn begin(&mut self, decision: RecoveryDecision) {
        if let Some(capture) = &mut self.capture {
            capture.begin(self.invocation, decision);
        }
    }

    pub(super) fn invoke(&mut self) {
        self.invocation += 1;
        self.begin(RecoveryDecision::Invoke);
    }

    pub(super) fn complete(&mut self, outcome: RecoveryOutcome) {
        if let Some(capture) = &mut self.capture {
            capture.complete(outcome);
        }
    }

    pub(super) fn stop(&mut self, outcome: RecoveryOutcome) {
        self.complete(outcome);
        self.begin(RecoveryDecision::Stop);
        self.complete(outcome);
    }

    pub(super) fn stopped(&mut self, event: &EngineEvent) {
        self.stop(if matches!(event, EngineEvent::StreamAborted { .. }) {
            RecoveryOutcome::Cancelled
        } else {
            RecoveryOutcome::DeadlineExceeded
        });
    }

    pub(super) fn compact_result(&mut self, compacted: Result<bool, ()>) {
        let outcome = match compacted {
            Ok(true) => RecoveryOutcome::CompactSucceeded,
            Ok(false) => RecoveryOutcome::CompactNoop,
            Err(()) => RecoveryOutcome::CompactFailed,
        };
        self.complete(outcome);
    }

    pub(super) fn rejected(&mut self, budget: bool) {
        self.begin(RecoveryDecision::RetryWait);
        self.complete(if budget {
            RecoveryOutcome::BudgetRejected
        } else {
            RecoveryOutcome::PolicyRejected
        });
    }

    pub(super) fn success(&mut self) {
        self.complete(RecoveryOutcome::Success);
        drop(self.capture.take());
    }

    pub(super) fn provider_failed(&mut self, details: &kcoder_types::ProviderFailureDetails) {
        self.complete(RecoveryOutcome::Failed);
        if details.recovery_action == kcoder_types::ProviderFailureRecoveryAction::NeedsHuman {
            self.begin(RecoveryDecision::NeedsHuman);
            self.complete(RecoveryOutcome::PolicyRejected);
        }
        self.stop(RecoveryOutcome::Failed);
    }
}
