//! Optional live evidence for one newly committed initial Work input.
//!
//! The host must independently prove the original accepted request, account,
//! source and session lease. This does not authorize actions or authenticate a
//! current mutable Work record. Cold recovery cannot recreate this evidence.
use super::*;
use crate::user_input_commit::WeakCommittedUserInput;
use crate::{AppState, CommittedUserInput, UserInputCommit};
use kcoder_types::{ContentBlock, Message, MessageOrigin};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct CapacityInner {
    limit: usize,
    active: AtomicUsize,
}

/// Shared host-owned capacity for live native observation owners. The host
/// must create and share this pool at its actual process/owner boundary, using
/// its configured resident capacity. A zero limit disables new observations.
#[derive(Clone)]
pub struct NativeInitialWorkCapacity(Arc<CapacityInner>);
impl NativeInitialWorkCapacity {
    pub fn new(limit: usize) -> Self {
        Self(Arc::new(CapacityInner {
            limit,
            active: AtomicUsize::new(0),
        }))
    }

    fn try_acquire(&self) -> Option<ReceiptPermit> {
        self.0
            .active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                if current < self.0.limit {
                    current.checked_add(1)
                } else {
                    None
                }
            })
            .ok()
            .map(|_| ReceiptPermit(Arc::clone(&self.0)))
    }
}
struct ReceiptPermit(Arc<CapacityInner>);
impl Drop for ReceiptPermit {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Values supplied by the trusted host. Scope and source names alone confer no
/// rights; the host must retain and revalidate its original native authorities.
pub struct NativeInitialWorkRequest<'a> {
    pub state: &'a AppState,
    pub scope: &'a WorkScope,
    pub work: WorkRecord,
    pub source: &'a WorkInputSource,
    pub request_id: &'a str,
    pub committed: CommittedUserInput,
    /// Caller-supplied comparison against the original pre-Hook host request.
    pub original_accepted: &'a Message,
    pub accepted_deliveries: Vec<WorkDeliveryRequirement>,
    /// A shared host-level pool, never a new pool per request.
    pub capacity: &'a NativeInitialWorkCapacity,
}

/// Host-verified observation of a foreground turn that used one saved input.
pub struct NativeForegroundWorkApplication<'a> {
    pub state: &'a AppState,
    pub scope: &'a WorkScope,
    pub work_id: &'a str,
    pub source: &'a WorkInputSource,
    pub input_id: &'a str,
    pub goal_id: &'a str,
    pub expected_control_epoch: u64,
    pub committed: &'a CommittedUserInput,
    pub original_accepted: &'a Message,
}

/// Keep small inputs inline. Large inputs retain an exact native history
/// locator and content digest, rather than truncating or copying attachments.
pub fn native_work_input_payload(
    committed: &CommittedUserInput,
    original: &Message,
    include_accepted_attempt: bool,
) -> Result<Value> {
    ensure!(
        committed.outcome() == UserInputCommit::Durable && committed.matches_original(original),
        "CONTINUOUS_WORK_INPUT_UNCONFIRMED"
    );
    let attempt = committed
        .attempt()
        .context("CONTINUOUS_WORK_ATTEMPT_UNAVAILABLE")?;
    let Message::User {
        content,
        origin: MessageOrigin::User,
    } = original
    else {
        anyhow::bail!("CONTINUOUS_WORK_INPUT_INVALID")
    };
    let raw_size = content
        .iter()
        .try_fold(0usize, |size, block| {
            let bytes = match block {
                ContentBlock::Text { text } => text.len(),
                ContentBlock::Image { source } => source
                    .source_type
                    .len()
                    .checked_add(source.media_type.len())?
                    .checked_add(source.data.len())?,
                _ => return None,
            };
            size.checked_add(bytes)
        })
        .context("CONTINUOUS_WORK_INPUT_INVALID")?;
    ensure!(raw_size > 0, "CONTINUOUS_WORK_INPUT_INVALID");
    if raw_size <= MAX_INPUT_BYTES {
        let mut inline = match content.as_slice() {
            [ContentBlock::Text { text }] => serde_json::json!({"text": text}),
            _ => serde_json::json!({"content": content}),
        };
        if include_accepted_attempt {
            inline
                .as_object_mut()
                .context("CONTINUOUS_WORK_INPUT_INVALID")?
                .insert("acceptedAttempt".into(), serde_json::to_value(attempt)?);
        }
        if payload_bytes(&inline).is_ok() {
            return Ok(inline);
        }
    }
    struct HashWriter(Sha256);
    impl std::io::Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut digest = HashWriter(Sha256::new());
    serde_json::to_writer(&mut digest, original)?;
    let mut payload = serde_json::json!({"historyRef":{
        "attempt":attempt, "historyUuid":committed.uuid(),
        "messageSha256":format!("{:x}", digest.0.finalize())
    }});
    if include_accepted_attempt {
        payload
            .as_object_mut()
            .context("CONTINUOUS_WORK_INPUT_INVALID")?
            .insert("acceptedAttempt".into(), serde_json::to_value(attempt)?);
    }
    payload_bytes(&payload)?;
    Ok(payload)
}

