//! Streaming usage coalescing, bounded lock waits and crash reconciliation.
use super::*;
use kcoder_config::PrivateLeaseMode;
use std::time::{Duration, Instant};

const ESTIMATE: u64 = 400_000;

fn streaming_policy() -> NativeBudgetPolicy {
    policy(1, 1_000_000, 4, "first")
}

fn dispatched(
    store: &NativeBudgetStore,
    id: &str,
) -> (NativeBudgetRequest, BudgetReservationReceipt) {
    let mut proposed = request(id, ESTIMATE);
    proposed.estimate.cost_micros = Some(10);
    let receipt = store
        .reserve(&proposed, &[streaming_policy()], 100)
        .unwrap()
        .receipt()
        .clone();
    let BudgetDispatchResult::Fresh(receipt) = store
        .mark_dispatched(id, receipt.revision, &[streaming_policy()], 110)
        .unwrap()
    else {
        panic!("first dispatch must be fresh");
    };
    (proposed, receipt)
}

fn observed(tokens: u64) -> BudgetCharge {
    BudgetCharge {
        tokens,
        model_calls: 1,
        run_millis: 50,
        cost_micros: None,
    }
}

/// Drive one simulated stream through the coalescer, as the native meters do.
struct Stream<'a> {
    store: &'a NativeBudgetStore,
    receipt: BudgetReservationReceipt,
    coalescer: NativeBudgetUsageCoalescer,
    writes: u64,
}
impl<'a> Stream<'a> {
    fn new(store: &'a NativeBudgetStore, receipt: BudgetReservationReceipt) -> Self {
        let coalescer = NativeBudgetUsageCoalescer::new(
            &receipt,
            BudgetUsageFlushPolicy {
                interval: Duration::from_secs(3600),
                token_delta: 10_000,
                max_optional_writes: 24,
            },
            Instant::now(),
        );
        Self {
            store,
            receipt,
            coalescer,
            writes: 0,
        }
    }
    fn write(
        &mut self,
        coverage: BudgetUsageCoverage,
        known: BudgetCharge,
        end: Option<&NativeBudgetTerminal>,
    ) -> anyhow::Result<()> {
        self.receipt = self.store.record_usage(
            &self.receipt.reservation_id,
            self.receipt.revision,
            &format!("usage-{}", self.writes),
            &NativeBudgetUsage { coverage, known },
            end,
            120,
        )?;
        self.writes += 1;
        Ok(())
    }
    fn observe(&mut self, tokens: u64) -> anyhow::Result<BudgetUsageFlush> {
        let charge = observed(tokens);
        let now = Instant::now();
        let flush = self.coalescer.observe(&self.receipt, &charge, now);
        if flush != BudgetUsageFlush::Deferred {
            self.write(BudgetUsageCoverage::Partial, charge.clone(), None)?;
            self.coalescer.persisted(flush, &charge, now);
        }
        Ok(flush)
    }
}

#[test]
fn streaming_usage_is_coalesced_into_a_bounded_number_of_ledger_writes() {
    let fixture = Fixture::new();
    let (proposed, receipt) = dispatched(&fixture.store, "coalesced");
    let before = fixture.store.committed_write_count();
    let mut stream = Stream::new(&fixture.store, receipt);
    for event in 1..=500u64 {
        stream.observe(event * 500).unwrap();
    }
    assert!(stream.coalescer.has_pending());
    let partial_writes = fixture.store.committed_write_count() - before;
    assert!(
        (1..=24).contains(&partial_writes),
        "500 covered usage events produced {partial_writes} writes"
    );
    let end = terminal(&proposed, BudgetTerminalKind::Completed);
    stream
        .write(BudgetUsageCoverage::Complete, observed(250_000), Some(&end))
        .unwrap();
    let settled = fixture
        .store
        .read_reservation("coalesced")
        .unwrap()
        .unwrap();
    assert!(settled.execution_confirmed_terminal);
    assert_eq!(settled.known_usage.tokens, 250_000);
    assert_eq!(
        fixture.store.committed_write_count() - before,
        partial_writes + 1
    );
}

#[test]
fn usage_above_the_persisted_hold_is_written_before_the_stream_continues() {
    let fixture = Fixture::new();
    let (_, receipt) = dispatched(&fixture.store, "over-hold");
    let mut stream = Stream::new(&fixture.store, receipt);
    assert_eq!(stream.observe(1_000).unwrap(), BudgetUsageFlush::Deferred);
    assert_eq!(
        stream.observe(ESTIMATE + 1).unwrap(),
        BudgetUsageFlush::Required
    );
    // Crash right after: a reopened ledger already holds the observed usage.
    let reopened = fixture.reopen();
    let held = reopened.read_reservation("over-hold").unwrap().unwrap();
    assert!(held.charged.tokens > ESTIMATE);
    let window = reopened
        .observe_policy(&streaming_policy())
        .unwrap()
        .unwrap();
    assert!(window.charged.tokens > ESTIMATE);
}

