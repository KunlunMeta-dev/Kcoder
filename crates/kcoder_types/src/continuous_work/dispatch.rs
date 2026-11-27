//! Original dispatch identities and durable facts, never dispatch authority.
//!
//! Prepared/armed facts are not proof that an external action started. The
//! host owns the original execution gate, source authorization and receipt
//! verification. A repeated operation identity must be reconciled, not resent.
use super::{MAX_ATOM_BYTES, WorkIdentity, WorkScope, atom, deserialize_attempt, digest};
use crate::TurnAttemptIdentity;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

/// Request targets are strict. Tool identifiers are scoped by the exact native
/// parent attempt; they must not be inferred from displayed history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkDispatchTarget {
    Turn {
        #[serde(deserialize_with = "deserialize_attempt")]
        attempt: TurnAttemptIdentity,
    },
    Tool {
        #[serde(deserialize_with = "deserialize_attempt")]
        attempt: TurnAttemptIdentity,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
    },
}
impl WorkDispatchTarget {
    pub fn attempt(&self) -> &TurnAttemptIdentity {
        match self {
            Self::Turn { attempt } | Self::Tool { attempt, .. } => attempt,
        }
    }
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        self.attempt().validate()?;
        if let Self::Tool { tool_call_id, .. } = self
            && !atom(tool_call_id)
        {
            return Err("invalid original tool call identity");
        }
        Ok(())
    }
}

/// A future target is retained verbatim for observation and reconciliation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkDispatchTargetFact {
    Known(WorkDispatchTarget),
    Unknown(serde_json::Value),
}
impl WorkDispatchTargetFact {
    pub fn known(&self) -> Option<&WorkDispatchTarget> {
        match self {
            Self::Known(target) => Some(target),
            Self::Unknown(_) => None,
        }
    }
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        match self {
            Self::Known(target) => target.validate_shape(),
            Self::Unknown(value) => {
                let kind = value
                    .as_object()
                    .and_then(|object| object.get("kind"))
                    .and_then(serde_json::Value::as_str);
                if kind.is_some_and(atom)
                    && super::control::opaque_weight(value, 0)
                        .is_some_and(|weight| weight <= super::control::MAX_OPAQUE_TARGET_WEIGHT)
                {
                    Ok(())
                } else {
                    Err("invalid future dispatch target")
                }
            }
        }
    }
}
impl Serialize for WorkDispatchTargetFact {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Known(target) => target.serialize(serializer),
            Self::Unknown(raw) => raw.serialize(serializer),
        }
    }
}
impl<'de> Deserialize<'de> for WorkDispatchTargetFact {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = serde_json::Value::deserialize(deserializer)?;
        let fact = match serde_json::from_value::<WorkDispatchTarget>(raw.clone()) {
            Ok(target) => Self::Known(target),
            Err(_) => Self::Unknown(raw),
        };
        fact.validate_shape().map_err(serde::de::Error::custom)?;
        Ok(fact)
    }
}
#[cfg(feature = "json-schema")]
impl schemars::JsonSchema for WorkDispatchTargetFact {
    fn schema_name() -> String {
        "WorkDispatchTargetFact".into()
    }
    fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        <super::WorkControlTargetFact as schemars::JsonSchema>::json_schema(generator)
    }
}

