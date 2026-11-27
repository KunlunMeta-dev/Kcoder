//! Tolerate brief Windows scheduling stalls without masking a dead observer.
pub(crate) const HEARTBEAT_GRACE_MS: u64 = 3_000;
pub(crate) fn heartbeat_is_fresh(elapsed_ms: u64, last_heartbeat_ms: u64) -> bool {
    elapsed_ms <= last_heartbeat_ms.saturating_add(HEARTBEAT_GRACE_MS)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tolerates_short_stalls_but_rejects_expired_heartbeat() {
        assert!(heartbeat_is_fresh(1_501, 1_000));
        assert!(heartbeat_is_fresh(3_999, 1_000));
        assert!(heartbeat_is_fresh(4_000, 1_000));
        assert!(!heartbeat_is_fresh(4_001, 1_000));
        assert!(heartbeat_is_fresh(4_001, 4_000));
    }
}
