//! Classification regressions; Native history/configuration checks remain real verifier tests.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn a_current_live_owner_never_falls_back_to_cold_configuration() {
    let calls = AtomicUsize::new(0);
    let value = after_live_check(Ok(17), || {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(99)
    })
    .unwrap();
    assert_eq!(value, 17);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn busy_denied_corrupt_scope_or_matching_error_text_never_selects_cold() {
    for reason in [
        "peer_source_busy",
        "peer_source_current_authorization_unavailable",
        "peer_source_scope_changed",
        "peer_source_history_replaced",
        "peer_source_native_image_changed",
        "peer_source_connect_timeout",
        "peer_source_endpoint_absent",
    ] {
        let calls = AtomicUsize::new(0);
        let result = after_live_check::<()>(Err(anyhow::anyhow!(reason.to_owned())), || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        assert!(result.is_err(), "{reason}");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "{reason}");
    }
}

#[test]
fn typed_kernel_absence_requires_the_fresh_cold_verifier_result() {
    let calls = AtomicUsize::new(0);
    let absent = anyhow::Error::new(OriginalSourceUnavailable).context("actual carrier connect");
    let result = after_live_check::<()>(Err(absent), || {
        calls.fetch_add(1, Ordering::SeqCst);
        anyhow::bail!("owned current source permission revoked")
    });
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("permission revoked")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        after_live_check(Err(OriginalSourceUnavailable.into()), || Ok(23)).unwrap(),
        23
    );
}
