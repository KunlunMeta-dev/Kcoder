//! Original native identities are references, never newly minted authority.
use super::control::{MAX_OPAQUE_TARGET_WEIGHT, opaque_weight};
use super::{MAX_ATOM_BYTES, WorkIdentity, WorkScope, atom, deserialize_attempt, digest};
use crate::{BackgroundRunKey, TurnAttemptIdentity};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeSet;

open_label!(WorkBackgroundKind {
    Generic => "generic", Subagent => "subagent", Workflow => "workflow",
});

open_label!(WorkItemKind { Local => "local", Cloud => "cloud" });

/// An exact locator in the original client or cloud work-item store. It is not
/// a native run, completion fact, or proof of permission to access that store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemReference {
    pub kind: WorkItemKind,
    /// Opaque identity of the original client store or cloud service instance.
    pub source_instance_id: String,
    pub project_id: String,
    pub item_id: String,
    /// Missing means no original version was observed, not version zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_version: Option<u64>,
}

impl WorkItemReference {
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        if !atom(self.kind.as_str())
            || !atom(&self.source_instance_id)
            || !atom(&self.project_id)
            || !atom(&self.item_id)
        {
            return Err("invalid work item reference");
        }
        Ok(())
    }
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn task_capability_scope_reference_keeps_the_legacy_kind_tag() {
        let reference = WorkKnownReference::TaskCapabilityScope {
            initial_attempt: TurnAttemptIdentity {
                thread_id: "thread-1".into(),
                turn_id: "turn-1".into(),
                attempt_id: "attempt-1".into(),
            },
            accepted_task_key: "a".repeat(64),
        };
        let value = serde_json::to_value(&reference).unwrap();
        assert_eq!(value["kind"], "task_source");
        assert_eq!(
            serde_json::from_value::<WorkKnownReference>(json!({
                "kind": "task_source",
                "initialAttempt": {"threadId":"thread-1","turnId":"turn-1","attemptId":"attempt-1"},
                "acceptedTaskKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }))
            .unwrap(),
            reference
        );
    }
}

/// A proposed association. The host must verify the original work item and
/// an authorized user action or original admission before using this link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemLink {
    pub work: WorkIdentity,
    pub item: WorkItemReference,
    pub link_revision: u64,
}

impl WorkItemLink {
    /// Validate representation against the actual host scope; this does not
    /// authenticate the caller or authorize access to the original work item.
    pub fn validate_for_mutation(&self, actual_scope: &WorkScope) -> Result<(), &'static str> {
        self.work.validate_shape()?;
        actual_scope.validate_shape()?;
        self.item.validate_shape()?;
        if !self.work.matches_scope(actual_scope)
            || self.link_revision == 0
            || !self.item.kind.is_known()
        {
            return Err("work item link is not valid for mutation");
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrictBackgroundRun {
    parent_session_id: String,
    agent_id: String,
    run_id: String,
}
fn deserialize_background<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BackgroundRunKey, D::Error> {
    let run = StrictBackgroundRun::deserialize(deserializer)?;
    Ok(BackgroundRunKey {
        parent_session_id: run.parent_session_id,
        agent_id: run.agent_id,
        run_id: run.run_id,
    })
}

/// These are exact original locators. The target host must independently read
/// the original object and verify scope, ownership, revision and authorization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkKnownReference {
    Goal {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "goalId")]
        goal_id: String,
        revision: u64,
    },
    /// Original host-accepted task tool and resource scope; this locator grants no access.
    #[serde(rename = "task_source")]
    TaskCapabilityScope {
        #[serde(rename = "initialAttempt", deserialize_with = "deserialize_attempt")]
        initial_attempt: TurnAttemptIdentity,
        #[serde(rename = "acceptedTaskKey")]
        accepted_task_key: String,
    },
    /// This is the separate PlanStore namespace, not the business work ID.
    Plan {
        #[serde(rename = "planWorkId")]
        plan_work_id: String,
        revision: u64,
        #[serde(rename = "planSha256")]
        plan_sha256: String,
    },
    Background {
        #[serde(rename = "parentAttempt", deserialize_with = "deserialize_attempt")]
        parent_attempt: TurnAttemptIdentity,
        #[serde(deserialize_with = "deserialize_background")]
        run: BackgroundRunKey,
        #[serde(rename = "runKind")]
        run_kind: WorkBackgroundKind,
        /// None is unproven, never filled from a mutable current task.
        #[serde(
            rename = "parentToolCallId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        parent_tool_call_id: Option<String>,
    },
    Workflow {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(
            rename = "definitionId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        definition_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<u64>,
        #[serde(rename = "runId")]
        run_id: String,
        revision: u64,
        #[serde(rename = "resumeCount")]
        resume_count: u32,
    },
}

/// Future or incomplete native reference kinds remain losslessly readable, but
/// cannot be used to mutate the work record or authorize a native operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum WorkNativeReference {
    Known(WorkKnownReference),
    Unknown(serde_json::Value),
}

