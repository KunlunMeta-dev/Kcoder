use anyhow::Result;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Instant;

const DEFAULT_MAX_JOBS: usize = 32;
const DEFAULT_MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_PENDING_ATTEMPTS: usize = 4096;

type DiagnosticTask = Box<dyn FnOnce() -> Result<()> + Send + 'static>;

/// A snapshot of the bounded diagnostic writer's current budget and outcomes.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DiagnosticWriterStats {
    pub reserved_jobs: usize,
    pub reserved_bytes: usize,
    pub tracked_tickets: usize,
    pub pending_attempts: usize,
    pub tracking_degraded: bool,
    pub written: u64,
    pub failed: u64,
    pub dropped: u64,
}

/// A bounded, asynchronous sink for best-effort diagnostics.
#[derive(Clone)]
pub struct DiagnosticWriter {
    handle: Arc<WriterHandle>,
}

/// A frozen workspace completion boundary that does not keep writer intake open.
pub struct DiagnosticBarrier {
    control: Arc<Control>,
    target: (u64, u64),
}

impl DiagnosticBarrier {
    /// Blocks until the captured work is released or the absolute deadline expires.
    pub fn wait_until(&self, deadline: Instant) -> bool {
        flush_through(&self.control, self.target, deadline)
    }
}

impl fmt::Debug for DiagnosticWriter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DiagnosticWriter")
            .field("stats", &self.stats())
            .finish_non_exhaustive()
    }
}

impl Default for DiagnosticWriter {
    fn default() -> Self {
        Self::with_limits(DEFAULT_MAX_JOBS, DEFAULT_MAX_BYTES)
    }
}

impl DiagnosticWriter {
    pub(crate) fn with_limits(max_jobs: usize, max_bytes: usize) -> Self {
        Self {
            handle: Arc::new(WriterHandle {
                control: Arc::new(Control {
                    state: Mutex::new(State::new(max_jobs, max_bytes)),
                    changed: Condvar::new(),
                }),
            }),
        }
    }

    pub(crate) fn try_reserve(&self, bytes: usize) -> Option<DiagnosticPermit> {
        let control = &self.handle.control;
        let mut state = lock(&control.state);
        if state.closed
            || state.reserved_jobs >= state.max_jobs
            || bytes > state.max_bytes.saturating_sub(state.reserved_bytes)
        {
            state.dropped = state.dropped.saturating_add(1);
            return None;
        }
        if state.next_ticket == u64::MAX {
            state.closed = true;
            state.dropped = state.dropped.saturating_add(1);
            control.changed.notify_all();
            return None;
        }

        let ticket = state.next_ticket;
        state.next_ticket = state.next_ticket.saturating_add(1);
        state.reserved_jobs = state.reserved_jobs.saturating_add(1);
        state.reserved_bytes = state.reserved_bytes.saturating_add(bytes);
        state.tickets.insert(ticket, Ticket::pending(bytes));
        drop(state);

        if !start_worker(control, ticket) {
            let mut state = lock(&control.state);
            if release_ticket(&mut state, ticket) {
                state.dropped = state.dropped.saturating_add(1);
            }
            control.changed.notify_all();
            return None;
        }

        let mut state = lock(&control.state);
        if state.closed || !state.tickets.contains_key(&ticket) {
            if release_ticket(&mut state, ticket) {
                state.dropped = state.dropped.saturating_add(1);
            }
            control.changed.notify_all();
            return None;
        }
        drop(state);

        Some(DiagnosticPermit {
            control: Arc::clone(control),
            ticket,
            active: true,
        })
    }

    pub(crate) fn note_dropped(&self) {
        let mut state = lock(&self.handle.control.state);
        state.dropped = state.dropped.saturating_add(1);
    }

