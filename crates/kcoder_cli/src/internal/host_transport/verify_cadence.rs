//! Bounded re-verification for transport output frames.
//!
//! Complete owner/scope/peer verification opens private directories, reads
//! ACLs, takes the identity lock and (on Windows) reopens the peer image. Doing
//! that for every streamed notification made the original-host transport
//! unusably slow. Output frames are results of requests that were verified at
//! their own dispatch boundary, so they re-verify on a bounded cadence instead.
//! A failed verification is never remembered as success: the next frame
//! verifies again and the caller closes the transport on the error.
use anyhow::Result;
use std::time::{Duration, Instant};

/// Maximum time an output stream runs on the previous complete verification.
pub const OUTPUT_REVERIFY_INTERVAL: Duration = Duration::from_secs(1);

pub struct VerifyCadence {
    interval: Duration,
    verified_at: Option<Instant>,
}

impl VerifyCadence {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            verified_at: None,
        }
    }

    /// Run `verify` when no successful verification happened within the
    /// interval. Errors propagate and leave the cadence due.
    pub fn check(&mut self, now: Instant, verify: impl FnOnce() -> Result<()>) -> Result<()> {
        if self
            .verified_at
            .is_some_and(|at| now.saturating_duration_since(at) < self.interval)
        {
            return Ok(());
        }
        self.verified_at = None;
        verify()?;
        self.verified_at = Some(now);
        Ok(())
    }

    /// Record a complete verification performed by the caller (for example at
    /// a request boundary), so output frames right after it do not repeat it.
    pub fn verified(&mut self, now: Instant) {
        self.verified_at = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn warm_output_frames_verify_at_most_once_per_interval() {
        let calls = Cell::new(0);
        let mut cadence = VerifyCadence::new(Duration::from_secs(1));
        let start = Instant::now();
        for frame in 0..500u64 {
            let now = start + Duration::from_millis(frame);
            cadence
                .check(now, || {
                    calls.set(calls.get() + 1);
                    Ok(())
                })
                .unwrap();
        }
        assert_eq!(calls.get(), 1, "500 frames inside one interval");
        cadence
            .check(start + Duration::from_millis(1000), || {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(calls.get(), 2, "interval elapsed forces a full check");
    }

    #[test]
    fn revocation_fails_closed_and_is_never_cached_as_success() {
        let calls = Cell::new(0);
        let mut cadence = VerifyCadence::new(Duration::from_secs(1));
        let start = Instant::now();
        cadence.check(start, || Ok(())).unwrap();
        let revoked = start + Duration::from_secs(1);
        for offset in 0..3u64 {
            let error = cadence
                .check(revoked + Duration::from_millis(offset), || {
                    calls.set(calls.get() + 1);
                    anyhow::bail!("INTEGRATION_IDENTITY_REVOKED")
                })
                .unwrap_err();
            assert_eq!(error.to_string(), "INTEGRATION_IDENTITY_REVOKED");
        }
        assert_eq!(calls.get(), 3, "every frame after a failure re-verifies");
    }

    #[test]
    fn request_boundary_verification_resets_the_output_window() {
        let calls = Cell::new(0);
        let mut cadence = VerifyCadence::new(Duration::from_secs(1));
        let start = Instant::now();
        cadence.verified(start);
        cadence
            .check(start + Duration::from_millis(999), || {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(calls.get(), 0);
    }
}
