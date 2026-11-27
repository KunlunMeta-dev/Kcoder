//! Original child intent records, checked against the held runtime binding.
use super::*;
use kcoder_types::{BackgroundRunKey, TurnAttemptIdentity};
use kcoder_workflow::native_parent_facts::NativeWorkflowParentFacts;
use serde::{Deserialize, Serialize};

pub const MAX_CHILDREN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildIntent {
    pub operation_id: String,
    pub receipt_revision: u64,
    runtime_acceptance_sha256: String,
    pub workflow_task_id: String,
    pub parent_thread_id: String,
    pub definition_id: String,
    pub definition_version: u64,
    definition_sha256: String,
    inputs_sha256: String,
    pub node_id: String,
    pub source_revision: String,
    pub background_run: BackgroundRunKey,
    pub child_identity: TurnAttemptIdentity,
    pub input_hash: String,
    pub fingerprint: String,
    workflow_facts_sha256: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildIntentPhase {
    Prepared,
    Accepted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildIntentRecord {
    pub intent: ChildIntent,
    pub phase: ChildIntentPhase,
}
pub fn sha(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
pub fn facts(intent: &ChildIntent) -> NativeWorkflowParentFacts {
    NativeWorkflowParentFacts {
        operation_id: intent.operation_id.clone(),
        receipt_revision: intent.receipt_revision,
        runtime_acceptance_sha256: intent.runtime_acceptance_sha256.clone(),
        workflow_task_id: intent.workflow_task_id.clone(),
        definition_id: intent.definition_id.clone(),
        definition_version: intent.definition_version,
        node_id: intent.node_id.clone(),
        source_revision: intent.source_revision.clone(),
    }
}
impl ChildIntent {
    /// Bind the supplied child facts to the original accepted runtime record.
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep independent source pins and child facts explicit"
    )]
    pub fn from_parent_facts(
        binding: &RuntimeBinding,
        source: &NativeWorkflowParentFacts,
        definition_sha256: &str,
        inputs_sha256: &str,
        background_run: BackgroundRunKey,
        child_identity: TurnAttemptIdentity,
        input_hash: &str,
        fingerprint: &str,
    ) -> Result<Self> {
        let intent = Self {
            operation_id: source.operation_id.clone(),
            receipt_revision: source.receipt_revision,
            runtime_acceptance_sha256: source.runtime_acceptance_sha256.clone(),
            workflow_task_id: source.workflow_task_id.clone(),
            parent_thread_id: background_run.parent_session_id.clone(),
            definition_id: source.definition_id.clone(),
            definition_version: source.definition_version,
            definition_sha256: definition_sha256.into(),
            inputs_sha256: inputs_sha256.into(),
            node_id: source.node_id.clone(),
            source_revision: source.source_revision.clone(),
            background_run,
            child_identity,
            input_hash: input_hash.into(),
            fingerprint: fingerprint.into(),
            workflow_facts_sha256: source.sha256(),
        };
        intent.validate(binding)?;
        Ok(intent)
    }

    pub fn validate(&self, binding: &RuntimeBinding) -> Result<()> {
        self.child_identity.validate().map_err(anyhow::Error::msg)?;
        let accepted = binding
            .acceptance
            .as_ref()
            .context("RUNTIME_CHILD_PARENT_UNACCEPTED")?;
        let workflow = binding
            .spec
            .configuration
            .workflow
            .as_ref()
            .context("RUNTIME_CHILD_WORKFLOW_REQUIRED")?;
        ensure!(
            self.operation_id == binding.operation_id
                && self.parent_thread_id == accepted.thread_id
                && accepted.task_id.as_deref() == Some(self.workflow_task_id.as_str())
                && accepted.turn_id.is_none()
                && self.child_identity.thread_id != self.parent_thread_id
                && self.runtime_acceptance_sha256
                    == sha(&(
                        binding.owner.clone(),
                        binding.operation_id.as_str(),
                        accepted
                    ))?
                && self.definition_id == workflow.definition_id
                && self.definition_version == workflow.version
                && workflow.definition_sha256.as_deref() == Some(self.definition_sha256.as_str())
                && sha(&workflow.args)? == self.inputs_sha256
                && self.background_run.parent_session_id == self.parent_thread_id
                && label(&self.node_id)
                && label(&self.background_run.agent_id)
                && uuid::Uuid::parse_str(&self.background_run.run_id).is_ok()
                && self.receipt_revision > 0
                && [
                    &self.runtime_acceptance_sha256,
                    &self.definition_sha256,
                    &self.inputs_sha256,
                    &self.source_revision,
                    &self.input_hash,
                    &self.fingerprint,
                    &self.workflow_facts_sha256
                ]
                .into_iter()
                .all(|value| digest(value))
                && facts(self).sha256() == self.workflow_facts_sha256,
            "RUNTIME_CHILD_INTENT_INVALID"
        );
        Ok(())
    }
}
pub fn validate_records(binding: &RuntimeBinding) -> Result<()> {
    ensure!(
        binding.child_intents.len() <= MAX_CHILDREN,
        "RUNTIME_CHILD_CAPACITY"
    );
    let mut runs = std::collections::BTreeSet::new();
    let mut children = std::collections::BTreeSet::new();
    let mut source = None;
    for record in &binding.child_intents {
        record.intent.validate(binding)?;
        ensure!(
            runs.insert(&record.intent.background_run)
                && children.insert(&record.intent.child_identity.thread_id),
            "RUNTIME_CHILD_INTENT_DUPLICATE"
        );
        if let Some(source) = source {
            ensure!(
                source == &record.intent.source_revision,
                "RUNTIME_CHILD_SOURCE_CHANGED"
            );
        } else {
            source = Some(&record.intent.source_revision);
        }
    }
    Ok(())
}
pub(crate) fn preserve_records(old: &RuntimeBinding, new: &RuntimeBinding) -> Result<()> {
    for previous in &old.child_intents {
        let next = new
            .child_intents
            .iter()
            .find(|value| value.intent.background_run == previous.intent.background_run)
            .context("RUNTIME_CHILD_INTENT_IMMUTABLE")?;
        ensure!(
            next.intent == previous.intent
                && (previous.phase != ChildIntentPhase::Accepted
                    || next.phase == ChildIntentPhase::Accepted),
            "RUNTIME_CHILD_INTENT_IMMUTABLE"
        );
    }
    Ok(())
}
