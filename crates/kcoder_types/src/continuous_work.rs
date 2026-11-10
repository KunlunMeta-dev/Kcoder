//! Shared facts for a continuous unit of work.
//!
//! These types contain no runtime, I/O, or authority. In particular, matching a
//! serialized scope or origin is not authorization: the target host must resolve
//! the actual profile, workspace, original acceptance and current permissions.
//! A turn outcome, input receipt or delivery intent alone is not completion.

use crate::TurnAttemptIdentity;
use crate::integrations::core::IntegrationTaskCapabilityScopeControlTarget;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::{BTreeMap, BTreeSet};

pub const CONTINUOUS_WORK_SCHEMA_V1: u32 = 1;
const MAX_ATOM_BYTES: usize = 256;
const MAX_THREAD_BINDINGS: usize = 256;
/// Maximum entries in each result artifact, evidence or required-delivery list.
pub const MAX_RESULT_REFERENCES: usize = 256;

// Unknown values are retained for read-only display; callers must explicitly
// reject them before making decisions or changing persistent state.
macro_rules! open_label {
    ($name:ident { $($variant:ident => $label:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum $name { $($variant,)+ Unknown(String) }
        impl $name {
            pub fn as_str(&self) -> &str {
                match self { $(Self::$variant => $label,)+ Self::Unknown(raw) => raw }
            }
            pub fn is_known(&self) -> bool { !matches!(self, Self::Unknown(_)) }
        }
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let raw = String::deserialize(deserializer)?;
                if raw.len() > MAX_ATOM_BYTES {
                    return Err(serde::de::Error::custom("label exceeds 256 UTF-8 bytes"));
                }
                Ok(match raw.as_str() { $($label => Self::$variant,)+ _ => Self::Unknown(raw) })
            }
        }
        #[cfg(feature = "json-schema")]
        impl schemars::JsonSchema for $name {
            fn schema_name() -> String { stringify!($name).into() }
            fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
                let mut schema = <String as schemars::JsonSchema>::json_schema(generator);
                if let schemars::schema::Schema::Object(object) = &mut schema {
                    object.extensions.insert("x-max-utf8-bytes".into(), serde_json::json!(MAX_ATOM_BYTES));
                    object.extensions.insert("x-known-values".into(), serde_json::json!([$($label,)+]));
                }
                schema
            }
        }
    };
}

mod references;
pub use references::{
    WorkBackgroundKind, WorkItemKind, WorkItemLink, WorkItemReference, WorkKnownReference,
    WorkNativeReference,
};
mod control;
pub use control::{WorkControlTarget, WorkControlTargetFact};
pub mod dispatch;
mod event;
pub use event::{WorkEventFactV2, WorkEventIdentityCandidate};
pub mod terminal_evidence;

open_label!(WorkPhase {
    Pending => "pending", Running => "running", WaitingUser => "waiting_user",
    WaitingEvent => "waiting_event", Paused => "paused", Completed => "completed",
    Failed => "failed", Stopped => "stopped", NeedsReconciliation => "needs_reconciliation",
});
open_label!(WorkOriginKind {
    Foreground => "foreground", Scheduled => "scheduled", NativeSource => "native_source",
});
open_label!(WorkInputState {
    Accepted => "accepted", Queued => "queued", Dispatched => "dispatched",
    Applied => "applied", Rejected => "rejected", NeedsReconciliation => "needs_reconciliation",
});
open_label!(WorkInputKind {
    Requirement => "requirement", Answer => "answer", StatusQuery => "status_query",
});
open_label!(WorkWaitKind { User => "user", Event => "event" });
open_label!(WorkEventState {
    Received => "received", PendingRoute => "pending_route", Linked => "linked",
    PendingDelivery => "pending_delivery", Applied => "applied", Processed => "processed",
    Ignored => "ignored", NeedsReconciliation => "needs_reconciliation",
});
open_label!(WorkDeliveryState {
    Pending => "pending", Sending => "sending", Confirmed => "confirmed",
    UnknownOutcome => "unknown_outcome", Failed => "failed", Cancelled => "cancelled",
});
open_label!(WorkConfirmationLevel {
    Accepted => "accepted", Delivered => "delivered", Read => "read",
});
impl WorkConfirmationLevel {
    /// Ordering of the known confirmation levels. An unknown future level keeps
    /// no rank, so it can never satisfy a minimum.
    pub fn confirmation_rank(&self) -> Option<u8> {
        match self {
            Self::Accepted => Some(1),
            Self::Delivered => Some(2),
            Self::Read => Some(3),
            Self::Unknown(_) => None,
        }
    }
}

open_label!(WorkObservationFreshness {
    Current => "current", Partial => "partial", Stale => "stale",
    Unreadable => "unreadable", Unobserved => "unknown",
});
open_label!(WorkControlAction {
    Pause => "pause", Resume => "resume", Stop => "stop", CancelRun => "cancel_run",
    Retry => "retry", Reconcile => "reconcile",
});
open_label!(WorkControlState {
    Accepted => "accepted", Settling => "settling", Settled => "settled",
    // The desired control was superseded; this does not settle owned resources.
    Superseded => "superseded", Failed => "failed", NeedsReconciliation => "needs_reconciliation",
});

