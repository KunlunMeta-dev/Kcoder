//! At most one body copy per selected guide in a provider batch, including parallel successful reads.
use std::{collections::BTreeSet, sync::Mutex};
#[derive(Default)]
pub(super) struct InstructionActivationGate {
    pending: Mutex<BTreeSet<String>>,
}
impl InstructionActivationGate {
    pub(super) fn begin_provider_boundary(&self) {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
    pub(super) fn reserve(&self, key: &str, already_present: impl FnOnce() -> bool) -> bool {
        if key.len() != 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return false;
        }
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.contains(key) || pending.len() >= 128 || already_present() {
            return false;
        }
        pending.insert(key.into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_parallel_reservations_are_bounded_and_a_new_provider_boundary_can_retry_unobserved_context()
     {
        let gate = std::sync::Arc::new(InstructionActivationGate::default());
        let threads = (0..16)
            .map(|_| {
                let gate = gate.clone();
                std::thread::spawn(move || gate.reserve(&"a".repeat(64), || false))
            })
            .collect::<Vec<_>>();
        assert_eq!(
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(|won| *won)
                .count(),
            1
        );
        gate.begin_provider_boundary();
        assert!(
            !gate.reserve(&"a".repeat(64), || true),
            "durable activation is not replayed"
        );
        assert!(
            gate.reserve(&"a".repeat(64), || false),
            "an unobserved result from an interrupted batch can be observed after the next boundary"
        );
    }
}
