//! Precise original targets for idempotent control requests and receipts.
#[cfg(feature = "json-schema")]
use super::MAX_ATOM_BYTES;
use super::{WorkControlAction, atom};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub(super) const MAX_OPAQUE_TARGET_WEIGHT: usize = 16 * 1024;
const MAX_OPAQUE_TARGET_DEPTH: usize = 64;

// A conservative upper bound for UTF-8 JSON encoding: strings are charged six
// bytes per UTF-8 byte for escaping, numbers 32 bytes, and container punctuation
// separately. The JavaScript contract validator uses the identical algorithm.
pub(super) fn opaque_weight(value: &serde_json::Value, depth: usize) -> Option<usize> {
    if depth > MAX_OPAQUE_TARGET_DEPTH {
        return None;
    }
    fn text_weight(value: &str) -> Option<usize> {
        value.len().checked_mul(6)?.checked_add(2)
    }
    match value {
        serde_json::Value::Null => Some(4),
        serde_json::Value::Bool(_) => Some(5),
        serde_json::Value::Number(number) => {
            let value = number.as_f64()?;
            if !value.is_finite() || (value.fract() == 0.0 && value.abs() > 9_007_199_254_740_991.0)
            {
                None
            } else {
                Some(32)
            }
        }
        serde_json::Value::String(value) => text_weight(value),
        serde_json::Value::Array(values) => values.iter().try_fold(2usize, |sum, value| {
            sum.checked_add(1)?
                .checked_add(opaque_weight(value, depth + 1)?)
        }),
        serde_json::Value::Object(values) => values.iter().try_fold(2usize, |sum, (key, value)| {
            sum.checked_add(2)?
                .checked_add(text_weight(key)?)?
                .checked_add(opaque_weight(value, depth + 1)?)
        }),
    }
}
fn bounded_opaque_target(value: &serde_json::Value) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("kind"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(atom)
        && opaque_weight(value, 0).is_some_and(|weight| weight <= MAX_OPAQUE_TARGET_WEIGHT)
}

/// Target identities do not grant access. The host must resolve them under the
/// actual work owner and check the original run or operation before acting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkControlTarget {
    Work {},
    Turn {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
    },
    Agent {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
    Workflow {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId")]
        run_id: String,
        revision: u64,
        #[serde(rename = "resumeCount")]
        resume_count: u32,
    },
    Operation {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
}

impl WorkControlTarget {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        let valid = match self {
            Self::Work {} => true,
            Self::Turn {
                thread_id,
                turn_id,
                attempt_id,
            } => [thread_id, turn_id, attempt_id]
                .into_iter()
                .all(|id| atom(id)),
            Self::Agent {
                thread_id,
                turn_id,
                attempt_id,
                agent_id,
                run_id,
            } => [thread_id, turn_id, attempt_id, agent_id, run_id]
                .into_iter()
                .all(|id| atom(id)),
            Self::Workflow {
                thread_id,
                run_id,
                revision,
                ..
            } => atom(thread_id) && atom(run_id) && *revision > 0,
            Self::Operation { operation_id } => atom(operation_id),
        };
        if valid {
            Ok(())
        } else {
            Err("invalid original control target")
        }
    }

    /// Shape compatibility alone does not prove that the target exists or is
    /// owned by this work; those checks remain the host's responsibility.
    pub fn matches_action(&self, action: &WorkControlAction) -> bool {
        match action {
            WorkControlAction::Pause | WorkControlAction::Resume | WorkControlAction::Stop => {
                matches!(self, Self::Work {})
            }
            WorkControlAction::CancelRun => matches!(
                self,
                Self::Turn { .. } | Self::Agent { .. } | Self::Workflow { .. }
            ),
            WorkControlAction::Retry => matches!(
                self,
                Self::Turn { .. }
                    | Self::Agent { .. }
                    | Self::Workflow { .. }
                    | Self::Operation { .. }
            ),
            WorkControlAction::Reconcile => matches!(self, Self::Operation { .. }),
            WorkControlAction::Unknown(_) => false,
        }
    }
}

