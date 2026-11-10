//! FIFO admission for short in-process catalog transactions, never storage authority.
use anyhow::{Context, Result, ensure};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap},
    marker::PhantomData,
    rc::Rc,
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
    thread::{self, ThreadId},
    time::{Duration, Instant},
};
// A full migration wave can queue 64 independent metadata transactions. Bound
// waiting for the FIFO admission itself; no storage mutation is replayed.
const WAIT: Duration = Duration::from_secs(30);
const MAX_WAITERS: u64 = 256;
#[derive(Default)]
struct State {
    next: u64,
    serving: u64,
    writer: Option<ThreadId>,
    owners: HashMap<ThreadId, usize>,
    cancelled: BTreeSet<u64>,
}
#[derive(Default)]
struct Gate {
    state: Mutex<State>,
    changed: Condvar,
    parsed: Mutex<Option<super::metadata_snapshot::Snapshot>>,
}
static GATES: OnceLock<Mutex<HashMap<String, Weak<Gate>>>> = OnceLock::new();
thread_local! { static HELD: RefCell<BTreeMap<String, usize>> = const { RefCell::new(BTreeMap::new()) }; }

/// Non-Send: a catalog transaction and its nesting/order tracking stay on their owner thread.
pub(super) struct CatalogAdmission {
    gate: Arc<Gate>,
    key: String,
    #[cfg(test)]
    ticket: u64,
    _owner: PhantomData<Rc<()>>,
}
fn skip_cancelled(state: &mut State) {
    while state.cancelled.remove(&state.serving) {
        state.serving += 1;
    }
}
impl CatalogAdmission {
    pub(super) fn document(
        &self,
        directory: &kcoder_config::PrivateDirectory,
    ) -> Result<super::model::Document> {
        super::metadata_snapshot::load(directory, &self.gate.parsed)
    }
    pub(super) fn remember_document(
        &self,
        directory: &kcoder_config::PrivateDirectory,
        bytes: &[u8],
        document: &super::model::Document,
    ) -> Result<()> {
        super::metadata_snapshot::remember(directory, bytes, document, &self.gate.parsed)
    }
    pub(super) fn acquire(key: String, writable: bool) -> Result<Self> {
        Self::acquire_for(key, writable, WAIT)
    }
    fn acquire_for(key: String, writable: bool, timeout: Duration) -> Result<Self> {
        // Nested independent catalogs have one process-wide ordering, avoiding AB/BA waits.
        ensure!(
            HELD.with(|held| {
                let held = held.borrow();
                held.contains_key(&key) || held.last_key_value().is_none_or(|(last, _)| last < &key)
            }),
            "external_history_lifecycle_busy"
        );
        let gate = {
            let mut entries = GATES
                .get_or_init(Default::default)
                .lock()
                .map_err(|_| anyhow::anyhow!("external_history_lifecycle_busy"))?;
            entries.retain(|_, gate| gate.strong_count() > 0);
            if let Some(gate) = entries.get(&key).and_then(Weak::upgrade) {
                gate
            } else {
                let gate = Arc::new(Gate::default());
                entries.insert(key.clone(), Arc::downgrade(&gate));
                gate
            }
        };
        let me = thread::current().id();
        let mut state = gate
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("external_history_lifecycle_busy"))?;
        if state.owners.contains_key(&me) {
            // Read recursion preserves the original shared kernel-lease behavior;
            // upgrades and nested writers must never wait for themselves.
            ensure!(
                !writable && state.writer.is_none(),
                "external_history_lifecycle_busy"
            );
            *state.owners.get_mut(&me).unwrap() += 1;
            #[cfg(test)]
            let ticket = state.serving;
            drop(state);
            HELD.with(|held| *held.borrow_mut().entry(key.clone()).or_default() += 1);
            return Ok(Self {
                gate,
                key,
                #[cfg(test)]
                ticket,
                _owner: PhantomData,
            });
        }
        ensure!(
            state.next.saturating_sub(state.serving) < MAX_WAITERS,
            "external_history_lifecycle_busy"
        );
        let ticket = state.next;
        state.next = state
            .next
            .checked_add(1)
            .context("external_history_lifecycle_busy")?;
        let deadline = Instant::now() + timeout;
        loop {
            if state.serving == ticket
                && state.writer.is_none()
                && (!writable || state.owners.is_empty())
            {
                if writable {
                    state.writer = Some(me);
                }
                state.owners.insert(me, 1);
                // Adjacent readers may share the metadata snapshot. A writer at
                // the head blocks every later reader until prior readers exit.
                state.serving += 1;
                skip_cancelled(&mut state);
                gate.changed.notify_all();
                drop(state);
                HELD.with(|held| *held.borrow_mut().entry(key.clone()).or_default() += 1);
                return Ok(Self {
                    gate,
                    key,
                    #[cfg(test)]
                    ticket,
                    _owner: PhantomData,
                });
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.cancelled.insert(ticket);
                skip_cancelled(&mut state);
                gate.changed.notify_all();
                anyhow::bail!("external_history_lifecycle_busy");
            }
            state = gate
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| anyhow::anyhow!("external_history_lifecycle_busy"))?
                .0;
        }
    }
}
impl Drop for CatalogAdmission {
    fn drop(&mut self) {
        HELD.with(|held| {
            let mut held = held.borrow_mut();
            if let Some(depth) = held.get_mut(&self.key) {
                *depth -= 1;
                if *depth == 0 {
                    held.remove(&self.key);
                }
            }
        });
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let me = thread::current().id();
        if let Some(depth) = state.owners.get_mut(&me) {
            *depth -= 1;
            if *depth == 0 {
                state.owners.remove(&me);
                if state.writer == Some(me) {
                    state.writer = None;
                }
                self.gate.changed.notify_all();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_last_owner_releases_its_gate_and_parsed_snapshot_storage() {
        let guard = CatalogAdmission::acquire(uuid::Uuid::new_v4().to_string(), false).unwrap();
        let weak = Arc::downgrade(&guard.gate);
        drop(guard);
        assert!(weak.upgrade().is_none());
    }
    #[test]
    fn sixty_four_metadata_waiters_are_fifo_and_only_one_transaction_enters() {
        let key = uuid::Uuid::new_v4().to_string();
        let first = CatalogAdmission::acquire(key.clone(), true).unwrap();
        let gate = first.gate.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let threads = (0..64)
            .map(|_| {
                let key = key.clone();
                let send = send.clone();
                thread::spawn(move || {
                    let admitted = CatalogAdmission::acquire(key, true).unwrap();
                    send.send(admitted.ticket).unwrap();
                })
            })
            .collect::<Vec<_>>();
        let deadline = Instant::now() + Duration::from_secs(5);
        while gate.state.lock().unwrap().next != 65 {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        drop(first);
        let tickets = (0..64)
            .map(|_| receive.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect::<Vec<_>>();
        for work in threads {
            work.join().unwrap();
        }
        assert_eq!(tickets, (1..=64).collect::<Vec<_>>());
    }
    #[test]
    fn thirty_two_real_read_leases_overlap_but_a_queued_writer_blocks_the_next_reader() {
        use super::super::Catalog;
        use kcoder_config::PrivateDirectory;
        let root = tempfile::tempdir().unwrap();
        let base = PrivateDirectory::open_or_create(root.path()).unwrap();
        drop(Catalog::open(&base, true).unwrap().unwrap());
        let (entered, arrivals) = std::sync::mpsc::channel();
        let mut release = Vec::new();
        let mut readers = Vec::new();
        for _ in 0..32 {
            let path = root.path().to_owned();
            let entered = entered.clone();
            let (send, receive) = std::sync::mpsc::channel();
            release.push(send);
            readers.push(thread::spawn(move || {
                let base = PrivateDirectory::open_existing(&path).unwrap();
                let catalog = Catalog::open_readonly(&base).unwrap().unwrap();
                entered.send(catalog._admission.gate.clone()).unwrap();
                receive.recv_timeout(Duration::from_secs(5)).unwrap();
            }));
        }
        let gate = arrivals.recv_timeout(Duration::from_secs(5)).unwrap();
        for _ in 1..32 {
            assert!(Arc::ptr_eq(
                &gate,
                &arrivals.recv_timeout(Duration::from_secs(5)).unwrap()
            ));
        }
        assert_eq!(gate.state.lock().unwrap().owners.len(), 32);
        let (events, order) = std::sync::mpsc::channel();
        let (writer_release, writer_wait) = std::sync::mpsc::channel();
        let path = root.path().to_owned();
        let writer_event = events.clone();
        let writer = thread::spawn(move || {
            let base = PrivateDirectory::open_existing(&path).unwrap();
            let _catalog = Catalog::open(&base, false).unwrap().unwrap();
            writer_event.send("writer").unwrap();
            writer_wait.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while gate.state.lock().unwrap().next != 33 {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        let path = root.path().to_owned();
        let later = thread::spawn(move || {
            let base = PrivateDirectory::open_existing(&path).unwrap();
            let _catalog = Catalog::open_readonly(&base).unwrap().unwrap();
            events.send("later reader").unwrap();
        });
        while gate.state.lock().unwrap().next != 34 {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        assert!(order.try_recv().is_err());
        for send in release {
            send.send(()).unwrap();
        }
        assert_eq!(
            order.recv_timeout(Duration::from_secs(5)).unwrap(),
            "writer"
        );
        assert!(order.try_recv().is_err());
        writer_release.send(()).unwrap();
        assert_eq!(
            order.recv_timeout(Duration::from_secs(5)).unwrap(),
            "later reader"
        );
        for reader in readers {
            reader.join().unwrap();
        }
        writer.join().unwrap();
        later.join().unwrap();
    }

    #[test]
    fn recursive_writes_and_reverse_catalog_order_never_wait_on_the_owner_itself() {
        let key = format!("z-{}", uuid::Uuid::new_v4());
        let _first = CatalogAdmission::acquire(key.clone(), true).unwrap();
        assert!(CatalogAdmission::acquire(key, true).is_err());
        assert!(CatalogAdmission::acquire("a-other-catalog".into(), true).is_err());
    }
    #[test]
    fn shared_recursion_releases_only_after_both_original_readers_exit() {
        let key = uuid::Uuid::new_v4().to_string();
        let first = CatalogAdmission::acquire(key.clone(), false).unwrap();
        let second = CatalogAdmission::acquire(key.clone(), false).unwrap();
        assert!(CatalogAdmission::acquire(key, true).is_err());
        drop(first);
        assert_eq!(
            second.gate.state.lock().unwrap().owners[&thread::current().id()],
            1
        );
        drop(second);
    }
    #[test]
    fn a_timed_out_waiter_does_not_leave_a_hole_or_steal_the_original_transaction() {
        let key = uuid::Uuid::new_v4().to_string();
        let first = CatalogAdmission::acquire(key.clone(), true).unwrap();
        let failed_key = key.clone();
        let timed_out = thread::spawn(move || {
            CatalogAdmission::acquire_for(failed_key, true, Duration::from_millis(10)).is_err()
        });
        assert!(timed_out.join().unwrap());
        let gate = first.gate.clone();
        let next = thread::spawn(move || {
            let guard = CatalogAdmission::acquire(key, true).unwrap();
            guard.ticket
        });
        // Observe actual admission before releasing the last owner: otherwise a
        // newly created empty gate may legitimately restart its ticket counter.
        let deadline = Instant::now() + Duration::from_secs(5);
        while gate.state.lock().unwrap().next != 3 {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        drop(first);
        assert_eq!(next.join().unwrap(), 2);
    }
}