fn bounded_unknown_reference(value: &serde_json::Value) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("kind"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(atom)
        && opaque_weight(value, 0).is_some_and(|weight| weight <= MAX_OPAQUE_TARGET_WEIGHT)
}
impl<'de> Deserialize<'de> for WorkNativeReference {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        if let Ok(reference) = serde_json::from_value::<WorkKnownReference>(value.clone()) {
            return Ok(Self::Known(reference));
        }
        if !bounded_unknown_reference(&value) {
            return Err(serde::de::Error::custom("invalid unknown native reference"));
        }
        Ok(Self::Unknown(value))
    }
}

impl WorkNativeReference {
    pub(super) fn validate_shape(&self, threads: &BTreeSet<&String>) -> Result<(), &'static str> {
        let bound = |id: &String| atom(id) && threads.contains(id);
        match self {
            Self::Known(WorkKnownReference::Goal {
                thread_id, goal_id, ..
            }) => {
                if bound(thread_id) && atom(goal_id) {
                    Ok(())
                } else {
                    Err("invalid goal reference")
                }
            }
            Self::Known(WorkKnownReference::TaskCapabilityScope {
                initial_attempt,
                accepted_task_key,
            }) => {
                initial_attempt.validate()?;
                if bound(&initial_attempt.thread_id) && digest(accepted_task_key) {
                    Ok(())
                } else {
                    Err("invalid original task source reference")
                }
            }
            Self::Known(WorkKnownReference::Plan {
                plan_work_id,
                plan_sha256,
                ..
            }) => {
                if !plan_work_id.is_empty()
                    && plan_work_id.len() <= 128
                    && plan_work_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    && digest(plan_sha256)
                {
                    Ok(())
                } else {
                    Err("invalid original plan reference")
                }
            }
            Self::Known(WorkKnownReference::Background {
                parent_attempt,
                run,
                parent_tool_call_id,
                ..
            }) => {
                parent_attempt.validate()?;
                if !bound(&parent_attempt.thread_id)
                    || run.parent_session_id != parent_attempt.thread_id
                    || !atom(&run.agent_id)
                    || !atom(&run.run_id)
                    || parent_tool_call_id.as_ref().is_some_and(|id| !atom(id))
                {
                    return Err("invalid background parent or original run reference");
                }
                Ok(())
            }
            Self::Known(WorkKnownReference::Workflow {
                thread_id,
                definition_id,
                run_id,
                ..
            }) => {
                if bound(thread_id)
                    && atom(run_id)
                    && definition_id.as_ref().is_none_or(|id| atom(id))
                {
                    Ok(())
                } else {
                    Err("invalid original workflow reference")
                }
            }
            Self::Unknown(value) => {
                if !bounded_unknown_reference(value) {
                    return Err("invalid unknown native reference");
                }
                Ok(())
            }
        }
    }

    pub(super) fn permits_mutation(&self) -> bool {
        match self {
            Self::Unknown(_) => false,
            Self::Known(WorkKnownReference::Background {
                run_kind,
                parent_tool_call_id,
                ..
            }) => run_kind.is_known() && parent_tool_call_id.is_some(),
            Self::Known(WorkKnownReference::Workflow {
                definition_id,
                version,
                revision,
                ..
            }) => {
                definition_id.is_some()
                    && version.is_some_and(|version| version > 0)
                    && *revision > 0
            }
            Self::Known(WorkKnownReference::Plan { revision, .. }) => *revision > 0,
            Self::Known(_) => true,
        }
    }
}
