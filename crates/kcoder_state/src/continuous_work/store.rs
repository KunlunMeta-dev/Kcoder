use super::namespace::{DATA_LIMIT, Namespace};
use anyhow::{Context, Result, bail, ensure};
use kcoder_types::{
    TurnAttemptIdentity,
    continuous_work::{
        WorkControlAction, WorkControlReceipt, WorkControlState, WorkControlTarget,
        WorkControlTargetFact, WorkDeliveryRequirement, WorkIdentity, WorkInputKind,
        WorkInputReceipt, WorkInputState, WorkPhase, WorkRecord, WorkScope,
    },
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

mod deliveries;
#[cfg(all(test, any(target_os = "linux", windows)))]
mod input_read_tests;
mod isolated_observation;
mod isolation;
pub use isolation::WorkIsolationReport;
mod inputs;
pub use inputs::InputAuthority;
mod native_initial;
mod publication_intent;
mod results;
pub use isolated_observation::{
    StoredBindingLookup, StoredBindingObservation, observe_stored_work_binding,
    observe_stored_work_bindings,
};
pub use native_initial::{
    NativeForegroundWorkApplication, NativeInitialWorkAdmission, NativeInitialWorkCapacity,
    NativeInitialWorkOwner, NativeInitialWorkReceipt, NativeInitialWorkRequest,
    native_work_input_payload,
};
pub use publication_intent::InputPublicationStatus;
#[cfg(test)]
pub(super) use publication_intent::{
    crash_after_next_payload_for_test, crash_after_next_receipt_for_test,
};

const MAX_WORKS: usize = 4096;
const MAX_INPUTS: usize = 32768;
const MAX_OPERATIONS: usize = 65536;
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const WORK_PAGE_SIZE: usize = 10;

/// One bounded observation of target-owned work. A cursor is not authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkRecordPage {
    pub items: Vec<WorkRecord>,
    pub next_after_work_id: Option<String>,
}

/// An initial accepted input and its exact target-private payload.
#[derive(Debug, Clone, PartialEq)]
pub struct AcceptedInput {
    pub work: WorkRecord,
    pub receipt: WorkInputReceipt,
    pub payload: Value,
}

/// A repeated request reports the current work and its original input receipt.
#[derive(Debug, Clone, PartialEq)]
pub enum InitialAdmission {
    Accepted(AcceptedInput),
    Existing(AcceptedInput),
}

#[derive(Debug, Clone, PartialEq)]
pub enum InputAdmission {
    Accepted(WorkInputReceipt),
    Existing(WorkInputReceipt),
}

/// Host-resolved event namespace. These strings identify the original source;
/// they do not authorize accepting input or changing its source binding. They
/// must remain stable across reconnects and client changes: use the original
/// target/session or verified platform instance/conversation, not a transient
/// Gateway client connection identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkInputSource {
    pub kind: String,
    pub instance_id: String,
    pub conversation_id: String,
}
impl WorkInputSource {
    fn validate(&self) -> Result<()> {
        ensure!(
            [&self.kind, &self.instance_id, &self.conversation_id]
                .into_iter()
                .all(|id| atom(id)),
            "CONTINUOUS_WORK_INPUT_SOURCE_INVALID"
        );
        Ok(())
    }
}

/// The origin of a durable claim. Only an automatic claim counts toward the
/// business batch's automatic turns, and a user input never consumes that budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimTrigger {
    Input,
    Automatic,
}

impl ClaimTrigger {
    pub fn is_automatic(self) -> bool {
        matches!(self, Self::Automatic)
    }
}

/// The observed terminal outcome of a claimed turn. A claim released without an
/// observed outcome stays `Abandoned`; it never implies a completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimSettlement {
    Completed,
    Failed,
    Stalled,
    Abandoned,
}

/// ExistingActive requires reconciling the original dispatch; it must never
/// be treated as authorization to launch another turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimOutcome {
    Acquired(ClaimReceipt),
    ExistingActive(ClaimReceipt),
}

/// A durable coordinator claim, not proof of a live process or turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimReceipt {
    pub claim_id: String,
    pub thread_id: String,
    pub owner_epoch: u64,
    pub control_epoch: u64,
    pub released: bool,
}

