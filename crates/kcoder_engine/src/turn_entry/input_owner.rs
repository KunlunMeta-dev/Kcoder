use kcoder_state::{AppState, AppStateLifecycleIdentity, CommittedUserInput};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{OwnedRwLockReadGuard, RwLock};
use tokio_util::sync::CancellationToken;

pub(super) enum OwnerObservation {
    Current,
    Changed,
    Unavailable,
    Cancelled,
}

pub(super) struct InputAdmissionGuard {
    // The sticky result is set in Drop before this read guard is released.
    _gate: OwnedRwLockReadGuard<()>,
    failed: Arc<AtomicBool>,
    armed: bool,
}

impl InputAdmissionGuard {
    pub(super) fn try_start(gate: &Arc<RwLock<()>>, failed: &Arc<AtomicBool>) -> Option<Self> {
        let guard = Arc::clone(gate).try_read_owned().ok()?;
        if failed.load(Ordering::Acquire) {
            return None;
        }
        Some(Self {
            _gate: guard,
            failed: Arc::clone(failed),
            armed: false,
        })
    }
    pub(super) fn arm(&mut self) {
        self.armed = true;
    }
    pub(super) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for InputAdmissionGuard {
    fn drop(&mut self) {
        if self.armed {
            self.failed.store(true, Ordering::Release);
        }
    }
}

pub(super) async fn wait_for_input(
    input: &CommittedUserInput,
    cancel: &CancellationToken,
) -> OwnerObservation {
    let mut delay = Duration::from_millis(5);
    loop {
        if cancel.is_cancelled() {
            return OwnerObservation::Cancelled;
        }
        match input.try_is_current() {
            Ok(true) => return OwnerObservation::Current,
            Ok(false) => {}
            Err(_) => return OwnerObservation::Changed,
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return OwnerObservation::Cancelled,
            _ = futures_timer::Delay::new(delay) => {}
        }
        delay = delay.saturating_mul(2).min(Duration::from_millis(250));
    }
}

/// Observe the already accepted owner without waiting on the runtime thread.
pub(super) async fn wait_for_owner(
    state: &AppState,
    owner: &AppStateLifecycleIdentity,
    cancel: &CancellationToken,
) -> OwnerObservation {
    let mut delay = Duration::from_millis(5);
    loop {
        if cancel.is_cancelled() {
            return OwnerObservation::Cancelled;
        }
        match state.try_check_lifecycle_identity(owner) {
            Ok(Some(true)) => return OwnerObservation::Current,
            Ok(Some(false)) => return OwnerObservation::Changed,
            Err(_) => return OwnerObservation::Unavailable,
            Ok(None) => {}
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return OwnerObservation::Cancelled,
            _ = futures_timer::Delay::new(delay) => {}
        }
        delay = delay.saturating_mul(2).min(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abandoned_armed_admission_marks_unknown_before_releasing_gate() {
        let gate = Arc::new(RwLock::new(()));
        let failed = Arc::new(AtomicBool::new(false));
        let mut guard = InputAdmissionGuard::try_start(&gate, &failed).unwrap();
        guard.arm();
        assert!(Arc::clone(&gate).try_write_owned().is_err());
        drop(guard);
        let _ending = Arc::clone(&gate).try_write_owned().unwrap();
        assert!(failed.load(Ordering::Acquire));
    }

    #[test]
    fn busy_before_admission_is_safe_and_shutdown_gate_rejects_new_input() {
        let gate = Arc::new(RwLock::new(()));
        let failed = Arc::new(AtomicBool::new(false));
        let mut guard = InputAdmissionGuard::try_start(&gate, &failed).unwrap();
        guard.arm();
        guard.disarm();
        drop(guard);
        assert!(!failed.load(Ordering::Acquire));
        let ending = Arc::clone(&gate).try_write_owned().unwrap();
        assert!(InputAdmissionGuard::try_start(&gate, &failed).is_none());
        drop(ending);
        assert!(InputAdmissionGuard::try_start(&gate, &failed).is_some());
    }
}