    pub(crate) fn begin_attempt(&self) -> Option<DiagnosticAttempt> {
        let control = &self.handle.control;
        let mut state = lock(&control.state);
        if state.attempts.len() >= MAX_PENDING_ATTEMPTS || state.next_attempt == u64::MAX {
            if !state.tracking_degraded {
                tracing::warn!("LLM diagnostic workspace completion exhausted; flush is degraded");
            }
            state.tracking_degraded = true;
            control.changed.notify_all();
            return None;
        }
        let id = state.next_attempt;
        state.next_attempt += 1;
        state.attempts.insert(id);
        Some(DiagnosticAttempt {
            control: Arc::clone(control),
            id,
        })
    }

    pub fn stats(&self) -> DiagnosticWriterStats {
        lock(&self.handle.control.state).stats()
    }

    /// Waits only for reservations and attempts present in one shared snapshot.
    pub fn flush_until(&self, deadline: Instant) -> bool {
        self.barrier().wait_until(deadline)
    }

    /// Freezes both completion frontiers synchronously before an asynchronous wait.
    pub fn barrier(&self) -> DiagnosticBarrier {
        let control = &self.handle.control;
        let target = lock(&control.state).flush_target();
        DiagnosticBarrier {
            control: Arc::clone(control),
            target,
        }
    }

    /// Stops intake and lets already queued work drain without joining its worker.
    pub fn close(&self) {
        self.handle.control.close();
    }
}

struct WriterHandle {
    control: Arc<Control>,
}

impl Drop for WriterHandle {
    fn drop(&mut self) {
        self.control.close();
    }
}

struct Control {
    state: Mutex<State>,
    changed: Condvar,
}

impl Control {
    fn close(&self) {
        let mut state = lock(&self.state);
        if state.closed {
            return;
        }
        state.closed = true;
        self.changed.notify_all();
    }
}

struct State {
    max_jobs: usize,
    max_bytes: usize,
    reserved_jobs: usize,
    reserved_bytes: usize,
    next_ticket: u64,
    tickets: HashMap<u64, Ticket>,
    next_attempt: u64,
    attempts: BTreeSet<u64>,
    tracking_degraded: bool,
    queue: VecDeque<QueuedTask>,
    worker_started: bool,
    closed: bool,
    written: u64,
    failed: u64,
    dropped: u64,
}

impl State {
    fn new(max_jobs: usize, max_bytes: usize) -> Self {
        Self {
            max_jobs,
            max_bytes,
            reserved_jobs: 0,
            reserved_bytes: 0,
            next_ticket: 1,
            tickets: HashMap::new(),
            next_attempt: 1,
            attempts: BTreeSet::new(),
            tracking_degraded: false,
            queue: VecDeque::new(),
            worker_started: false,
            closed: false,
            written: 0,
            failed: 0,
            dropped: 0,
        }
    }

    fn flush_target(&self) -> (u64, u64) {
        (
            self.next_ticket.saturating_sub(1),
            self.next_attempt.saturating_sub(1),
        )
    }

    fn stats(&self) -> DiagnosticWriterStats {
        DiagnosticWriterStats {
            reserved_jobs: self.reserved_jobs,
            reserved_bytes: self.reserved_bytes,
            tracked_tickets: self.tickets.len(),
            pending_attempts: self.attempts.len(),
            tracking_degraded: self.tracking_degraded,
            written: self.written,
            failed: self.failed,
            dropped: self.dropped,
        }
    }
}

struct Ticket {
    bytes: usize,
    pending: bool,
}

impl Ticket {
    fn pending(bytes: usize) -> Self {
        Self {
            bytes,
            pending: true,
        }
    }

    #[cfg(test)]
    fn queued(bytes: usize) -> Self {
        Self {
            bytes,
            pending: false,
        }
    }
}

struct QueuedTask {
    ticket: u64,
    task: DiagnosticTask,
}

pub(crate) struct DiagnosticAttempt {
    control: Arc<Control>,
    id: u64,
}

impl Drop for DiagnosticAttempt {
    fn drop(&mut self) {
        lock(&self.control.state).attempts.remove(&self.id);
        self.control.changed.notify_all();
    }
}

pub(crate) struct DiagnosticPermit {
    control: Arc<Control>,
    ticket: u64,
    active: bool,
}