fn atom(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ATOM_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// These wrappers are local to this new contract. The existing shared attempt
// type is intentionally unchanged for older histories and RPC consumers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictAttempt {
    thread_id: String,
    turn_id: String,
    attempt_id: String,
}
impl From<StrictAttempt> for TurnAttemptIdentity {
    fn from(value: StrictAttempt) -> Self {
        Self {
            thread_id: value.thread_id,
            turn_id: value.turn_id,
            attempt_id: value.attempt_id,
        }
    }
}
fn deserialize_attempt<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<TurnAttemptIdentity, D::Error> {
    StrictAttempt::deserialize(deserializer).map(Into::into)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictSourceTarget {
    initial_attempt: StrictAttempt,
    #[serde(default)]
    runtime_operation_id: Option<String>,
}
fn deserialize_source_target<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<IntegrationTaskCapabilityScopeControlTarget, D::Error> {
    let target = StrictSourceTarget::deserialize(deserializer)?;
    Ok(IntegrationTaskCapabilityScopeControlTarget {
        initial_attempt: target.initial_attempt.into(),
        runtime_operation_id: target.runtime_operation_id,
    })
}

/// Scope names are opaque lookup facts supplied by the actual target host.
/// They must never be used as file paths or accepted as proof of ownership.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkScope {
    pub account_id: String,
    pub target_id: String,
    pub workspace_id: String,
}
impl WorkScope {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        if [&self.account_id, &self.target_id, &self.workspace_id]
            .into_iter()
            .all(|v| atom(v))
        {
            Ok(())
        } else {
            Err("invalid work scope")
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkIdentity {
    pub scope: WorkScope,
    pub work_id: String,
}
impl WorkIdentity {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        self.scope.validate_shape()?;
        // A work ID can be used as a private storage leaf after its containing
        // directory and owner have independently been validated.
        if self.work_id.is_empty()
            || self.work_id.len() > 128
            || !self
                .work_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("invalid work ID");
        }
        Ok(())
    }
    /// Compare against a scope resolved by the host. This check grants no rights.
    pub fn matches_scope(&self, actual: &WorkScope) -> bool {
        self.scope == *actual
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledOriginRef {
    pub job_id: String,
    pub trigger_id: String,
    pub receipt_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSourceOriginRef {
    #[serde(deserialize_with = "deserialize_source_target")]
    pub target: IntegrationTaskCapabilityScopeControlTarget,
    pub instance_id: String,
    pub accepted_operation_id: String,
}

/// Original identity is immutable evidence, not a client-supplied permission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkOrigin {
    pub kind: WorkOriginKind,
    #[serde(deserialize_with = "deserialize_attempt")]
    pub initial_attempt: TurnAttemptIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<ScheduledOriginRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_source: Option<NativeSourceOriginRef>,
}
impl WorkOrigin {
    fn validate_shape(&self) -> Result<(), &'static str> {
        self.initial_attempt.validate()?;
        match self.kind {
            WorkOriginKind::Foreground
                if self.schedule.is_none() && self.native_source.is_none() =>
            {
                Ok(())
            }
            WorkOriginKind::Scheduled if self.native_source.is_none() => {
                let schedule = self
                    .schedule
                    .as_ref()
                    .ok_or("missing original schedule receipt")?;
                if [&schedule.job_id, &schedule.trigger_id, &schedule.receipt_id]
                    .into_iter()
                    .all(|v| atom(v))
                {
                    Ok(())
                } else {
                    Err("invalid schedule reference")
                }
            }
            WorkOriginKind::NativeSource if self.schedule.is_none() => {
                let source = self
                    .native_source
                    .as_ref()
                    .ok_or("missing original source reference")?;
                source
                    .target
                    .validate()
                    .map_err(|_| "invalid original source target")?;
                if source.target.initial_attempt != self.initial_attempt
                    || !atom(&source.instance_id)
                    || !atom(&source.accepted_operation_id)
                {
                    return Err("original source identity mismatch");
                }
                Ok(())
            }
            // An unknown future origin remains readable, but may not be mutated.
            WorkOriginKind::Unknown(_) => Ok(()),
            _ => Err("origin kind and original references conflict"),
        }
    }
}

/// Durable counters of one business batch. A process restart, reconnect, status
/// inquiry, model retry or source event must not reset them, and a missing value
/// on an older record is not evidence that no automatic turn ever ran.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkUsage {
    #[serde(default)]
    pub automatic_turns: u64,
    #[serde(default)]
    pub consecutive_failures: u64,
    #[serde(default)]
    pub stalled_rounds: u64,
}