/// The host must resolve this original history entry before recording it here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedInputReference {
    pub attempt: TurnAttemptIdentity,
    pub history_uuid: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreData {
    version: u32,
    works: BTreeMap<String, StoredWork>,
    inputs: BTreeMap<String, StoredInput>,
    input_ids: BTreeMap<String, String>,
    operations: BTreeMap<String, StoredOperation>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pending_publications: BTreeMap<String, publication_intent::PendingInputPublication>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pending_input_ids: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredWork {
    // Preserve unknown fields in another record when updating this namespace.
    record: Value,
    bindings: BTreeMap<String, TurnAttemptIdentity>,
    claims: BTreeMap<String, ClaimReceipt>,
    active_claim: Option<String>,
    pending_control: Option<WorkControlReceipt>,
    accepted_deliveries: Vec<WorkDeliveryRequirement>,
    /// Observed delivery states keyed by delivery id; older records have none.
    #[serde(default)]
    deliveries: BTreeMap<String, kcoder_types::continuous_work::WorkDelivery>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredInput {
    receipt: Value,
    source: WorkInputSource,
    payload_sha256: String,
    payload_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    publication: Option<publication_intent::PendingInputPublication>,
    // Only a requirement input changes the host-verified delivery snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accepted_deliveries: Option<Vec<WorkDeliveryRequirement>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    applied: Option<AppliedInputReference>,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
// Boxing would not change the stored JSON; the frozen store keeps its shape.
#[allow(clippy::large_enum_variant)]
enum StoredOperation {
    Input {
        digest: String,
        input_key: String,
    },
    Binding {
        digest: String,
        work_key: String,
        thread_id: String,
    },
    Control {
        digest: String,
        receipt: WorkControlReceipt,
    },
}

impl Default for StoreData {
    fn default() -> Self {
        Self {
            version: 1,
            works: BTreeMap::new(),
            inputs: BTreeMap::new(),
            input_ids: BTreeMap::new(),
            operations: BTreeMap::new(),
            pending_publications: BTreeMap::new(),
            pending_input_ids: BTreeMap::new(),
        }
    }
}

fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn work_key(identity: &WorkIdentity) -> Result<String> {
    hash(identity)
}
fn input_key(identity: &WorkIdentity, source: &WorkInputSource, input_id: &str) -> Result<String> {
    hash(&(identity, source, input_id))
}
fn input_identity_key(
    scope: &WorkScope,
    source: &WorkInputSource,
    input_id: &str,
) -> Result<String> {
    hash(&(scope, source, input_id))
}
fn input_operation_key(
    scope: &WorkScope,
    source: &WorkInputSource,
    request_id: &str,
) -> Result<String> {
    hash(&(scope, source, request_id))
}
fn operation_key(scope: &WorkScope, request_id: &str) -> Result<String> {
    hash(&(scope, request_id))
}
fn atom(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
fn next(value: u64) -> Result<u64> {
    value
        .checked_add(1)
        .context("CONTINUOUS_WORK_REVISION_EXHAUSTED")
}
fn validate_deliveries(deliveries: &[WorkDeliveryRequirement]) -> Result<()> {
    ensure!(deliveries.len() <= 256, "CONTINUOUS_WORK_DELIVERY_LIMIT");
    let mut ids = BTreeSet::new();
    for delivery in deliveries {
        ensure!(
            atom(&delivery.delivery_id) && ids.insert(&delivery.delivery_id),
            "CONTINUOUS_WORK_DELIVERY_INVALID"
        );
    }
    Ok(())
}
fn payload_bytes(payload: &Value) -> Result<(Vec<u8>, String)> {
    let bytes = serde_json::to_vec(payload)?;
    ensure!(
        bytes.len() <= MAX_INPUT_BYTES,
        "CONTINUOUS_WORK_INPUT_LIMIT"
    );
    let digest = format!("{:x}", Sha256::digest(&bytes));
    Ok((bytes, digest))
}
fn parse<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).context("CONTINUOUS_WORK_DATA_INVALID")
}
fn mutable_parse<T: DeserializeOwned + Serialize>(value: &Value) -> Result<T> {
    let result: T = parse(value)?;
    ensure!(
        serde_json::to_value(&result)? == *value,
        "CONTINUOUS_WORK_UNRECOGNIZED_FIELDS"
    );
    Ok(result)
}
fn record(stored: &StoredWork) -> Result<WorkRecord> {
    let record: WorkRecord = parse(&stored.record)?;
    record.validate_shape().map_err(anyhow::Error::msg)?;
    Ok(record)
}
fn mutable_record_for_release(stored: &StoredWork, scope: &WorkScope) -> Result<WorkRecord> {
    let record: WorkRecord = mutable_parse(&stored.record)?;
    record
        .validate_for_mutation(scope)
        .map_err(anyhow::Error::msg)?;
    Ok(record)
}
fn mutable_record(stored: &StoredWork, scope: &WorkScope) -> Result<WorkRecord> {
    let record = mutable_record_for_release(stored, scope)?;
    ensure!(
        stored
            .accepted_deliveries
            .iter()
            .all(|delivery| delivery.minimum_confirmation.is_known()),
        "CONTINUOUS_WORK_DELIVERY_UNKNOWN"
    );
    if let Some(control) = &stored.pending_control {
        ensure!(
            control.action.is_known()
                && control.state.is_known()
                && control.target.known().is_some()
                && control.target.matches_action(&control.action),
            "CONTINUOUS_WORK_CONTROL_UNKNOWN"
        );
    }
    Ok(record)
}
fn receipt(stored: &StoredInput) -> Result<WorkInputReceipt> {
    let receipt: WorkInputReceipt = parse(&stored.receipt)?;
    receipt.validate_shape().map_err(anyhow::Error::msg)?;
    ensure!(
        stored.payload_size <= MAX_INPUT_BYTES as u64
            && stored.payload_sha256.len() == 64
            && stored
                .payload_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "CONTINUOUS_WORK_PAYLOAD_INVALID"
    );
    publication_intent::validate_publication_receipt(stored, &receipt)?;
    Ok(receipt)
}
fn require_known_inputs(data: &StoreData, identity: &WorkIdentity) -> Result<()> {
    for input in data.inputs.values() {
        let receipt = receipt(input)?;
        if receipt.work == *identity {
            receipt
                .validate_for_mutation(&identity.scope)
                .map_err(anyhow::Error::msg)?;
        }
    }
    Ok(())
}
fn parse_data(bytes: &[u8]) -> Result<StoreData> {
    ensure!(
        bytes.len() as u64 <= DATA_LIMIT,
        "CONTINUOUS_WORK_DATA_LIMIT"
    );
    let data: StoreData = serde_json::from_slice(bytes).context("CONTINUOUS_WORK_DATA_INVALID")?;
    ensure!(
        data.version == 1
            && data.works.len() <= MAX_WORKS
            && data.inputs.len() <= MAX_INPUTS
            && data.input_ids.len() == data.inputs.len()
            && data.operations.len() <= MAX_OPERATIONS,
        "CONTINUOUS_WORK_DATA_INVALID"
    );
    let mut parsed_works = BTreeMap::new();
    for (key, stored) in &data.works {
        let value = record(stored)?;
        validate_deliveries(&stored.accepted_deliveries)?;
        ensure!(
            *key == work_key(&value.identity)?,
            "CONTINUOUS_WORK_IDENTITY_MISMATCH"
        );
        ensure!(
            stored.bindings.len() == value.linked_thread_ids.len(),
            "CONTINUOUS_WORK_BINDING_INVALID"
        );
        for thread in &value.linked_thread_ids {
            let binding = stored
                .bindings
                .get(thread)
                .context("CONTINUOUS_WORK_BINDING_MISSING")?;
            binding.validate().map_err(anyhow::Error::msg)?;
            ensure!(
                binding.thread_id == *thread,
                "CONTINUOUS_WORK_BINDING_INVALID"
            );
        }
        if let Some(active) = &stored.active_claim {
            let claim = stored
                .claims
                .get(active)
                .context("CONTINUOUS_WORK_CLAIM_MISSING")?;
            ensure!(
                !claim.released
                    && claim.owner_epoch == value.revision.owner_epoch
                    && stored.bindings.contains_key(&claim.thread_id),
                "CONTINUOUS_WORK_CLAIM_INVALID"
            );
        }
        if let Some(control) = &stored.pending_control {
            ensure!(
                control.work == value.identity
                    && control.control_epoch == value.revision.control_epoch
                    && control.control_epoch > 0
                    && control.expected_revision > 0
                    && atom(&control.request_id)
                    && control.target.validate_shape().is_ok()
                    && (!control.action.is_known()
                        || control.target.known().is_none()
                        || control.target.matches_action(&control.action)),
                "CONTINUOUS_WORK_CONTROL_INVALID"
            );
            let key = operation_key(&value.identity.scope, &control.request_id)?;
            match data.operations.get(&key) {
                Some(StoredOperation::Control { receipt, .. }) if receipt == control => {}
                _ => bail!("CONTINUOUS_WORK_CONTROL_RECEIPT_MISMATCH"),
            }
        }
        parsed_works.insert(key.clone(), value);
    }
    // Per work: sequence -> (kind, replaced sequence, delivery requirements).
    type InputsBySequence<'a> = BTreeMap<
        u64,
        (
            WorkInputKind,
            Option<u64>,
            Option<&'a Vec<WorkDeliveryRequirement>>,
        ),
    >;
    let mut per_work: BTreeMap<String, InputsBySequence<'_>> = BTreeMap::new();
    for (key, stored) in &data.inputs {
        let value = receipt(stored)?;
        stored.source.validate()?;
        if let Some(deliveries) = &stored.accepted_deliveries {
            validate_deliveries(deliveries)?;
        }
        if value.kind.is_known() {
            ensure!(
                (value.kind == WorkInputKind::Requirement) == stored.accepted_deliveries.is_some(),
                "CONTINUOUS_WORK_DELIVERY_INVALID"
            );
        }
        ensure!(
            *key == input_key(&value.work, &stored.source, &value.input_id)?,
            "CONTINUOUS_WORK_INPUT_MISMATCH"
        );
        ensure!(
            value.payload_ref == format!("payload-{key}")
                && data.input_ids.get(&input_identity_key(
                    &value.work.scope,
                    &stored.source,
                    &value.input_id
                )?) == Some(key),
            "CONTINUOUS_WORK_INPUT_MISMATCH"
        );
        let key_for_work = work_key(&value.work)?;
        let work = parsed_works
            .get(&key_for_work)
            .context("CONTINUOUS_WORK_INPUT_ORPHAN")?;
        ensure!(
            value.sequence <= work.revision.accepted_input_sequence,
            "CONTINUOUS_WORK_INPUT_WATERMARK_INVALID"
        );
        if value.state.is_known() {
            ensure!(
                (value.state == WorkInputState::Applied) == stored.applied.is_some(),
                "CONTINUOUS_WORK_INPUT_APPLIED_INVALID"
            );
            ensure!(
                (value.sequence <= work.revision.applied_input_sequence)
                    == (value.state == WorkInputState::Applied),
                "CONTINUOUS_WORK_INPUT_WATERMARK_INVALID"
            );
        }
        if let Some(applied) = &stored.applied {
            applied.attempt.validate().map_err(anyhow::Error::msg)?;
            ensure!(
                atom(&applied.history_uuid),
                "CONTINUOUS_WORK_INPUT_APPLIED_INVALID"
            );
        }
        ensure!(
            per_work
                .entry(key_for_work)
                .or_default()
                .insert(
                    value.sequence,
                    (
                        value.kind,
                        value.requirements_revision,
                        stored.accepted_deliveries.as_ref()
                    )
                )
                .is_none(),
            "CONTINUOUS_WORK_INPUT_SEQUENCE_DUPLICATE"
        );
    }
    for (key, stored) in &data.works {
        let work = parsed_works
            .get(key)
            .context("CONTINUOUS_WORK_RECORD_MISSING")?;
        let inputs = per_work.get(key).context("CONTINUOUS_WORK_INPUT_MISSING")?;
        ensure!(
            u64::try_from(inputs.len())? == work.revision.accepted_input_sequence,
            "CONTINUOUS_WORK_INPUT_WATERMARK_INVALID"
        );
        let mut sequence = 0_u64;
        let mut requirements_revision = 0_u64;
        let mut latest_deliveries = None;
        let mut unknown = false;
        for (current, (kind, revision, deliveries)) in inputs {
            sequence = next(sequence)?;
            ensure!(*current == sequence, "CONTINUOUS_WORK_INPUT_SEQUENCE_GAP");
            match kind {
                WorkInputKind::Requirement => {
                    requirements_revision = next(requirements_revision)?;
                    ensure!(
                        *revision == Some(requirements_revision),
                        "CONTINUOUS_WORK_REQUIREMENTS_REVISION_INVALID"
                    );
                    latest_deliveries = *deliveries;
                }
                WorkInputKind::Answer | WorkInputKind::StatusQuery => {
                    ensure!(
                        revision.is_none(),
                        "CONTINUOUS_WORK_REQUIREMENTS_REVISION_INVALID"
                    );
                }
                WorkInputKind::Unknown(_) => unknown = true,
            }
        }
        if !unknown {
            ensure!(
                requirements_revision == work.revision.requirements_revision
                    && latest_deliveries == Some(&stored.accepted_deliveries),
                "CONTINUOUS_WORK_DELIVERY_SNAPSHOT_MISMATCH"
            );
        }
    }
    for (request_key, operation) in &data.operations {
        ensure!(request_key.len() == 64, "CONTINUOUS_WORK_OPERATION_INVALID");
        match operation {
            StoredOperation::Input { digest, input_key } => {
                let input = data
                    .inputs
                    .get(input_key)
                    .context("CONTINUOUS_WORK_RECEIPT_MISSING")?;
                ensure!(
                    receipt(input)?.request_digest == *digest,
                    "CONTINUOUS_WORK_OPERATION_INVALID"
                );
            }
            StoredOperation::Binding {
                work_key,
                thread_id,
                ..
            } => {
                let work = data
                    .works
                    .get(work_key)
                    .context("CONTINUOUS_WORK_RECORD_MISSING")?;
                ensure!(
                    work.bindings.contains_key(thread_id),
                    "CONTINUOUS_WORK_BINDING_MISSING"
                );
            }
            StoredOperation::Control {
                receipt: control, ..
            } => {
                let work = parsed_works
                    .get(&work_key(&control.work)?)
                    .context("CONTINUOUS_WORK_RECORD_MISSING")?;
                ensure!(
                    control.control_epoch <= work.revision.control_epoch
                        && control.control_epoch > 0
                        && control.expected_revision > 0
                        && atom(&control.request_id)
                        && control.target.validate_shape().is_ok()
                        && (!control.action.is_known()
                            || control.target.known().is_none()
                            || control.target.matches_action(&control.action)),
                    "CONTINUOUS_WORK_CONTROL_INVALID"
                );
            }
        }
    }
    publication_intent::validate_publications(&data)?;
    Ok(data)
}

/// Target profile storage. Its host must independently verify the actual
/// account, target, workspace, accepted attempt and any native source grant.
/// Scope strings and saved references are observations, never authorization.
pub struct ContinuousWorkStore {
    namespace: Namespace,
}
impl ContinuousWorkStore {
    fn observe_payload(
        &self,
        input: &StoredInput,
    ) -> Result<(Value, crate::prepared_immutable::UnverifiedCommittedRead)> {
        let receipt = receipt(input)?;
        let expected = input
            .publication
            .as_ref()
            .map(|intent| intent.current_attempt().map(|attempt| &attempt.identity))
            .transpose()?;
        let witness = self.namespace.observe_committed_payload(
            &receipt.payload_ref,
            input.payload_size,
            expected,
        )?;
        ensure!(
            witness.bytes().len() as u64 == input.payload_size
                && format!("{:x}", Sha256::digest(witness.bytes())) == input.payload_sha256,
            "CONTINUOUS_WORK_PAYLOAD_CHANGED"
        );
        let payload =
            serde_json::from_slice(witness.bytes()).context("CONTINUOUS_WORK_PAYLOAD_INVALID")?;
        Ok((payload, witness))
    }
    /// Read-only opening does not create the profile or namespace.
    pub fn open_existing(profile: &Path) -> Result<Option<Self>> {
        let Some(namespace) = Namespace::open_existing(profile)? else {
            return Ok(None);
        };
        namespace.read(|bytes| parse_data(bytes).map(|_| ()))?;
        Ok(Some(Self { namespace }))
    }
    /// Called only after an actual request is accepted by the trusted host.
    pub fn open_or_create(profile: &Path) -> Result<Self> {
        let namespace =
            Namespace::open_or_create(profile, &serde_json::to_vec(&StoreData::default())?)?;
        namespace.read(|bytes| parse_data(bytes).map(|_| ()))?;
        Ok(Self { namespace })
    }
    fn read<T>(&self, action: impl FnOnce(&StoreData) -> Result<T>) -> Result<T> {
        self.namespace.read(|bytes| action(&parse_data(bytes)?))
    }
    fn update<T>(&self, action: impl FnOnce(&mut StoreData) -> Result<(T, bool)>) -> Result<T> {
        self.namespace.update(|bytes| {
            let mut data = parse_data(bytes)?;
            let (result, changed) = action(&mut data)?;
            if !changed {
                return Ok((None, result));
            }
            let encoded = serde_json::to_vec(&data)?;
            // Recheck the complete post-transaction state before publishing it.
            parse_data(&encoded)?;
            Ok((Some(encoded), result))
        })
    }

    pub fn read_work(&self, actual_scope: &WorkScope, work_id: &str) -> Result<Option<WorkRecord>> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        self.read(|data| {
            data.works
                .get(&work_key(&identity)?)
                .map(record)
                .transpose()
        })
    }

    /// Observe one page in the host-resolved scope without creating or
    /// repairing storage. Records remain observations, not access authority.
    pub fn list_for_scope(
        &self,
        actual_scope: &WorkScope,
        after_work_id: Option<&str>,
        updated_after_ms: Option<u64>,
        phase: Option<&WorkPhase>,
        query: Option<&str>,
    ) -> Result<WorkRecordPage> {
        actual_scope.validate_shape().map_err(anyhow::Error::msg)?;
        if let Some(work_id) = after_work_id {
            WorkIdentity {
                scope: actual_scope.clone(),
                work_id: work_id.into(),
            }
            .validate_shape()
            .map_err(anyhow::Error::msg)?;
        }
        ensure!(
            phase.is_none_or(WorkPhase::is_known),
            "CONTINUOUS_WORK_PHASE_INVALID"
        );
        ensure!(
            query.is_none_or(|value| value.len() <= 1024 && !value.chars().any(char::is_control)),
            "CONTINUOUS_WORK_QUERY_INVALID"
        );
        let query = query
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase);
        self.read(|data| {
            let mut works = BTreeMap::new();
            for stored in data.works.values() {
                let work = record(stored)?;
                if !work.identity.matches_scope(actual_scope)
                    || after_work_id.is_some_and(|after| work.identity.work_id.as_str() <= after)
                    || phase.is_some_and(|expected| &work.phase != expected)
                    || updated_after_ms.is_some_and(|after| {
                        work.presentation
                            .as_ref()
                            .and_then(|value| value.updated_at_ms)
                            .is_none_or(|updated| updated <= after)
                    })
                    || query.as_ref().is_some_and(|needle| {
                        !work.presentation.as_ref().is_some_and(|value| {
                            [value.title.as_deref(), value.objective_summary.as_deref()]
                                .into_iter()
                                .flatten()
                                .any(|text| text.to_lowercase().contains(needle))
                        })
                    })
                {
                    continue;
                }
                works.insert(work.identity.work_id.clone(), work);
                if works.len() > WORK_PAGE_SIZE + 1 {
                    works.pop_last();
                }
            }
            let has_more = works.len() > WORK_PAGE_SIZE;
            let items: Vec<_> = works.into_values().take(WORK_PAGE_SIZE).collect();
            let next_after_work_id = has_more.then(|| {
                items
                    .last()
                    .expect("nonempty page")
                    .identity
                    .work_id
                    .clone()
            });
            Ok(WorkRecordPage {
                items,
                next_after_work_id,
            })
        })
    }

    /// The current host-accepted delivery requirements are independent of a
    /// model result or an optional completion notification.
    pub fn accepted_deliveries(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
    ) -> Result<Option<Vec<WorkDeliveryRequirement>>> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        self.read(|data| {
            Ok(data
                .works
                .get(&work_key(&identity)?)
                .map(|stored| stored.accepted_deliveries.clone()))
        })
    }

    /// Only explicit accepted attempt bindings are considered; no cwd/title or
    /// workspace active pointer is used to infer a work for an old thread.
    pub fn list_for_thread(
        &self,
        actual_scope: &WorkScope,
        thread_id: &str,
    ) -> Result<Vec<WorkIdentity>> {
        actual_scope.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(atom(thread_id), "CONTINUOUS_WORK_THREAD_INVALID");
        self.read(|data| {
            let mut found = Vec::new();
            for stored in data.works.values() {
                let value = record(stored)?;
                if value.identity.matches_scope(actual_scope)
                    && stored.bindings.contains_key(thread_id)
                {
                    found.push(value.identity);
                }
            }
            Ok(found)
        })
    }

    /// Read exact original-scope bytes without holding the global State lock
    /// during body I/O. A matching digest/FileID does not prove cross-process
    /// object birth or authorize execution; the host verifies native history.
    pub fn read_input(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        input_id: &str,
    ) -> Result<Option<(WorkInputReceipt, Value)>> {
        #[cfg(any(target_os = "linux", windows))]
        {
            self.read_input_inner(actual_scope, work_id, source, input_id, || Ok(()))
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let identity = WorkIdentity {
                scope: actual_scope.clone(),
                work_id: work_id.into(),
            };
            identity.validate_shape().map_err(anyhow::Error::msg)?;
            source.validate()?;
            ensure!(atom(input_id), "CONTINUOUS_WORK_INPUT_INVALID");
            self.read(|data| {
                data.inputs
                    .get(&input_key(&identity, source, input_id)?)
                    .map(|input| {
                        ensure!(
                            input.publication.is_none(),
                            "CONTINUOUS_WORK_PUBLICATION_UNSUPPORTED"
                        );
                        let original = receipt(input)?;
                        let bytes = self
                            .namespace
                            .read_payload(&original.payload_ref, input.payload_size)?;
                        ensure!(
                            format!("{:x}", Sha256::digest(&bytes)) == input.payload_sha256,
                            "CONTINUOUS_WORK_PAYLOAD_CHANGED"
                        );
                        let payload = serde_json::from_slice(&bytes)
                            .context("CONTINUOUS_WORK_PAYLOAD_INVALID")?;
                        Ok((original, payload))
                    })
                    .transpose()
            })
        }
    }

    #[cfg(any(target_os = "linux", windows))]
    fn read_input_inner(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        input_id: &str,
        after_read: impl FnOnce() -> Result<()>,
    ) -> Result<Option<(WorkInputReceipt, Value)>> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        source.validate()?;
        ensure!(atom(input_id), "CONTINUOUS_WORK_INPUT_INVALID");
        let key = input_key(&identity, source, input_id)?;
        let Some(input) = self.read(|data| Ok(data.inputs.get(&key).cloned()))? else {
            return Ok(None);
        };
        let original = receipt(&input)?;
        ensure!(
            original.work == identity && input.source == *source && original.input_id == input_id,
            "CONTINUOUS_WORK_INPUT_MISMATCH"
        );
        let (payload, witness) = self.observe_payload(&input)?;
        after_read()?;
        self.read(|data| {
            ensure!(
                data.inputs.get(&key) == Some(&input),
                "CONTINUOUS_WORK_INPUT_STALE"
            );
            witness.revalidate()?;
            Ok(())
        })?;
        Ok(Some((original, payload)))
    }

    /// Observe pending original inputs by persisted sequence. The returned
    /// page contains at most ten source/receipt pairs and never loads payloads.
    /// Unknown states remain visible; each call observes a separate snapshot.
    /// The current backing metadata index is bounded but still read as a whole;
    /// its scaling and latency have not yet passed the board acceptance gate.
    pub fn list_pending_inputs(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        after_sequence: Option<u64>,
    ) -> Result<super::PendingInputPage> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        self.read(|data| {
            ensure!(
                data.works.contains_key(&work_key(&identity)?),
                "CONTINUOUS_WORK_NOT_FOUND"
            );
            let entries = data.inputs.values().map(|input| {
                Ok(super::PendingInputEntry {
                    source: input.source.clone(),
                    receipt: receipt(input)?,
                })
            });
            super::pending_inputs::project_pending_inputs(
                &identity,
                after_sequence.unwrap_or(0),
                entries,
            )
        })
    }

    /// Read original input metadata in sequence order, including applied
    /// references. The host must verify each reference against native history.
    /// This does not read input bodies or change their application status.
    pub fn list_inputs(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        after_sequence: Option<u64>,
    ) -> Result<super::WorkInputPage> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        self.read(|data| {
            ensure!(
                data.works.contains_key(&work_key(&identity)?),
                "CONTINUOUS_WORK_NOT_FOUND"
            );
            let entries = data.inputs.values().map(|input| {
                Ok(super::WorkInputEntry {
                    source: input.source.clone(),
                    receipt: receipt(input)?,
                    applied: input.applied.clone(),
                })
            });
            super::pending_inputs::project_all_inputs(
                &identity,
                after_sequence.unwrap_or(0),
                entries,
            )
        })
    }

    /// The initial attempt and request must already be verified against the
    /// original host Accepted ledger. This transaction never starts a turn.
    pub fn admit(
        &self,
        actual_scope: &WorkScope,
        work: WorkRecord,
        source: &WorkInputSource,
        request_id: &str,
        payload: Value,
        accepted_deliveries: Vec<WorkDeliveryRequirement>,
    ) -> Result<InitialAdmission> {
        self.admit_two_phase(
            actual_scope,
            work,
            source,
            request_id,
            payload,
            accepted_deliveries,
        )
    }

    /// Persist the original payload and receipt together before any dispatch.
    /// The host verifies that this input came from an authorized bound source.
    // Frozen input store (lean plan section 5): the wide signature is kept as is.
    #[allow(clippy::too_many_arguments)]
    pub fn accept_input(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        expected_revision: u64,
        input_id: &str,
        request_id: &str,
        kind: WorkInputKind,
        payload: Value,
        accepted_deliveries: Option<Vec<WorkDeliveryRequirement>>,
    ) -> Result<InputAdmission> {
        self.accept_input_two_phase(publication_intent::InputAcceptance {
            actual_scope,
            work_id,
            source,
            expected_revision,
            input_id,
            request_id,
            kind,
            payload,
            accepted_deliveries,
            queued: false,
        })
    }

    /// Accept an input while the target is busy. A queued input is durable but
    /// not consumed: it must be dispatched under a claim and settled before any
    /// turn may treat it as applied. A status query never advances the
    /// requirement revision or replaces the delivery snapshot.
    // Frozen input store (lean plan section 5): the wide signature is kept as is.
    #[allow(clippy::too_many_arguments)]
    pub fn queue_input(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        expected_revision: u64,
        input_id: &str,
        request_id: &str,
        kind: WorkInputKind,
        payload: Value,
        accepted_deliveries: Option<Vec<WorkDeliveryRequirement>>,
    ) -> Result<InputAdmission> {
        self.accept_input_two_phase(publication_intent::InputAcceptance {
            actual_scope,
            work_id,
            source,
            expected_revision,
            input_id,
            request_id,
            kind,
            payload,
            accepted_deliveries,
            queued: true,
        })
    }

    /// Move one queued input to dispatched under the exact current claim. Earlier
    /// accepted or queued inputs must already be dispatched or applied so a later
    /// requirement cannot overtake an earlier one.
    // Frozen input store (lean plan section 5): the wide signature is kept as is.
    #[allow(clippy::too_many_arguments)]
    pub fn dispatch_input(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        input_id: &str,
        claim_id: &str,
        owner_epoch: u64,
        control_epoch: u64,
    ) -> Result<WorkInputReceipt> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        source.validate()?;
        ensure!(
            atom(input_id) && atom(claim_id),
            "CONTINUOUS_WORK_INPUT_INVALID"
        );
        let key = input_key(&identity, source, input_id)?;
        self.update(|data| {
            require_known_inputs(data, &identity)?;
            let work = record(
                data.works
                    .get(&work_key(&identity)?)
                    .context("CONTINUOUS_WORK_NOT_FOUND")?,
            )?;
            let current = receipt(
                data.inputs
                    .get(&key)
                    .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?,
            )?;
            match current.state {
                WorkInputState::Dispatched | WorkInputState::Applied => {
                    return Ok((current, false));
                }
                WorkInputState::Queued => {}
                _ => bail!("CONTINUOUS_WORK_INPUT_NOT_QUEUED"),
            }
            let stored = data
                .works
                .get(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let claim = stored
                .claims
                .get(claim_id)
                .context("CONTINUOUS_WORK_CLAIM_NOT_FOUND")?;
            ensure!(
                stored.active_claim.as_deref() == Some(claim_id)
                    && !claim.released
                    && claim.owner_epoch == owner_epoch
                    && work.revision.owner_epoch == owner_epoch
                    && claim.control_epoch == control_epoch
                    && work.revision.control_epoch == control_epoch,
                "CONTINUOUS_WORK_OWNER_CONFLICT"
            );
            let mut earlier = None;
            for (candidate_key, candidate) in &data.inputs {
                if candidate_key == &key {
                    continue;
                }
                let candidate = receipt(candidate)?;
                if candidate.work == identity
                    && candidate.sequence < current.sequence
                    && !matches!(
                        candidate.state,
                        WorkInputState::Dispatched | WorkInputState::Applied
                    )
                {
                    earlier = Some(candidate.sequence);
                    break;
                }
            }
            ensure!(earlier.is_none(), "CONTINUOUS_WORK_INPUT_ORDER_CONFLICT");
            let input = data
                .inputs
                .get_mut(&key)
                .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?;
            let mut dispatched = current;
            dispatched.state = WorkInputState::Dispatched;
            input.receipt = serde_json::to_value(&dispatched)?;
            Ok((dispatched, true))
        })
    }

    /// Settle one dispatched input as applied after the host verified the native
    /// history identity. This shares every watermark invariant with the direct
    /// application path.
    // Frozen input store (lean plan section 5): the wide signature is kept as is.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_input(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        input_id: &str,
        claim_id: &str,
        owner_epoch: u64,
        control_epoch: u64,
        applied: AppliedInputReference,
    ) -> Result<WorkInputReceipt> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        let key = input_key(&identity, source, input_id)?;
        let current = self.read(|data| {
            let input = data
                .inputs
                .get(&key)
                .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?;
            receipt(input)
        })?;
        ensure!(
            matches!(
                current.state,
                WorkInputState::Dispatched | WorkInputState::Applied
            ),
            "CONTINUOUS_WORK_INPUT_NOT_DISPATCHED"
        );
        self.mark_input_applied(
            actual_scope,
            work_id,
            source,
            input_id,
            claim_id,
            owner_epoch,
            control_epoch,
            applied,
        )
    }

    /// Bind only an independently verified native Accepted attempt. Binding a
    /// second thread does not grant it a coordinator claim or source permission.
    pub fn bind_thread(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        expected_revision: u64,
        request_id: &str,
        attempt: TurnAttemptIdentity,
    ) -> Result<WorkRecord> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        attempt.validate().map_err(anyhow::Error::msg)?;
        ensure!(atom(request_id), "CONTINUOUS_WORK_REQUEST_INVALID");
        let work_key = work_key(&identity)?;
        let operation_key = operation_key(actual_scope, request_id)?;
        let digest = hash(&(&identity, &attempt))?;
        self.update(|data| {
            if let Some(operation) = data.operations.get(&operation_key) {
                let StoredOperation::Binding {
                    digest: previous,
                    work_key: previous_work,
                    thread_id,
                } = operation
                else {
                    bail!("CONTINUOUS_WORK_REQUEST_CONFLICT")
                };
                ensure!(
                    *previous == digest
                        && *previous_work == work_key
                        && *thread_id == attempt.thread_id,
                    "CONTINUOUS_WORK_REQUEST_CONFLICT"
                );
                return Ok((
                    record(
                        data.works
                            .get(&work_key)
                            .context("CONTINUOUS_WORK_RECORD_MISSING")?,
                    )?,
                    false,
                ));
            }
            ensure!(
                data.operations.len() < MAX_OPERATIONS,
                "CONTINUOUS_WORK_CAPACITY"
            );
            require_known_inputs(data, &identity)?;
            let stored = data
                .works
                .get_mut(&work_key)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record(stored, actual_scope)?;
            ensure!(
                work.revision.revision == expected_revision,
                "CONTINUOUS_WORK_REVISION_CONFLICT"
            );
            if let Some(previous) = stored.bindings.get(&attempt.thread_id) {
                ensure!(*previous == attempt, "CONTINUOUS_WORK_BINDING_CONFLICT");
            } else {
                work.linked_thread_ids.push(attempt.thread_id.clone());
                work.revision.revision = next(work.revision.revision)?;
                work.validate_for_mutation(actual_scope)
                    .map_err(anyhow::Error::msg)?;
                stored
                    .bindings
                    .insert(attempt.thread_id.clone(), attempt.clone());
                stored.record = serde_json::to_value(&work)?;
            }
            data.operations.insert(
                operation_key,
                StoredOperation::Binding {
                    digest,
                    work_key,
                    thread_id: attempt.thread_id,
                },
            );
            Ok((work, true))
        })
    }

    /// Claim once per work and increment its durable fencing epoch. A caller
    /// must still acquire the original thread execution gate before dispatch.
    // Frozen input store (lean plan section 5): the wide signature is kept as is.
    #[allow(clippy::too_many_arguments)]
    pub fn claim(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        expected_revision: u64,
        expected_control_epoch: u64,
        claim_id: &str,
        thread_id: &str,
        trigger: ClaimTrigger,
    ) -> Result<ClaimOutcome> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(
            atom(claim_id) && atom(thread_id),
            "CONTINUOUS_WORK_CLAIM_INVALID"
        );
        self.update(|data| {
            require_known_inputs(data, &identity)?;
            let stored = data
                .works
                .get_mut(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record(stored, actual_scope)?;
            if let Some(previous) = stored.claims.get(claim_id) {
                ensure!(
                    previous.thread_id == thread_id
                        && previous.control_epoch == expected_control_epoch,
                    "CONTINUOUS_WORK_CLAIM_CONFLICT"
                );
                ensure!(
                    !previous.released
                        && stored.active_claim.as_deref() == Some(claim_id)
                        && previous.owner_epoch == work.revision.owner_epoch
                        && previous.control_epoch == work.revision.control_epoch,
                    "CONTINUOUS_WORK_CLAIM_STALE"
                );
                return Ok((ClaimOutcome::ExistingActive(previous.clone()), false));
            }
            ensure!(
                stored.claims.len() < MAX_OPERATIONS,
                "CONTINUOUS_WORK_CAPACITY"
            );
            ensure!(
                stored.active_claim.is_none(),
                "CONTINUOUS_WORK_ALREADY_CLAIMED"
            );
            ensure!(
                stored.bindings.contains_key(thread_id),
                "CONTINUOUS_WORK_THREAD_NOT_BOUND"
            );
            ensure!(
                work.revision.revision == expected_revision
                    && work.revision.control_epoch == expected_control_epoch,
                "CONTINUOUS_WORK_REVISION_CONFLICT"
            );
            ensure!(
                matches!(work.phase, WorkPhase::Pending | WorkPhase::Running),
                "CONTINUOUS_WORK_CLAIM_NOT_ELIGIBLE"
            );
            if let Some(control) = &stored.pending_control {
                ensure!(
                    control.state == WorkControlState::Settled
                        && matches!(
                            &control.action,
                            WorkControlAction::Pause | WorkControlAction::Resume
                        )
                        && matches!(control.target.known(), Some(WorkControlTarget::Work {})),
                    "CONTINUOUS_WORK_CONTROL_PENDING"
                );
            }
            work.revision.revision = next(work.revision.revision)?;
            work.revision.owner_epoch = next(work.revision.owner_epoch)?;
            if trigger.is_automatic() {
                work.revision.usage.automatic_turns =
                    work.revision.usage.automatic_turns.saturating_add(1);
            }
            let claim = ClaimReceipt {
                claim_id: claim_id.into(),
                thread_id: thread_id.into(),
                owner_epoch: work.revision.owner_epoch,
                control_epoch: work.revision.control_epoch,
                released: false,
            };
            stored.claims.insert(claim_id.into(), claim.clone());
            stored.active_claim = Some(claim_id.into());
            stored.record = serde_json::to_value(&work)?;
            Ok((ClaimOutcome::Acquired(claim), true))
        })
    }

    pub fn active_claim(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
    ) -> Result<Option<ClaimReceipt>> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        self.read(|data| {
            let Some(stored) = data.works.get(&work_key(&identity)?) else {
                return Ok(None);
            };
            Ok(stored
                .active_claim
                .as_ref()
                .and_then(|id| stored.claims.get(id))
                .cloned())
        })
    }

    /// Observe the original control receipt without replaying its action.
    pub fn read_control(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        request_id: &str,
    ) -> Result<Option<WorkControlReceipt>> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(atom(request_id), "CONTINUOUS_WORK_REQUEST_INVALID");
        self.read(|data| {
            let key = operation_key(actual_scope, request_id)?;
            Ok(match data.operations.get(&key) {
                Some(StoredOperation::Control { receipt, .. }) if receipt.work == identity => {
                    Some(receipt.clone())
                }
                _ => None,
            })
        })
    }

    /// Read the most recently accepted control, including an intent that has
    /// not yet settled or changed the displayed business phase.
    pub fn current_control(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
    ) -> Result<Option<WorkControlReceipt>> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        self.read(|data| {
            Ok(data
                .works
                .get(&work_key(&identity)?)
                .and_then(|work| work.pending_control.clone()))
        })
    }

    /// The original owner calls this only after its native turn/process is
    /// settled. A timeout or missing reply is never sufficient to release it.
    pub fn release_claim(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        claim_id: &str,
        owner_epoch: u64,
        settlement: ClaimSettlement,
    ) -> Result<ClaimReceipt> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        self.update(|data| {
            let stored = data
                .works
                .get_mut(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record_for_release(stored, actual_scope)?;
            let claim = stored
                .claims
                .get_mut(claim_id)
                .context("CONTINUOUS_WORK_CLAIM_NOT_FOUND")?;
            ensure!(
                claim.owner_epoch == owner_epoch,
                "CONTINUOUS_WORK_OWNER_CONFLICT"
            );
            if claim.released {
                return Ok((claim.clone(), false));
            }
            ensure!(
                stored.active_claim.as_deref() == Some(claim_id)
                    && work.revision.owner_epoch == owner_epoch,
                "CONTINUOUS_WORK_OWNER_CONFLICT"
            );
            claim.released = true;
            let result = claim.clone();
            stored.active_claim = None;
            match settlement {
                ClaimSettlement::Completed => {
                    work.revision.usage.consecutive_failures = 0;
                    work.revision.usage.stalled_rounds = 0;
                }
                ClaimSettlement::Failed => {
                    work.revision.usage.consecutive_failures =
                        work.revision.usage.consecutive_failures.saturating_add(1);
                    work.revision.usage.stalled_rounds = 0;
                }
                ClaimSettlement::Stalled => {
                    work.revision.usage.stalled_rounds =
                        work.revision.usage.stalled_rounds.saturating_add(1);
                }
                ClaimSettlement::Abandoned => {}
            }
            work.revision.revision = next(work.revision.revision)?;
            stored.record = serde_json::to_value(&work)?;
            Ok((result, true))
        })
    }

    /// Record the user's intent and fence old dispatch before the host begins
    /// cancel/stop/cleanup. An Accepted receipt does not imply resources settled.
    pub fn control(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        expected_revision: u64,
        request_id: &str,
        action: WorkControlAction,
        target: WorkControlTarget,
    ) -> Result<WorkControlReceipt> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(
            atom(request_id) && action.is_known(),
            "CONTINUOUS_WORK_CONTROL_INVALID"
        );
        // Fine-grained native targets require exact run lookup and the original
        // executor; until that adapter exists, never persist a false acceptance.
        ensure!(
            matches!(&target, WorkControlTarget::Work {})
                && matches!(
                    &action,
                    WorkControlAction::Pause | WorkControlAction::Resume | WorkControlAction::Stop
                ),
            "CONTINUOUS_WORK_CONTROL_TARGET_UNSUPPORTED"
        );
        let digest = hash(&(&identity, expected_revision, &action, &target))?;
        let operation_id_key = operation_key(actual_scope, request_id)?;
        self.update(|data| {
            if let Some(operation) = data.operations.get(&operation_id_key) {
                let StoredOperation::Control {
                    digest: previous,
                    receipt,
                } = operation
                else {
                    bail!("CONTINUOUS_WORK_REQUEST_CONFLICT")
                };
                ensure!(*previous == digest, "CONTINUOUS_WORK_REQUEST_CONFLICT");
                return Ok((receipt.clone(), false));
            }
            ensure!(
                data.operations.len() < MAX_OPERATIONS,
                "CONTINUOUS_WORK_CAPACITY"
            );
            let stored = data
                .works
                .get_mut(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record(stored, actual_scope)?;
            ensure!(
                work.revision.revision == expected_revision,
                "CONTINUOUS_WORK_REVISION_CONFLICT"
            );
            if action == WorkControlAction::Resume {
                ensure!(
                    work.phase == WorkPhase::Paused,
                    "CONTINUOUS_WORK_NOT_PAUSED"
                );
                ensure!(
                    !stored
                        .pending_control
                        .as_ref()
                        .is_some_and(|pending| pending.action == WorkControlAction::Stop),
                    "CONTINUOUS_WORK_STOPPED_REQUIRES_NEW_ACCEPTANCE"
                );
            }
            ensure!(
                work.phase != WorkPhase::Stopped,
                "CONTINUOUS_WORK_STOPPED_REQUIRES_NEW_ACCEPTANCE"
            );
            if let Some(pending) = stored.pending_control.clone() {
                ensure!(
                    pending.state == WorkControlState::Settled || action == WorkControlAction::Stop,
                    "CONTINUOUS_WORK_CONTROL_PENDING"
                );
                ensure!(
                    pending.action != WorkControlAction::Stop,
                    "CONTINUOUS_WORK_STOPPED_REQUIRES_NEW_ACCEPTANCE"
                );
                if pending.state != WorkControlState::Settled {
                    let previous_key = operation_key(actual_scope, &pending.request_id)?;
                    let previous = data
                        .operations
                        .get_mut(&previous_key)
                        .context("CONTINUOUS_WORK_CONTROL_NOT_FOUND")?;
                    let StoredOperation::Control { receipt, .. } = previous else {
                        bail!("CONTINUOUS_WORK_CONTROL_NOT_FOUND")
                    };
                    ensure!(
                        *receipt == pending,
                        "CONTINUOUS_WORK_CONTROL_RECEIPT_MISMATCH"
                    );
                    receipt.state = WorkControlState::Superseded;
                }
            }
            work.revision.revision = next(work.revision.revision)?;
            work.revision.control_epoch = next(work.revision.control_epoch)?;
            let receipt = WorkControlReceipt {
                work: identity,
                request_id: request_id.into(),
                action,
                target: WorkControlTargetFact::Known(target),
                expected_revision,
                control_epoch: work.revision.control_epoch,
                state: WorkControlState::Accepted,
            };
            receipt
                .validate_for_mutation(actual_scope)
                .map_err(anyhow::Error::msg)?;
            stored.pending_control = Some(receipt.clone());
            stored.record = serde_json::to_value(&work)?;
            data.operations.insert(
                operation_id_key,
                StoredOperation::Control {
                    digest,
                    receipt: receipt.clone(),
                },
            );
            Ok((receipt, true))
        })
    }

    /// Mark an input as consumed only after the host verifies its original
    /// committed history identity. Consecutive input watermarks cannot skip.
    // Frozen input store (lean plan section 5): the wide signature is kept as is.
    #[allow(clippy::too_many_arguments)]
    pub fn mark_input_applied(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        input_id: &str,
        claim_id: &str,
        owner_epoch: u64,
        control_epoch: u64,
        applied: AppliedInputReference,
    ) -> Result<WorkInputReceipt> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        source.validate()?;
        applied.attempt.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            atom(input_id) && atom(claim_id) && atom(&applied.history_uuid),
            "CONTINUOUS_WORK_INPUT_INVALID"
        );
        self.update(|data| {
            require_known_inputs(data, &identity)?;
            let stored = data
                .works
                .get_mut(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record(stored, actual_scope)?;
            let input = data
                .inputs
                .get_mut(&input_key(&identity, source, input_id)?)
                .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?;
            let mut current: WorkInputReceipt = mutable_parse(&input.receipt)?;
            current.validate_shape().map_err(anyhow::Error::msg)?;
            if current.state == WorkInputState::Applied {
                ensure!(
                    input.applied.as_ref() == Some(&applied),
                    "CONTINUOUS_WORK_INPUT_APPLICATION_CONFLICT"
                );
                return Ok((current, false));
            }
            ensure!(
                matches!(
                    current.state,
                    WorkInputState::Accepted | WorkInputState::Queued | WorkInputState::Dispatched
                ),
                "CONTINUOUS_WORK_INPUT_NOT_APPLICABLE"
            );
            let claim = stored
                .claims
                .get(claim_id)
                .context("CONTINUOUS_WORK_CLAIM_NOT_FOUND")?;
            ensure!(
                stored.active_claim.as_deref() == Some(claim_id)
                    && !claim.released
                    && claim.thread_id == applied.attempt.thread_id
                    && claim.owner_epoch == owner_epoch
                    && work.revision.owner_epoch == owner_epoch
                    && claim.control_epoch == control_epoch
                    && work.revision.control_epoch == control_epoch,
                "CONTINUOUS_WORK_OWNER_CONFLICT"
            );
            ensure!(
                current.sequence == next(work.revision.applied_input_sequence)?,
                "CONTINUOUS_WORK_INPUT_ORDER_CONFLICT"
            );
            current.state = WorkInputState::Applied;
            work.revision.applied_input_sequence = current.sequence;
            work.revision.revision = next(work.revision.revision)?;
            input.receipt = serde_json::to_value(&current)?;
            input.applied = Some(applied);
            stored.record = serde_json::to_value(&work)?;
            Ok((current, true))
        })
    }

    /// Settle only the exact current control after the host has verified the
    /// native outcome. Pause/stop cannot settle while this work has an owner.
    pub fn settle_control(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        request_id: &str,
        control_epoch: u64,
        state: WorkControlState,
    ) -> Result<WorkControlReceipt> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(
            matches!(
                state,
                WorkControlState::Settled
                    | WorkControlState::Failed
                    | WorkControlState::NeedsReconciliation
            ),
            "CONTINUOUS_WORK_CONTROL_STATE_INVALID"
        );
        let operation_key = operation_key(actual_scope, request_id)?;
        self.update(|data| {
            let stored = data
                .works
                .get_mut(&work_key(&identity)?)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut work = mutable_record(stored, actual_scope)?;
            let operation = data
                .operations
                .get_mut(&operation_key)
                .context("CONTINUOUS_WORK_CONTROL_NOT_FOUND")?;
            let StoredOperation::Control { receipt, .. } = operation else {
                bail!("CONTINUOUS_WORK_CONTROL_NOT_FOUND")
            };
            ensure!(
                receipt.work == identity && receipt.control_epoch == control_epoch,
                "CONTINUOUS_WORK_CONTROL_CONFLICT"
            );
            if receipt.state == state {
                return Ok((receipt.clone(), false));
            }
            ensure!(
                receipt.state == WorkControlState::Accepted
                    || receipt.state == WorkControlState::Settling,
                "CONTINUOUS_WORK_CONTROL_TERMINAL"
            );
            ensure!(
                work.revision.control_epoch == control_epoch
                    && stored
                        .pending_control
                        .as_ref()
                        .is_some_and(|pending| pending.request_id == request_id),
                "CONTINUOUS_WORK_CONTROL_CONFLICT"
            );
            if state == WorkControlState::Settled {
                match receipt.action {
                    WorkControlAction::Pause | WorkControlAction::Stop => {
                        ensure!(
                            stored.active_claim.is_none(),
                            "CONTINUOUS_WORK_CONTROL_NOT_SETTLED"
                        );
                        work.phase = if receipt.action == WorkControlAction::Pause {
                            WorkPhase::Paused
                        } else {
                            WorkPhase::Stopped
                        };
                    }
                    WorkControlAction::Resume => work.phase = WorkPhase::Pending,
                    _ => {}
                }
            }
            receipt.state = state;
            stored.pending_control = Some(receipt.clone());
            work.revision.revision = next(work.revision.revision)?;
            stored.record = serde_json::to_value(&work)?;
            Ok((receipt.clone(), true))
        })
    }
}
