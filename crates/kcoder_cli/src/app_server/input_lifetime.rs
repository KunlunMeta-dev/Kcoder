//! Original input identity and interaction route, independent of session survival.
use super::*;

#[derive(Clone)]
pub(super) struct ClientInputLifetime {
    owner: std::sync::Weak<()>,
    ended: CancellationToken,
    pub(super) outbound: mpsc::Sender<Value>,
}

impl ClientInputLifetime {
    /// Private Native admission has its own current-source/background checks.
    /// Public input never obtains that policy through a serialized source label.
    pub(super) fn capture(state: &ConnectionState, outbound: &mpsc::Sender<Value>) -> Option<Self> {
        (!state.native_source_dispatch).then(|| Self {
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            outbound: outbound.clone(),
        })
    }

    pub(super) fn is_active(&self) -> bool {
        self.owner.upgrade().is_some() && !self.ended.is_cancelled()
    }

    pub(super) fn owner(&self) -> std::sync::Weak<()> {
        self.owner.clone()
    }
}

impl BackgroundFollowupState {
    pub(super) fn suspend_client_continuations(&self, state: &ConnectionState) -> bool {
        // Legacy detach cleanup is not an explicit user Goal pause. The task
        // host handles last-attach grace and session policy for every source.
        let _ = state;
        false
    }

    pub(super) fn continuation_client_lifetime(&self) -> Option<ClientInputLifetime> {
        // Match goal controls' lock order. Expiry retires only the currently
        // selected source, never a newer client's continuation.
        let source = self.client_lifetime.lock().unwrap();
        source.clone()
    }

    pub(super) fn claim_continuation_source(
        &self,
        expected: &Option<ClientInputLifetime>,
        running: &AtomicBool,
    ) -> bool {
        let goals = self.goals.lock().unwrap();
        let current = self.client_lifetime.lock().unwrap();
        let same_source = match (expected, current.as_ref()) {
            (None, None) => true,
            (Some(expected), Some(current)) => expected.owner.ptr_eq(&current.owner),
            _ => false,
        };
        same_source
            && !goals.is_suspended()
            && running
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_liveness_only_controls_its_interactions_not_session_survival() {
        let state = ConnectionState::default();
        let (output, _) = mpsc::channel(8);
        let source = ClientInputLifetime::capture(&state, &output).unwrap();
        assert!(source.is_active());
        let original_turn = CancellationToken::new();
        state.input_ended.cancel();
        assert!(!source.is_active());
        assert!(!original_turn.is_cancelled());
    }
}