/// The original pipeline stage is part of the idempotency identity. The target
/// owner enforces scope + target + kind + slot + attempt uniqueness across work
/// records; changing operation ID cannot create another native action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkDispatchKind {
    TurnStart,
    PreToolHook,
    ToolPermission,
    ToolStart,
    SandboxEscalation,
    ToolRetry,
}
impl WorkDispatchKind {
    fn matches_target(self, target: &WorkDispatchTarget) -> bool {
        matches!(
            (self, target),
            (Self::TurnStart, WorkDispatchTarget::Turn { .. })
                | (
                    Self::PreToolHook
                        | Self::ToolPermission
                        | Self::ToolStart
                        | Self::SandboxEscalation
                        | Self::ToolRetry,
                    WorkDispatchTarget::Tool { .. }
                )
        )
    }
}
open_label!(WorkDispatchKindFact {
    TurnStart => "turn_start", PreToolHook => "pre_tool_hook", ToolPermission => "tool_permission",
    ToolStart => "tool_start", SandboxEscalation => "sandbox_escalation", ToolRetry => "tool_retry",
});
impl From<WorkDispatchKind> for WorkDispatchKindFact {
    fn from(value: WorkDispatchKind) -> Self {
        match value {
            WorkDispatchKind::TurnStart => Self::TurnStart,
            WorkDispatchKind::PreToolHook => Self::PreToolHook,
            WorkDispatchKind::ToolPermission => Self::ToolPermission,
            WorkDispatchKind::ToolStart => Self::ToolStart,
            WorkDispatchKind::SandboxEscalation => Self::SandboxEscalation,
            WorkDispatchKind::ToolRetry => Self::ToolRetry,
        }
    }
}
impl WorkDispatchKindFact {
    pub fn known(&self) -> Option<WorkDispatchKind> {
        match self {
            Self::TurnStart => Some(WorkDispatchKind::TurnStart),
            Self::PreToolHook => Some(WorkDispatchKind::PreToolHook),
            Self::ToolPermission => Some(WorkDispatchKind::ToolPermission),
            Self::ToolStart => Some(WorkDispatchKind::ToolStart),
            Self::SandboxEscalation => Some(WorkDispatchKind::SandboxEscalation),
            Self::ToolRetry => Some(WorkDispatchKind::ToolRetry),
            Self::Unknown(_) => None,
        }
    }
}

/// Watermarks are captured from the target's durable work and claim, not from
/// a client's view. Applied input must cover every accepted required input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkDispatchFence {
    pub thread_id: String,
    pub claim_id: String,
    pub claim_revision: u64,
    pub work_revision: u64,
    pub requirements_revision: u64,
    pub owner_epoch: u64,
    pub control_epoch: u64,
    pub accepted_input_sequence: u64,
    pub required_input_sequence: u64,
    pub applied_input_sequence: u64,
}
impl WorkDispatchFence {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        if !atom(&self.thread_id)
            || !atom(&self.claim_id)
            || self.claim_revision == 0
            || self.work_revision < self.claim_revision
            || self.requirements_revision == 0
            || self.owner_epoch == 0
            || self.required_input_sequence > self.accepted_input_sequence
            || self.applied_input_sequence > self.accepted_input_sequence
        {
            return Err("invalid dispatch fence");
        }
        Ok(())
    }
    pub fn inputs_are_applied(&self) -> bool {
        self.applied_input_sequence >= self.required_input_sequence
    }
}

/// A candidate request to register one target-owned operation. `request_sha256`
/// fingerprints the original call arguments and never replaces those facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkDispatchRequest {
    pub work: WorkIdentity,
    pub operation_id: String,
    pub request_sha256: String,
    pub operation_kind: WorkDispatchKind,
    /// Original hook/approval/execution step identity derived by the host.
    pub operation_slot: String,
    pub operation_attempt: u32,
    pub target: WorkDispatchTarget,
    pub fence: WorkDispatchFence,
}
impl WorkDispatchRequest {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        self.work.validate_shape()?;
        self.target.validate_shape()?;
        self.fence.validate_shape()?;
        if !atom(&self.operation_id)
            || !atom(&self.operation_slot)
            || !digest(&self.request_sha256)
            || self.operation_attempt == 0
            || !self.operation_kind.matches_target(&self.target)
            || self.target.attempt().thread_id != self.fence.thread_id
        {
            return Err("invalid original dispatch identity");
        }
        Ok(())
    }
    pub fn validate_for_prepare(&self, actual_scope: &WorkScope) -> Result<(), &'static str> {
        self.validate_shape()?;
        actual_scope.validate_shape()?;
        if !self.work.matches_scope(actual_scope) || !self.fence.inputs_are_applied() {
            return Err("dispatch scope or required-input watermark mismatch");
        }
        Ok(())
    }
}

// Unknown future labels remain readable but cannot grant permission to act.
open_label!(WorkDispatchState {
    Prepared => "prepared", Armed => "armed", NotSent => "not_sent",
    OutcomeUnknown => "outcome_unknown", Succeeded => "succeeded", Failed => "failed",
});