/// Only Accepted contains original native observation ownership. Unavailable
/// occurs before this call starts a Work publication, and does not characterize
/// earlier calls. WithoutWitness means this call committed the Work but could
/// not preserve a live observation; it must not be replayed. Unknown may also
/// follow a durable publication and must never trigger automatic replay.
#[must_use]
pub enum NativeInitialWorkAdmission {
    Accepted(NativeInitialWorkOwner),
    WithoutWitness,
    Unavailable,
    Unknown,
}

struct Evidence {
    initial_work: WorkRecord,
    published: Mutex<publication_intent::NativePublishedInput>,
    // In-flight observers keep the permit until their blocking IO exits.
    _permit: ReceiptPermit,
}

/// The host must retain this single non-cloneable owner beside the original
/// session lease and drop it when that owner closes. It retains the original
/// input and publication handles only until then. Dropping it never performs IO.
pub struct NativeInitialWorkOwner {
    original: CommittedUserInput,
    evidence: Arc<Evidence>,
    alive: Arc<AtomicBool>,
}
impl NativeInitialWorkOwner {
    /// The originally published record is an observation, not current authority.
    pub fn initial_work(&self) -> &WorkRecord {
        &self.evidence.initial_work
    }

    pub fn observer(&self) -> NativeInitialWorkReceipt {
        NativeInitialWorkReceipt {
            original: self.original.downgrade(),
            evidence: Arc::downgrade(&self.evidence),
            alive: Arc::downgrade(&self.alive),
        }
    }
}
impl Drop for NativeInitialWorkOwner {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
    }
}

/// A weak process-local observation. It never keeps the input, publication,
/// owner or session alive. It cannot be serialized or recreated after restart.
#[derive(Clone)]
pub struct NativeInitialWorkReceipt {
    original: WeakCommittedUserInput,
    evidence: Weak<Evidence>,
    alive: Weak<AtomicBool>,
}

impl NativeInitialWorkReceipt {
    /// Observe the exact initial record only, on a bounded owned blocking
    /// worker outside State locks. None means unavailable, never not-sent.
    /// The host must also revalidate the original session lease and authority.
    /// This does not establish the present stored Work status or authorization.
    pub fn observe_original(&self, state: &AppState) -> Option<WorkRecord> {
        let alive = self.alive.upgrade()?;
        if !alive.load(Ordering::Acquire) {
            return None;
        }
        let input = self.original.upgrade()?;
        let evidence = self.evidence.upgrade()?;
        let mut publication = evidence.published.try_lock().ok()?;
        if !input.belongs_to_live_state(state)
            || !input.try_is_current().is_ok_and(|current| current)
            || publication.published.revalidate().is_err()
            || publication.verified.verify_contents().is_err()
            || publication.published.revalidate().is_err()
        {
            return None;
        }
        #[cfg(test)]
        pause_before_observation_result_for_test();
        if !alive.load(Ordering::Acquire)
            || !input.belongs_to_live_state(state)
            || !input.try_is_current().is_ok_and(|current| current)
        {
            return None;
        }
        let initial_work = evidence.initial_work.clone();
        if !alive.load(Ordering::Acquire)
            || !input.belongs_to_live_state(state)
            || !input.try_is_current().is_ok_and(|current| current)
        {
            return None;
        }
        Some(initial_work)
    }
}

