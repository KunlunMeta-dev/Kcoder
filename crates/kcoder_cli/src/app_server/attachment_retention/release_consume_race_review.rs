//! Deterministic receipt-state interleavings over the real private retention ledger.
use super::*;
use anyhow::{Context, Result};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Default)]
struct GateState {
    arrivals: usize,
    permits: usize,
}

struct ProjectionGate {
    phase: String,
    retention_id: String,
    state: Mutex<GateState>,
    changed: Condvar,
}

static PROJECTION_GATES: OnceLock<Mutex<Vec<Arc<ProjectionGate>>>> = OnceLock::new();

fn gates() -> &'static Mutex<Vec<Arc<ProjectionGate>>> {
    PROJECTION_GATES.get_or_init(|| Mutex::new(Vec::new()))
}

fn arm_gate(phase: &str, retention_id: &str) -> Arc<ProjectionGate> {
    let gate = Arc::new(ProjectionGate {
        phase: phase.into(),
        retention_id: retention_id.into(),
        state: Mutex::new(GateState::default()),
        changed: Condvar::new(),
    });
    let mut active = gates().lock().expect("projection gate registry poisoned");
    assert!(
        !active
            .iter()
            .any(|known| known.phase == phase && known.retention_id == retention_id),
        "duplicate exact projection gate"
    );
    active.push(gate.clone());
    gate
}

/// Called only by the product's cfg(test) seam. The global registry lock is
/// released before waiting so the test can release this exact phase and ID.
pub(in crate::app_server::attachment_retention) fn pause_before_final_projection(
    phase: &str,
    retention_id: &str,
) {
    let gate = gates()
        .lock()
        .expect("projection gate registry poisoned")
        .iter()
        .find(|gate| gate.phase == phase && gate.retention_id == retention_id)
        .cloned();
    let Some(gate) = gate else {
        return;
    };
    let mut state = gate.state.lock().expect("projection gate poisoned");
    let ticket = state.arrivals;
    state.arrivals += 1;
    gate.changed.notify_all();
    while state.permits <= ticket {
        state = gate.changed.wait(state).expect("projection gate poisoned");
    }
}

fn wait_for_arrivals(gate: &ProjectionGate, wanted: usize) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut state = gate.state.lock().expect("projection gate poisoned");
    while state.arrivals < wanted {
        let remaining = deadline.saturating_duration_since(Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "timed out waiting for projection phase {}",
            gate.phase
        );
        let (next, timeout) = gate
            .changed
            .wait_timeout(state, remaining)
            .expect("projection gate poisoned");
        state = next;
        anyhow::ensure!(
            !timeout.timed_out() || state.arrivals >= wanted,
            "timed out waiting for projection phase {}",
            gate.phase
        );
    }
    Ok(())
}

fn release_one(gate: &ProjectionGate) {
    let mut state = gate.state.lock().expect("projection gate poisoned");
    state.permits += 1;
    gate.changed.notify_all();
}

fn release_all(gate: &ProjectionGate) {
    let mut state = gate.state.lock().expect("projection gate poisoned");
    state.permits = usize::MAX;
    gate.changed.notify_all();
}

struct WorkerCleanup {
    gates: Vec<Arc<ProjectionGate>>,
    workers: Vec<JoinHandle<Result<RetentionReceiptV1>>>,
}

impl WorkerCleanup {
    fn new() -> Self {
        Self {
            gates: Vec::new(),
            workers: Vec::new(),
        }
    }
    fn arm(&mut self, phase: &str, retention_id: &str) -> Arc<ProjectionGate> {
        let gate = arm_gate(phase, retention_id);
        self.gates.push(gate.clone());
        gate
    }
    fn push(&mut self, worker: JoinHandle<Result<RetentionReceiptV1>>) {
        self.workers.push(worker);
    }
    fn join_all(&mut self) -> Result<Vec<RetentionReceiptV1>> {
        self.workers
            .drain(..)
            .map(|worker| {
                worker
                    .join()
                    .map_err(|_| anyhow::anyhow!("release worker panicked"))?
            })
            .collect()
    }
}

