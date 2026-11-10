//! Opaque, write-guarded revisions for current message provenance.
//! Tracked values must not contain interior mutability.
use std::{
    ops::{Deref, DerefMut},
    sync::{
        Arc, LockResult, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard, TryLockError,
        TryLockResult,
    },
};

#[derive(Clone, Debug)]
pub(super) struct Revision(Arc<()>);

impl Default for Revision {
    fn default() -> Self {
        Self(Arc::new(()))
    }
}
impl PartialEq for Revision {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for Revision {}

#[derive(Debug)]
pub(super) struct Tracked<T> {
    value: T,
    revision: Revision,
}
impl<T> Tracked<T> {
    pub(super) fn new(value: T) -> Self {
        Self {
            value,
            revision: Revision::default(),
        }
    }
    pub(super) fn revision(&self) -> Revision {
        self.revision.clone()
    }
}
impl<T: Default> Default for Tracked<T> {
    fn default() -> Self {
        Self::new(T::default())
    }
}
impl<T: Clone> Clone for Tracked<T> {
    fn clone(&self) -> Self {
        Self {
            value: self.value.clone(),
            revision: self.revision.clone(),
        }
    }
}
impl<T: PartialEq> PartialEq for Tracked<T> {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}
impl<T: Eq> Eq for Tracked<T> {}
impl<T: PartialEq> PartialEq<Vec<T>> for Tracked<Vec<T>> {
    fn eq(&self, other: &Vec<T>) -> bool {
        &self.value == other
    }
}
impl<T> From<T> for Tracked<T> {
    fn from(value: T) -> Self {
        Self::new(value)
    }
}
impl<T> Deref for Tracked<T> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        &self.value
    }
}
impl<T> DerefMut for Tracked<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.revision = Revision::default();
        &mut self.value
    }
}

pub(super) trait ProvenanceTokens {
    fn provenance_tokens(&self) -> (Revision, Revision);
}