/// One host-verified observation of the same original operation. The host
/// resolves the referenced native receipt; this shape alone is not proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkDispatchObservation {
    pub observation_id: String,
    pub state: WorkDispatchState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_receipt_ref: Option<String>,
}
impl WorkDispatchObservation {
    pub fn validate_for_recording(&self) -> Result<(), &'static str> {
        if !atom(&self.observation_id)
            || self
                .native_receipt_ref
                .as_deref()
                .is_some_and(|value| !atom(value))
        {
            return Err("invalid original dispatch observation");
        }
        match &self.state {
            WorkDispatchState::OutcomeUnknown => Ok(()),
            WorkDispatchState::NotSent
            | WorkDispatchState::Succeeded
            | WorkDispatchState::Failed
                if self.native_receipt_ref.is_some() =>
            {
                Ok(())
            }
            _ => Err("dispatch observation lacks a verified terminal receipt"),
        }
    }
}
/// A durable operation fact. A native receipt reference is lookup data only;
/// the host must verify its target, outcome and owner before recording it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WorkDispatchReceipt {
    pub schema_version: u32,
    pub work: WorkIdentity,
    pub operation_id: String,
    pub request_sha256: String,
    pub operation_kind: WorkDispatchKindFact,
    pub operation_slot: String,
    pub operation_attempt: u32,
    pub target: WorkDispatchTargetFact,
    pub fence: WorkDispatchFence,
    pub state: WorkDispatchState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_receipt_ref: Option<String>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}
