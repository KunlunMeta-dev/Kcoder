//! Bounded backpressure for the same original receipt, never message dispatch.
use anyhow::Result;
use std::time::Duration;

const ATTEMPTS: usize = 3;
const PAUSE: Duration = Duration::from_millis(2);

pub(crate) fn is_busy(error: &anyhow::Error) -> bool {
    kcoder_state::cross_session_messages::CrossSessionMessageStore::is_temporary_read_contention(
        error,
    ) || error.chain().any(|cause| {
        matches!(
            cause.to_string().as_str(),
            "AGENT_MESSAGE_BUSY"
                | "peer_router_busy"
                | "peer_source_busy"
                | "peer_source_settings_busy"
                | "peer_source_permissions_busy"
                | "peer_message_host_busy"
        )
    })
}

/// The owned blocking worker rechecks current authority inside every attempt.
/// Only original-ID reads and their idempotent receipt checkpoint belong here.
pub(crate) fn read_current<R>(mut read: impl FnMut() -> Result<R>) -> Result<R> {
    for attempt in 0..ATTEMPTS {
        match read() {
            Err(error) if attempt + 1 < ATTEMPTS && is_busy(&error) => std::thread::sleep(PAUSE),
            result => return result,
        }
    }
    unreachable!()
}

/// Revalidate after an async result without blocking the connection executor.
pub(crate) async fn verify_current(mut verify: impl FnMut() -> Result<()>) -> Result<()> {
    for attempt in 0..ATTEMPTS {
        match verify() {
            Err(error) if attempt + 1 < ATTEMPTS && is_busy(&error) => {
                tokio::time::sleep(PAUSE).await
            }
            result => return result,
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contention_rechecks_the_same_read_but_never_retries_revocation_or_corruption() {
        let mut calls = 0;
        assert_eq!(
            read_current(|| {
                calls += 1;
                if calls == 1 {
                    anyhow::bail!("AGENT_MESSAGE_BUSY");
                }
                Ok("original-receipt")
            })
            .unwrap(),
            "original-receipt"
        );
        assert_eq!(calls, 2);
        for code in [
            "peer_source_owner_changed",
            "peer_source_owner_closed",
            "AGENT_MESSAGE_NAMESPACE_CHANGED",
        ] {
            let mut calls = 0;
            let error = read_current::<()>(|| {
                calls += 1;
                if calls == 1 {
                    anyhow::bail!("peer_source_busy");
                }
                anyhow::bail!(code);
            })
            .unwrap_err();
            assert_eq!(error.to_string(), code);
            assert_eq!(
                calls, 2,
                "a denied current check cannot borrow an earlier allow"
            );
        }
        let mut calls = 0;
        assert!(
            read_current::<()>(|| {
                calls += 1;
                anyhow::bail!("AGENT_MESSAGE_BUSY")
            })
            .is_err()
        );
        assert_eq!(calls, ATTEMPTS);
    }
}