/// Independent watermarks: a later input can be accepted without being applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkRevision {
    pub revision: u64,
    pub requirements_revision: u64,
    pub control_epoch: u64,
    pub owner_epoch: u64,
    pub accepted_input_sequence: u64,
    pub required_input_sequence: u64,
    pub applied_input_sequence: u64,
    /// Older records keep the default counters until the next claim or settlement.
    #[serde(default)]
    pub usage: WorkUsage,
}
impl WorkRevision {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        if self.revision == 0
            || self.requirements_revision == 0
            || self.required_input_sequence > self.accepted_input_sequence
            || self.applied_input_sequence > self.accepted_input_sequence
        {
            return Err("invalid work revision or input watermarks");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkWait {
    pub kind: WorkWaitKind,
    pub reference: String,
}

/// The basis under which a result was actually produced. It is not a claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultBasis {
    pub requirements_revision: u64,
    pub control_epoch: u64,
    pub owner_epoch: u64,
    pub applied_input_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkResult {
    pub result_id: String,
    pub basis: ResultBasis,
    pub artifact_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    /// These required deliveries are fixed by the accepted request and cannot
    /// be silently removed merely because a send failed or its ACK was lost.
    pub required_delivery_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkDelivery {
    pub delivery_id: String,
    pub required_for_completion: bool,
    pub state: WorkDeliveryState,
    pub minimum_confirmation: WorkConfirmationLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_confirmation: Option<WorkConfirmationLevel>,
    /// Original send operation/receipt; presence alone is not its verification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_ref: Option<String>,
}

/// A required delivery is frozen by the native acceptance path, not inferred
/// from a model result. The host resolves and verifies this authoritative list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkDeliveryRequirement {
    pub delivery_id: String,
    pub minimum_confirmation: WorkConfirmationLevel,
}

/// Bounded index/display hints derived by the host from the accepted request.
/// An absent timestamp is unknown. Hints never replace the original input or
/// become authority to access its source, execute tools, or complete work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPresentation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
}
impl WorkPresentation {
    fn validate_shape(&self) -> Result<(), &'static str> {
        if self
            .title
            .as_ref()
            .is_some_and(|v| v.len() > 512 || v.chars().any(char::is_control))
            || self.objective_summary.as_ref().is_some_and(|v| {
                v.len() > 8192 || v.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
            })
        {
            return Err("invalid work display metadata");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WorkRecord {
    pub schema_version: u32,
    pub identity: WorkIdentity,
    pub origin: WorkOrigin,
    pub linked_thread_ids: Vec<String>,
    pub phase: WorkPhase,
    pub revision: WorkRevision,
    /// Exact native objects, established only from their original authority.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub native_refs: Vec<WorkNativeReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<WorkPresentation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<WorkWait>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<WorkResult>,
    /// Future top-level data is retained for observation. Old writers must not
    /// mutate records containing fields whose semantics they cannot interpret.
    #[serde(flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}
impl WorkRecord {
    /// Structural checks only. Original acceptance, scope, artifacts and
    /// receipts remain the responsibility of their native authorities.
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        self.identity.validate_shape()?;
        self.origin.validate_shape()?;
        self.revision.validate_shape()?;
        if self.linked_thread_ids.is_empty() || self.linked_thread_ids.len() > MAX_THREAD_BINDINGS {
            return Err("invalid thread binding count");
        }
        if self.extensions.len() > 64
            || self.extensions.keys().any(|key| {
                !atom(key)
                    || matches!(
                        key.as_str(),
                        "schemaVersion"
                            | "identity"
                            | "origin"
                            | "linkedThreadIds"
                            | "phase"
                            | "revision"
                            | "nativeRefs"
                            | "presentation"
                            | "waiting"
                            | "result"
                    )
            })
        {
            return Err("invalid future extension fields");
        }
        if let Some(presentation) = &self.presentation {
            presentation.validate_shape()?;
        }
        let mut threads = BTreeSet::new();
        for thread in &self.linked_thread_ids {
            if !atom(thread) || !threads.insert(thread) {
                return Err("invalid or duplicate thread binding");
            }
        }
        if !threads.contains(&self.origin.initial_attempt.thread_id) {
            return Err("original thread is not explicitly bound");
        }
        if self.native_refs.len() > MAX_RESULT_REFERENCES {
            return Err("too many native references");
        }
        let mut refs = BTreeSet::new();
        for reference in &self.native_refs {
            reference.validate_shape(&threads)?;
            let key = serde_json::to_vec(reference).map_err(|_| "invalid native reference")?;
            if !refs.insert(key) {
                return Err("duplicate native reference");
            }
        }
        if let Some(waiting) = &self.waiting
            && !atom(&waiting.reference)
        {
            return Err("invalid wait reference");
        }
        match (&self.phase, self.waiting.as_ref().map(|w| &w.kind)) {
            (WorkPhase::WaitingUser, Some(WorkWaitKind::User))
            | (WorkPhase::WaitingEvent, Some(WorkWaitKind::Event)) => {}
            (WorkPhase::WaitingUser | WorkPhase::WaitingEvent, _) => {
                return Err("waiting phase requires its original condition");
            }
            _ => {}
        }
        if let Some(result) = &self.result {
            if !atom(&result.result_id)
                || result.artifact_refs.len() > MAX_RESULT_REFERENCES
                || result.evidence_refs.len() > MAX_RESULT_REFERENCES
                || result.required_delivery_ids.len() > MAX_RESULT_REFERENCES
                || result
                    .artifact_refs
                    .iter()
                    .chain(&result.evidence_refs)
                    .chain(&result.required_delivery_ids)
                    .any(|v| !atom(v))
            {
                return Err("invalid result references");
            }
            if result
                .required_delivery_ids
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != result.required_delivery_ids.len()
            {
                return Err("duplicate required delivery");
            }
        }
        Ok(())
    }

    /// Call only with a scope independently resolved from the host. This does
    /// not authenticate that scope or authorize the requested mutation.
    pub fn validate_for_mutation(&self, actual_scope: &WorkScope) -> Result<(), &'static str> {
        self.validate_shape()?;
        actual_scope.validate_shape()?;
        if self.schema_version != CONTINUOUS_WORK_SCHEMA_V1 {
            return Err("unsupported work schema");
        }
        if !self.extensions.is_empty() {
            return Err("unknown work fields cannot be mutated");
        }
        if !self.identity.matches_scope(actual_scope) {
            return Err("work scope mismatch");
        }
        if self
            .native_refs
            .iter()
            .any(|reference| !reference.permits_mutation())
            || !self.phase.is_known()
            || !self.origin.kind.is_known()
            || self
                .waiting
                .as_ref()
                .is_some_and(|wait| !wait.kind.is_known())
        {
            return Err("unknown work state cannot be mutated");
        }
        Ok(())
    }

    /// Check the necessary completion fences and required delivery facts.
    /// The state transaction must also atomically compare its current revision,
    /// verify actual results/receipts and perform all native authorization checks.
    pub fn validate_completion(
        &self,
        actual_scope: &WorkScope,
        accepted_deliveries: &[WorkDeliveryRequirement],
        deliveries: &[WorkDelivery],
    ) -> Result<(), &'static str> {
        self.validate_for_mutation(actual_scope)?;
        if !matches!(self.phase, WorkPhase::Running | WorkPhase::Completed) {
            return Err("work is not eligible to complete");
        }
        if self.waiting.is_some() {
            return Err("work has an unresolved wait");
        }
        let result = self.result.as_ref().ok_or("missing result")?;
        let basis = &result.basis;
        let current = &self.revision;
        if basis.requirements_revision != current.requirements_revision
            || basis.control_epoch != current.control_epoch
            || basis.owner_epoch != current.owner_epoch
            || basis.owner_epoch == 0
            || basis.applied_input_sequence < current.required_input_sequence
            || basis.applied_input_sequence > current.applied_input_sequence
        {
            return Err("result is based on stale or unapplied work");
        }
        let mut required = BTreeSet::new();
        for requirement in accepted_deliveries {
            if !atom(&requirement.delivery_id)
                || !required.insert(&requirement.delivery_id)
                || confirmation_rank(&requirement.minimum_confirmation).is_none()
            {
                return Err("invalid accepted delivery requirement");
            }
        }
        if required != result.required_delivery_ids.iter().collect::<BTreeSet<_>>() {
            return Err("result does not match accepted delivery requirements");
        }
        let mut seen = BTreeSet::new();
        for delivery in deliveries {
            if !atom(&delivery.delivery_id) || !seen.insert(&delivery.delivery_id) {
                return Err("invalid or duplicate delivery");
            }
            if delivery.required_for_completion
                && !result.required_delivery_ids.contains(&delivery.delivery_id)
            {
                return Err("required delivery is missing from result basis");
            }
        }
        for requirement in accepted_deliveries {
            let delivery = deliveries
                .iter()
                .find(|delivery| delivery.delivery_id == requirement.delivery_id)
                .ok_or("required delivery missing")?;
            if !delivery.required_for_completion
                || delivery.state != WorkDeliveryState::Confirmed
                || delivery.minimum_confirmation != requirement.minimum_confirmation
                || !delivery.receipt_ref.as_deref().is_some_and(atom)
            {
                return Err("required delivery is not confirmed");
            }
            let minimum = confirmation_rank(&requirement.minimum_confirmation)
                .ok_or("unknown confirmation level")?;
            let observed = delivery
                .observed_confirmation
                .as_ref()
                .and_then(confirmation_rank)
                .ok_or("missing or unknown observed confirmation")?;
            if observed < minimum {
                return Err("required confirmation level not reached");
            }
        }
        Ok(())
    }
}

fn confirmation_rank(level: &WorkConfirmationLevel) -> Option<u8> {
    match level {
        WorkConfirmationLevel::Accepted => Some(1),
        WorkConfirmationLevel::Delivered => Some(2),
        WorkConfirmationLevel::Read => Some(3),
        WorkConfirmationLevel::Unknown(_) => None,
    }
}

/// The original input payload lives in the target's private store. Its digest
/// is for integrity and idempotency, not a substitute for the original content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkInputReceipt {
    pub work: WorkIdentity,
    pub input_id: String,
    pub request_id: String,
    pub request_digest: String,
    pub payload_ref: String,
    pub sequence: u64,
    pub kind: WorkInputKind,
    pub state: WorkInputState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirements_revision: Option<u64>,
}
impl WorkInputReceipt {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        self.work.validate_shape()?;
        if !atom(&self.input_id)
            || !atom(&self.request_id)
            || !atom(&self.payload_ref)
            || !digest(&self.request_digest)
            || self.sequence == 0
            || self.requirements_revision == Some(0)
        {
            return Err("invalid input receipt");
        }
        Ok(())
    }

    /// This checks consistency with a host-resolved scope; the host must still
    /// verify the original acceptance, payload and applicable authorization.
    pub fn validate_for_mutation(&self, actual_scope: &WorkScope) -> Result<(), &'static str> {
        self.validate_shape()?;
        actual_scope.validate_shape()?;
        if !self.work.matches_scope(actual_scope) {
            return Err("work scope mismatch");
        }
        if !self.kind.is_known() || !self.state.is_known() {
            return Err("unknown input state cannot be mutated");
        }
        match (&self.kind, self.requirements_revision) {
            (WorkInputKind::Requirement, None) => {
                Err("requirement must advance the requirements revision")
            }
            (WorkInputKind::Answer, Some(_)) => {
                Err("answer cannot advance the requirements revision")
            }
            (WorkInputKind::StatusQuery, Some(_)) => {
                Err("status query cannot advance the requirements revision")
            }
            _ => Ok(()),
        }
    }
}

