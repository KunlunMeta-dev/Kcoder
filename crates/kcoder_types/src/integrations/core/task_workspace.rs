//! Read-only projections of original native identities, never execution authority.
use super::*;
use crate::BackgroundRunKey;
use serde::{Deserialize, Serialize};

pub const TASK_WORKSPACE_PAGE_SIZE: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TaskWorkspaceNativeRef {
    Thread {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    Goal {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "goalId")]
        goal_id: String,
        revision: u64,
    },
    Agent {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "backgroundRun")]
        background_run: Option<BackgroundRunKey>,
    },
    WorkflowRun {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId")]
        run_id: String,
        revision: u64,
        #[serde(rename = "definitionRef")]
        definition_ref: Option<IntegrationRevisionRef>,
    },
}
impl TaskWorkspaceNativeRef {
    pub fn thread_id(&self) -> &str {
        match self {
            Self::Thread { thread_id }
            | Self::Goal { thread_id, .. }
            | Self::Agent { thread_id, .. }
            | Self::WorkflowRun { thread_id, .. } => thread_id,
        }
    }
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        id(self.thread_id(), "reference.threadId")?;
        match self {
            Self::Goal { goal_id, .. } => id(goal_id, "reference.goalId")?,
            Self::Agent {
                thread_id,
                agent_id,
                background_run,
            } => {
                id(agent_id, "reference.agentId")?;
                if let Some(run) = background_run {
                    id(&run.run_id, "reference.backgroundRun.runId")?;
                    if run.agent_id != *agent_id || run.parent_session_id != *thread_id {
                        return Err(invalid(
                            "reference.backgroundRun",
                            "original agent run identity mismatch",
                        ));
                    }
                }
            }
            Self::WorkflowRun {
                run_id,
                definition_ref,
                ..
            } => {
                id(run_id, "reference.runId")?;
                if let Some(reference) = definition_ref {
                    reference.validate()?;
                }
            }
            Self::Thread { .. } => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum TaskWorkspaceFacetKind {
    Thread,
    Goal,
    Agents,
    Workflows,
    Artifacts,
    Runtime,
    Sources,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum TaskWorkspaceAvailability {
    Available,
    Partial,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskWorkspaceFacet {
    pub kind: TaskWorkspaceFacetKind,
    pub availability: TaskWorkspaceAvailability,
    /// None is unknown, never an inferred zero.
    pub observed_count: Option<u64>,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskWorkspaceEntry {
    pub reference: TaskWorkspaceNativeRef,
    pub title: String,
    /// Exact native label. Consumers must preserve unfamiliar/future labels.
    pub native_status: Option<String>,
    pub source_method: String,
    pub native_revision: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskWorkspaceReadParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Explicit original tuple selected by the user; this is never a grant.
    /// `sourceTarget` is the existing RPC field name.
    #[serde(
        rename = "sourceTarget",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub task_capability_scope_target: Option<IntegrationTaskCapabilityScopeControlTarget>,
}
impl TaskWorkspaceReadParams {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        id(&self.thread_id, "threadId")?;
        if let Some(target) = &self.task_capability_scope_target {
            target.validate()?;
            if target.initial_attempt.thread_id != self.thread_id {
                return Err(invalid(
                    "sourceTarget",
                    "original source tuple belongs to another thread",
                ));
            }
        }
        if self.thread_id.len() > 256
            || !self
                .thread_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(invalid(
                "threadId",
                "native thread identity must be a bounded single identifier",
            ));
        }
        if self.cursor.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > 256 || value.chars().any(char::is_control)
        }) {
            return Err(invalid("cursor", "invalid observation cursor"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskWorkspaceSnapshot {
    pub schema_version: u32,
    /// Identity fence only; actual authority remains in the Native source.
    pub scope: IntegrationScope,
    pub snapshot_id: String,
    pub observed_at_ms: u64,
    pub thread: TaskWorkspaceEntry,
    pub entries: Vec<TaskWorkspaceEntry>,
    pub facets: Vec<TaskWorkspaceFacet>,
    pub artifact_refs: Vec<IntegrationEntityRef>,
    /// Present only when the exact original runtime reference was read.
    pub runtime: Option<IntegrationRuntimeTask>,
    /// Absence means not observed. It never selects an implicit account.
    /// `sourceSelection` is the existing RPC and stored-session field name.
    #[serde(rename = "sourceSelection")]
    pub task_capability_scope_selection: Option<IntegrationTaskCapabilityScopeSnapshot>,
    /// Echoes only the explicitly requested tuple, binding paginated observations.
    /// `sourceTarget` is the existing RPC field name.
    #[serde(
        rename = "sourceTarget",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub task_capability_scope_target: Option<IntegrationTaskCapabilityScopeControlTarget>,
    pub next_cursor: Option<String>,
}
impl TaskWorkspaceSnapshot {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.scope.validate()?;
        id(&self.snapshot_id, "snapshotId")?;
        if self.schema_version != 1
            || self.entries.len() > TASK_WORKSPACE_PAGE_SIZE
            || self.facets.len() > 7
            || self.artifact_refs.len() > 1024
        {
            return Err(invalid(
                "snapshot",
                "bounded original observations required",
            ));
        }
        self.thread.reference.validate()?;
        if let Some(target) = &self.task_capability_scope_target {
            target.validate()?;
            if target.initial_attempt.thread_id != self.thread.reference.thread_id()
                || self
                    .task_capability_scope_selection
                    .as_ref()
                    .is_some_and(|source| source.thread_id != target.initial_attempt.thread_id)
                || self.runtime.as_ref().is_some_and(|runtime| {
                    target.runtime_operation_id.is_none()
                        || runtime.thread_id != target.initial_attempt.thread_id
                })
            {
                return Err(invalid(
                    "sourceTarget",
                    "observed identity differs from the explicit original tuple",
                ));
            }
        } else if self.task_capability_scope_selection.is_some() || self.runtime.is_some() {
            return Err(invalid(
                "sourceTarget",
                "source/runtime observations require an explicit original tuple",
            ));
        }
        for entry in std::iter::once(&self.thread).chain(self.entries.iter()) {
            entry.reference.validate()?;
            if entry.reference.thread_id() != self.thread.reference.thread_id()
                || entry.title.chars().count() > 512
            {
                return Err(invalid(
                    "entries",
                    "foreign task identity or unbounded preview",
                ));
            }
            id(&entry.source_method, "entry.sourceMethod")?;
            if let Some(status) = &entry.native_status {
                id(status, "entry.nativeStatus")?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optional_original_task_capability_scope_target_keeps_legacy_wire_and_rejects_cross_thread_or_extra_grants()
     {
        let legacy = serde_json::json!({"threadId":"original-thread"});
        let parsed: TaskWorkspaceReadParams = serde_json::from_value(legacy.clone()).unwrap();
        assert!(parsed.task_capability_scope_target.is_none());
        assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);
        let mut explicit = serde_json::json!({"threadId":"original-thread","sourceTarget":{"initialAttempt":{"threadId":"original-thread","turnId":"original-turn","attemptId":"original-attempt"},"runtimeOperationId":"original-runtime-op"}});
        let parsed: TaskWorkspaceReadParams = serde_json::from_value(explicit.clone()).unwrap();
        parsed.validate().unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), explicit);
        explicit["sourceTarget"]["initialAttempt"]["threadId"] =
            serde_json::json!("foreign-thread");
        assert!(
            serde_json::from_value::<TaskWorkspaceReadParams>(explicit.clone())
                .unwrap()
                .validate()
                .is_err()
        );
        explicit["sourceTarget"]["trusted"] = serde_json::json!(true);
        assert!(serde_json::from_value::<TaskWorkspaceReadParams>(explicit).is_err());
    }
    #[test]
    fn native_member_reference_does_not_substitute_another_run_owner() {
        let reference = TaskWorkspaceNativeRef::Agent {
            thread_id: "parent".into(),
            agent_id: "agent".into(),
            background_run: Some(BackgroundRunKey {
                parent_session_id: "other".into(),
                agent_id: "agent".into(),
                run_id: "run".into(),
            }),
        };
        assert!(reference.validate().is_err());
        assert!(serde_json::from_value::<TaskWorkspaceNativeRef>(serde_json::json!({"kind":"agent","threadId":"parent","agentId":"agent","backgroundRun":null,"path":"not-a-reference"})).is_err());
    }
    #[test]
    fn snapshot_keeps_future_native_labels_and_unknown_counts() {
        let value = TaskWorkspaceFacet {
            kind: TaskWorkspaceFacetKind::Agents,
            availability: TaskWorkspaceAvailability::Unknown,
            observed_count: None,
            reason_code: Some("NATIVE_UNREADABLE".into()),
        };
        assert_eq!(
            serde_json::to_value(value).unwrap()["observedCount"],
            serde_json::Value::Null
        );
        let entry = TaskWorkspaceEntry {
            reference: TaskWorkspaceNativeRef::Thread {
                thread_id: "original".into(),
            },
            title: "Original".into(),
            native_status: Some("future_native_state".into()),
            source_method: "thread/read".into(),
            native_revision: None,
        };
        let wire = serde_json::to_value(&entry).unwrap();
        assert_eq!(
            serde_json::from_value::<TaskWorkspaceEntry>(wire).unwrap(),
            entry
        );
    }
}
