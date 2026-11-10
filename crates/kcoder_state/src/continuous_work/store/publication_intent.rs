//! Durable per-input publication intents. These records are not acceptance,
//! a source grant, or proof that the original model/tool action has run.
use super::super::namespace::PublicationLease;
use super::*;
use crate::prepared_immutable::PreparedImmutableIdentity;

const MAX_PUBLICATION_ATTEMPTS: usize = 64;

#[cfg(test)]
thread_local! {
    static CRASH_AFTER_INTENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CRASH_AFTER_PUBLICATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CRASH_AFTER_RECEIPT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_AFTER_NATIVE_COMMIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static PAUSE_AFTER_INTENT: std::cell::RefCell<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>> = const { std::cell::RefCell::new(None) };
    static PREPARE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(in crate::continuous_work) fn crash_after_next_payload_for_test() {
    CRASH_AFTER_PUBLICATION.with(|flag| flag.set(true));
}

#[cfg(test)]
pub(in crate::continuous_work) fn crash_after_next_receipt_for_test() {
    CRASH_AFTER_RECEIPT.with(|flag| flag.set(true));
}

#[cfg(test)]
pub(super) fn fail_after_native_commit_for_test() {
    FAIL_AFTER_NATIVE_COMMIT.with(|flag| flag.set(true));
}

#[cfg(test)]
pub(super) fn pause_after_native_intent_for_test(
    ready: std::sync::mpsc::Sender<()>,
    resume: std::sync::mpsc::Receiver<()>,
) {
    PAUSE_AFTER_INTENT.with(|hook| *hook.borrow_mut() = Some((ready, resume)));
}

pub(super) fn validate_publications(data: &StoreData) -> Result<()> {
    ensure!(
        data.pending_publications.len() <= MAX_INPUTS
            && data.pending_input_ids.len() == data.pending_publications.len(),
        "CONTINUOUS_WORK_PUBLICATION_INDEX_INVALID"
    );
    for (operation_key, intent) in &data.pending_publications {
        intent.validate_shape()?;
        let expected_operation =
            input_operation_key(&intent.scope, &intent.source, &intent.request_id)?;
        let identity_key = input_identity_key(&intent.scope, &intent.source, &intent.input_id)?;
        ensure!(
            *operation_key == expected_operation
                && data.pending_input_ids.get(&identity_key) == Some(operation_key)
                && !data.operations.contains_key(operation_key)
                && !data.input_ids.contains_key(&identity_key),
            "CONTINUOUS_WORK_PUBLICATION_INDEX_INVALID"
        );
    }
    Ok(())
}

pub(super) fn validate_publication_receipt(
    input: &StoredInput,
    receipt: &WorkInputReceipt,
) -> Result<()> {
    let Some(intent) = &input.publication else {
        return Ok(());
    };
    intent.validate_shape()?;
    ensure!(
        intent.work_identity() == &receipt.work
            && intent.source == input.source
            && intent.input_id == receipt.input_id
            && intent.request_id == receipt.request_id
            && intent.request_sha256 == receipt.request_digest
            && intent.payload_sha256 == input.payload_sha256
            && intent.payload_size == input.payload_size
            && intent.payload_ref == receipt.payload_ref
            && !intent.current_attempt()?.verified_absent,
        "CONTINUOUS_WORK_PUBLICATION_RECEIPT_MISMATCH"
    );
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PublicationObjectAttempt {
    pub(super) generation: u64,
    pub(super) identity: PreparedImmutableIdentity,
    /// True only after the original lease is held and its exact final entry was
    /// verified absent; it is never inferred from timeout or a lost response.
    pub(super) verified_absent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PublicationFenceRebase {
    pub(super) from_revision: u64,
    pub(super) to_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum PendingInputAction {
    Initial {
        work: Box<WorkRecord>,
        accepted_deliveries: Vec<WorkDeliveryRequirement>,
    },
    Append {
        work: WorkIdentity,
        expected_revision: u64,
        expected_control_epoch: u64,
        input_kind: WorkInputKind,
        accepted_deliveries: Option<Vec<WorkDeliveryRequirement>>,
        /// Persisted intents written before target-side queues existed are accepted
        /// receipts, not queued ones.
        #[serde(default)]
        queued: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PendingInputPublication {
    pub(super) version: u32,
    pub(super) scope: WorkScope,
    pub(super) source: WorkInputSource,
    pub(super) input_id: String,
    pub(super) request_id: String,
    pub(super) request_sha256: String,
    pub(super) payload_sha256: String,
    pub(super) payload_size: u64,
    pub(super) payload_ref: String,
    pub(super) lease_name: String,
    pub(super) lease_identity: kcoder_config::PortableLeaseIdentity,
    pub(super) attempts: Vec<PublicationObjectAttempt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) rebases: Vec<PublicationFenceRebase>,
    pub(super) action: PendingInputAction,
}

/// Transient prepared object before its owner lease and intent exist. It is
/// never serialized or returned as an accepted input.
pub(super) struct InputPublicationDraft {
    pub(super) scope: WorkScope,
    pub(super) source: WorkInputSource,
    pub(super) input_id: String,
    pub(super) request_id: String,
    pub(super) request_sha256: String,
    pub(super) payload_sha256: String,
    pub(super) payload_size: u64,
    pub(super) payload_ref: String,
    pub(super) object_identity: PreparedImmutableIdentity,
    pub(super) action: PendingInputAction,
}

struct ReplayIdentity<'a> {
    scope: &'a WorkScope,
    source: &'a WorkInputSource,
    input_id: &'a str,
    request_id: &'a str,
    request_sha256: &'a str,
    payload_sha256: &'a str,
    payload_size: u64,
    action: &'a PendingInputAction,
}

fn original_receipt_matches(
    data: &StoreData,
    input: &StoredInput,
    identity: &ReplayIdentity<'_>,
) -> Result<bool> {
    let original = receipt(input)?;
    let category_matches = match identity.action {
        PendingInputAction::Initial { work, .. } => {
            let stored = data
                .works
                .get(&work_key(&original.work)?)
                .context("CONTINUOUS_WORK_RECORD_MISSING")?;
            let saved = record(stored)?;
            let original_attempt = &work.origin.initial_attempt;
            original.sequence == 1
                && original.kind == WorkInputKind::Requirement
                && work.identity.scope == original.work.scope
                && saved.identity == original.work
                && saved.origin == work.origin
                && stored.bindings.get(&original_attempt.thread_id) == Some(original_attempt)
        }
        PendingInputAction::Append {
            work, input_kind, ..
        } => original.work == *work && original.sequence > 1 && original.kind == *input_kind,
    };
    Ok(original.work.matches_scope(identity.scope)
        && input.source == *identity.source
        && original.input_id == identity.input_id
        && original.request_digest == identity.request_sha256
        && input.payload_sha256 == identity.payload_sha256
        && input.payload_size == identity.payload_size
        && category_matches)
}
impl InputPublicationDraft {
    fn work_identity(&self) -> &WorkIdentity {
        match &self.action {
            PendingInputAction::Initial { work, .. } => &work.identity,
            PendingInputAction::Append { work, .. } => work,
        }
    }

    fn matches_pending_target(&self, existing: &PendingInputPublication) -> bool {
        match (&self.action, &existing.action) {
            (
                PendingInputAction::Initial { work, .. },
                PendingInputAction::Initial { work: original, .. },
            ) => work.identity.scope == original.identity.scope && work.origin == original.origin,
            (
                PendingInputAction::Append { work, .. },
                PendingInputAction::Append { work: original, .. },
            ) => work == original,
            _ => false,
        }
    }
}

impl PendingInputPublication {
    pub(super) fn work_identity(&self) -> &WorkIdentity {
        match &self.action {
            PendingInputAction::Initial { work, .. } => &work.identity,
            PendingInputAction::Append { work, .. } => work,
        }
    }
    pub(super) fn current_attempt(&self) -> Result<&PublicationObjectAttempt> {
        self.attempts
            .last()
            .context("CONTINUOUS_WORK_PUBLICATION_ATTEMPT_MISSING")
    }
    pub(super) fn validate_shape(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && atom(&self.input_id)
                && atom(&self.request_id)
                && self.request_sha256.len() == 64
                && self.payload_sha256.len() == 64
                && [&self.request_sha256, &self.payload_sha256]
                    .into_iter()
                    .all(|digest| digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
                && self.payload_size <= MAX_INPUT_BYTES as u64,
            "CONTINUOUS_WORK_PUBLICATION_INTENT_INVALID"
        );
        self.scope.validate_shape().map_err(anyhow::Error::msg)?;
        self.source.validate()?;
        self.work_identity()
            .validate_shape()
            .map_err(anyhow::Error::msg)?;
        ensure!(
            self.work_identity().matches_scope(&self.scope)
                && self.payload_ref
                    == format!(
                        "payload-{}",
                        input_key(self.work_identity(), &self.source, &self.input_id)?
                    ),
            "CONTINUOUS_WORK_PUBLICATION_INTENT_INVALID"
        );
        let lease_id = self
            .lease_name
            .strip_prefix("publication-")
            .and_then(|value| value.strip_suffix(".lease"));
        ensure!(
            lease_id
                .and_then(|value| uuid::Uuid::parse_str(value).ok())
                .is_some(),
            "CONTINUOUS_WORK_PUBLICATION_LEASE_INVALID"
        );
        ensure!(
            !self.attempts.is_empty() && self.attempts.len() <= MAX_PUBLICATION_ATTEMPTS,
            "CONTINUOUS_WORK_PUBLICATION_ATTEMPT_INVALID"
        );
        for (index, attempt) in self.attempts.iter().enumerate() {
            ensure!(
                attempt.generation == u64::try_from(index)? + 1
                    && (index + 1 == self.attempts.len() || attempt.verified_absent),
                "CONTINUOUS_WORK_PUBLICATION_ATTEMPT_INVALID"
            );
        }
        ensure!(
            self.rebases.len() <= MAX_PUBLICATION_ATTEMPTS,
            "CONTINUOUS_WORK_CAPACITY"
        );
        let mut previous = None;
        for rebase in &self.rebases {
            ensure!(
                rebase.from_revision > 0
                    && rebase.to_revision > rebase.from_revision
                    && previous.is_none_or(|revision| revision == rebase.from_revision),
                "CONTINUOUS_WORK_PUBLICATION_FENCE_INVALID"
            );
            previous = Some(rebase.to_revision);
        }
        match &self.action {
            PendingInputAction::Initial {
                work,
                accepted_deliveries,
            } => {
                ensure!(
                    self.rebases.is_empty(),
                    "CONTINUOUS_WORK_PUBLICATION_FENCE_INVALID"
                );
                work.validate_for_mutation(&self.scope)
                    .map_err(anyhow::Error::msg)?;
                validate_deliveries(accepted_deliveries)?;
                ensure!(
                    work.phase == WorkPhase::Pending
                        && work.waiting.is_none()
                        && work.result.is_none()
                        && work.revision.revision == 1
                        && work.revision.requirements_revision == 1
                        && work.revision.control_epoch == 0
                        && work.revision.owner_epoch == 0
                        && work.revision.accepted_input_sequence == 1
                        && work.revision.required_input_sequence == 1
                        && work.revision.applied_input_sequence == 0
                        && work.linked_thread_ids.len() == 1
                        && accepted_deliveries
                            .iter()
                            .all(|delivery| delivery.minimum_confirmation.is_known()),
                    "CONTINUOUS_WORK_INITIAL_STATE_INVALID"
                );
                ensure!(
                    self.input_id == self.request_id
                        && hash(&(
                            &work.origin,
                            &self.source,
                            &self.payload_sha256,
                            accepted_deliveries
                        ))? == self.request_sha256,
                    "CONTINUOUS_WORK_PUBLICATION_REQUEST_CONFLICT"
                );
            }
            PendingInputAction::Append {
                work,
                expected_revision,
                input_kind,
                accepted_deliveries,
                ..
            } => {
                ensure!(
                    previous.is_none_or(|revision| revision == *expected_revision),
                    "CONTINUOUS_WORK_PUBLICATION_FENCE_INVALID"
                );
                ensure!(
                    *expected_revision > 0
                        && matches!(
                            input_kind,
                            WorkInputKind::Requirement
                                | WorkInputKind::Answer
                                | WorkInputKind::StatusQuery
                        )
                        && (input_kind == &WorkInputKind::Requirement)
                            == accepted_deliveries.is_some(),
                    "CONTINUOUS_WORK_PUBLICATION_INTENT_INVALID"
                );
                if let Some(deliveries) = accepted_deliveries {
                    validate_deliveries(deliveries)?;
                    ensure!(
                        deliveries
                            .iter()
                            .all(|delivery| delivery.minimum_confirmation.is_known()),
                        "CONTINUOUS_WORK_DELIVERY_UNKNOWN"
                    );
                }
                ensure!(
                    hash(&(
                        work,
                        &self.source,
                        &self.input_id,
                        input_kind,
                        &self.payload_sha256,
                        accepted_deliveries
                    ))? == self.request_sha256,
                    "CONTINUOUS_WORK_PUBLICATION_REQUEST_CONFLICT"
                );
            }
        }
        Ok(())
    }

    fn validate_current_fence(&self, data: &StoreData) -> Result<()> {
        match &self.action {
            PendingInputAction::Initial { work, .. } => ensure!(
                !data.works.contains_key(&work_key(&work.identity)?),
                "CONTINUOUS_WORK_IDENTITY_CONFLICT"
            ),
            PendingInputAction::Append {
                work,
                expected_revision,
                expected_control_epoch,
                ..
            } => {
                require_known_inputs(data, work)?;
                let stored = data
                    .works
                    .get(&work_key(work)?)
                    .context("CONTINUOUS_WORK_NOT_FOUND")?;
                let record = mutable_record(stored, &self.scope)?;
                ensure!(
                    record.phase != WorkPhase::Stopped
                        && !stored
                            .pending_control
                            .as_ref()
                            .is_some_and(|control| control.action == WorkControlAction::Stop),
                    "CONTINUOUS_WORK_STOPPED_REQUIRES_NEW_ACCEPTANCE"
                );
                ensure!(
                    record.revision.revision == *expected_revision
                        && record.revision.control_epoch == *expected_control_epoch,
                    "CONTINUOUS_WORK_REVISION_CONFLICT"
                );
            }
        }
        Ok(())
    }
}

/// An acquired owner lease must stay alive through publication and receipt
/// commit. InProgress never means that the input was already accepted.
pub(super) enum PublicationReservation {
    Existing(WorkInputReceipt),
    Owner {
        intent: Box<PendingInputPublication>,
        lease: PublicationLease,
        created: bool,
    },
    InProgress,
}

/// Pending means an original publication intent exists, not that the input
/// was accepted or any tool/model action started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputPublicationStatus {
    pub work: WorkIdentity,
    pub source: WorkInputSource,
    pub input_id: String,
    pub request_id: String,
}

pub(super) struct InputAcceptance<'a> {
    pub actual_scope: &'a WorkScope,
    pub work_id: &'a str,
    pub source: &'a WorkInputSource,
    pub expected_revision: u64,
    pub input_id: &'a str,
    pub request_id: &'a str,
    pub kind: WorkInputKind,
    pub payload: Value,
    pub accepted_deliveries: Option<Vec<WorkDeliveryRequirement>>,
    /// A busy target keeps the input queued instead of treating it as accepted
    /// for the running turn.
    pub queued: bool,
}

pub(super) struct InitialInputAcceptance<'a> {
    pub actual_scope: &'a WorkScope,
    pub work: WorkRecord,
    pub source: &'a WorkInputSource,
    pub request_id: &'a str,
    pub payload: Value,
    pub accepted_deliveries: Vec<WorkDeliveryRequirement>,
}

impl ContinuousWorkStore {
    fn prepare_original_input(
        &self,
        name: &str,
        bytes: &[u8],
    ) -> Result<crate::prepared_immutable::PreparedImmutable> {
        #[cfg(test)]
        PREPARE_COUNT.with(|count| count.set(count.get() + 1));
        self.namespace.prepare_publication_object(name, bytes)
    }

    /// Observe an exact committed request without creating a new object. An
    /// unknown request ID must take the regular transaction so any new alias
    /// is durably recorded and checked against concurrent operations.
    fn try_replay_accepted_input(
        &self,
        identity: &ReplayIdentity<'_>,
        expected_payload: &Value,
    ) -> Result<Option<(WorkInputReceipt, Value)>> {
        self.try_replay_accepted_input_inner(identity, expected_payload, || Ok(()))
    }

    fn try_replay_accepted_input_inner(
        &self,
        identity: &ReplayIdentity<'_>,
        expected_payload: &Value,
        after_read: impl FnOnce() -> Result<()>,
    ) -> Result<Option<(WorkInputReceipt, Value)>> {
        let operation_key =
            input_operation_key(identity.scope, identity.source, identity.request_id)?;
        let snapshot = self.read(|data| {
            let Some(operation) = data.operations.get(&operation_key) else {
                return Ok(None);
            };
            let StoredOperation::Input { digest, input_key } = operation else {
                bail!("CONTINUOUS_WORK_REQUEST_CONFLICT");
            };
            ensure!(
                digest == identity.request_sha256,
                "CONTINUOUS_WORK_REQUEST_CONFLICT"
            );
            let input = data
                .inputs
                .get(input_key)
                .context("CONTINUOUS_WORK_RECEIPT_MISSING")?;
            ensure!(
                original_receipt_matches(data, input, identity)?,
                "CONTINUOUS_WORK_REQUEST_CONFLICT"
            );
            Ok(Some((input_key.clone(), input.clone(), receipt(input)?)))
        })?;
        let Some((input_key, input, original)) = snapshot else {
            return Ok(None);
        };
        let (payload, witness) = self.observe_payload(&input)?;
        ensure!(
            &payload == expected_payload,
            "CONTINUOUS_WORK_PAYLOAD_CHANGED"
        );
        after_read()?;
        let unchanged = self.read(|data| {
            let operation_unchanged = matches!(
                data.operations.get(&operation_key),
                Some(StoredOperation::Input { digest, input_key: saved_key })
                    if digest == identity.request_sha256 && saved_key == &input_key
            );
            if !operation_unchanged
                || data.inputs.get(&input_key) != Some(&input)
                || !original_receipt_matches(data, &input, identity)?
            {
                return Ok(false);
            }
            witness.revalidate()?;
            Ok(true)
        })?;
        Ok(unchanged.then_some((original, payload)))
    }

    /// Pure lookup: no lease acquisition, file repair or publication occurs.
    pub fn read_input_publication_status(
        &self,
        scope: &WorkScope,
        source: &WorkInputSource,
        request_id: &str,
    ) -> Result<Option<InputPublicationStatus>> {
        scope.validate_shape().map_err(anyhow::Error::msg)?;
        source.validate()?;
        ensure!(atom(request_id), "CONTINUOUS_WORK_REQUEST_INVALID");
        let key = input_operation_key(scope, source, request_id)?;
        self.read(|data| {
            Ok(data
                .pending_publications
                .get(&key)
                .map(|intent| InputPublicationStatus {
                    work: intent.work_identity().clone(),
                    source: intent.source.clone(),
                    input_id: intent.input_id.clone(),
                    request_id: intent.request_id.clone(),
                }))
        })
    }
    /// Two-phase initial input publication. The host must verify the original
    /// accepted attempt and source before entering this private storage path.
    pub(super) fn admit_two_phase(
        &self,
        actual_scope: &WorkScope,
        work: WorkRecord,
        source: &WorkInputSource,
        request_id: &str,
        payload: Value,
        accepted_deliveries: Vec<WorkDeliveryRequirement>,
    ) -> Result<InitialAdmission> {
        self.admit_two_phase_observed(
            InitialInputAcceptance {
                actual_scope,
                work,
                source,
                request_id,
                payload,
                accepted_deliveries,
            },
            None,
        )
    }

    pub(super) fn admit_two_phase_observed(
        &self,
        request: InitialInputAcceptance<'_>,
        original_capture: Option<&mut Option<NativePublishedInput>>,
    ) -> Result<InitialAdmission> {
        let InitialInputAcceptance {
            actual_scope,
            work,
            source,
            request_id,
            payload,
            accepted_deliveries,
        } = request;
        work.validate_for_mutation(actual_scope)
            .map_err(anyhow::Error::msg)?;
        source.validate()?;
        ensure!(atom(request_id), "CONTINUOUS_WORK_REQUEST_INVALID");
        validate_deliveries(&accepted_deliveries)?;
        ensure!(
            accepted_deliveries
                .iter()
                .all(|delivery| delivery.minimum_confirmation.is_known()),
            "CONTINUOUS_WORK_DELIVERY_UNKNOWN"
        );
        ensure!(
            work.phase == WorkPhase::Pending
                && work.waiting.is_none()
                && work.result.is_none()
                && work.revision.revision == 1
                && work.revision.requirements_revision == 1
                && work.revision.control_epoch == 0
                && work.revision.owner_epoch == 0
                && work.revision.accepted_input_sequence == 1
                && work.revision.required_input_sequence == 1
                && work.revision.applied_input_sequence == 0
                && work.linked_thread_ids.len() == 1,
            "CONTINUOUS_WORK_INITIAL_STATE_INVALID"
        );
        let (bytes, payload_sha256) = payload_bytes(&payload)?;
        let payload_ref = format!("payload-{}", input_key(&work.identity, source, request_id)?);
        let request_sha256 = hash(&(&work.origin, source, &payload_sha256, &accepted_deliveries))?;
        let action = PendingInputAction::Initial {
            work: Box::new(work),
            accepted_deliveries,
        };
        let replay = ReplayIdentity {
            scope: actual_scope,
            source,
            input_id: request_id,
            request_id,
            request_sha256: &request_sha256,
            payload_sha256: &payload_sha256,
            payload_size: bytes.len() as u64,
            action: &action,
        };
        if let Some((receipt, payload)) = self.try_replay_accepted_input(&replay, &payload)? {
            let work = self
                .read_work(actual_scope, &receipt.work.work_id)?
                .context("CONTINUOUS_WORK_RECORD_MISSING")?;
            return Ok(InitialAdmission::Existing(AcceptedInput {
                work,
                receipt,
                payload,
            }));
        }
        let prepared = self.prepare_original_input(&payload_ref, &bytes)?;
        let draft = InputPublicationDraft {
            scope: actual_scope.clone(),
            source: source.clone(),
            input_id: request_id.into(),
            request_id: request_id.into(),
            request_sha256,
            payload_sha256,
            payload_size: bytes.len() as u64,
            payload_ref,
            object_identity: prepared.identity().clone(),
            action,
        };
        match self.run_input_publication(draft, prepared, &bytes, original_capture)? {
            PublicationFinalized::Initial(accepted, true) => {
                Ok(InitialAdmission::Accepted(*accepted))
            }
            PublicationFinalized::Initial(accepted, false) => {
                Ok(InitialAdmission::Existing(*accepted))
            }
            _ => bail!("CONTINUOUS_WORK_PUBLICATION_ACTION_MISMATCH"),
        }
    }

    /// Two-phase append. Receipt creation is distinct from applying the input.
    pub(super) fn accept_input_two_phase(
        &self,
        request: InputAcceptance<'_>,
    ) -> Result<InputAdmission> {
        let InputAcceptance {
            actual_scope,
            work_id,
            source,
            expected_revision,
            input_id,
            request_id,
            kind,
            payload,
            accepted_deliveries,
            queued,
        } = request;
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        source.validate()?;
        ensure!(
            atom(input_id) && atom(request_id) && expected_revision > 0,
            "CONTINUOUS_WORK_INPUT_INVALID"
        );
        ensure!(
            matches!(
                &kind,
                WorkInputKind::Requirement | WorkInputKind::Answer | WorkInputKind::StatusQuery
            ) && (kind == WorkInputKind::Requirement) == accepted_deliveries.is_some(),
            "CONTINUOUS_WORK_DELIVERY_SNAPSHOT_REQUIRED"
        );
        if let Some(deliveries) = &accepted_deliveries {
            validate_deliveries(deliveries)?;
            ensure!(
                deliveries
                    .iter()
                    .all(|delivery| delivery.minimum_confirmation.is_known()),
                "CONTINUOUS_WORK_DELIVERY_UNKNOWN"
            );
        }
        let work = self
            .read_work(actual_scope, work_id)?
            .context("CONTINUOUS_WORK_NOT_FOUND")?;
        let (bytes, payload_sha256) = payload_bytes(&payload)?;
        let payload_ref = format!("payload-{}", input_key(&identity, source, input_id)?);
        let request_sha256 = hash(&(
            &identity,
            source,
            input_id,
            &kind,
            &payload_sha256,
            &accepted_deliveries,
        ))?;
        let action = PendingInputAction::Append {
            work: identity,
            expected_revision,
            expected_control_epoch: work.revision.control_epoch,
            input_kind: kind,
            accepted_deliveries,
            queued,
        };
        let replay = ReplayIdentity {
            scope: actual_scope,
            source,
            input_id,
            request_id,
            request_sha256: &request_sha256,
            payload_sha256: &payload_sha256,
            payload_size: bytes.len() as u64,
            action: &action,
        };
        if let Some((receipt, _)) = self.try_replay_accepted_input(&replay, &payload)? {
            return Ok(InputAdmission::Existing(receipt));
        }
        let prepared = self.prepare_original_input(&payload_ref, &bytes)?;
        let draft = InputPublicationDraft {
            scope: actual_scope.clone(),
            source: source.clone(),
            input_id: input_id.into(),
            request_id: request_id.into(),
            request_sha256,
            payload_sha256,
            payload_size: bytes.len() as u64,
            payload_ref,
            object_identity: prepared.identity().clone(),
            action,
        };
        match self.run_input_publication(draft, prepared, &bytes, None)? {
            PublicationFinalized::Append(receipt, true) => Ok(InputAdmission::Accepted(*receipt)),
            PublicationFinalized::Append(receipt, false) => Ok(InputAdmission::Existing(*receipt)),
            _ => bail!("CONTINUOUS_WORK_PUBLICATION_ACTION_MISMATCH"),
        }
    }

    /// The prepared object already exists as an unpublished held kernel
    /// handle. This short transaction records its exact original identity and
    /// operation lease before any final name can be linked.
    pub(super) fn reserve_input_publication(
        &self,
        candidate: InputPublicationDraft,
    ) -> Result<PublicationReservation> {
        candidate
            .scope
            .validate_shape()
            .map_err(anyhow::Error::msg)?;
        candidate.source.validate()?;
        candidate
            .work_identity()
            .validate_shape()
            .map_err(anyhow::Error::msg)?;
        ensure!(
            candidate.work_identity().matches_scope(&candidate.scope)
                && atom(&candidate.input_id)
                && atom(&candidate.request_id)
                && candidate.payload_size <= MAX_INPUT_BYTES as u64,
            "CONTINUOUS_WORK_PUBLICATION_INTENT_INVALID"
        );
        let operation_key =
            input_operation_key(&candidate.scope, &candidate.source, &candidate.request_id)?;
        let identity_key =
            input_identity_key(&candidate.scope, &candidate.source, &candidate.input_id)?;
        self.update(|data| {
            if let Some(operation) = data.operations.get(&operation_key) {
                let StoredOperation::Input { digest, input_key } = operation else {
                    bail!("CONTINUOUS_WORK_REQUEST_CONFLICT")
                };
                ensure!(
                    *digest == candidate.request_sha256,
                    "CONTINUOUS_WORK_REQUEST_CONFLICT"
                );
                let accepted = data
                    .inputs
                    .get(input_key)
                    .context("CONTINUOUS_WORK_RECEIPT_MISSING")?;
                let replay = ReplayIdentity {
                    scope: &candidate.scope,
                    source: &candidate.source,
                    input_id: &candidate.input_id,
                    request_id: &candidate.request_id,
                    request_sha256: &candidate.request_sha256,
                    payload_sha256: &candidate.payload_sha256,
                    payload_size: candidate.payload_size,
                    action: &candidate.action,
                };
                ensure!(
                    original_receipt_matches(data, accepted, &replay)?,
                    "CONTINUOUS_WORK_REQUEST_CONFLICT"
                );
                return Ok((PublicationReservation::Existing(receipt(accepted)?), false));
            }
            if let Some(existing_key) = data.input_ids.get(&identity_key) {
                let accepted = data
                    .inputs
                    .get(existing_key)
                    .context("CONTINUOUS_WORK_RECEIPT_MISSING")?;
                let original = receipt(accepted)?;
                let replay = ReplayIdentity {
                    scope: &candidate.scope,
                    source: &candidate.source,
                    input_id: &candidate.input_id,
                    request_id: &candidate.request_id,
                    request_sha256: &candidate.request_sha256,
                    payload_sha256: &candidate.payload_sha256,
                    payload_size: candidate.payload_size,
                    action: &candidate.action,
                };
                ensure!(
                    original_receipt_matches(data, accepted, &replay)?,
                    "CONTINUOUS_WORK_INPUT_CONFLICT"
                );
                let existing_key = existing_key.clone();
                ensure!(
                    data.operations.len() < MAX_OPERATIONS,
                    "CONTINUOUS_WORK_CAPACITY"
                );
                data.operations.insert(
                    operation_key,
                    StoredOperation::Input {
                        digest: candidate.request_sha256.clone(),
                        input_key: existing_key,
                    },
                );
                return Ok((PublicationReservation::Existing(original), true));
            }
            if let Some(mut existing) = data.pending_publications.get(&operation_key).cloned() {
                ensure!(
                    existing.input_id == candidate.input_id
                        && candidate.matches_pending_target(&existing)
                        && existing.request_sha256 == candidate.request_sha256
                        && existing.payload_sha256 == candidate.payload_sha256
                        && existing.payload_size == candidate.payload_size,
                    "CONTINUOUS_WORK_REQUEST_CONFLICT"
                );
                let Some(lease) = self
                    .namespace
                    .try_publication_lease(&existing.lease_name, &existing.lease_identity)?
                else {
                    return Ok((PublicationReservation::InProgress, false));
                };
                let mut changed = false;
                if let (
                    PendingInputAction::Append {
                        work,
                        expected_revision: old_revision,
                        expected_control_epoch: old_control,
                        ..
                    },
                    PendingInputAction::Append {
                        expected_revision: new_revision,
                        expected_control_epoch: new_control,
                        ..
                    },
                ) = (&mut existing.action, &candidate.action)
                {
                    let stored = data
                        .works
                        .get(&work_key(work)?)
                        .context("CONTINUOUS_WORK_NOT_FOUND")?;
                    let record = mutable_record(stored, &existing.scope)?;
                    ensure!(
                        record.phase != WorkPhase::Stopped
                            && !stored
                                .pending_control
                                .as_ref()
                                .is_some_and(|control| control.action == WorkControlAction::Stop),
                        "CONTINUOUS_WORK_STOPPED_REQUIRES_NEW_ACCEPTANCE"
                    );
                    ensure!(
                        record.revision.control_epoch == *old_control
                            && *new_control == *old_control
                            && record.revision.revision == *new_revision,
                        "CONTINUOUS_WORK_REVISION_CONFLICT"
                    );
                    if *old_revision != *new_revision {
                        ensure!(
                            existing.rebases.len() < MAX_PUBLICATION_ATTEMPTS,
                            "CONTINUOUS_WORK_CAPACITY"
                        );
                        existing.rebases.push(PublicationFenceRebase {
                            from_revision: *old_revision,
                            to_revision: *new_revision,
                        });
                        *old_revision = *new_revision;
                        changed = true;
                    }
                }
                existing.validate_current_fence(data)?;
                if changed {
                    existing.validate_shape()?;
                    data.pending_publications
                        .insert(operation_key.clone(), existing.clone());
                }
                return Ok((
                    PublicationReservation::Owner {
                        intent: Box::new(existing),
                        lease,
                        created: false,
                    },
                    changed,
                ));
            }
            if let Some(existing_key) = data.pending_input_ids.get(&identity_key) {
                let existing = data
                    .pending_publications
                    .get(existing_key)
                    .context("CONTINUOUS_WORK_PUBLICATION_INTENT_MISSING")?;
                ensure!(
                    existing.work_identity() == candidate.work_identity()
                        && existing.request_sha256 == candidate.request_sha256
                        && existing.payload_sha256 == candidate.payload_sha256
                        && existing.payload_size == candidate.payload_size,
                    "CONTINUOUS_WORK_INPUT_CONFLICT"
                );
                // A different transport request can observe the pending
                // original, but may not claim or replace its operation.
                return Ok((PublicationReservation::InProgress, false));
            }
            ensure!(
                data.pending_publications.len() < MAX_INPUTS
                    && data.pending_input_ids.len() < MAX_INPUTS,
                "CONTINUOUS_WORK_CAPACITY"
            );
            match &candidate.action {
                PendingInputAction::Initial { work, .. } => {
                    ensure!(
                        !data.works.contains_key(&work_key(&work.identity)?),
                        "CONTINUOUS_WORK_IDENTITY_CONFLICT"
                    );
                    ensure!(
                        !data.pending_publications.values().any(|pending| matches!(
                            &pending.action,
                            PendingInputAction::Initial { .. }
                        ) && pending
                            .work_identity()
                            == &work.identity),
                        "CONTINUOUS_WORK_IDENTITY_CONFLICT"
                    );
                }
                PendingInputAction::Append {
                    work,
                    expected_revision,
                    expected_control_epoch,
                    ..
                } => {
                    require_known_inputs(data, work)?;
                    ensure!(
                        !data.pending_publications.values().any(|pending| matches!(
                            &pending.action,
                            PendingInputAction::Append { .. }
                        ) && pending
                            .work_identity()
                            == work),
                        "CONTINUOUS_WORK_INPUT_IN_PROGRESS"
                    );
                    let stored = data
                        .works
                        .get(&work_key(work)?)
                        .context("CONTINUOUS_WORK_NOT_FOUND")?;
                    let record = mutable_record(stored, &candidate.scope)?;
                    ensure!(
                        record.revision.revision == *expected_revision
                            && record.revision.control_epoch == *expected_control_epoch,
                        "CONTINUOUS_WORK_REVISION_CONFLICT"
                    );
                    ensure!(
                        record.phase != WorkPhase::Stopped
                            && !stored
                                .pending_control
                                .as_ref()
                                .is_some_and(|control| control.action == WorkControlAction::Stop),
                        "CONTINUOUS_WORK_STOPPED_REQUIRES_NEW_ACCEPTANCE"
                    );
                }
            }
            let lease = self.namespace.create_publication_lease()?;
            let intent = PendingInputPublication {
                version: 1,
                scope: candidate.scope,
                source: candidate.source,
                input_id: candidate.input_id,
                request_id: candidate.request_id,
                request_sha256: candidate.request_sha256,
                payload_sha256: candidate.payload_sha256,
                payload_size: candidate.payload_size,
                payload_ref: candidate.payload_ref,
                lease_name: lease.name().to_owned(),
                lease_identity: lease.identity().clone(),
                attempts: vec![PublicationObjectAttempt {
                    generation: 1,
                    identity: candidate.object_identity,
                    verified_absent: false,
                }],
                rebases: Vec::new(),
                action: candidate.action,
            };
            intent.validate_shape()?;
            data.pending_input_ids
                .insert(identity_key, operation_key.clone());
            data.pending_publications
                .insert(operation_key, intent.clone());
            Ok((
                PublicationReservation::Owner {
                    intent: Box::new(intent),
                    lease,
                    created: true,
                },
                true,
            ))
        })
    }

    /// After the original owner lease has been reacquired, register a new
    /// prepared inode only if the exact final name is still absent. This does
    /// not execute or replay an external action and preserves older attempts.
    pub(super) fn reprepare_input_publication(
        &self,
        intent: &PendingInputPublication,
        lease: &PublicationLease,
        identity: PreparedImmutableIdentity,
    ) -> Result<PendingInputPublication> {
        let operation_key = input_operation_key(&intent.scope, &intent.source, &intent.request_id)?;
        self.update(|data| {
            lease.revalidate(&self.namespace)?;
            let current = data
                .pending_publications
                .get_mut(&operation_key)
                .context("CONTINUOUS_WORK_PUBLICATION_INTENT_MISSING")?;
            ensure!(
                *current == *intent
                    && current.lease_name == lease.name()
                    && current.lease_identity == *lease.identity(),
                "CONTINUOUS_WORK_PUBLICATION_INTENT_CHANGED"
            );
            ensure!(
                self.namespace
                    .publication_name_absent(&current.payload_ref)?,
                "CONTINUOUS_WORK_PUBLICATION_RECONCILIATION_REQUIRED"
            );
            ensure!(
                current.attempts.len() < MAX_PUBLICATION_ATTEMPTS,
                "CONTINUOUS_WORK_CAPACITY"
            );
            let previous = current
                .attempts
                .last_mut()
                .context("CONTINUOUS_WORK_PUBLICATION_ATTEMPT_MISSING")?;
            previous.verified_absent = true;
            let generation = next(previous.generation)?;
            current.attempts.push(PublicationObjectAttempt {
                generation,
                identity,
                verified_absent: false,
            });
            current.validate_shape()?;
            Ok((current.clone(), true))
        })
    }

    /// Verify full original bytes outside the State lock, then hold the exact
    /// witness and operation lease through the short atomic receipt transaction.
    pub(super) fn finalize_input_publication(
        &self,
        intent: &PendingInputPublication,
        lease: &PublicationLease,
        witness: &mut crate::prepared_immutable::VerifiedImmutableRead,
    ) -> Result<PublicationFinalized> {
        lease.revalidate(&self.namespace)?;
        ensure!(
            witness.identity() == &intent.current_attempt()?.identity,
            "CONTINUOUS_WORK_PUBLICATION_IDENTITY_MISMATCH"
        );
        witness.verify_contents()?;
        ensure!(
            witness.bytes().len() as u64 == intent.payload_size
                && format!("{:x}", Sha256::digest(witness.bytes())) == intent.payload_sha256,
            "CONTINUOUS_WORK_PAYLOAD_CHANGED"
        );
        // Parse the bounded original body while only the per-operation lease
        // is held; the global State transaction must not wait for body I/O.
        let mut initial_payload: Option<Value> =
            if matches!(&intent.action, PendingInputAction::Initial { .. }) {
                Some(
                    serde_json::from_slice(witness.bytes())
                        .context("CONTINUOUS_WORK_PAYLOAD_INVALID")?,
                )
            } else {
                None
            };
        let operation_key = input_operation_key(&intent.scope, &intent.source, &intent.request_id)?;
        let identity_key = input_identity_key(&intent.scope, &intent.source, &intent.input_id)?;
        let key = input_key(intent.work_identity(), &intent.source, &intent.input_id)?;
        self.update(|data| {
            lease.revalidate(&self.namespace)?;
            witness.revalidate()?;
            let current = data
                .pending_publications
                .get(&operation_key)
                .context("CONTINUOUS_WORK_PUBLICATION_INTENT_MISSING")?;
            ensure!(
                *current == *intent
                    && current.lease_name == lease.name()
                    && current.lease_identity == *lease.identity()
                    && data.pending_input_ids.get(&identity_key) == Some(&operation_key),
                "CONTINUOUS_WORK_PUBLICATION_INTENT_CHANGED"
            );
            ensure!(
                !data.inputs.contains_key(&key)
                    && !data.input_ids.contains_key(&identity_key)
                    && !data.operations.contains_key(&operation_key),
                "CONTINUOUS_WORK_INPUT_CONFLICT"
            );
            let (receipt, finalized) = match &intent.action {
                PendingInputAction::Initial {
                    work,
                    accepted_deliveries,
                } => {
                    ensure!(
                        !data.works.contains_key(&work_key(&work.identity)?),
                        "CONTINUOUS_WORK_IDENTITY_CONFLICT"
                    );
                    let receipt = WorkInputReceipt {
                        work: work.identity.clone(),
                        input_id: intent.input_id.clone(),
                        request_id: intent.request_id.clone(),
                        request_digest: intent.request_sha256.clone(),
                        payload_ref: intent.payload_ref.clone(),
                        sequence: 1,
                        kind: WorkInputKind::Requirement,
                        state: WorkInputState::Accepted,
                        requirements_revision: Some(1),
                    };
                    receipt
                        .validate_for_mutation(&intent.scope)
                        .map_err(anyhow::Error::msg)?;
                    let binding = work.origin.initial_attempt.clone();
                    data.works.insert(
                        work_key(&work.identity)?,
                        StoredWork {
                            record: serde_json::to_value(work)?,
                            bindings: BTreeMap::from([(binding.thread_id.clone(), binding)]),
                            claims: BTreeMap::new(),
                            active_claim: None,
                            pending_control: None,
                            accepted_deliveries: accepted_deliveries.clone(),
                            deliveries: BTreeMap::new(),
                        },
                    );
                    let payload = initial_payload
                        .take()
                        .context("CONTINUOUS_WORK_PAYLOAD_INVALID")?;
                    let accepted = AcceptedInput {
                        work: work.as_ref().clone(),
                        receipt: receipt.clone(),
                        payload,
                    };
                    (
                        receipt,
                        PublicationFinalized::Initial(Box::new(accepted), true),
                    )
                }
                PendingInputAction::Append {
                    work,
                    expected_revision,
                    expected_control_epoch,
                    input_kind,
                    accepted_deliveries,
                    queued,
                } => {
                    require_known_inputs(data, work)?;
                    let stored = data
                        .works
                        .get_mut(&work_key(work)?)
                        .context("CONTINUOUS_WORK_NOT_FOUND")?;
                    let mut record = mutable_record(stored, &intent.scope)?;
                    ensure!(
                        record.revision.revision == *expected_revision
                            && record.revision.control_epoch == *expected_control_epoch,
                        "CONTINUOUS_WORK_REVISION_CONFLICT"
                    );
                    ensure!(
                        record.phase != WorkPhase::Stopped
                            && !stored
                                .pending_control
                                .as_ref()
                                .is_some_and(|control| control.action == WorkControlAction::Stop),
                        "CONTINUOUS_WORK_STOPPED_REQUIRES_NEW_ACCEPTANCE"
                    );
                    record.revision.revision = next(record.revision.revision)?;
                    record.revision.accepted_input_sequence =
                        next(record.revision.accepted_input_sequence)?;
                    record.revision.required_input_sequence =
                        record.revision.accepted_input_sequence;
                    if let Some(presentation) = &mut record.presentation {
                        presentation.updated_at_ms = Some(
                            presentation
                                .updated_at_ms
                                .unwrap_or(0)
                                .max(crate::now_millis()),
                        );
                    }
                    if record.phase == WorkPhase::Completed {
                        record.phase = WorkPhase::Pending;
                    }
                    if let Some(deliveries) = accepted_deliveries {
                        stored.accepted_deliveries = deliveries.clone();
                    }
                    let requirements_revision = if *input_kind == WorkInputKind::Requirement {
                        record.revision.requirements_revision =
                            next(record.revision.requirements_revision)?;
                        Some(record.revision.requirements_revision)
                    } else {
                        None
                    };
                    let receipt = WorkInputReceipt {
                        work: work.clone(),
                        input_id: intent.input_id.clone(),
                        request_id: intent.request_id.clone(),
                        request_digest: intent.request_sha256.clone(),
                        payload_ref: intent.payload_ref.clone(),
                        sequence: record.revision.accepted_input_sequence,
                        kind: input_kind.clone(),
                        state: if *queued {
                            WorkInputState::Queued
                        } else {
                            WorkInputState::Accepted
                        },
                        requirements_revision,
                    };
                    receipt
                        .validate_for_mutation(&intent.scope)
                        .map_err(anyhow::Error::msg)?;
                    stored.record = serde_json::to_value(record)?;
                    (
                        receipt.clone(),
                        PublicationFinalized::Append(Box::new(receipt), true),
                    )
                }
            };
            let accepted_deliveries = match &intent.action {
                PendingInputAction::Initial {
                    accepted_deliveries,
                    ..
                } => Some(accepted_deliveries.clone()),
                PendingInputAction::Append {
                    accepted_deliveries,
                    ..
                } => accepted_deliveries.clone(),
            };
            data.inputs.insert(
                key.clone(),
                StoredInput {
                    receipt: serde_json::to_value(&receipt)?,
                    source: intent.source.clone(),
                    payload_sha256: intent.payload_sha256.clone(),
                    payload_size: intent.payload_size,
                    publication: Some(intent.clone()),
                    accepted_deliveries,
                    applied: None,
                },
            );
            data.input_ids.insert(identity_key.clone(), key.clone());
            data.operations.insert(
                operation_key.clone(),
                StoredOperation::Input {
                    digest: intent.request_sha256.clone(),
                    input_key: key,
                },
            );
            data.pending_input_ids.remove(&identity_key);
            data.pending_publications.remove(&operation_key);
            Ok((finalized, true))
        })
    }
}

pub(super) enum PublicationFinalized {
    Initial(Box<AcceptedInput>, bool),
    Append(Box<WorkInputReceipt>, bool),
}

/// Both objects came from the same original publication and remain held.
pub(super) struct NativePublishedInput {
    pub(super) published: crate::prepared_immutable::PublishedImmutable,
    pub(super) verified: crate::prepared_immutable::VerifiedImmutableRead,
}

impl ContinuousWorkStore {
    /// Orchestrate only private storage. The host has already authenticated
    /// the original source and retained exactly these serialized input bytes.
    /// No network, model or tool call runs while either State lock is held.
    pub(super) fn run_input_publication(
        &self,
        draft: InputPublicationDraft,
        mut prepared: crate::prepared_immutable::PreparedImmutable,
        bytes: &[u8],
        original_capture: Option<&mut Option<NativePublishedInput>>,
    ) -> Result<PublicationFinalized> {
        ensure!(
            bytes.len() as u64 == draft.payload_size
                && format!("{:x}", Sha256::digest(bytes)) == draft.payload_sha256
                && prepared.byte_len() == draft.payload_size
                && prepared.identity() == &draft.object_identity,
            "CONTINUOUS_WORK_PUBLICATION_REQUEST_CONFLICT"
        );
        let source = draft.source.clone();
        let is_initial = matches!(&draft.action, PendingInputAction::Initial { .. });
        match self.reserve_input_publication(draft)? {
            PublicationReservation::Existing(receipt) => {
                let (original, payload) = self
                    .read_input(
                        &receipt.work.scope,
                        &receipt.work.work_id,
                        &source,
                        &receipt.input_id,
                    )?
                    .context("CONTINUOUS_WORK_RECEIPT_MISSING")?;
                ensure!(original == receipt, "CONTINUOUS_WORK_RECEIPT_CHANGED");
                if is_initial {
                    let work = self
                        .read_work(&receipt.work.scope, &receipt.work.work_id)?
                        .context("CONTINUOUS_WORK_RECORD_MISSING")?;
                    Ok(PublicationFinalized::Initial(
                        Box::new(AcceptedInput {
                            work,
                            receipt,
                            payload,
                        }),
                        false,
                    ))
                } else {
                    Ok(PublicationFinalized::Append(Box::new(receipt), false))
                }
            }
            PublicationReservation::InProgress => bail!("CONTINUOUS_WORK_INPUT_IN_PROGRESS"),
            PublicationReservation::Owner {
                intent,
                lease,
                created,
            } => {
                let mut intent = *intent;
                lease.revalidate(&self.namespace)?;
                #[cfg(test)]
                CRASH_AFTER_INTENT.with(|flag| {
                    if flag.replace(false) {
                        std::process::exit(92);
                    }
                });
                #[cfg(test)]
                PAUSE_AFTER_INTENT.with(|hook| -> Result<()> {
                    if let Some((ready, resume)) = hook.borrow_mut().take() {
                        ready.send(())?;
                        resume.recv_timeout(std::time::Duration::from_secs(10))?;
                    }
                    Ok(())
                })?;
                if !created {
                    // The previous process's inode/FileID is no longer held.
                    // Even matching bytes and a reused identity cannot prove
                    // an existing name belongs to that original operation.
                    ensure!(
                        self.namespace
                            .publication_name_absent(&intent.payload_ref)?,
                        "CONTINUOUS_WORK_PUBLICATION_RECONCILIATION_REQUIRED"
                    );
                    prepared = self
                        .namespace
                        .prepare_publication_object(&intent.payload_ref, bytes)?;
                    intent = self.reprepare_input_publication(
                        &intent,
                        &lease,
                        prepared.identity().clone(),
                    )?;
                }
                ensure!(
                    prepared.target_name() == std::ffi::OsStr::new(&intent.payload_ref)
                        && prepared.identity() == &intent.current_attempt()?.identity,
                    "CONTINUOUS_WORK_PUBLICATION_IDENTITY_MISMATCH"
                );
                lease.revalidate(&self.namespace)?;
                self.read(|data| {
                    let key =
                        input_operation_key(&intent.scope, &intent.source, &intent.request_id)?;
                    let current = data
                        .pending_publications
                        .get(&key)
                        .context("CONTINUOUS_WORK_PUBLICATION_INTENT_MISSING")?;
                    ensure!(
                        *current == intent,
                        "CONTINUOUS_WORK_PUBLICATION_INTENT_CHANGED"
                    );
                    current.validate_current_fence(data)
                })?;
                let published = prepared
                    .publish()
                    .context("CONTINUOUS_WORK_PAYLOAD_UNCONFIRMED")?;
                #[cfg(test)]
                CRASH_AFTER_PUBLICATION.with(|flag| {
                    if flag.replace(false) {
                        std::process::exit(93);
                    }
                });
                ensure!(
                    published.target_name() == std::ffi::OsStr::new(&intent.payload_ref)
                        && published.identity() == &intent.current_attempt()?.identity
                        && published.byte_len() == intent.payload_size,
                    "CONTINUOUS_WORK_PUBLICATION_IDENTITY_MISMATCH"
                );
                let mut witness = self
                    .namespace
                    .read_live_publication(&published, intent.payload_size)?;
                let result = self.finalize_input_publication(&intent, &lease, &mut witness);
                #[cfg(test)]
                if result.is_ok() {
                    CRASH_AFTER_RECEIPT.with(|flag| {
                        if flag.replace(false) {
                            std::process::exit(94);
                        }
                    });
                }
                #[cfg(test)]
                if original_capture.is_some()
                    && matches!(&result, Ok(PublicationFinalized::Initial(_, true)))
                    && FAIL_AFTER_NATIVE_COMMIT.with(|flag| flag.replace(false))
                {
                    anyhow::bail!("CONTINUOUS_WORK_NATIVE_RECEIPT_LOST");
                }
                if created
                    && matches!(&result, Ok(PublicationFinalized::Initial(_, true)))
                    && let Some(capture) = original_capture
                {
                    *capture = Some(NativePublishedInput {
                        published,
                        verified: witness,
                    });
                    return result;
                }
                drop(published);
                result
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope() -> WorkScope {
        WorkScope {
            account_id: "a".into(),
            target_id: "t".into(),
            workspace_id: "w".into(),
        }
    }
    fn source() -> WorkInputSource {
        WorkInputSource {
            kind: "foreground".into(),
            instance_id: "target-thread".into(),
            conversation_id: "thread".into(),
        }
    }
    fn work() -> WorkRecord {
        serde_json::from_value(json!({"schemaVersion":1,"identity":{"scope":scope(),"workId":"work"},
            "origin":{"kind":"foreground","initialAttempt":{"threadId":"thread","turnId":"turn","attemptId":"attempt"}},
            "linkedThreadIds":["thread"],"phase":"pending","revision":{"revision":1,"requirementsRevision":1,
                "controlEpoch":0,"ownerEpoch":0,"acceptedInputSequence":1,"requiredInputSequence":1,"appliedInputSequence":0}})).unwrap()
    }
    fn initial(store: &ContinuousWorkStore) -> Result<()> {
        assert!(matches!(
            store.admit_two_phase(
                &scope(),
                work(),
                &source(),
                "initial",
                json!({"text":"original"}),
                vec![]
            )?,
            InitialAdmission::Accepted(_)
        ));
        Ok(())
    }

    #[test]
    fn live_publication_commits_original_identity_and_replay_does_not_republish() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-two-phase-live")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        initial(&store)?;
        let result = store.accept_input(
            &scope(),
            "work",
            &source(),
            1,
            "input-2",
            "request-2",
            WorkInputKind::Requirement,
            json!({"text":"new requirement"}),
            Some(vec![]),
        )?;
        assert!(matches!(result, InputAdmission::Accepted(_)));
        assert!(matches!(
            store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "input-2",
                "retry-2",
                WorkInputKind::Requirement,
                json!({"text":"new requirement"}),
                Some(vec![])
            )?,
            InputAdmission::Existing(_)
        ));
        assert!(
            store
                .accept_input(
                    &scope(),
                    "work",
                    &source(),
                    2,
                    "input-3",
                    "retry-2",
                    WorkInputKind::Requirement,
                    json!({"text":"different"}),
                    Some(vec![])
                )
                .is_err()
        );
        assert_eq!(
            store
                .read_input(&scope(), "work", &source(), "input-2")?
                .unwrap()
                .1,
            json!({"text":"new requirement"})
        );
        store.read(|data| {
            let identity = WorkIdentity {
                scope: scope(),
                work_id: "work".into(),
            };
            let input = data
                .inputs
                .get(&input_key(&identity, &source(), "input-2")?)
                .unwrap();
            let receipt = input
                .publication
                .as_ref()
                .expect("original publication evidence");
            ensure!(
                receipt.attempts.len() == 1 && !receipt.attempts[0].verified_absent,
                "publication evidence missing"
            );
            ensure!(
                data.pending_publications.is_empty(),
                "publication did not commit"
            );
            Ok(())
        })?;
        Ok(())
    }

    #[test]
    fn exact_replays_skip_preparation_and_aliases_remain_reserved() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-replay-fast")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        let count = || PREPARE_COUNT.with(std::cell::Cell::get);
        let before = count();
        initial(&store)?;
        assert_eq!(count(), before + 1);
        let state = std::fs::read(temp.path().join("continuous-work.v1/state.json"))?;
        assert!(matches!(
            store.admit_two_phase(
                &scope(),
                work(),
                &source(),
                "initial",
                json!({"text":"original"}),
                vec![]
            )?,
            InitialAdmission::Existing(_)
        ));
        assert_eq!(count(), before + 1);
        assert_eq!(
            std::fs::read(temp.path().join("continuous-work.v1/state.json"))?,
            state
        );

        assert!(matches!(
            store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "input",
                "request",
                WorkInputKind::Requirement,
                json!({"text":"new"}),
                Some(vec![])
            )?,
            InputAdmission::Accepted(_)
        ));
        let after_accept = count();
        assert!(matches!(
            store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "input",
                "request",
                WorkInputKind::Requirement,
                json!({"text":"new"}),
                Some(vec![])
            )?,
            InputAdmission::Existing(_)
        ));
        assert_eq!(count(), after_accept);
        // A new request ID must first be reserved in the original transaction.
        assert!(matches!(
            store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "input",
                "alias",
                WorkInputKind::Requirement,
                json!({"text":"new"}),
                Some(vec![])
            )?,
            InputAdmission::Existing(_)
        ));
        let after_alias = count();
        assert_eq!(after_alias, after_accept + 1);
        assert!(matches!(
            store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "input",
                "alias",
                WorkInputKind::Requirement,
                json!({"text":"new"}),
                Some(vec![])
            )?,
            InputAdmission::Existing(_)
        ));
        assert_eq!(count(), after_alias);
        assert!(
            store
                .accept_input(
                    &scope(),
                    "work",
                    &source(),
                    2,
                    "different",
                    "alias",
                    WorkInputKind::Requirement,
                    json!({"text":"different"}),
                    Some(vec![])
                )
                .is_err()
        );
        assert_eq!(count(), after_alias);
        Ok(())
    }

    #[test]
    fn replay_checks_work_scope_and_original_request_category() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-replay-scope")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        initial(&store)?;
        let mut other_work = work();
        other_work.identity.work_id = "other".into();
        let state = std::fs::read(temp.path().join("continuous-work.v1/state.json"))?;
        let replay = store.admit_two_phase(
            &scope(),
            other_work.clone(),
            &source(),
            "initial",
            json!({"text":"original"}),
            vec![],
        )?;
        let InitialAdmission::Existing(replay) = replay else {
            bail!("same initial request created another work");
        };
        assert_eq!(replay.work.identity.work_id, "work");
        let mut other_attempt = other_work.clone();
        other_attempt.origin.initial_attempt.attempt_id = "other-attempt".into();
        assert!(
            store
                .admit_two_phase(
                    &scope(),
                    other_attempt,
                    &source(),
                    "initial",
                    json!({"text":"original"}),
                    vec![],
                )
                .is_err()
        );
        assert!(
            store
                .accept_input(
                    &scope(),
                    "work",
                    &source(),
                    1,
                    "initial",
                    "initial",
                    WorkInputKind::Requirement,
                    json!({"text":"original"}),
                    Some(vec![])
                )
                .is_err()
        );
        assert_eq!(
            std::fs::read(temp.path().join("continuous-work.v1/state.json"))?,
            state
        );

        // A receipt for the initial request cannot stand in for an append,
        // even if a caller presents the same stored digest.
        let actual_scope = scope();
        let original_source = source();
        let initial_work = work();
        let original_payload = json!({"text":"original"});
        let (original_bytes, original_sha) = payload_bytes(&original_payload)?;
        let original_digest = hash(&(
            &initial_work.origin,
            &original_source,
            &original_sha,
            &Vec::<WorkDeliveryRequirement>::new(),
        ))?;
        let append_action = PendingInputAction::Append {
            work: initial_work.identity.clone(),
            expected_revision: 1,
            expected_control_epoch: 0,
            input_kind: WorkInputKind::Requirement,
            accepted_deliveries: Some(vec![]),
            queued: false,
        };
        let wrong_category = ReplayIdentity {
            scope: &actual_scope,
            source: &original_source,
            input_id: "initial",
            request_id: "initial",
            request_sha256: &original_digest,
            payload_sha256: &original_sha,
            payload_size: original_bytes.len() as u64,
            action: &append_action,
        };
        store.read(|data| {
            let key = input_key(&initial_work.identity, &original_source, "initial")?;
            let input = data.inputs.get(&key).context("initial input missing")?;
            ensure!(!original_receipt_matches(data, input, &wrong_category)?);
            Ok(())
        })?;

        // Exercise the transactional path directly, independent of the fast path.
        let (bytes, payload_sha256) = payload_bytes(&json!({"text":"original"}))?;
        let request_sha256 = hash(&(
            &other_work.origin,
            &source(),
            &payload_sha256,
            &Vec::<WorkDeliveryRequirement>::new(),
        ))?;
        let payload_ref = format!(
            "payload-{}",
            input_key(&other_work.identity, &source(), "initial")?
        );
        let prepared = store.prepare_original_input(&payload_ref, &bytes)?;
        let draft = InputPublicationDraft {
            scope: scope(),
            source: source(),
            input_id: "initial".into(),
            request_id: "initial".into(),
            request_sha256,
            payload_sha256,
            payload_size: bytes.len() as u64,
            payload_ref,
            object_identity: prepared.identity().clone(),
            action: PendingInputAction::Initial {
                work: Box::new(other_work.clone()),
                accepted_deliveries: vec![],
            },
        };
        match store.reserve_input_publication(draft)? {
            PublicationReservation::Existing(original) => assert_eq!(original.work.work_id, "work"),
            _ => bail!("transactional replay did not recover the original work"),
        }
        assert_eq!(
            std::fs::read(temp.path().join("continuous-work.v1/state.json"))?,
            state
        );

        // The same source and request ID in a different verified scope is independent.
        let mut other_scope = scope();
        other_scope.target_id = "other-target".into();
        let mut scoped_work = work();
        scoped_work.identity.scope = other_scope.clone();
        assert!(matches!(
            store.admit_two_phase(
                &other_scope,
                scoped_work.clone(),
                &source(),
                "initial",
                json!({"text":"original"}),
                vec![]
            )?,
            InitialAdmission::Accepted(_)
        ));
        assert!(matches!(
            store.admit_two_phase(
                &other_scope,
                scoped_work,
                &source(),
                "initial",
                json!({"text":"original"}),
                vec![]
            )?,
            InitialAdmission::Existing(_)
        ));
        // A distinct, host-verified source is an independent request namespace.
        let mut other_source = source();
        other_source.instance_id = "other-instance".into();
        assert!(matches!(
            store.admit_two_phase(
                &scope(),
                other_work,
                &other_source,
                "initial",
                json!({"text":"original"}),
                vec![]
            )?,
            InitialAdmission::Accepted(_)
        ));
        assert!(matches!(
            store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "append",
                "append-request",
                WorkInputKind::Requirement,
                json!({"text":"addition"}),
                Some(vec![])
            )?,
            InputAdmission::Accepted(_)
        ));
        assert!(
            store
                .accept_input(
                    &scope(),
                    "other",
                    &source(),
                    1,
                    "append",
                    "append-request",
                    WorkInputKind::Requirement,
                    json!({"text":"addition"}),
                    Some(vec![])
                )
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn pending_initial_retry_requires_the_same_source_and_attempt() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-pending-work")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        let source = source();
        let (bytes, payload_sha256) = payload_bytes(&json!({"text":"original"}))?;
        let draft_for = |work: WorkRecord| -> Result<_> {
            let payload_ref = format!("payload-{}", input_key(&work.identity, &source, "initial")?);
            let prepared = store.prepare_original_input(&payload_ref, &bytes)?;
            let digest = hash(&(
                &work.origin,
                &source,
                &payload_sha256,
                &Vec::<WorkDeliveryRequirement>::new(),
            ))?;
            let draft = InputPublicationDraft {
                scope: scope(),
                source: source.clone(),
                input_id: "initial".into(),
                request_id: "initial".into(),
                request_sha256: digest,
                payload_sha256: payload_sha256.clone(),
                payload_size: bytes.len() as u64,
                payload_ref,
                object_identity: prepared.identity().clone(),
                action: PendingInputAction::Initial {
                    work: Box::new(work),
                    accepted_deliveries: vec![],
                },
            };
            Ok((draft, prepared))
        };
        let (first, first_prepared) = draft_for(work())?;
        let first_lease = match store.reserve_input_publication(first)? {
            PublicationReservation::Owner { lease, .. } => lease,
            _ => bail!("initial request did not retain its original owner"),
        };
        let before = std::fs::read(temp.path().join("continuous-work.v1/state.json"))?;
        let (retry, retry_prepared) = draft_for(work())?;
        assert!(matches!(
            store.reserve_input_publication(retry)?,
            PublicationReservation::InProgress
        ));
        let mut other_work = work();
        other_work.identity.work_id = "other".into();
        let (different, other_prepared) = draft_for(other_work.clone())?;
        assert!(matches!(
            store.reserve_input_publication(different)?,
            PublicationReservation::InProgress
        ));
        other_work.origin.initial_attempt.attempt_id = "other-attempt".into();
        let (different_attempt, attempt_prepared) = draft_for(other_work)?;
        match store.reserve_input_publication(different_attempt) {
            Err(error) => assert!(error.to_string().contains("REQUEST_CONFLICT")),
            Ok(_) => bail!("different attempt reused a pending initial request"),
        }
        assert_eq!(
            std::fs::read(temp.path().join("continuous-work.v1/state.json"))?,
            before
        );
        let status = store
            .read_input_publication_status(&scope(), &source, "initial")?
            .unwrap();
        assert_eq!(status.work.work_id, "work");
        let mut other_source = source.clone();
        other_source.instance_id = "another-instance".into();
        assert!(
            store
                .read_input_publication_status(&scope(), &other_source, "initial")?
                .is_none()
        );
        let mut independent = work();
        independent.identity.work_id = "independent".into();
        assert!(matches!(
            store.admit_two_phase(
                &scope(),
                independent,
                &other_source,
                "initial",
                json!({"text":"original"}),
                vec![]
            )?,
            InitialAdmission::Accepted(_)
        ));
        drop((
            first_lease,
            first_prepared,
            retry_prepared,
            other_prepared,
            attempt_prepared,
        ));
        Ok(())
    }

    #[test]
    fn initial_retry_after_process_exit_recovers_the_original_candidate_id() -> Result<()> {
        if let Some(profile) = std::env::var_os("KCODER_TEST_INITIAL_REPLAY_PROFILE") {
            let store = ContinuousWorkStore::open_existing(std::path::Path::new(&profile))?
                .context("test store missing")?;
            match std::env::var("KCODER_TEST_INITIAL_REPLAY_STAGE")?.as_str() {
                "intent" => CRASH_AFTER_INTENT.with(|flag| flag.set(true)),
                "published" => CRASH_AFTER_PUBLICATION.with(|flag| flag.set(true)),
                "receipt" => CRASH_AFTER_RECEIPT.with(|flag| flag.set(true)),
                _ => bail!("invalid owned test stage"),
            }
            store.admit_two_phase(
                &scope(),
                work(),
                &source(),
                "initial",
                json!({"text":"original"}),
                vec![],
            )?;
            bail!("owned child failed to exit at its selected boundary");
        }
        for (stage, exit_code) in [("intent", 92), ("published", 93), ("receipt", 94)] {
            let temp = kcoder_config::create_private_temp_dir("continuous-initial-replay-crash")?;
            let store = ContinuousWorkStore::open_or_create(temp.path())?;
            let child = std::process::Command::new(std::env::current_exe()?)
                .args(["--exact", "continuous_work::store::publication_intent::tests::initial_retry_after_process_exit_recovers_the_original_candidate_id", "--nocapture"])
                .env("KCODER_TEST_INITIAL_REPLAY_PROFILE", temp.path())
                .env("KCODER_TEST_INITIAL_REPLAY_STAGE", stage)
                .output()?;
            assert_eq!(
                child.status.code(),
                Some(exit_code),
                "stdout={} stderr={}",
                String::from_utf8_lossy(&child.stdout),
                String::from_utf8_lossy(&child.stderr)
            );
            let mut new_candidate = work();
            new_candidate.identity.work_id = "regenerated".into();
            let original_path = temp.path().join("continuous-work.v1").join(format!(
                "payload-{}",
                input_key(&work().identity, &source(), "initial")?
            ));
            let regenerated_path = temp.path().join("continuous-work.v1").join(format!(
                "payload-{}",
                input_key(&new_candidate.identity, &source(), "initial")?
            ));
            let retried = store.admit_two_phase(
                &scope(),
                new_candidate,
                &source(),
                "initial",
                json!({"text":"original"}),
                vec![],
            );
            match stage {
                "intent" => {
                    let InitialAdmission::Accepted(accepted) = retried? else {
                        bail!("unpublished original was not safely resumed");
                    };
                    assert_eq!(accepted.work.identity.work_id, "work");
                    assert!(original_path.exists());
                }
                "published" => {
                    let error = retried.err().context("unproven object was accepted")?;
                    assert!(error.to_string().contains("RECONCILIATION_REQUIRED"));
                    assert!(original_path.exists());
                    assert!(store.read_work(&scope(), "work")?.is_none());
                    assert_eq!(
                        store
                            .read_input_publication_status(&scope(), &source(), "initial")?
                            .unwrap()
                            .work
                            .work_id,
                        "work"
                    );
                }
                "receipt" => {
                    let InitialAdmission::Existing(accepted) = retried? else {
                        bail!("lost response did not return the original receipt");
                    };
                    assert_eq!(accepted.work.identity.work_id, "work");
                    assert!(original_path.exists());
                }
                _ => unreachable!(),
            }
            assert!(!regenerated_path.exists());
            assert!(store.read_work(&scope(), "regenerated")?.is_none());
        }
        Ok(())
    }

    #[test]
    fn replay_snapshot_race_falls_back_without_returning_old_receipt() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-replay-race")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        initial(&store)?;
        store.claim(
            &scope(),
            "work",
            1,
            0,
            "claim",
            "thread",
            ClaimTrigger::Input,
        )?;
        let payload = json!({"text":"original"});
        let (bytes, payload_sha256) = payload_bytes(&payload)?;
        let source = source();
        let work_record = work();
        let actual_scope = scope();
        let request_sha256 = hash(&(
            &work_record.origin,
            &source,
            &payload_sha256,
            &Vec::<WorkDeliveryRequirement>::new(),
        ))?;
        let action = PendingInputAction::Initial {
            work: Box::new(work_record),
            accepted_deliveries: vec![],
        };
        let replay = ReplayIdentity {
            scope: &actual_scope,
            source: &source,
            input_id: "initial",
            request_id: "initial",
            request_sha256: &request_sha256,
            payload_sha256: &payload_sha256,
            payload_size: bytes.len() as u64,
            action: &action,
        };
        let stale = store.try_replay_accepted_input_inner(&replay, &payload, || {
            store.mark_input_applied(
                &actual_scope,
                "work",
                &source,
                "initial",
                "claim",
                1,
                0,
                AppliedInputReference {
                    attempt: TurnAttemptIdentity {
                        thread_id: "thread".into(),
                        turn_id: "turn".into(),
                        attempt_id: "attempt".into(),
                    },
                    history_uuid: "history-initial".into(),
                },
            )?;
            Ok(())
        })?;
        assert!(stale.is_none());
        assert!(matches!(
            store.admit_two_phase(&actual_scope, work(), &source, "initial", payload, vec![])?,
            InitialAdmission::Existing(_)
        ));
        Ok(())
    }

    #[test]
    fn intent_crash_recovery_never_claims_an_unproven_existing_object() -> Result<()> {
        if let Some(profile) = std::env::var_os("KCODER_TEST_TWO_PHASE_PROFILE") {
            let store =
                ContinuousWorkStore::open_existing(std::path::Path::new(&profile))?.unwrap();
            if std::env::var("KCODER_TEST_TWO_PHASE_AFTER")? == "1" {
                CRASH_AFTER_PUBLICATION.with(|flag| flag.set(true));
            } else {
                CRASH_AFTER_INTENT.with(|flag| flag.set(true));
            }
            store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "input-2",
                "request-2",
                WorkInputKind::Requirement,
                json!({"text":"exact original"}),
                Some(vec![]),
            )?;
            panic!("the owned child must exit at the selected publication boundary");
        }
        for (after, inject_unowned) in [(false, false), (true, false), (false, true)] {
            let temp = kcoder_config::create_private_temp_dir("continuous-two-phase-crash")?;
            let store = ContinuousWorkStore::open_or_create(temp.path())?;
            initial(&store)?;
            let directory = temp.path().join("continuous-work.v1");
            std::fs::write(directory.join("unowned-user-data"), b"preserve")?;
            let output = std::process::Command::new(std::env::current_exe()?)
                .args(["--exact","continuous_work::store::publication_intent::tests::intent_crash_recovery_never_claims_an_unproven_existing_object","--nocapture"])
                .env("KCODER_TEST_TWO_PHASE_PROFILE",temp.path())
                .env("KCODER_TEST_TWO_PHASE_AFTER",if after {"1"} else {"0"}).output()?;
            assert_eq!(
                output.status.code(),
                Some(if after { 93 } else { 92 }),
                "stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                store
                    .read_input_publication_status(&scope(), &source(), "request-2")?
                    .is_some()
            );
            assert!(
                store
                    .read_input(&scope(), "work", &source(), "input-2")?
                    .is_none()
            );
            let before_listing = std::fs::read(directory.join("state.json"))?;
            for page in [
                store
                    .list_pending_inputs(&scope(), "work", None)?
                    .inputs
                    .into_iter()
                    .map(|input| input.receipt.input_id)
                    .collect::<Vec<_>>(),
                store
                    .list_inputs(&scope(), "work", None)?
                    .inputs
                    .into_iter()
                    .map(|input| input.receipt.input_id)
                    .collect::<Vec<_>>(),
            ] {
                assert_eq!(
                    page,
                    ["initial"],
                    "an unfinished publication is not accepted"
                );
            }
            assert_eq!(std::fs::read(directory.join("state.json"))?, before_listing);
            let input_identity = WorkIdentity {
                scope: scope(),
                work_id: "work".into(),
            };
            let payload_path = directory.join(format!(
                "payload-{}",
                input_key(&input_identity, &source(), "input-2")?
            ));
            if after {
                assert!(payload_path.exists());
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    assert_eq!(std::fs::metadata(&payload_path)?.nlink(), 1);
                }
            } else {
                assert!(!payload_path.exists());
            }
            assert_eq!(
                std::fs::read(directory.join("unowned-user-data"))?,
                b"preserve"
            );
            if inject_unowned {
                std::fs::write(
                    &payload_path,
                    serde_json::to_vec(&json!({"text":"exact original"}))?,
                )?;
            }
            let retry = store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "input-2",
                "request-2",
                WorkInputKind::Requirement,
                json!({"text":"exact original"}),
                Some(vec![]),
            );
            if after || inject_unowned {
                assert!(
                    retry
                        .unwrap_err()
                        .to_string()
                        .contains("RECONCILIATION_REQUIRED")
                );
                assert!(
                    store
                        .read_input_publication_status(&scope(), &source(), "request-2")?
                        .is_some()
                );
                assert!(
                    store
                        .read_input(&scope(), "work", &source(), "input-2")?
                        .is_none()
                );
            } else {
                assert!(matches!(retry?, InputAdmission::Accepted(_)));
                store.read(|data| {
                    let id = WorkIdentity {
                        scope: scope(),
                        work_id: "work".into(),
                    };
                    let input = data
                        .inputs
                        .get(&input_key(&id, &source(), "input-2")?)
                        .unwrap();
                    let publication = input.publication.as_ref().unwrap();
                    ensure!(
                        publication.attempts.len() == 2 && publication.attempts[0].verified_absent,
                        "missing original attempt evidence"
                    );
                    Ok(())
                })?;
            }
        }
        Ok(())
    }

    #[test]
    fn receipt_committed_before_process_exit_is_read_back_without_republishing() -> Result<()> {
        if let Some(profile) = std::env::var_os("KCODER_TEST_TWO_PHASE_RECEIPT_PROFILE") {
            let store =
                ContinuousWorkStore::open_existing(std::path::Path::new(&profile))?.unwrap();
            CRASH_AFTER_RECEIPT.with(|flag| flag.set(true));
            store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "input-2",
                "request-2",
                WorkInputKind::Requirement,
                json!({"text":"committed once"}),
                Some(vec![]),
            )?;
            panic!("the owned child must exit after receipt commit and before its reply");
        }
        let temp = kcoder_config::create_private_temp_dir("continuous-two-phase-receipt")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        initial(&store)?;
        let output = std::process::Command::new(std::env::current_exe()?)
            .args(["--exact", "continuous_work::store::publication_intent::tests::receipt_committed_before_process_exit_is_read_back_without_republishing", "--nocapture"])
            .env("KCODER_TEST_TWO_PHASE_RECEIPT_PROFILE", temp.path()).output()?;
        assert_eq!(
            output.status.code(),
            Some(94),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let accepted = store
            .read_input(&scope(), "work", &source(), "input-2")?
            .unwrap();
        assert_eq!(accepted.0.sequence, 2);
        assert_eq!(accepted.1, json!({"text":"committed once"}));
        assert!(matches!(
            store.accept_input(
                &scope(),
                "work",
                &source(),
                1,
                "input-2",
                "request-2",
                WorkInputKind::Requirement,
                json!({"text":"committed once"}),
                Some(vec![])
            )?,
            InputAdmission::Existing(_)
        ));
        assert_eq!(
            store
                .read_work(&scope(), "work")?
                .unwrap()
                .revision
                .accepted_input_sequence,
            2
        );
        Ok(())
    }

    #[test]
    fn pending_body_does_not_block_stop_and_old_input_is_not_accepted_after_stop() -> Result<()> {
        use std::sync::{Arc, mpsc};
        struct ResumeOnDrop(Option<mpsc::Sender<()>>);
        impl Drop for ResumeOnDrop {
            fn drop(&mut self) {
                if let Some(sender) = self.0.take() {
                    let _ = sender.send(());
                }
            }
        }
        let temp = kcoder_config::create_private_temp_dir("continuous-two-phase-stop")?;
        let store = Arc::new(ContinuousWorkStore::open_or_create(temp.path())?);
        initial(&store)?;
        let (ready_tx, ready_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let worker_store = store.clone();
        std::thread::scope(|threads| -> Result<()> {
            let worker = threads.spawn(move || {
                PAUSE_AFTER_INTENT.with(|hook| *hook.borrow_mut() = Some((ready_tx, resume_rx)));
                worker_store.accept_input(
                    &scope(),
                    "work",
                    &source(),
                    1,
                    "input-2",
                    "request-2",
                    WorkInputKind::Requirement,
                    json!({"text":"new requirement"}),
                    Some(vec![]),
                )
            });
            let resume = ResumeOnDrop(Some(resume_tx));
            let control_result = (|| -> Result<()> {
                ready_rx.recv_timeout(std::time::Duration::from_secs(10))?;
                let second = store.accept_input(
                    &scope(),
                    "work",
                    &source(),
                    1,
                    "input-2",
                    "request-2",
                    WorkInputKind::Requirement,
                    json!({"text":"new requirement"}),
                    Some(vec![]),
                );
                ensure!(
                    second
                        .unwrap_err()
                        .to_string()
                        .contains("INPUT_IN_PROGRESS"),
                    "duplicate did not stay in progress"
                );
                let later = store.accept_input(
                    &scope(),
                    "work",
                    &source(),
                    1,
                    "input-3",
                    "request-3",
                    WorkInputKind::Requirement,
                    json!({"text":"later requirement"}),
                    Some(vec![]),
                );
                ensure!(
                    later.unwrap_err().to_string().contains("INPUT_IN_PROGRESS"),
                    "later input overtook pending input"
                );
                store.control(
                    &scope(),
                    "work",
                    1,
                    "stop",
                    WorkControlAction::Stop,
                    WorkControlTarget::Work {},
                )?;
                Ok(())
            })();
            drop(resume);
            let publication = worker.join().expect("publication worker");
            control_result?;
            ensure!(publication.is_err(), "stopped input was accepted");
            Ok(())
        })?;
        assert!(
            store
                .read_input_publication_status(&scope(), &source(), "request-2")?
                .is_some()
        );
        assert!(
            store
                .read_input(&scope(), "work", &source(), "input-2")?
                .is_none()
        );
        assert_eq!(
            store.current_control(&scope(), "work")?.unwrap().action,
            WorkControlAction::Stop
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn replay_does_not_accept_a_same_content_replacement_after_reading() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let temp = kcoder_config::create_private_temp_dir("continuous-replay-replacement")?;
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        initial(&store)?;
        let actual_scope = scope();
        let source = source();
        let (original_receipt, payload) = store
            .read_input(&actual_scope, "work", &source, "initial")?
            .context("original input missing")?;
        let (bytes, payload_sha256) = payload_bytes(&payload)?;
        let action = PendingInputAction::Initial {
            work: Box::new(work()),
            accepted_deliveries: vec![],
        };
        let replay = ReplayIdentity {
            scope: &actual_scope,
            source: &source,
            input_id: "initial",
            request_id: "initial",
            request_sha256: &original_receipt.request_digest,
            payload_sha256: &payload_sha256,
            payload_size: bytes.len() as u64,
            action: &action,
        };
        let directory = temp.path().join("continuous-work.v1");
        let path = directory.join(&original_receipt.payload_ref);
        let before = std::fs::read(directory.join("state.json"))?;
        let result = store.try_replay_accepted_input_inner(&replay, &payload, || {
            std::fs::rename(&path, directory.join("original-held"))?;
            std::fs::write(&path, &bytes)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(directory.join("original-held"))?, bytes);
        assert_eq!(std::fs::read(directory.join("state.json"))?, before);
        Ok(())
    }
}