/// A persisted/observed target preserves future wire fields and kinds. Only a
/// fully known target may be passed to a native control operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkControlTargetFact {
    Known(WorkControlTarget),
    Unknown(serde_json::Value),
}
impl WorkControlTargetFact {
    pub fn known(&self) -> Option<&WorkControlTarget> {
        match self {
            Self::Known(target) => Some(target),
            Self::Unknown(_) => None,
        }
    }
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        match self {
            Self::Known(target) => target.validate_shape(),
            Self::Unknown(value) if bounded_opaque_target(value) => Ok(()),
            Self::Unknown(_) => Err("invalid unknown control target"),
        }
    }
    pub fn matches_action(&self, action: &WorkControlAction) -> bool {
        self.known()
            .is_some_and(|target| target.validate_shape().is_ok() && target.matches_action(action))
    }
}
impl From<WorkControlTarget> for WorkControlTargetFact {
    fn from(target: WorkControlTarget) -> Self {
        Self::Known(target)
    }
}
impl Serialize for WorkControlTargetFact {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Known(target) => target.serialize(serializer),
            Self::Unknown(raw) => raw.serialize(serializer),
        }
    }
}
impl<'de> Deserialize<'de> for WorkControlTargetFact {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        if !bounded_opaque_target(&value) {
            return Err(serde::de::Error::custom(
                "control target requires a bounded kind",
            ));
        }
        Ok(
            match serde_json::from_value::<WorkControlTarget>(value.clone()) {
                Ok(target) => Self::Known(target),
                Err(_) => Self::Unknown(value),
            },
        )
    }
}
#[cfg(feature = "json-schema")]
impl schemars::JsonSchema for WorkControlTargetFact {
    fn schema_name() -> String {
        "WorkControlTargetFact".into()
    }
    fn json_schema(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        serde_json::from_value(serde_json::json!({
            "type": "object",
            "properties": { "kind": {
                "type": "string", "x-max-utf8-bytes": MAX_ATOM_BYTES,
                "pattern": r"^[^\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000](?:[^\u0000-\u001f\u007f-\u009f]*[^\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000])?(?![\s\S])"
            } },
            "required": ["kind"],
            "additionalProperties": true,
            "x-max-opaque-json-weight": MAX_OPAQUE_TARGET_WEIGHT
        }))
        .expect("static control-target observation schema is valid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn original_target_is_complete_and_cannot_carry_client_authority() {
        let target = WorkControlTarget::Agent {
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            attempt_id: "attempt-1".into(),
            agent_id: "agent-1".into(),
            run_id: "run-1".into(),
        };
        assert!(target.validate_shape().is_ok());
        assert!(target.matches_action(&WorkControlAction::CancelRun));
        assert!(!target.matches_action(&WorkControlAction::Stop));
        let mut serialized = serde_json::to_value(target.clone()).unwrap();
        assert_eq!(
            serde_json::from_value::<WorkControlTarget>(serialized.clone()).unwrap(),
            target
        );
        serialized["attemptId"] = json!("another-attempt");
        assert_ne!(
            serde_json::from_value::<WorkControlTarget>(serialized).unwrap(),
            target
        );
        assert!(
            serde_json::from_value::<WorkControlTarget>(json!({"kind":"work","approved":true}))
                .is_err()
        );
        assert!(serde_json::from_value::<WorkControlTarget>(json!({"kind":"future"})).is_err());
        let mut workflow: WorkControlTarget = serde_json::from_value(json!({"kind":"workflow",
            "threadId":"thread-1","runId":"run-1","revision":0,"resumeCount":0}))
        .unwrap();
        assert!(workflow.validate_shape().is_err());
        if let WorkControlTarget::Workflow { revision, .. } = &mut workflow {
            *revision = 1;
        }
        assert!(workflow.validate_shape().is_ok());
    }

    #[test]
    fn future_targets_and_extra_fields_remain_readable_but_cannot_control() {
        for raw in [
            json!({"kind":"future_operation","version":2}),
            json!({"kind":"work","newPolicy":true}),
        ] {
            let fact: WorkControlTargetFact = serde_json::from_value(raw.clone()).unwrap();
            assert!(fact.known().is_none());
            assert!(!fact.matches_action(&WorkControlAction::Pause));
            assert_eq!(serde_json::to_value(fact).unwrap(), raw);
        }
        let known: WorkControlTargetFact = serde_json::from_value(json!({"kind":"work"})).unwrap();
        assert!(known.matches_action(&WorkControlAction::Pause));
        assert!(!known.matches_action(&WorkControlAction::CancelRun));
        assert!(serde_json::from_value::<WorkControlTargetFact>(json!({"noKind":true})).is_err());
        assert!(serde_json::from_value::<WorkControlTargetFact>(json!({"kind":" bad"})).is_err());
        assert!(
            serde_json::from_value::<WorkControlTargetFact>(json!({"kind":"\u{85}future"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<WorkControlTargetFact>(json!({"kind":"\u{feff}future"}))
                .is_ok()
        );
        assert!(
            serde_json::from_value::<WorkControlTargetFact>(
                json!({"kind":"future","text":"x".repeat(3000)})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<WorkControlTargetFact>(
                json!({"kind":"未来动作","text":"汉".repeat(800)})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<WorkControlTargetFact>(
                json!({"kind":"future","number":9_007_199_254_740_992_u64})
            )
            .is_err()
        );
        let mut nested = json!({});
        for _ in 0..66 {
            nested = json!({"next":nested});
        }
        assert!(
            serde_json::from_value::<WorkControlTargetFact>(
                json!({"kind":"future","nested":nested})
            )
            .is_err()
        );
    }
}
