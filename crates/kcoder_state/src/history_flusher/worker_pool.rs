//! Bounded, process-owned blocking execution for history flusher operations.

use super::HistoryFlusherQueue;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::oneshot;

const WORKERS: usize = 8;
const QUEUED_JOBS: usize = 64;
const MAX_SUPERVISORS: usize = 8192;

use super::owned_slots::{OwnedSlot, SlotError, try_insert};

static SUPERVISORS: [OwnedSlot<tokio::task::JoinHandle<()>>; MAX_SUPERVISORS] =
    [const { OwnedSlot::new() }; MAX_SUPERVISORS];

#[cfg(test)]
pub(super) fn abort_supervisor(id: tokio::task::Id) -> bool {
    for slot in &SUPERVISORS {
        if super::owned_slots::with_live(slot, |task| {
            if task.id() == id {
                task.abort();
                true
            } else {
                false
            }
        }) == Some(true)
        {
            return true;
        }
    }
    false
}

/// Reserve one independent slot before allowing the supervisor to execute.
pub(super) fn spawn_supervisor(
    handle: &tokio::runtime::Handle,
    future: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<tokio::task::Id, SlotError> {
    spawn_in_slots(&SUPERVISORS, handle, future)
}

fn spawn_in_slots(
    slots: &[OwnedSlot<tokio::task::JoinHandle<()>>],
    handle: &tokio::runtime::Handle,
    future: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<tokio::task::Id, SlotError> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let (start, ready) = oneshot::channel::<()>();
    let id = try_insert(
        slots,
        NEXT.fetch_add(1, Ordering::Relaxed),
        |task| task.is_finished(),
        || {
            let task = handle.spawn(async move {
                if ready.await.is_ok() {
                    future.await;
                }
            });
            let id = task.id();
            (task, id)
        },
    )?;
    // A supervisor may not touch its queue until its real JoinHandle is owned.
    if start.send(()).is_err() {
        return Err(SlotError::Unavailable);
    }
    Ok(id)
}

struct Job {
    queue: Arc<HistoryFlusherQueue>,
    operation: Box<dyn FnOnce() + Send>,
    completed: oneshot::Sender<anyhow::Result<()>>,
}

struct Pool {
    sender: mpsc::SyncSender<Job>,
    // A process-lifetime owner retains every worker handle. A runtime or an
    // individual session may disappear while one of these workers is in I/O.
    _workers: Vec<JoinHandle<()>>,
}

impl Pool {
    fn start() -> Result<Self, String> {
        let (sender, receiver) = mpsc::sync_channel::<Job>(QUEUED_JOBS);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers: Vec<JoinHandle<()>> = Vec::with_capacity(WORKERS);
        for index in 0..WORKERS {
            let receiver = Arc::clone(&receiver);
            match thread::Builder::new()
                .name(format!("kcoder-history-writer-{index}"))
                .spawn(move || worker(receiver))
            {
                Ok(worker) => workers.push(worker),
                Err(error) => {
                    // No job can have been submitted before initialization
                    // completes, so these workers only have to leave recv().
                    drop(sender);
                    for worker in workers {
                        let _ = worker.join();
                    }
                    return Err(error.to_string());
                }
            }
        }
        Ok(Self {
            sender,
            _workers: workers,
        })
    }

    fn global() -> anyhow::Result<&'static Self> {
        static POOL: OnceLock<Result<Pool, String>> = OnceLock::new();
        match POOL.get_or_init(Self::start) {
            Ok(pool) => Ok(pool),
            Err(error) => anyhow::bail!("history writer pool unavailable: {error}"),
        }
    }
}

fn worker(receiver: Arc<Mutex<mpsc::Receiver<Job>>>) {
    loop {
        let job = {
            let receiver = receiver.lock().unwrap_or_else(|error| error.into_inner());
            receiver.recv()
        };
        let Ok(job) = job else { break };
        #[cfg(test)]
        job.queue
            .jobs_started
            .fetch_add(1, std::sync::atomic::Ordering::Release);
        let result = catch_unwind(AssertUnwindSafe(job.operation));
        if result.is_err() {
            job.queue.mark_worker_unknown();
        }
        let _ = job.completed.send(match result {
            Ok(()) => Ok(()),
            Err(_) => Err(anyhow::anyhow!(
                "history writer panicked; its result is unknown"
            )),
        });
    }
}

/// Run one operation while retaining its actual worker if this future is
/// dropped. Full queues apply asynchronous backpressure; no operation is
/// replayed and each session awaits its current operation before the next.
pub(super) async fn run(
    queue: Arc<HistoryFlusherQueue>,
    operation: impl FnOnce() + Send + 'static,
) -> anyhow::Result<()> {
    let pool = match Pool::global() {
        Ok(pool) => pool,
        Err(error) => {
            queue.mark_worker_unknown();
            return Err(error);
        }
    };
    run_in_pool(pool, queue, operation).await
}

