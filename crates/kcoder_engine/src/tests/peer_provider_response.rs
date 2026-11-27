//! A separate owned thread holds the actual registry at the sole response event.
use std::sync::{Mutex, mpsc};

pub(super) struct HeldResponse {
    registry: crate::owned_turn::OwnedTurnRegistry,
    poison: bool,
    worker: Mutex<Option<(mpsc::Sender<()>, std::thread::JoinHandle<()>)>>,
}
impl HeldResponse {
    pub(super) fn new(registry: crate::owned_turn::OwnedTurnRegistry, poison: bool) -> Self {
        Self {
            registry,
            poison,
            worker: Mutex::new(None),
        }
    }
    pub(super) fn hold(&self) {
        let (ready, observed) = mpsc::sync_channel(0);
        let (release, released) = mpsc::channel();
        let registry = self.registry.clone();
        let poison = self.poison;
        let worker = std::thread::spawn(move || {
            registry.with_entries_locked_for_owned_test(|| {
                ready.send(()).unwrap();
                let _ = released.recv();
                assert!(!poison, "owned registry poison negative control");
            })
        });
        assert!(
            self.worker
                .lock()
                .unwrap()
                .replace((release, worker))
                .is_none()
        );
        observed.recv().expect("actual owner registry must be held");
    }
    pub(super) fn release(&self) {
        let (release, worker) = self
            .worker
            .lock()
            .unwrap()
            .take()
            .expect("one original held worker");
        let _ = release.send(());
        assert_eq!(worker.join().is_err(), self.poison);
    }
}
impl Drop for HeldResponse {
    fn drop(&mut self) {
        if let Some((release, worker)) = self
            .worker
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = release.send(());
            let _ = worker.join();
        }
    }
}
