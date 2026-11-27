//! Nonblocking, independently reserved process-owned slots.
use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};

const FREE: u8 = 0;
const RESERVED: u8 = 1;
const LIVE: u8 = 2;
const INSPECTING: u8 = 3;
const POISONED: u8 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SlotError {
    Busy,
    Full,
    Unavailable,
}

pub(crate) struct OwnedSlot<T> {
    state: AtomicU8,
    value: Mutex<Option<T>>,
}

impl<T> OwnedSlot<T> {
    pub(crate) const fn new() -> Self {
        Self {
            state: AtomicU8::new(FREE),
            value: Mutex::new(None),
        }
    }
}

struct Claim<'a, T> {
    slot: &'a OwnedSlot<T>,
    committed: bool,
}
impl<T> Drop for Claim<'_, T> {
    fn drop(&mut self) {
        if !self.committed {
            // An interrupted insertion cannot be adopted as an empty slot.
            self.slot.state.store(POISONED, Ordering::Release);
        }
    }
}

/// Inspect and reserve each slot independently; neither contention on another
/// slot nor a poisoned slot can make an unrelated free slot unavailable.
pub(crate) fn try_insert<T, R>(
    slots: &[OwnedSlot<T>],
    start: usize,
    reclaim: impl Fn(&T) -> bool,
    create: impl FnOnce() -> (T, R),
) -> Result<R, SlotError> {
    let mut create = Some(create);
    let mut transient = false;
    let mut unavailable = false;
    for offset in 0..slots.len() {
        let slot = &slots[start.wrapping_add(offset) % slots.len()];
        if slot
            .state
            .compare_exchange(LIVE, INSPECTING, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let mut inspection = Claim {
                slot,
                committed: false,
            };
            match slot.value.try_lock() {
                Ok(mut value) => {
                    if let Some(current) = value.as_ref() {
                        let reusable = reclaim(current);
                        if reusable {
                            value.take();
                        }
                        drop(value);
                        slot.state
                            .store(if reusable { FREE } else { LIVE }, Ordering::Release);
                    } else {
                        drop(value);
                        unavailable = true;
                        slot.state.store(POISONED, Ordering::Release);
                    }
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    unavailable = true;
                    slot.state.store(POISONED, Ordering::Release);
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    unavailable = true;
                    slot.state.store(POISONED, Ordering::Release);
                }
            }
            inspection.committed = true;
        }
        match slot
            .state
            .compare_exchange(FREE, RESERVED, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => {
                let mut claim = Claim {
                    slot,
                    committed: false,
                };
                match slot.value.try_lock() {
                    Ok(mut value) => {
                        if value.is_some() {
                            unavailable = true;
                            continue;
                        }
                        let (stored, result) = create.take().expect("slot factory is used once")();
                        *value = Some(stored);
                        drop(value);
                        slot.state.store(LIVE, Ordering::Release);
                        claim.committed = true;
                        return Ok(result);
                    }
                    Err(std::sync::TryLockError::WouldBlock) => {
                        unavailable = true;
                    }
                    Err(std::sync::TryLockError::Poisoned(_)) => {
                        unavailable = true;
                    }
                }
            }
            Err(RESERVED | INSPECTING) => transient = true,
            Err(POISONED) => unavailable = true,
            Err(_) => {}
        }
    }
    if transient {
        Err(SlotError::Busy)
    } else if unavailable {
        Err(SlotError::Unavailable)
    } else {
        Err(SlotError::Full)
    }
}