async fn run_in_pool(
    pool: &Pool,
    queue: Arc<HistoryFlusherQueue>,
    operation: impl FnOnce() + Send + 'static,
) -> anyhow::Result<()> {
    let (completed, finished) = oneshot::channel();
    let mut job = Job {
        queue: Arc::clone(&queue),
        operation: Box::new(operation),
        completed,
    };
    let mut delay_ms = 1;
    loop {
        match pool.sender.try_send(job) {
            Ok(()) => break,
            Err(mpsc::TrySendError::Full(returned)) => {
                job = returned;
                futures_timer::Delay::new(Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms * 2).min(50);
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                queue.mark_worker_unknown();
                anyhow::bail!("history writer pool stopped; its result is unknown");
            }
        }
    }
    match finished.await {
        Ok(result) => result,
        Err(_) => {
            queue.mark_worker_unknown();
            anyhow::bail!("history writer stopped before reporting its result")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history_store::HistorySource;
    use std::sync::Condvar;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(flavor = "current_thread")]
    async fn poisoned_supervisor_slot_never_adopts_or_discards_its_handle() {
        let slots = [OwnedSlot::new()];
        let id = spawn_in_slots(
            &slots,
            &tokio::runtime::Handle::current(),
            std::future::pending::<()>(),
        )
        .unwrap();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            super::super::owned_slots::poison_for_test(&slots[0]);
        }));
        let rejected = spawn_in_slots(&slots, &tokio::runtime::Handle::current(), async {});
        assert_eq!(rejected, Err(SlotError::Unavailable));
        assert_eq!(
            super::super::owned_slots::inspect_poisoned_for_test(&slots[0], |task| {
                let same = task.id() == id;
                task.abort();
                same
            }),
            Some(true)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn supervisor_handle_is_owned_until_exit_and_capacity_rejects_before_spawn() {
        let slots = [OwnedSlot::new()];
        let (started, ready) = oneshot::channel();
        let (release, wait) = oneshot::channel::<()>();
        let (finished, done) = oneshot::channel();
        let id = spawn_in_slots(&slots, &tokio::runtime::Handle::current(), async move {
            let _ = started.send(());
            let _ = wait.await;
            let _ = finished.send(());
        })
        .unwrap();
        ready.await.unwrap();
        assert_eq!(
            super::super::owned_slots::with_live(&slots[0], |task| (task.id(), task.is_finished())),
            Some((id, false))
        );
        struct DropProof(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for DropProof {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let owner = DropProof(Arc::clone(&dropped));
        let rejected = spawn_in_slots(&slots, &tokio::runtime::Handle::current(), async move {
            let _owner = owner;
            std::future::pending::<()>().await;
        });
        assert_eq!(rejected, Err(SlotError::Full));
        assert!(dropped.load(Ordering::Acquire));
        release.send(()).unwrap();
        done.await.unwrap();
        tokio::task::yield_now().await;
        assert!(spawn_in_slots(&slots, &tokio::runtime::Handle::current(), async {}).is_ok());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn full_pool_backpressures_without_blocking_or_reissuing() {
        let temp = tempfile::tempdir().unwrap();
        let source = HistorySource::bind(&temp.path().join("pool.jsonl")).unwrap();
        let queue = Arc::new(HistoryFlusherQueue::new(source));
        let pool = Arc::new(Pool::start().unwrap());
        let (started_tx, started_rx) = mpsc::sync_channel(WORKERS);
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let completed_count = Arc::new(AtomicUsize::new(0));

        for _ in 0..WORKERS {
            let gate = Arc::clone(&gate);
            let started = started_tx.clone();
            let completed_count = Arc::clone(&completed_count);
            let (completed, _) = oneshot::channel();
            pool.sender
                .try_send(Job {
                    queue: Arc::clone(&queue),
                    completed,
                    operation: Box::new(move || {
                        started.send(()).unwrap();
                        let (lock, changed) = &*gate;
                        let mut released = lock.lock().unwrap();
                        while !*released {
                            released = changed.wait(released).unwrap();
                        }
                        completed_count.fetch_add(1, Ordering::Relaxed);
                    }),
                })
                .unwrap_or_else(|_| panic!("worker job was not admitted"));
        }
        for _ in 0..WORKERS {
            started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        for _ in 0..QUEUED_JOBS {
            let completed_count = Arc::clone(&completed_count);
            let (completed, _) = oneshot::channel();
            pool.sender
                .try_send(Job {
                    queue: Arc::clone(&queue),
                    completed,
                    operation: Box::new(move || {
                        completed_count.fetch_add(1, Ordering::Relaxed);
                    }),
                })
                .unwrap_or_else(|_| panic!("queued job was not admitted"));
        }

        let unexpected = Arc::new(AtomicUsize::new(0));
        let worker_pool = Arc::clone(&pool);
        let worker_queue = Arc::clone(&queue);
        let worker_unexpected = Arc::clone(&unexpected);
        let pending = tokio::spawn(async move {
            run_in_pool(&worker_pool, worker_queue, move || {
                worker_unexpected.fetch_add(1, Ordering::Relaxed);
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !pending.is_finished(),
            "a full pool must not accept another job"
        );
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        {
            let (lock, changed) = &*gate;
            *lock.lock().unwrap() = true;
            changed.notify_all();
        }

        let pool = Arc::try_unwrap(pool).unwrap_or_else(|_| panic!("pool owner leaked"));
        let Pool { sender, _workers } = pool;
        drop(sender);
        for worker in _workers {
            worker.join().unwrap();
        }
        assert_eq!(
            completed_count.load(Ordering::Relaxed),
            WORKERS + QUEUED_JOBS
        );
        assert_eq!(
            unexpected.load(Ordering::Relaxed),
            0,
            "cancelled pre-admission job ran"
        );
    }
}