/// Source revision distinguishes a later edit/withdrawal from duplicate replay.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkEvent {
    pub work: WorkIdentity,
    pub event_id: String,
    pub source_ref: String,
    pub source_revision: String,
    pub kind: String,
    pub state: WorkEventState,
    pub observed_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurred_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<String>,
}
impl std::fmt::Debug for WorkEvent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkEvent")
            .field("state_known", &self.state.is_known())
            .field("occurred_at_present", &self.occurred_at_ms.is_some())
            .field("payload_ref_present", &self.payload_ref.is_some())
            .field("causation_id_present", &self.causation_id.is_some())
            .finish_non_exhaustive()
    }
}
impl WorkEvent {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        self.work.validate_shape()?;
        if [
            &self.event_id,
            &self.source_ref,
            &self.source_revision,
            &self.kind,
        ]
        .into_iter()
        .any(|v| !atom(v))
            || self.payload_ref.as_deref().is_some_and(|v| !atom(v))
            || self.causation_id.as_deref().is_some_and(|v| !atom(v))
        {
            return Err("invalid event identity or reference");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkControlReceipt {
    pub work: WorkIdentity,
    pub request_id: String,
    pub action: WorkControlAction,
    pub target: WorkControlTargetFact,
    pub expected_revision: u64,
    pub control_epoch: u64,
    pub state: WorkControlState,
}
impl WorkControlReceipt {
    pub fn validate_for_mutation(&self, actual_scope: &WorkScope) -> Result<(), &'static str> {
        self.work.validate_shape()?;
        actual_scope.validate_shape()?;
        if !self.work.matches_scope(actual_scope)
            || !atom(&self.request_id)
            || self.expected_revision == 0
            || self.control_epoch == 0
            || !self.action.is_known()
            || !self.state.is_known()
            || self.target.validate_shape().is_err()
            || !self.target.matches_action(&self.action)
        {
            return Err("invalid control receipt or scope");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkObservation {
    pub freshness: WorkObservationFreshness,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> WorkRecord {
        WorkRecord {
            schema_version: 1,
            identity: WorkIdentity {
                scope: WorkScope {
                    account_id: "profile-1".into(),
                    target_id: "host-1".into(),
                    workspace_id: "workspace-1".into(),
                },
                work_id: "work-1".into(),
            },
            origin: WorkOrigin {
                kind: WorkOriginKind::Foreground,
                initial_attempt: TurnAttemptIdentity {
                    thread_id: "thread-1".into(),
                    turn_id: "turn-1".into(),
                    attempt_id: "attempt-1".into(),
                },
                schedule: None,
                native_source: None,
            },
            linked_thread_ids: vec!["thread-1".into()],
            phase: WorkPhase::Running,
            revision: WorkRevision {
                revision: 4,
                requirements_revision: 2,
                control_epoch: 3,
                owner_epoch: 1,
                accepted_input_sequence: 2,
                required_input_sequence: 2,
                applied_input_sequence: 2,
                usage: WorkUsage::default(),
            },
            native_refs: vec![],
            presentation: None,
            waiting: None,
            result: Some(WorkResult {
                result_id: "result-1".into(),
                basis: ResultBasis {
                    requirements_revision: 2,
                    control_epoch: 3,
                    owner_epoch: 1,
                    applied_input_sequence: 2,
                },
                artifact_refs: vec!["artifact-version-1".into()],
                evidence_refs: vec!["test-run-1".into()],
                required_delivery_ids: vec![],
            }),
            extensions: BTreeMap::new(),
        }
    }

    #[test]
    fn scope_and_original_thread_must_match_without_granting_authority() {
        let mut work = fixture();
        let scope = work.identity.scope.clone();
        assert!(work.validate_for_mutation(&scope).is_ok());
        let mut link = WorkItemLink {
            work: work.identity.clone(),
            item: WorkItemReference {
                kind: WorkItemKind::Local,
                source_instance_id: "client-store".into(),
                project_id: "project-1".into(),
                item_id: "item-1".into(),
                item_version: None,
            },
            link_revision: 1,
        };
        for kind in [WorkItemKind::Local, WorkItemKind::Cloud] {
            link.item.kind = kind;
            let value = serde_json::to_value(&link).unwrap();
            let decoded: WorkItemLink = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(&decoded).unwrap(), value);
            assert!(decoded.validate_for_mutation(&scope).is_ok());
        }
        for field in 0..3 {
            let mut other = scope.clone();
            match field {
                0 => other.account_id.push('2'),
                1 => other.target_id.push('2'),
                _ => other.workspace_id.push('2'),
            }
            assert!(work.validate_for_mutation(&other).is_err());
            assert!(link.validate_for_mutation(&other).is_err());
        }
        link.item.kind = WorkItemKind::Unknown("future".into());
        let value = serde_json::to_value(&link).unwrap();
        let decoded: WorkItemLink = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), value);
        assert!(decoded.validate_for_mutation(&scope).is_err());
        work.linked_thread_ids = vec!["thread-2".into()];
        assert!(work.validate_for_mutation(&scope).is_err());
        work.linked_thread_ids = vec!["thread-1".into(), "thread-1".into()];
        assert!(work.validate_for_mutation(&scope).is_err());
        work.identity.work_id = "../other-profile".into();
        assert!(work.validate_shape().is_err());
    }

    #[test]
    fn future_labels_round_trip_but_cannot_authorize_mutation() {
        let work = fixture();
        let mut json = serde_json::to_value(&work).unwrap();
        json["phase"] = json!("waiting_for_quorum");
        let future: WorkRecord = serde_json::from_value(json.clone()).unwrap();
        assert!(future.validate_shape().is_ok());
        assert!(future.validate_for_mutation(&work.identity.scope).is_err());
        assert_eq!(serde_json::to_value(&future).unwrap(), json);
        let mut newer_schema = work.clone();
        newer_schema.schema_version = 2;
        assert!(newer_schema.validate_shape().is_ok());
        assert!(
            newer_schema
                .validate_for_mutation(&work.identity.scope)
                .is_err()
        );
        assert!(serde_json::from_value::<WorkPhase>(json!("x".repeat(257))).is_err());
    }

    #[test]
    fn display_metadata_is_bounded_optional_and_does_not_invent_time() {
        let mut work = fixture();
        let older = serde_json::to_value(&work).unwrap();
        assert!(older.get("presentation").is_none());
        assert!(
            serde_json::from_value::<WorkRecord>(older)
                .unwrap()
                .presentation
                .is_none()
        );
        work.presentation = Some(WorkPresentation {
            title: Some("Write the report".into()),
            objective_summary: Some("Summarize the supplied source.\nPreserve references.".into()),
            created_at_ms: Some(200),
            updated_at_ms: Some(100),
        });
        // Clock changes do not fabricate a reordered timestamp or invalidate a record.
        work.validate_shape().unwrap();
        work.presentation.as_mut().unwrap().title = Some("x".repeat(513));
        assert!(work.validate_shape().is_err());
    }

    #[test]
    fn native_references_preserve_original_run_and_reject_cross_thread_parentage() {
        let mut work = fixture();
        let scope = work.identity.scope.clone();
        let attempt = work.origin.initial_attempt.clone();
        work.native_refs = vec![
            WorkNativeReference::Known(WorkKnownReference::Goal {
                thread_id: "thread-1".into(),
                goal_id: "goal-1".into(),
                revision: 0,
            }),
            WorkNativeReference::Known(WorkKnownReference::Plan {
                plan_work_id: "plan-work-1".into(),
                revision: 1,
                plan_sha256: "a".repeat(64),
            }),
            WorkNativeReference::Known(WorkKnownReference::Background {
                parent_attempt: attempt,
                run: crate::BackgroundRunKey {
                    parent_session_id: "thread-1".into(),
                    agent_id: "agent-1".into(),
                    run_id: "run-1".into(),
                },
                run_kind: WorkBackgroundKind::Subagent,
                parent_tool_call_id: Some("tool-call-1".into()),
            }),
            WorkNativeReference::Known(WorkKnownReference::Workflow {
                thread_id: "thread-1".into(),
                definition_id: Some("flow-1".into()),
                version: Some(2),
                run_id: "workflow-run-1".into(),
                revision: 3,
                resume_count: 1,
            }),
        ];
        work.validate_for_mutation(&scope).unwrap();
        let value = serde_json::to_value(&work).unwrap();
        let parsed: WorkRecord = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        if let WorkNativeReference::Known(WorkKnownReference::Background { run, .. }) =
            &mut work.native_refs[2]
        {
            run.parent_session_id = "different-thread".into();
        }
        assert!(work.validate_for_mutation(&scope).is_err());
    }

    #[test]
    fn future_or_unproven_references_round_trip_without_allowing_mutation() {
        let work = fixture();
        let mut value = serde_json::to_value(&work).unwrap();
        value["nativeRefs"] = json!([{"kind":"future_kind","futureIdentity":"x"}]);
        let parsed: WorkRecord = serde_json::from_value(value.clone()).unwrap();
        parsed.validate_shape().unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
        assert!(parsed.validate_for_mutation(&work.identity.scope).is_err());

        value["nativeRefs"] = json!([{"kind":"background","run":{"parentSessionId":"thread-1","agentId":"a","runId":"r"}}]);
        let unproven: WorkRecord = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&unproven).unwrap(), value);
        assert!(
            unproven
                .validate_for_mutation(&work.identity.scope)
                .is_err()
        );