impl DiagnosticPermit {
    pub(crate) fn try_grow(&mut self, additional: usize) -> bool {
        if !self.active {
            return false;
        }
        let mut state = lock(&self.control.state);
        if state.closed || additional > state.max_bytes.saturating_sub(state.reserved_bytes) {
            return false;
        }
        let Some(ticket) = state.tickets.get_mut(&self.ticket) else {
            return false;
        };
        if !ticket.pending {
            return false;
        }
        ticket.bytes += additional;
        state.reserved_bytes += additional;
        true
    }

    pub(crate) fn submit(mut self, task: DiagnosticTask) -> bool {
        let mut state = lock(&self.control.state);
        if state.closed {
            drop(state);
            let panicked = discard_task(task);
            let mut state = lock(&self.control.state);
            if release_ticket(&mut state, self.ticket) {
                state.dropped = state.dropped.saturating_add(1);
            }
            if panicked {
                state.failed = state.failed.saturating_add(1);
            }
            self.active = false;
            self.control.changed.notify_all();
            return false;
        }
        let Some(ticket) = state.tickets.get_mut(&self.ticket) else {
            drop(state);
            let panicked = discard_task(task);
            self.active = false;
            if panicked {
                let mut state = lock(&self.control.state);
                state.failed = state.failed.saturating_add(1);
                self.control.changed.notify_all();
            }
            return false;
        };
        if !ticket.pending {
            drop(state);
            let panicked = discard_task(task);
            self.active = false;
            if panicked {
                let mut state = lock(&self.control.state);
                state.failed = state.failed.saturating_add(1);
                self.control.changed.notify_all();
            }
            return false;
        }
        ticket.pending = false;
        self.active = false;
        state.queue.push_back(QueuedTask {
            ticket: self.ticket,
            task,
        });
        self.control.changed.notify_all();
        true
    }
}

impl Drop for DiagnosticPermit {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        let mut state = lock(&self.control.state);
        if release_ticket(&mut state, self.ticket) {
            state.dropped = state.dropped.saturating_add(1);
        }
        self.control.changed.notify_all();
    }
}

fn start_worker(control: &Arc<Control>, originating_ticket: u64) -> bool {
    {
        let mut state = lock(&control.state);
        if state.worker_started {
            return true;
        }
        state.worker_started = true;
    }

    let worker_control = Arc::clone(control);
    if thread::Builder::new()
        .name("kcoder-diagnostic-writer".into())
        .spawn(move || worker_loop(worker_control))
        .is_ok()
    {
        return true;
    }

    handle_worker_start_failure(control, originating_ticket);
    false
}

fn handle_worker_start_failure(control: &Control, originating_ticket: u64) {
    let discarded_tasks = {
        let mut state = lock(&control.state);
        state.worker_started = false;
        state.closed = true;
        let discarded_tasks = std::mem::take(&mut state.queue);
        if release_ticket(&mut state, originating_ticket) {
            state.dropped = state.dropped.saturating_add(1);
        }
        discarded_tasks
    };
    control.changed.notify_all();
    for QueuedTask { ticket, task } in discarded_tasks {
        let panicked = discard_task(task);
        let mut state = lock(&control.state);
        if release_ticket(&mut state, ticket) {
            state.dropped = state.dropped.saturating_add(1);
        }
        if panicked {
            state.failed = state.failed.saturating_add(1);
        }
        control.changed.notify_all();
    }
}