#[test]
fn terminal_write_settles_pending_usage_after_failure_or_cancel() {
    for (id, kind) in [
        ("failed-stream", BudgetTerminalKind::Failed),
        ("cancelled-stream", BudgetTerminalKind::Cancelled),
    ] {
        let fixture = Fixture::new();
        let (proposed, receipt) = dispatched(&fixture.store, id);
        let mut stream = Stream::new(&fixture.store, receipt);
        for tokens in [100, 200, 300] {
            assert_eq!(stream.observe(tokens).unwrap(), BudgetUsageFlush::Deferred);
        }
        assert!(stream.coalescer.has_pending());
        let end = terminal(&proposed, kind);
        stream
            .write(BudgetUsageCoverage::Partial, observed(300), Some(&end))
            .unwrap();
        let settled = fixture.store.read_reservation(id).unwrap().unwrap();
        assert!(settled.execution_confirmed_terminal);
        assert_eq!(settled.known_usage.tokens, 300);
        // Partial coverage keeps the conservative original hold.
        assert!(settled.charged.covers(&proposed.estimate));
    }
}

#[test]
fn crash_before_the_terminal_write_reconciles_conservatively() {
    let fixture = Fixture::new();
    let (proposed, receipt) = dispatched(&fixture.store, "crashed-stream");
    {
        let mut stream = Stream::new(&fixture.store, receipt);
        for event in 1..=8u64 {
            assert_eq!(
                stream.observe(event * 1_000).unwrap(),
                BudgetUsageFlush::Deferred
            );
        }
        // Process crash: the coalesced 8_000 tokens were never written.
    }
    let reopened = fixture.reopen();
    let held = reopened
        .read_reservation("crashed-stream")
        .unwrap()
        .unwrap();
    assert!(!held.execution_confirmed_terminal);
    assert_eq!(held.phase, BudgetPhase::Dispatched);
    assert!(held.charged.covers(&proposed.estimate));
    assert!(held.charged.tokens >= 8_000, "lost usage is over-counted");
    let window = reopened
        .observe_policy(&streaming_policy())
        .unwrap()
        .unwrap();
    assert_eq!(window.active_calls, 1, "the unknown call keeps its slot");
    assert!(window.charged.tokens >= ESTIMATE);
}

fn hold_lock(root: &std::path::Path, hold: Duration) -> std::thread::JoinHandle<()> {
    let root = root.join("budgets");
    let (ready, acquired) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let file = directory
            .open_single_link_regular_file(OsStr::new("budgets.lock"))
            .unwrap();
        let identity = directory.portable_regular_handle_identity(&file).unwrap();
        let lease = directory
            .try_existing_portable_lock(
                OsStr::new("budgets.lock"),
                &identity,
                PrivateLeaseMode::Exclusive,
            )
            .unwrap()
            .unwrap();
        ready.send(()).unwrap();
        std::thread::sleep(hold);
        drop(lease);
    });
    acquired.recv().unwrap();
    holder
}

#[test]
fn brief_lock_contention_waits_instead_of_interrupting_the_stream() {
    let fixture = Fixture::new();
    let (_, receipt) = dispatched(&fixture.store, "contended");
    let mut stream = Stream::new(&fixture.store, receipt);
    let holder = hold_lock(&fixture.root, Duration::from_millis(300));
    let started = Instant::now();
    assert_eq!(
        stream.observe(ESTIMATE + 5).unwrap(),
        BudgetUsageFlush::Required
    );
    assert!(started.elapsed() >= Duration::from_millis(200));
    holder.join().unwrap();
    assert!(
        fixture
            .store
            .read_reservation("contended")
            .unwrap()
            .unwrap()
            .charged
            .tokens
            > ESTIMATE
    );
}

#[test]
fn lock_timeout_is_typed_and_only_reported_after_the_bound() {
    let fixture = Fixture::new();
    dispatched(&fixture.store, "timeout");
    let mut store = fixture.reopen();
    store.set_lock_wait(Duration::from_millis(150));
    let holder = hold_lock(&fixture.root, Duration::from_millis(900));
    let receipt = store.read_reservation("timeout").unwrap().unwrap();
    let started = Instant::now();
    let error = store
        .record_usage(
            "timeout",
            receipt.revision,
            "usage-timeout",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Partial,
                known: observed(1),
            },
            None,
            120,
        )
        .unwrap_err();
    let waited = started.elapsed();
    holder.join().unwrap();
    let timeout = error.downcast_ref::<BudgetLockTimeout>().unwrap();
    assert!(timeout.waited >= Duration::from_millis(150));
    assert!(waited >= Duration::from_millis(150) && waited < Duration::from_millis(850));
    assert_eq!(error.to_string(), "BUDGET_BUSY");
    // Nothing was written; the retry after contention succeeds.
    assert_eq!(store.committed_write_count(), 0);
    store
        .record_usage(
            "timeout",
            receipt.revision,
            "usage-timeout",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Partial,
                known: observed(1),
            },
            None,
            120,
        )
        .unwrap();
}