impl Drop for WorkerCleanup {
    fn drop(&mut self) {
        for gate in &self.gates {
            release_all(gate);
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
        let mut active = gates().lock().expect("projection gate registry poisoned");
        active.retain(|candidate| !self.gates.iter().any(|gate| Arc::ptr_eq(gate, candidate)));
    }
}

fn prepared_receipt(owner_count: usize) -> Result<(tempfile::TempDir, Scope, RetentionReceiptV1)> {
    let (temp, service, scope) = super::fixture(Limits::default());
    let mut leases = Vec::with_capacity(owner_count);
    let mut references = Vec::with_capacity(owner_count);
    for index in 0..owner_count {
        let lease = service.create_owner(&scope)?;
        references.push(super::upload(
            &service,
            &scope,
            &lease,
            &format!("race-upload-{index}"),
        ));
        leases.push(lease);
    }
    let oldest = references
        .iter()
        .map(|reference| reference.epoch)
        .min()
        .context("race fixture has no stage references")?;
    let request_id = super::wire_id(service.namespace(), oldest);
    let receipt = service.reserve(&scope, &request_id, "thread-race", &references)?;
    drop(leases);
    drop(service);
    Ok((temp, scope, receipt))
}

fn reopened(temp: &tempfile::TempDir) -> Result<RetentionService> {
    RetentionService::open(&temp.path().join("account"), true, Limits::default())
}

fn current_receipt(
    service: &RetentionService,
    scope: &Scope,
    id: &str,
) -> Result<RetentionReceiptV1> {
    service
        .read(
            scope,
            &RetentionReceiptSelectorV1::RetentionId {
                retention_id: id.into(),
            },
        )?
        .receipt
        .context("race receipt projection missing")
}

fn start_release(
    temp: &tempfile::TempDir,
    scope: Scope,
    receipt: RetentionReceiptV1,
) -> JoinHandle<Result<RetentionReceiptV1>> {
    let account = temp.path().join("account");
    std::thread::spawn(move || {
        let service = RetentionService::open(&account, true, Limits::default())?;
        service.release_receipt(
            &scope,
            &receipt.retention_id,
            receipt.revision,
            RetentionReleaseReasonV1::Discard,
        )
    })
}

fn consume_current_release(
    service: &RetentionService,
    scope: &Scope,
    id: &str,
) -> Result<RetentionConsumeAckV1> {
    let released = current_receipt(service, scope, id)?;
    anyhow::ensure!(
        released.state == RetentionReceiptStateV1::Released,
        "race fixture must observe an authoritative Released terminal before consuming"
    );
    let ack = RetentionConsumeAckV1 {
        retention_id: id.into(),
        terminal_revision: released.revision,
        client_ack_id: "race-ack-1".into(),
    };
    assert_eq!(
        service.consume(scope, &ack, &NoAcceptedTurnProof)?,
        RetentionConsumeStatusV1::Consumed
    );
    Ok(ack)
}

fn assert_consumed_with_exact_tombstone(
    service: &RetentionService,
    scope: &Scope,
    ack: &RetentionConsumeAckV1,
) -> Result<()> {
    let receipt = current_receipt(service, scope, &ack.retention_id)?;
    assert_eq!(receipt.state, RetentionReceiptStateV1::Consumed);
    assert_eq!(receipt.revision, ack.terminal_revision);
    let tx = service.store.transaction()?;
    let tombstone: Tombstone = tx
        .read(Area::Consumed, &ack.retention_id)?
        .context("consumed race tombstone missing")?;
    assert_eq!(tombstone.scope_hash, scope.hash);
    assert_eq!(tombstone.retention_id, ack.retention_id);
    assert_eq!(tombstone.revision, ack.terminal_revision);
    assert_eq!(tombstone.client_ack_id, ack.client_ack_id);
    Ok(())
}

#[test]
fn release_wrapper_final_projection_cannot_downgrade_a_consumed_receipt() -> Result<()> {
    let (temp, scope, receipt) = prepared_receipt(1)?;
    let probe = reopened(&temp)?;
    let mut cleanup = WorkerCleanup::new();
    let gate = cleanup.arm("receipt", &receipt.retention_id);
    cleanup.push(start_release(&temp, scope.clone(), receipt.clone()));

    wait_for_arrivals(&gate, 1)?;
    let ack = consume_current_release(&probe, &scope, &receipt.retention_id)?;
    release_all(&gate);
    let responses = cleanup.join_all()?;
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].state, RetentionReceiptStateV1::Consumed);
    assert_consumed_with_exact_tombstone(&probe, &scope, &ack)
}

#[test]
fn concurrent_owner_final_projections_cannot_downgrade_a_consumed_receipt() -> Result<()> {
    let (temp, scope, receipt) = prepared_receipt(2)?;
    let probe = reopened(&temp)?;
    let mut cleanup = WorkerCleanup::new();
    let owner_gate = cleanup.arm("owner", &receipt.retention_id);
    let receipt_gate = cleanup.arm("receipt", &receipt.retention_id);
    cleanup.push(start_release(&temp, scope.clone(), receipt.clone()));
    // Start the second release only after the first is outside every namespace
    // transaction. Its first owner lease is then observably busy, not a metadata
    // lock collision that could make the test depend on scheduler timing.
    wait_for_arrivals(&owner_gate, 1)?;
    cleanup.push(start_release(&temp, scope.clone(), receipt.clone()));

    // Both owners have completed physical release and are waiting before their
    // own durable receipt projections. Let one publish Released first.
    wait_for_arrivals(&owner_gate, 2)?;
    release_one(&owner_gate);
    wait_for_arrivals(&receipt_gate, 1)?;
    let ack = consume_current_release(&probe, &scope, &receipt.retention_id)?;

    // The second owner projection now reads the already-consumed receipt. Hold
    // both outer release projections so this assertion isolates that seam.
    release_one(&owner_gate);
    wait_for_arrivals(&receipt_gate, 2)?;
    let after_owner_projections = current_receipt(&probe, &scope, &receipt.retention_id)?;
    // The first worker reached receipt ticket 0 before the second owner was
    // released above; the second worker was still held at owner ticket 1.
    // Complete those final namespace transactions separately: Store explicitly
    // returns busy rather than blocking competing metadata transactions.
    release_one(&receipt_gate);
    let first_response = cleanup
        .workers
        .remove(0)
        .join()
        .map_err(|_| anyhow::anyhow!("release worker panicked"))??;
    release_one(&receipt_gate);
    let mut responses = vec![first_response];
    responses.extend(cleanup.join_all()?);

    assert_eq!(
        after_owner_projections.state,
        RetentionReceiptStateV1::Consumed
    );
    assert_eq!(responses.len(), 2);
    assert!(
        responses
            .iter()
            .all(|response| response.state == RetentionReceiptStateV1::Consumed)
    );
    assert_consumed_with_exact_tombstone(&probe, &scope, &ack)
}