fn worker_loop(control: Arc<Control>) {
    loop {
        let queued = {
            let mut state = lock(&control.state);
            loop {
                if let Some(queued) = state.queue.pop_front() {
                    break Some(queued);
                }
                if state.closed {
                    break None;
                }
                state = control
                    .changed
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };
        let Some(queued) = queued else {
            return;
        };

        let succeeded = execute_task(queued.task);
        let mut state = lock(&control.state);
        if release_ticket(&mut state, queued.ticket) {
            if succeeded {
                state.written = state.written.saturating_add(1);
            } else {
                state.failed = state.failed.saturating_add(1);
            }
        }
        control.changed.notify_all();
    }
}

fn flush_through(control: &Control, target: (u64, u64), deadline: Instant) -> bool {
    let mut state = lock(&control.state);
    loop {
        if state.tracking_degraded {
            return false;
        }
        if !state.tickets.keys().any(|ticket| *ticket <= target.0)
            && state.attempts.range(..=target.1).next().is_none()
        {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let timeout = deadline.saturating_duration_since(now);
        let (next_state, _) = control
            .changed
            .wait_timeout(state, timeout)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state = next_state;
    }
}

fn release_ticket(state: &mut State, ticket: u64) -> bool {
    let Some(ticket_state) = state.tickets.remove(&ticket) else {
        return false;
    };
    state.reserved_jobs = state.reserved_jobs.saturating_sub(1);
    state.reserved_bytes = state.reserved_bytes.saturating_sub(ticket_state.bytes);
    true
}

fn discard_task(task: DiagnosticTask) -> bool {
    match catch_unwind(AssertUnwindSafe(|| drop(task))) {
        Ok(()) => false,
        Err(payload) => {
            discard_panic_payload(payload);
            true
        }
    }
}

fn execute_task(task: DiagnosticTask) -> bool {
    match catch_unwind(AssertUnwindSafe(|| task().is_ok())) {
        Ok(succeeded) => succeeded,
        Err(payload) => {
            discard_panic_payload(payload);
            false
        }
    }
}

/// Discards at most one panic payload at a time. Rust cannot force an arbitrary
/// `Drop` implementation that repeatedly panics or blocks to terminate.
fn discard_panic_payload(mut payload: Box<dyn std::any::Any + Send>) {
    loop {
        match catch_unwind(AssertUnwindSafe(|| drop(payload))) {
            Ok(()) => return,
            Err(next_payload) => payload = next_payload,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{
        Control, DiagnosticWriter, QueuedTask, State, Ticket, WriterHandle, flush_through,
        handle_worker_start_failure, lock, worker_loop,
    };
    use std::sync::{Arc, Condvar, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};
    use std::{error::Error, fmt};

    struct BlockingDrop {
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl Drop for BlockingDrop {
        fn drop(&mut self) {
            let _ = self.started.send(());
            let _ = self.release.recv();
        }
    }

    #[derive(Debug)]
    struct ErrorDropGate {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl Drop for ErrorDropGate {
        fn drop(&mut self) {
            let _ = self.started.send(());
            let _ = self.release.lock().expect("lock error drop gate").recv();
        }
    }

    #[derive(Debug)]
    struct GatedError {
        gate: Arc<ErrorDropGate>,
    }

    impl fmt::Display for GatedError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            let _ = &self.gate;
            formatter.write_str("gated error")
        }
    }

    impl Error for GatedError {}

    #[derive(Debug)]
    struct ErrorWithPanickingDrop;

    impl fmt::Display for ErrorWithPanickingDrop {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("error with panicking drop")
        }
    }

    impl Error for ErrorWithPanickingDrop {}

    impl Drop for ErrorWithPanickingDrop {
        fn drop(&mut self) {
            panic!("error drop panic");
        }
    }

    struct PanicPayloadWithPanickingDrop;

    impl Drop for PanicPayloadWithPanickingDrop {
        fn drop(&mut self) {
            panic!("panic payload drop panic");
        }
    }

    #[test]
    fn workspace_attempt_capacity_degrades_without_consuming_payload_budget() {
        let writer = DiagnosticWriter::default();
        let attempts = (0..super::MAX_PENDING_ATTEMPTS)
            .map(|_| writer.begin_attempt().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(writer.stats().pending_attempts, 4096);
        assert!(!writer.stats().tracking_degraded);
        assert!(writer.begin_attempt().is_none());
        assert!(writer.stats().tracking_degraded);
        assert!(!writer.flush_until(Instant::now()));
        drop(attempts);
        assert_eq!(writer.stats().pending_attempts, 0);
        assert_eq!(writer.stats().reserved_jobs, 0);
        assert_eq!(writer.stats().reserved_bytes, 0);
        assert_eq!(writer.stats().written, 0);
        assert_eq!(writer.stats().dropped, 0);
        assert!(!writer.flush_until(Instant::now()));
        assert!(!lock(&writer.handle.control.state).worker_started);
    }

    #[test]
    fn workspace_attempt_id_exhaustion_stays_degraded_after_existing_completion() {
        let writer = DiagnosticWriter::default();
        lock(&writer.handle.control.state).next_attempt = u64::MAX - 1;
        let last = writer.begin_attempt().unwrap();
        assert!(writer.begin_attempt().is_none());
        assert!(!writer.flush_until(Instant::now()));
        drop(last);
        assert_eq!(writer.stats().pending_attempts, 0);
        assert!(writer.stats().tracking_degraded);
        assert!(!writer.flush_until(Instant::now()));
        assert_eq!(writer.stats().written, 0);
        assert_eq!(writer.stats().dropped, 0);
    }

    #[tokio::test]
    async fn no_target_attempts_are_lazy_and_global_snapshot_ignores_later_captures() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = DiagnosticWriter::default();
        let state = crate::AppState::new(tmp.path());
        state.set_diagnostic_context(writer.clone(), None);
        let request = || {
            crate::DiagnosticRequest::new(kcoder_types::MessagesRequest::new("test", Vec::new()))
        };
        let first = state.begin_llm_exchange(request(), false).await;
        let barrier = writer.barrier();
        let later = state.begin_llm_exchange(request(), false).await;
        assert!(!barrier.wait_until(Instant::now()));
        first.finish(None);
        assert!(barrier.wait_until(Instant::now()));
        assert!(!writer.flush_until(Instant::now()));
        assert_eq!(writer.stats().pending_attempts, 1);
        assert_eq!(writer.stats().reserved_jobs, 0);
        assert!(!lock(&writer.handle.control.state).worker_started);
        drop(later);
        assert!(writer.flush_until(Instant::now()));
        assert!(!lock(&writer.handle.control.state).worker_started);
    }

    #[test]
    fn submitted_work_keeps_budget_and_flush_waits_for_the_running_sink() {
        let writer = DiagnosticWriter::with_limits(1, 16);
        let permit = writer.try_reserve(8).expect("initial reservation");
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        assert!(permit.submit(Box::new(move || {
            started_tx.send(()).expect("signal sink start");
            release_rx.recv().expect("release sink");
            Ok(())
        })));
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("sink started after submit returned");

        assert!(writer.try_reserve(1).is_none());
        assert!(!writer.flush_until(Instant::now()));

        release_tx.send(()).expect("release sink");
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(1)));
    }

    #[test]
    fn reservation_growth_and_drop_hold_exact_budget() {
        let writer = DiagnosticWriter::with_limits(2, 10);
        let mut permit = writer.try_reserve(4).expect("initial reservation");
        assert_eq!(writer.stats().reserved_jobs, 1);
        assert_eq!(writer.stats().reserved_bytes, 4);

        assert!(permit.try_grow(5));
        assert!(!permit.try_grow(2));
        assert_eq!(writer.stats().reserved_bytes, 9);

        drop(permit);
        assert_eq!(writer.stats().reserved_jobs, 0);
        assert_eq!(writer.stats().reserved_bytes, 0);
        assert_eq!(writer.stats().dropped, 1);
    }

    #[test]
    fn byte_limit_rejects_without_exceeding_the_budget() {
        let writer = DiagnosticWriter::with_limits(2, 8);
        let permit = writer.try_reserve(5).expect("first reservation");

        assert!(writer.try_reserve(4).is_none());
        assert_eq!(writer.stats().reserved_jobs, 1);
        assert_eq!(writer.stats().reserved_bytes, 5);
        assert_eq!(writer.stats().dropped, 1);

        drop(permit);
    }

    #[test]
    fn earlier_unsubmitted_ticket_keeps_flush_waiting_after_later_work_finishes() {
        let writer = DiagnosticWriter::with_limits(2, 16);
        let first = writer.try_reserve(4).expect("first reservation");
        let second = writer.try_reserve(4).expect("second reservation");
        let (finished_tx, finished_rx) = mpsc::channel();

        assert!(second.submit(Box::new(move || {
            finished_tx.send(()).expect("signal second completion");
            Ok(())
        })));
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("later ticket completed");

        assert!(!writer.flush_until(Instant::now()));
        drop(first);
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(1)));
    }

    #[test]
    fn later_ticket_churn_keeps_tracking_bounded_while_an_earlier_ticket_is_pending() {
        let writer = DiagnosticWriter::with_limits(2, 16);
        let first = writer.try_reserve(4).expect("first reservation");

        for _ in 0..128 {
            let later = writer.try_reserve(4).expect("later reservation");
            assert_eq!(writer.stats().tracked_tickets, 2);
            drop(later);
            assert_eq!(writer.stats().tracked_tickets, 1);
        }

        assert!(!writer.flush_until(Instant::now()));
        drop(first);
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(1)));
    }

    #[test]
    fn flush_target_does_not_include_a_later_ticket() {
        let writer = DiagnosticWriter::with_limits(2, 16);
        let first = writer.try_reserve(4).expect("first reservation");
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        assert!(first.submit(Box::new(move || {
            started_tx.send(()).expect("signal first start");
            release_rx.recv().expect("release first sink");
            Ok(())
        })));
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("first sink started");

        let target = lock(&writer.handle.control.state).flush_target();
        let later = writer.try_reserve(4).expect("later reservation");
        release_tx.send(()).expect("release first sink");

        assert!(flush_through(
            &writer.handle.control,
            target,
            Instant::now() + Duration::from_secs(1),
        ));
        assert_eq!(writer.stats().reserved_jobs, 1);
        drop(later);
    }

    #[test]
    fn close_rejects_collection_and_failed_submission_releases_pending_work() {
        let writer = DiagnosticWriter::with_limits(2, 16);
        let permit = writer.try_reserve(4).expect("initial reservation");

        writer.close();
        assert_eq!(writer.stats().reserved_jobs, 1);
        assert_eq!(writer.stats().reserved_bytes, 4);
        assert!(writer.try_reserve(1).is_none());
        assert!(!permit.submit(Box::new(|| Ok(()))));
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(1)));

        let stats = writer.stats();
        assert_eq!(stats.reserved_jobs, 0);
        assert_eq!(stats.reserved_bytes, 0);
        assert!(stats.dropped >= 2);
    }

    #[test]
    fn failed_submit_keeps_budget_until_its_payload_has_been_dropped() {
        let writer = DiagnosticWriter::with_limits(1, 8);
        let permit = writer.try_reserve(4).expect("initial reservation");
        writer.close();
        let observer = writer.clone();
        let (drop_started_tx, drop_started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (submit_done_tx, submit_done_rx) = mpsc::channel();

        thread::spawn(move || {
            let payload = BlockingDrop {
                started: drop_started_tx,
                release: release_rx,
            };
            let submitted = permit.submit(Box::new(move || {
                let _payload = payload;
                Ok(())
            }));
            submit_done_tx
                .send(submitted)
                .expect("signal failed submit completion");
        });
        drop_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("payload drop started");

        let stats = observer.stats();
        assert_eq!(stats.reserved_jobs, 1);
        assert_eq!(stats.reserved_bytes, 4);
        assert!(!observer.flush_until(Instant::now()));

        release_tx.send(()).expect("release payload drop");
        assert!(
            !submit_done_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("failed submit completed")
        );
        assert!(observer.flush_until(Instant::now() + Duration::from_secs(1)));
    }

    #[test]
    fn ticket_exhaustion_closes_intake_without_wrapping() {
        let writer = DiagnosticWriter::with_limits(2, 16);
        lock(&writer.handle.control.state).next_ticket = u64::MAX;

        assert!(writer.try_reserve(1).is_none());
        assert!(writer.try_reserve(1).is_none());
        let stats = writer.stats();
        assert_eq!(stats.reserved_jobs, 0);
        assert_eq!(stats.reserved_bytes, 0);
        assert_eq!(stats.dropped, 2);
    }

    #[test]
    fn worker_start_failure_drops_queued_payload_before_releasing_its_ticket() {
        let control = Arc::new(Control {
            state: Mutex::new(State::new(3, 24)),
            changed: Condvar::new(),
        });
        let (drop_started_tx, drop_started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let queued_payload = BlockingDrop {
            started: drop_started_tx,
            release: release_rx,
        };
        {
            let mut state = lock(&control.state);
            state.next_ticket = 4;
            state.reserved_jobs = 3;
            state.reserved_bytes = 12;
            state.tickets.insert(1, Ticket::pending(4));
            state.tickets.insert(2, Ticket::queued(4));
            state.tickets.insert(3, Ticket::pending(4));
            state.queue.push_back(QueuedTask {
                ticket: 2,
                task: Box::new(move || {
                    let _payload = queued_payload;
                    Ok(())
                }),
            });
        }

        let failing_control = Arc::clone(&control);
        let (failure_done_tx, failure_done_rx) = mpsc::channel();
        thread::spawn(move || {
            handle_worker_start_failure(&failing_control, 3);
            failure_done_tx.send(()).expect("signal failure cleanup");
        });
        drop_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("queued payload drop started");

        let state = lock(&control.state);
        assert!(state.closed);
        assert!(state.queue.is_empty());
        assert_eq!(state.stats().reserved_jobs, 2);
        assert_eq!(state.stats().reserved_bytes, 8);
        assert_eq!(state.stats().tracked_tickets, 2);
        assert_eq!(state.stats().dropped, 1);
        assert!(state.tickets.contains_key(&1));
        assert!(state.tickets.contains_key(&2));
        drop(state);

        release_tx.send(()).expect("release queued payload drop");
        failure_done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("failure cleanup completed");
        let state = lock(&control.state);
        assert_eq!(state.stats().reserved_jobs, 1);
        assert_eq!(state.stats().reserved_bytes, 4);
        assert_eq!(state.stats().tracked_tickets, 1);
        assert_eq!(state.stats().dropped, 2);
    }

    #[test]
    fn queued_work_survives_last_sender_drop_before_the_worker_enters_its_loop() {
        let control = Arc::new(Control {
            state: Mutex::new(State::new(1, 8)),
            changed: Condvar::new(),
        });
        let (executed_tx, executed_rx) = mpsc::channel();
        {
            let mut state = lock(&control.state);
            state.next_ticket = 2;
            state.reserved_jobs = 1;
            state.reserved_bytes = 4;
            state.tickets.insert(1, Ticket::queued(4));
            state.queue.push_back(QueuedTask {
                ticket: 1,
                task: Box::new(move || {
                    executed_tx.send(()).expect("signal queued execution");
                    Ok(())
                }),
            });
        }

        let writer = WriterHandle {
            control: Arc::clone(&control),
        };
        let worker_control = Arc::clone(&control);
        let weak_control = Arc::downgrade(&control);
        let (worker_spawned_tx, worker_spawned_rx) = mpsc::channel();
        let (start_tx, start_rx) = mpsc::channel();
        drop(control);

        let worker = thread::spawn(move || {
            worker_spawned_tx.send(()).expect("signal worker spawned");
            start_rx.recv().expect("start worker loop");
            worker_loop(worker_control);
        });
        worker_spawned_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker is held behind the start gate");

        drop(writer);
        start_tx.send(()).expect("open worker start gate");
        executed_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("queued work executes after last sender drop");
        worker.join().expect("worker exits after close and drain");
        assert!(weak_control.upgrade().is_none());
    }

    #[test]
    fn sink_errors_and_panics_are_counted_without_stopping_following_work() {
        let writer = DiagnosticWriter::with_limits(3, 24);
        let failed = writer.try_reserve(4).expect("error reservation");
        let panicked = writer.try_reserve(4).expect("panic reservation");
        let written = writer.try_reserve(4).expect("success reservation");
        let (written_tx, written_rx) = mpsc::channel();

        assert!(failed.submit(Box::new(|| Err(anyhow::anyhow!("sink error")))));
        assert!(panicked.submit(Box::new(|| panic!("sink panic"))));
        assert!(written.submit(Box::new(move || {
            written_tx.send(()).expect("signal recovered sink");
            Ok(())
        })));
        written_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker continued after failures");
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(1)));

        let stats = writer.stats();
        assert_eq!(stats.written, 1);
        assert_eq!(stats.failed, 2);
        assert_eq!(stats.reserved_jobs, 0);
        assert_eq!(stats.reserved_bytes, 0);
    }

    #[test]
    fn error_drop_keeps_budget_until_the_error_has_been_destroyed() {
        let writer = DiagnosticWriter::with_limits(1, 8);
        let permit = writer.try_reserve(4).expect("initial reservation");
        let (drop_started_tx, drop_started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let gate = Arc::new(ErrorDropGate {
            started: drop_started_tx,
            release: Mutex::new(release_rx),
        });

        assert!(permit.submit(Box::new(move || {
            Err(anyhow::Error::new(GatedError { gate }))
        })));
        drop_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("error drop started");

        assert_eq!(writer.stats().reserved_jobs, 1);
        assert_eq!(writer.stats().reserved_bytes, 4);
        assert!(!writer.flush_until(Instant::now()));

        release_tx.send(()).expect("release error drop");
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(1)));
        assert_eq!(writer.stats().failed, 1);
    }

    #[test]
    fn panicking_error_drop_does_not_stop_following_work() {
        let writer = DiagnosticWriter::with_limits(2, 16);
        let failing = writer.try_reserve(4).expect("failing reservation");
        let succeeding = writer.try_reserve(4).expect("succeeding reservation");
        let (written_tx, written_rx) = mpsc::channel();

        assert!(failing.submit(Box::new(|| {
            Err(anyhow::Error::new(ErrorWithPanickingDrop))
        })));
        assert!(succeeding.submit(Box::new(move || {
            written_tx.send(()).expect("signal following work");
            Ok(())
        })));

        written_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker continued after error drop panic");
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(1)));
        assert_eq!(writer.stats().failed, 1);
        assert_eq!(writer.stats().written, 1);
    }

    #[test]
    fn panicking_panic_payload_drop_does_not_stop_following_work() {
        let writer = DiagnosticWriter::with_limits(2, 16);
        let failing = writer.try_reserve(4).expect("failing reservation");
        let succeeding = writer.try_reserve(4).expect("succeeding reservation");
        let (written_tx, written_rx) = mpsc::channel();

        assert!(failing.submit(Box::new(|| {
            std::panic::panic_any(PanicPayloadWithPanickingDrop);
        })));
        assert!(succeeding.submit(Box::new(move || {
            written_tx.send(()).expect("signal following work");
            Ok(())
        })));

        written_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker continued after panic payload drop panic");
        assert!(writer.flush_until(Instant::now() + Duration::from_secs(1)));
        assert_eq!(writer.stats().failed, 1);
        assert_eq!(writer.stats().written, 1);
    }

    #[test]
    fn dropping_last_sender_does_not_join_a_blocked_sink() {
        let writer = DiagnosticWriter::with_limits(1, 8);
        let permit = writer.try_reserve(4).expect("initial reservation");
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (dropped_tx, dropped_rx) = mpsc::channel();

        assert!(permit.submit(Box::new(move || {
            started_tx.send(()).expect("signal sink start");
            release_rx.recv().expect("release sink");
            Ok(())
        })));
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("sink started");

        thread::spawn(move || {
            drop(writer);
            dropped_tx.send(()).expect("signal sender dropped");
        });
        dropped_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("dropping a sender must not wait for the sink");
        release_tx.send(()).expect("release sink");
    }
}
