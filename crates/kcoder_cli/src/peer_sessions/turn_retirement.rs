//! The actual host retires authorization immediately. Only a commit already
//! holding the real turn gate may delay release of the original kernel FD.
use super::*;
use kcoder_cli_storage::session_lease::{SessionLease, SessionLeaseRetirement};

struct TurnAdmissionRetirement {
    turns: kcoder_engine::owned_turn::OwnedTurnObserver,
    source: Option<std::sync::Weak<BoundPeerSource>>,
}
impl std::fmt::Debug for TurnAdmissionRetirement {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TurnAdmissionRetirement { original_owner }")
    }
}
impl SessionLeaseRetirement for TurnAdmissionRetirement {
    fn retain_original_file(&self, owned: Box<dyn Send>) {
        if let Some(source) = self.source.as_ref().and_then(std::sync::Weak::upgrade) {
            source.revoke();
        }
        self.turns.revoke_active();
        self.turns.retain_until_admissions_released(owned);
    }
}

pub(crate) fn bind(
    lease: &mut SessionLease,
    engine: &QueryEngine,
    source: Option<&Arc<BoundPeerSource>>,
) {
    assert!(
        lease.matches_target(&engine.session_lease_target()),
        "original turn lease target differs"
    );
    lease.bind_retirement(Arc::new(TurnAdmissionRetirement {
        turns: engine.owned_turn_observer(),
        source: source.map(Arc::downgrade),
    }));
}