/// Free every live slot whose value `reclaim` accepts, without waiting on any
/// slot. Values are returned so the caller drops them after every slot lock
/// is released: a reclaimed value may own arbitrary state.
pub(crate) fn take_reclaimable<T>(slots: &[OwnedSlot<T>], reclaim: impl Fn(&T) -> bool) -> Vec<T> {
    let mut taken = Vec::new();
    for slot in slots {
        if slot
            .state
            .compare_exchange(LIVE, INSPECTING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            continue;
        }
        let mut inspection = Claim {
            slot,
            committed: false,
        };
        let next = match slot.value.try_lock() {
            Ok(mut value) => match value.as_ref() {
                Some(current) if reclaim(current) => {
                    taken.extend(value.take());
                    FREE
                }
                Some(_) => LIVE,
                None => POISONED,
            },
            // Busy is not damage: a sweep must never shrink capacity.
            Err(std::sync::TryLockError::WouldBlock) => LIVE,
            Err(std::sync::TryLockError::Poisoned(_)) => POISONED,
        };
        slot.state.store(next, Ordering::Release);
        inspection.committed = true;
    }
    taken
}

#[cfg(test)]
pub(super) fn with_live<T, R>(slot: &OwnedSlot<T>, inspect: impl FnOnce(&mut T) -> R) -> Option<R> {
    if slot
        .state
        .compare_exchange(LIVE, INSPECTING, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return None;
    }
    let result = match slot.value.try_lock() {
        Ok(mut value) => value.as_mut().map(inspect),
        Err(_) => {
            slot.state.store(POISONED, Ordering::Release);
            return None;
        }
    };
    slot.state.store(LIVE, Ordering::Release);
    result
}

#[cfg(test)]
pub(crate) fn poison_for_test<T>(slot: &OwnedSlot<T>) {
    let _guard = slot.value.lock().unwrap();
    panic!("controlled owned-slot registry panic");
}

#[cfg(test)]
pub(crate) fn inspect_poisoned_for_test<T, R>(
    slot: &OwnedSlot<T>,
    inspect: impl FnOnce(&mut T) -> R,
) -> Option<R> {
    let mut guard = match slot.value.lock() {
        Err(error) => error.into_inner(),
        Ok(_) => return None,
    };
    guard.as_mut().map(inspect)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn factory_panic_never_reuses_a_partially_installed_slot() {
        let slots = [OwnedSlot::<u64>::new()];
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = try_insert(
                &slots,
                0,
                |_| false,
                || -> (u64, ()) { panic!("controlled slot factory panic") },
            );
        }));
        assert!(outcome.is_err());
        assert_eq!(
            try_insert(&slots, 0, |_| true, || (1, ())),
            Err(SlotError::Unavailable)
        );
    }

    #[test]
    fn concurrent_cleanup_cannot_reclaim_a_new_owner_by_old_generation() {
        let slots = Arc::new([OwnedSlot::new()]);
        let old = Arc::new(AtomicBool::new(true));
        let old_for_insert = Arc::clone(&old);
        try_insert(&*slots, 0, |_| false, || (old_for_insert, ())).unwrap();
        let next = Arc::new(AtomicBool::new(false));
        let next_for_thread = Arc::clone(&next);
        let owned = Arc::clone(&slots);
        let (entered, wait_entered) = mpsc::sync_channel(1);
        let (release, wait_release) = mpsc::channel();
        let cleaner = std::thread::spawn(move || {
            try_insert(
                &*owned,
                0,
                |value| {
                    entered.send(()).unwrap();
                    wait_release.recv_timeout(Duration::from_secs(2)).unwrap();
                    value.load(Ordering::Acquire)
                },
                || (next_for_thread, ()),
            )
        });
        wait_entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let other = Arc::new(AtomicBool::new(false));
        assert_eq!(
            try_insert(&*slots, 0, |v| v.load(Ordering::Acquire), || (other, ())),
            Err(SlotError::Busy)
        );
        release.send(()).unwrap();
        cleaner.join().unwrap().unwrap();
        old.store(true, Ordering::Release);
        assert_eq!(
            try_insert(
                &*slots,
                0,
                |v| v.load(Ordering::Acquire),
                || (Arc::new(AtomicBool::new(false)), ())
            ),
            Err(SlotError::Full)
        );
        assert_eq!(
            with_live(&slots[0], |current| Arc::ptr_eq(current, &next)),
            Some(true)
        );
    }
}