impl WorkDispatchReceipt {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        self.work.validate_shape()?;
        self.target.validate_shape()?;
        self.fence.validate_shape()?;
        if !atom(&self.operation_id)
            || !atom(&self.operation_slot)
            || !digest(&self.request_sha256)
            || self.operation_attempt == 0
            || self.native_receipt_ref.as_deref().is_some_and(|v| !atom(v))
            || self.extensions.len() > 64
        {
            return Err("invalid dispatch receipt");
        }
        match &self.state {
            WorkDispatchState::Prepared | WorkDispatchState::Armed
                if self.native_receipt_ref.is_some() =>
            {
                return Err("unobserved dispatch cannot carry a terminal receipt");
            }
            WorkDispatchState::NotSent
            | WorkDispatchState::Succeeded
            | WorkDispatchState::Failed
                if self.native_receipt_ref.is_none() =>
            {
                return Err("terminal dispatch requires an original receipt");
            }
            _ => {}
        }
        if let Some(target) = self.target.known()
            && (target.attempt().thread_id != self.fence.thread_id
                || self
                    .operation_kind
                    .known()
                    .is_some_and(|kind| !kind.matches_target(target)))
        {
            return Err("dispatch target thread or stage mismatch");
        }
        Ok(())
    }
    pub fn validate_for_mutation(&self, actual_scope: &WorkScope) -> Result<(), &'static str> {
        self.validate_shape()?;
        actual_scope.validate_shape()?;
        if self.schema_version != 1
            || !self.work.matches_scope(actual_scope)
            || !self.state.is_known()
            || !self.operation_kind.is_known()
            || self.target.known().is_none()
            || !self.extensions.is_empty()
        {
            return Err("unknown dispatch fact cannot authorize mutation");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> WorkDispatchRequest {
        WorkDispatchRequest {
            work: WorkIdentity {
                scope: WorkScope {
                    account_id: "profile".into(),
                    target_id: "target".into(),
                    workspace_id: "workspace".into(),
                },
                work_id: "work-1".into(),
            },
            operation_id: "operation-1".into(),
            request_sha256: "a".repeat(64),
            operation_kind: WorkDispatchKind::ToolStart,
            operation_slot: "tool-step-1".into(),
            operation_attempt: 1,
            target: WorkDispatchTarget::Tool {
                attempt: TurnAttemptIdentity {
                    thread_id: "thread-1".into(),
                    turn_id: "turn-1".into(),
                    attempt_id: "attempt-1".into(),
                },
                tool_call_id: "tool-1".into(),
            },
            fence: WorkDispatchFence {
                thread_id: "thread-1".into(),
                claim_id: "claim-1".into(),
                claim_revision: 2,
                work_revision: 3,
                requirements_revision: 2,
                owner_epoch: 1,
                control_epoch: 1,
                accepted_input_sequence: 2,
                required_input_sequence: 2,
                applied_input_sequence: 2,
            },
        }
    }

    #[test]
    fn prepare_requires_original_scope_claim_and_applied_watermark() {
        let request = request();
        let scope = request.work.scope.clone();
        request.validate_for_prepare(&scope).unwrap();
        let mut other = scope.clone();
        other.target_id = "other".into();
        assert!(request.validate_for_prepare(&other).is_err());
        let mut stale = request.clone();
        stale.fence.applied_input_sequence = 1;
        assert!(stale.validate_for_prepare(&scope).is_err());
        stale = request.clone();
        stale.fence.claim_revision = 4;
        assert!(stale.validate_for_prepare(&scope).is_err());
        stale = request.clone();
        stale.fence.thread_id = "other-thread".into();
        assert!(stale.validate_for_prepare(&scope).is_err());
        stale = request.clone();
        stale.request_sha256 = "not-a-digest".into();
        assert!(stale.validate_for_prepare(&scope).is_err());
        stale = request.clone();
        stale.operation_attempt = 0;
        assert!(stale.validate_for_prepare(&scope).is_err());
        stale = request.clone();
        stale.operation_slot.clear();
        assert!(stale.validate_for_prepare(&scope).is_err());
        stale = request.clone();
        stale.operation_kind = WorkDispatchKind::TurnStart;
        assert!(stale.validate_for_prepare(&scope).is_err());
    }

    #[test]
    fn unknown_dispatch_is_observable_but_not_authority_or_retry_permission() {
        let request = request();
        let mut receipt = WorkDispatchReceipt {
            schema_version: 1,
            work: request.work.clone(),
            operation_id: request.operation_id,
            request_sha256: request.request_sha256,
            operation_kind: request.operation_kind.into(),
            operation_slot: request.operation_slot,
            operation_attempt: request.operation_attempt,
            target: WorkDispatchTargetFact::Known(request.target),
            fence: request.fence,
            state: WorkDispatchState::Armed,
            native_receipt_ref: None,
            extensions: BTreeMap::new(),
        };
        receipt.validate_for_mutation(&receipt.work.scope).unwrap();
        receipt.state = WorkDispatchState::OutcomeUnknown;
        receipt.validate_shape().unwrap();
        let mut raw = serde_json::to_value(&receipt).unwrap();
        raw["target"] = json!({"kind":"future_target", "revision":3});
        raw["state"] = json!("future_state");
        raw["operationKind"] = json!("future_stage");
        let observed: WorkDispatchReceipt = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(serde_json::to_value(&observed).unwrap(), raw);
        assert!(observed.validate_for_mutation(&receipt.work.scope).is_err());
        raw["target"] = json!({"kind":"future_target", "body":"x".repeat(3000)});
        assert!(serde_json::from_value::<WorkDispatchReceipt>(raw).is_err());
    }

    #[test]
    fn terminal_observations_need_original_receipts_and_armed_is_not_an_outcome() {
        let mut observation = WorkDispatchObservation {
            observation_id: "observation-1".into(),
            state: WorkDispatchState::OutcomeUnknown,
            native_receipt_ref: None,
        };
        observation.validate_for_recording().unwrap();
        for state in [
            WorkDispatchState::Prepared,
            WorkDispatchState::Armed,
            WorkDispatchState::NotSent,
            WorkDispatchState::Succeeded,
            WorkDispatchState::Failed,
        ] {
            observation.state = state;
            assert!(observation.validate_for_recording().is_err());
        }
        observation.native_receipt_ref = Some("original-receipt".into());
        for state in [
            WorkDispatchState::NotSent,
            WorkDispatchState::Succeeded,
            WorkDispatchState::Failed,
        ] {
            observation.state = state;
            observation.validate_for_recording().unwrap();
        }
    }
}