impl ContinuousWorkStore {
    /// Record a single-thread foreground input already observed in the actual
    /// provider request. The host verifies the original session lease, accepted
    /// turn, source and provider response before calling this method.
    pub fn record_native_foreground_applied(
        &self,
        request: NativeForegroundWorkApplication<'_>,
    ) -> Result<WorkInputReceipt> {
        let NativeForegroundWorkApplication {
            state,
            scope,
            work_id,
            source,
            input_id,
            goal_id,
            expected_control_epoch,
            committed,
            original_accepted,
        } = request;
        source.validate()?;
        let attempt = committed
            .attempt()
            .context("CONTINUOUS_WORK_ATTEMPT_UNAVAILABLE")?;
        ensure!(
            committed.outcome() == UserInputCommit::Durable
                && committed.matches_original(original_accepted)
                && committed.belongs_to_live_state(state)
                && committed.try_is_current().is_ok_and(|current| current)
                && source.conversation_id == attempt.thread_id,
            "CONTINUOUS_WORK_INPUT_UNCONFIRMED"
        );
        let expected_payload = native_work_input_payload(committed, original_accepted, true)?;
        let identity = WorkIdentity {
            scope: scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        let key = input_key(&identity, source, input_id)?;
        let saved = self
            .read(|data| Ok(data.inputs.get(&key).cloned()))?
            .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?;
        let before = receipt(&saved)?;
        let (payload, witness) = self.observe_payload(&saved)?;
        ensure!(
            before.work == identity && payload == expected_payload,
            "CONTINUOUS_WORK_INPUT_MISMATCH"
        );
        let applied = AppliedInputReference {
            attempt: attempt.clone(),
            history_uuid: committed.uuid().to_owned(),
        };
        self.update(|data| {
            ensure!(
                committed.belongs_to_live_state(state)
                    && committed.try_is_current().is_ok_and(|current| current),
                "CONTINUOUS_WORK_INPUT_UNCONFIRMED"
            );
            require_known_inputs(data, &identity)?;
            ensure!(data.inputs.get(&key) == Some(&saved), "CONTINUOUS_WORK_INPUT_STALE");
            witness.revalidate()?;
            let stored = data.works.get_mut(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record(stored, scope)?;
            let input = data.inputs.get_mut(&key)
                .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?;
            let mut receipt: WorkInputReceipt = mutable_parse(&input.receipt)?;
            receipt.validate_for_mutation(scope).map_err(anyhow::Error::msg)?;
            ensure!(
                receipt == before
                    && input.source == *source
                    && work.linked_thread_ids.len() == 1
                    && work.linked_thread_ids[0] == attempt.thread_id
                    && stored.bindings.contains_key(&attempt.thread_id)
                    && work.native_refs.iter().any(|reference| matches!(reference,
                        kcoder_types::continuous_work::WorkNativeReference::Known(
                            kcoder_types::continuous_work::WorkKnownReference::Goal { thread_id, goal_id: saved, .. }
                        ) if thread_id == &attempt.thread_id && saved == goal_id)),
                "CONTINUOUS_WORK_INPUT_IDENTITY_MISMATCH"
            );
            if receipt.state == WorkInputState::Applied && input.applied.as_ref() == Some(&applied) {
                return Ok((receipt, false));
            }
            ensure!(
                receipt.state == WorkInputState::Accepted
                    && input.applied.is_none()
                    && stored.active_claim.is_none()
                    && stored.pending_control.is_none()
                    && matches!(&work.phase, WorkPhase::Pending | WorkPhase::Running)
                    && work.revision.control_epoch == expected_control_epoch
                    && work.revision.accepted_input_sequence == receipt.sequence
                    && receipt.sequence == next(work.revision.applied_input_sequence)?
                    && receipt.requirements_revision == Some(work.revision.requirements_revision),
                "CONTINUOUS_WORK_INPUT_REVISION_CHANGED"
            );
            work.revision.revision = next(work.revision.revision)?;
            work.revision.applied_input_sequence = receipt.sequence;
            receipt.state = WorkInputState::Applied;
            input.receipt = serde_json::to_value(&receipt)?;
            input.applied = Some(applied.clone());
            stored.record = serde_json::to_value(&work)?;
            Ok((receipt, true))
        })
    }

    /// Record application of the initial input by its already-running native
    /// turn. The host must first observe the exact committed message in the
    /// actual provider request and an original response from that request.
    /// This records a historical fact; it does not claim or dispatch a turn.
    pub fn record_native_initial_applied(
        &self,
        state: &AppState,
        scope: &WorkScope,
        source: &WorkInputSource,
        native: &NativeInitialWorkReceipt,
    ) -> Result<WorkInputReceipt> {
        source.validate()?;
        let observed = native
            .observe_original(state)
            .context("CONTINUOUS_WORK_INITIAL_WITNESS_UNAVAILABLE")?;
        let original = native
            .original
            .upgrade()
            .context("CONTINUOUS_WORK_INITIAL_WITNESS_UNAVAILABLE")?;
        let alive = native
            .alive
            .upgrade()
            .context("CONTINUOUS_WORK_INITIAL_WITNESS_UNAVAILABLE")?;
        let attempt = original
            .attempt()
            .context("CONTINUOUS_WORK_ATTEMPT_UNAVAILABLE")?
            .clone();
        let applied = AppliedInputReference {
            attempt: attempt.clone(),
            history_uuid: original.uuid().to_owned(),
        };
        let identity = observed.identity.clone();
        ensure!(
            identity.matches_scope(scope)
                && observed.origin.initial_attempt == attempt
                && source.conversation_id == attempt.thread_id,
            "CONTINUOUS_WORK_INITIAL_IDENTITY_MISMATCH"
        );
        self.update(|data| {
            ensure!(
                alive.load(Ordering::Acquire)
                    && original.belongs_to_live_state(state)
                    && original.try_is_current().is_ok_and(|current| current),
                "CONTINUOUS_WORK_INITIAL_WITNESS_UNAVAILABLE"
            );
            require_known_inputs(data, &identity)?;
            let stored = data
                .works
                .get_mut(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record(stored, scope)?;
            let input = data
                .inputs
                .get_mut(&input_key(&identity, source, original.uuid())?)
                .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?;
            let mut receipt: WorkInputReceipt = mutable_parse(&input.receipt)?;
            receipt
                .validate_for_mutation(scope)
                .map_err(anyhow::Error::msg)?;
            ensure!(
                input.source == *source
                    && receipt.work == identity
                    && receipt.input_id == original.uuid()
                    && receipt.sequence == 1
                    && stored.bindings.get(&attempt.thread_id) == Some(&attempt),
                "CONTINUOUS_WORK_INITIAL_IDENTITY_MISMATCH"
            );
            if receipt.state == WorkInputState::Applied && input.applied.as_ref() == Some(&applied)
            {
                return Ok((receipt, false));
            }
            ensure!(
                work == observed
                    && stored.active_claim.is_none()
                    && stored.pending_control.is_none()
                    && receipt.state == WorkInputState::Accepted
                    && input.applied.is_none(),
                "CONTINUOUS_WORK_INITIAL_REVISION_CHANGED"
            );
            work.revision.revision = next(work.revision.revision)?;
            work.revision.applied_input_sequence = 1;
            receipt.state = WorkInputState::Applied;
            input.receipt = serde_json::to_value(&receipt)?;
            input.applied = Some(applied.clone());
            stored.record = serde_json::to_value(&work)?;
            Ok((receipt, true))
        })
    }

    /// Publish one text or image initial input. The host must run this in its
    /// bounded owned worker and retain the returned owner beside the original
    /// live session lease. Cancellation cannot replay an accepted write.
    ///
    /// The host separately verifies the original accepted turn, pre-Hook input,
    /// account and source. Matching identifiers or user-supplied names do not
    /// do so. Existing/recovered or uncertain publications cannot mint proof.
    pub fn admit_initial_from_native(
        &self,
        request: NativeInitialWorkRequest<'_>,
    ) -> NativeInitialWorkAdmission {
        let NativeInitialWorkRequest {
            state,
            scope,
            work,
            source,
            request_id,
            committed,
            original_accepted,
            accepted_deliveries,
            capacity,
        } = request;
        let Some(attempt) = committed.attempt() else {
            return NativeInitialWorkAdmission::Unavailable;
        };
        if committed.outcome() != UserInputCommit::Durable
            || committed.original_message() != Some(original_accepted)
            || !committed.belongs_to_live_state(state)
            || !committed.try_is_current().is_ok_and(|current| current)
            || &work.origin.initial_attempt != attempt
            || work.origin.kind != kcoder_types::continuous_work::WorkOriginKind::Foreground
            || work.validate_for_mutation(scope).is_err()
            || source.validate().is_err()
            || !atom(request_id)
        {
            return NativeInitialWorkAdmission::Unavailable;
        }
        let Ok(payload) = native_work_input_payload(&committed, original_accepted, false) else {
            return NativeInitialWorkAdmission::Unavailable;
        };
        let permit = capacity.try_acquire();
        if !committed.claim_initial_work() {
            return NativeInitialWorkAdmission::Unknown;
        }
        let mut published = None;
        let outcome = self.admit_two_phase_observed(
            publication_intent::InitialInputAcceptance {
                actual_scope: scope,
                work,
                source,
                request_id,
                payload,
                accepted_deliveries,
            },
            permit.as_ref().map(|_| &mut published),
        );
        let Ok(InitialAdmission::Accepted(accepted)) = outcome else {
            return NativeInitialWorkAdmission::Unknown;
        };
        if !committed.belongs_to_live_state(state)
            || !committed.try_is_current().is_ok_and(|current| current)
        {
            return NativeInitialWorkAdmission::Unknown;
        }
        let Some(permit) = permit else {
            return NativeInitialWorkAdmission::WithoutWitness;
        };
        let Some(mut published) = published else {
            return NativeInitialWorkAdmission::Unknown;
        };
        if published.published.revalidate().is_err()
            || published.verified.verify_contents().is_err()
            || published.published.revalidate().is_err()
            || !committed.belongs_to_live_state(state)
            || !committed.try_is_current().is_ok_and(|current| current)
        {
            return NativeInitialWorkAdmission::Unknown;
        }
        NativeInitialWorkAdmission::Accepted(NativeInitialWorkOwner {
            original: committed,
            evidence: Arc::new(Evidence {
                initial_work: accepted.work,
                published: Mutex::new(published),
                _permit: permit,
            }),
            alive: Arc::new(AtomicBool::new(true)),
        })
    }
}

#[cfg(test)]
thread_local! {
    static PAUSE_BEFORE_OBSERVATION_RESULT: std::cell::RefCell<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
fn pause_before_observation_result_for_test() {
    PAUSE_BEFORE_OBSERVATION_RESULT.with(|hook| {
        if let Some((ready, resume)) = hook.borrow_mut().take() {
            ready.send(()).unwrap();
            resume
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
        }
    });
}

#[cfg(test)]
mod tests;