#[derive(Debug)]
struct Locked<T: ProvenanceTokens> {
    value: T,
    provenance_revision: Revision,
}
#[derive(Debug)]
pub(super) struct PrivateStateLock<T: ProvenanceTokens> {
    inner: RwLock<Locked<T>>,
}
impl<T: ProvenanceTokens> PrivateStateLock<T> {
    pub(super) fn new(value: T) -> Self {
        Self {
            inner: RwLock::new(Locked {
                value,
                provenance_revision: Revision::default(),
            }),
        }
    }
    pub(super) fn read(&self) -> LockResult<ReadGuard<'_, T>> {
        match self.inner.read() {
            Ok(guard) => Ok(ReadGuard(guard)),
            Err(poisoned) => Err(PoisonError::new(ReadGuard(poisoned.into_inner()))),
        }
    }
    pub(super) fn try_read(&self) -> TryLockResult<ReadGuard<'_, T>> {
        match self.inner.try_read() {
            Ok(guard) => Ok(ReadGuard(guard)),
            Err(TryLockError::WouldBlock) => Err(TryLockError::WouldBlock),
            Err(TryLockError::Poisoned(poisoned)) => Err(TryLockError::Poisoned(PoisonError::new(
                ReadGuard(poisoned.into_inner()),
            ))),
        }
    }
    pub(super) fn write(&self) -> LockResult<WriteGuard<'_, T>> {
        match self.inner.write() {
            Ok(guard) => Ok(WriteGuard::new(guard)),
            Err(poisoned) => Err(PoisonError::new(WriteGuard::new(poisoned.into_inner()))),
        }
    }
    pub(super) fn try_write(&self) -> TryLockResult<WriteGuard<'_, T>> {
        match self.inner.try_write() {
            Ok(guard) => Ok(WriteGuard::new(guard)),
            Err(TryLockError::WouldBlock) => Err(TryLockError::WouldBlock),
            Err(TryLockError::Poisoned(poisoned)) => Err(TryLockError::Poisoned(PoisonError::new(
                WriteGuard::new(poisoned.into_inner()),
            ))),
        }
    }
}
pub(super) struct ReadGuard<'a, T: ProvenanceTokens>(RwLockReadGuard<'a, Locked<T>>);
impl<T: ProvenanceTokens> ReadGuard<'_, T> {
    pub(super) fn provenance_revision(&self) -> Revision {
        self.0.provenance_revision.clone()
    }
}
impl<T: ProvenanceTokens> Deref for ReadGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        &self.0.value
    }
}
pub(super) struct WriteGuard<'a, T: ProvenanceTokens> {
    inner: RwLockWriteGuard<'a, Locked<T>>,
    before: (Revision, Revision),
}
impl<'a, T: ProvenanceTokens> WriteGuard<'a, T> {
    fn new(inner: RwLockWriteGuard<'a, Locked<T>>) -> Self {
        let before = inner.value.provenance_tokens();
        Self { inner, before }
    }
}
impl<T: ProvenanceTokens> Deref for WriteGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        &self.inner.value
    }
}
impl<T: ProvenanceTokens> DerefMut for WriteGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner.value
    }
}
impl<T: ProvenanceTokens> Drop for WriteGuard<'_, T> {
    fn drop(&mut self) {
        if self.inner.value.provenance_tokens() != self.before {
            self.inner.provenance_revision = Revision::default();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fixture {
        ids: Tracked<Vec<String>>,
        attempts: Tracked<HashMap<String, String>>,
        unrelated: usize,
    }
    impl ProvenanceTokens for Fixture {
        fn provenance_tokens(&self) -> (Revision, Revision) {
            (self.ids.revision(), self.attempts.revision())
        }
    }

    #[test]
    fn reads_and_unrelated_writes_do_not_invalidate_observations() {
        let lock = PrivateStateLock::new(Fixture::default());
        let original = lock.read().unwrap().provenance_revision();
        assert_eq!(lock.read().unwrap().provenance_revision(), original);
        lock.write().unwrap().unrelated = 42;
        assert_eq!(lock.read().unwrap().provenance_revision(), original);
    }

    #[test]
    fn successful_try_write_advances_revision() {
        let lock = PrivateStateLock::new(Fixture::default());
        let original = lock.read().unwrap().provenance_revision();
        {
            let mut inner = lock.try_write().unwrap();
            inner.ids.push("first".into());
        }
        assert_ne!(lock.read().unwrap().provenance_revision(), original);
    }

    #[test]
    fn direct_mutation_clone_and_old_container_reinsertion_cannot_restore_revision() {
        let lock = PrivateStateLock::new(Fixture::default());
        lock.write().unwrap().ids.push("id".into());
        let original = lock.read().unwrap().provenance_revision();
        let old = {
            let mut inner = lock.write().unwrap();
            std::mem::replace(&mut inner.ids, Tracked::new(vec!["other".into()]))
        };
        let changed = lock.read().unwrap().provenance_revision();
        assert_ne!(changed, original);
        lock.write().unwrap().ids = old;
        let restored = lock.read().unwrap().provenance_revision();
        assert_ne!(restored, original);
        assert_ne!(restored, changed);
        let copied = lock.read().unwrap().ids.clone();
        {
            let mut inner = lock.write().unwrap();
            inner.ids.push("temporary".into());
            inner.ids.pop();
        }
        let after_equal_content = lock.read().unwrap().provenance_revision();
        assert_ne!(after_equal_content, restored);
        lock.write().unwrap().ids = copied;
        assert_ne!(lock.read().unwrap().provenance_revision(), restored);
    }

    #[test]
    fn direct_map_entry_replacement_and_mutable_borrow_invalidate() {
        let lock = PrivateStateLock::new(Fixture::default());
        let before = lock.read().unwrap().provenance_revision();
        lock.write()
            .unwrap()
            .attempts
            .entry("uuid".into())
            .or_insert("attempt".into());
        let after = lock.read().unwrap().provenance_revision();
        assert_ne!(before, after);
        lock.write()
            .unwrap()
            .attempts
            .get_mut("uuid")
            .unwrap()
            .push('2');
        assert_ne!(lock.read().unwrap().provenance_revision(), after);
    }

    #[test]
    fn busy_and_poisoned_guards_never_forge_a_current_revision() {
        let lock = PrivateStateLock::new(Fixture::default());
        let before = lock.read().unwrap().provenance_revision();
        let held = lock.write().unwrap();
        assert!(matches!(lock.try_read(), Err(TryLockError::WouldBlock)));
        assert!(matches!(lock.try_write(), Err(TryLockError::WouldBlock)));
        drop(held);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut inner = lock.write().unwrap();
            inner.ids.push("changed".into());
            panic!("intentional poison fixture");
        }));
        assert!(matches!(lock.try_read(), Err(TryLockError::Poisoned(_))));
        let read = match lock.read() {
            Err(poisoned) => poisoned.into_inner(),
            Ok(_) => panic!("expected poison"),
        };
        assert_ne!(read.provenance_revision(), before);
        drop(read);
        {
            let mut write = match lock.write() {
                Err(poisoned) => poisoned.into_inner(),
                Ok(_) => panic!("expected poison"),
            };
            write.attempts.insert("id".into(), "attempt".into());
        }
        assert!(matches!(lock.try_write(), Err(TryLockError::Poisoned(_))));
    }

    #[test]
    fn concurrent_writers_cannot_revive_a_held_observation() {
        let lock = Arc::new(PrivateStateLock::new(Fixture::default()));
        let original = lock.read().unwrap().provenance_revision();
        std::thread::scope(|threads| {
            for worker in 0..8 {
                let lock = lock.clone();
                threads.spawn(move || {
                    for number in 0..100 {
                        lock.write().unwrap().ids.push(format!("{worker}-{number}"));
                    }
                });
            }
        });
        let final_state = lock.read().unwrap();
        assert_eq!(final_state.ids.len(), 800);
        assert_ne!(final_state.provenance_revision(), original);
    }
}