        value["nativeRefs"] = json!([{"kind":"workflow","threadId":"thread-1","runId":"r","revision":0,"resumeCount":1}]);
        let incomplete: WorkRecord = serde_json::from_value(value).unwrap();
        incomplete.validate_shape().unwrap();
        assert!(
            incomplete
                .validate_for_mutation(&work.identity.scope)
                .is_err()
        );
        let mut oversized = serde_json::to_value(&work).unwrap();
        oversized["nativeRefs"] = json!([{"kind":"future","payload":"x".repeat(3000)}]);
        assert!(serde_json::from_value::<WorkRecord>(oversized).is_err());
    }

    #[test]
    fn original_plan_revision_must_be_known_before_mutation() {
        let mut work = fixture();
        let scope = work.identity.scope.clone();
        work.native_refs = vec![WorkNativeReference::Known(WorkKnownReference::Plan {
            plan_work_id: "plan-work-1".into(),
            revision: 0,
            plan_sha256: "a".repeat(64),
        })];
        let encoded = serde_json::to_value(&work).unwrap();
        let observed: WorkRecord = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(serde_json::to_value(&observed).unwrap(), encoded);
        assert!(observed.validate_shape().is_ok());
        assert!(observed.validate_for_mutation(&scope).is_err());

        if let WorkNativeReference::Known(WorkKnownReference::Plan { revision, .. }) =
            &mut work.native_refs[0]
        {
            *revision = 1;
        }
        assert!(work.validate_for_mutation(&scope).is_ok());
        work.native_refs = vec![WorkNativeReference::Known(WorkKnownReference::Goal {
            thread_id: "thread-1".into(),
            goal_id: "goal-1".into(),
            revision: 0,
        })];
        // Native Goal revision zero is a valid initial revision.
        assert!(work.validate_for_mutation(&scope).is_ok());
    }

    #[test]
    fn unknown_top_level_fields_round_trip_read_only_and_nested_fields_fail_closed() {
        let work = fixture();
        let mut future = serde_json::to_value(&work).unwrap();
        future["futurePolicy"] = json!({"mode": "new", "revision": 4});
        let observed: WorkRecord = serde_json::from_value(future.clone()).unwrap();
        assert_eq!(serde_json::to_value(&observed).unwrap(), future);
        assert!(observed.validate_shape().is_ok());
        assert!(
            observed
                .validate_for_mutation(&work.identity.scope)
                .is_err()
        );

        let mut nested = serde_json::to_value(&work).unwrap();
        nested["origin"]["initialAttempt"]["futureAuthority"] = json!(true);
        assert!(serde_json::from_value::<WorkRecord>(nested).is_err());
        let mut nested = serde_json::to_value(&work).unwrap();
        nested["revision"]["futureWatermark"] = json!(8);
        assert!(serde_json::from_value::<WorkRecord>(nested).is_err());
    }

    #[test]
    fn original_source_tuple_cannot_be_replaced_by_another_thread_or_turn() {
        let mut work = fixture();
        let original = work.origin.initial_attempt.clone();
        work.origin.kind = WorkOriginKind::NativeSource;
        work.origin.native_source = Some(NativeSourceOriginRef {
            target: IntegrationTaskCapabilityScopeControlTarget {
                initial_attempt: original.clone(),
                runtime_operation_id: Some("operation-1".into()),
            },
            instance_id: "instance-1".into(),
            accepted_operation_id: "accepted-1".into(),
        });
        assert!(work.validate_shape().is_ok());
        work.origin
            .native_source
            .as_mut()
            .unwrap()
            .target
            .initial_attempt
            .turn_id = "other".into();
        assert!(work.validate_shape().is_err());
        work.origin.kind = WorkOriginKind::Foreground;
        assert!(work.validate_shape().is_err());
    }

    #[test]
    fn completion_rejects_stale_owner_control_requirements_and_unapplied_input() {
        let work = fixture();
        let scope = work.identity.scope.clone();
        assert!(work.validate_completion(&scope, &[], &[]).is_ok());
        for changed in 0..4 {
            let mut stale = work.clone();
            match changed {
                0 => stale.revision.requirements_revision += 1,
                1 => stale.revision.control_epoch += 1,
                2 => stale.revision.owner_epoch += 1,
                _ => {
                    stale.revision.accepted_input_sequence += 1;
                    stale.revision.required_input_sequence += 1;
                }
            }
            assert!(stale.validate_completion(&scope, &[], &[]).is_err());
        }
        for phase in [
            WorkPhase::Paused,
            WorkPhase::Stopped,
            WorkPhase::NeedsReconciliation,
        ] {
            let mut controlled = work.clone();
            controlled.phase = phase;
            assert!(controlled.validate_completion(&scope, &[], &[]).is_err());
        }
        let mut no_result = work.clone();
        no_result.phase = WorkPhase::Completed;
        no_result.result = None;
        assert!(no_result.validate_completion(&scope, &[], &[]).is_err());
    }

    #[test]
    fn completion_rejects_unresolved_waits_in_readable_records() {
        for phase in [WorkPhase::Running, WorkPhase::Completed] {
            for kind in [WorkWaitKind::User, WorkWaitKind::Event] {
                let mut work = fixture();
                work.phase = phase.clone();
                work.waiting = Some(WorkWait {
                    kind,
                    reference: "original-wait".into(),
                });
                let scope = work.identity.scope.clone();
                let encoded = serde_json::to_string(&work).unwrap();
                let restored: WorkRecord = serde_json::from_str(&encoded).unwrap();
                assert!(restored.validate_shape().is_ok());
                assert!(restored.validate_completion(&scope, &[], &[]).is_err());
                work.waiting = None;
                assert!(work.validate_completion(&scope, &[], &[]).is_ok());
            }
        }
    }

    #[test]
    fn required_delivery_needs_original_receipt_at_requested_confirmation_level() {
        let mut work = fixture();
        work.result
            .as_mut()
            .unwrap()
            .required_delivery_ids
            .push("send-1".into());
        let scope = work.identity.scope.clone();
        let requirement = WorkDeliveryRequirement {
            delivery_id: "send-1".into(),
            minimum_confirmation: WorkConfirmationLevel::Delivered,
        };
        assert!(
            work.validate_completion(&scope, std::slice::from_ref(&requirement), &[])
                .is_err()
        );
        let mut delivery = WorkDelivery {
            delivery_id: "send-1".into(),
            required_for_completion: true,
            state: WorkDeliveryState::UnknownOutcome,
            minimum_confirmation: WorkConfirmationLevel::Delivered,
            observed_confirmation: Some(WorkConfirmationLevel::Accepted),
            receipt_ref: Some("receipt-1".into()),
        };
        assert!(
            work.validate_completion(
                &scope,
                std::slice::from_ref(&requirement),
                &[delivery.clone()]
            )
            .is_err()
        );
        delivery.state = WorkDeliveryState::Confirmed;
        assert!(
            work.validate_completion(
                &scope,
                std::slice::from_ref(&requirement),
                &[delivery.clone()]
            )
            .is_err()
        );
        delivery.observed_confirmation = Some(WorkConfirmationLevel::Delivered);
        assert!(
            work.validate_completion(
                &scope,
                std::slice::from_ref(&requirement),
                &[delivery.clone()]
            )
            .is_ok()
        );
        work.result.as_mut().unwrap().required_delivery_ids.clear();
        // Even a successful turn and an omitted result-side send cannot erase
        // the required destination captured when the request was accepted.
        assert!(
            work.validate_completion(&scope, std::slice::from_ref(&requirement), &[])
                .is_err()
        );
        assert!(
            work.validate_completion(
                &scope,
                std::slice::from_ref(&requirement),
                &[delivery.clone()]
            )
            .is_err()
        );
        work.result
            .as_mut()
            .unwrap()
            .required_delivery_ids
            .push("send-1".into());
        delivery.minimum_confirmation = WorkConfirmationLevel::Accepted;
        assert!(
            work.validate_completion(
                &scope,
                std::slice::from_ref(&requirement),
                &[delivery.clone()]
            )
            .is_err()
        );
        delivery.minimum_confirmation = WorkConfirmationLevel::Delivered;
        delivery.receipt_ref = None;
        assert!(
            work.validate_completion(&scope, &[requirement], &[delivery])
                .is_err()
        );
    }

    #[test]
    fn input_receipt_keeps_distinct_request_identity_and_queue_state() {
        let work = fixture();
        let receipt = WorkInputReceipt {
            work: work.identity,
            input_id: "input-1".into(),
            request_id: "request-1".into(),
            request_digest: "a".repeat(64),
            payload_ref: "payload-1".into(),
            sequence: 3,
            kind: WorkInputKind::Requirement,
            state: WorkInputState::Queued,
            requirements_revision: Some(3),
        };
        receipt.validate_shape().unwrap();
        receipt.validate_for_mutation(&receipt.work.scope).unwrap();
        let round_trip: WorkInputReceipt =
            serde_json::from_value(serde_json::to_value(&receipt).unwrap()).unwrap();
        assert_eq!(round_trip, receipt);
        assert_ne!(round_trip.state, WorkInputState::Applied);
        let mut invalid = receipt;
        invalid.request_digest = "abc".into();
        assert!(invalid.validate_shape().is_err());
        invalid.request_digest = "a".repeat(64);
        invalid.kind = WorkInputKind::StatusQuery;
        assert!(invalid.validate_for_mutation(&invalid.work.scope).is_err());
    }

    #[test]
    fn only_requirement_inputs_may_advance_the_requirements_revision() {
        let work = fixture();
        let mut receipt = WorkInputReceipt {
            work: work.identity,
            input_id: "input-1".into(),
            request_id: "request-1".into(),
            request_digest: "a".repeat(64),
            payload_ref: "payload-1".into(),
            sequence: 3,
            kind: WorkInputKind::Requirement,
            state: WorkInputState::Queued,
            requirements_revision: Some(3),
        };
        let scope = receipt.work.scope.clone();
        for (kind, revision, allowed) in [
            (WorkInputKind::Requirement, Some(3), true),
            (WorkInputKind::Requirement, None, false),
            (WorkInputKind::Answer, None, true),
            (WorkInputKind::Answer, Some(3), false),
            (WorkInputKind::StatusQuery, None, true),
            (WorkInputKind::StatusQuery, Some(3), false),
            (WorkInputKind::Unknown("future".into()), None, false),
        ] {
            receipt.kind = kind;
            receipt.requirements_revision = revision;
            // Legacy or future facts remain observable even when they cannot
            // be used by a writer that understands only this contract.
            let encoded = serde_json::to_value(&receipt).unwrap();
            let observed: WorkInputReceipt = serde_json::from_value(encoded.clone()).unwrap();
            assert_eq!(serde_json::to_value(&observed).unwrap(), encoded);
            assert!(observed.validate_shape().is_ok());
            assert_eq!(
                observed.validate_for_mutation(&scope).is_ok(),
                allowed,
                "kind={:?}, revision={revision:?}",
                observed.kind
            );
        }
    }
}
