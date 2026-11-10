//! Stable workflow parent descriptor shared by the runtime and Engine.

/// Native facts returned by the actual private runtime verifier. Facts have no
/// serde and grant nothing without the installed authority's current checks.
#[derive(Clone, PartialEq, Eq)]
pub struct NativeWorkflowParentFacts {
    pub operation_id: String,
    pub receipt_revision: u64,
    pub runtime_acceptance_sha256: String,
    pub workflow_task_id: String,
    pub definition_id: String,
    pub definition_version: u64,
    pub node_id: String,
    pub source_revision: String,
}
impl NativeWorkflowParentFacts {
    pub fn valid(&self) -> bool {
        [
            &self.operation_id,
            &self.workflow_task_id,
            &self.definition_id,
            &self.node_id,
            &self.source_revision,
        ]
        .iter()
        .all(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        }) && self.receipt_revision > 0
            && self.definition_version > 0
            && self.runtime_acceptance_sha256.len() == 64
            && self
                .runtime_acceptance_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
    }
    /// Stable native descriptor digest; this is metadata, never authorization.
    pub fn sha256(&self) -> String {
        use sha2::{Digest, Sha256};
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&self.fingerprint_value())
                    .expect("workflow facts descriptor contains only scalar values")
            )
        )
    }
    pub fn fingerprint_value(&self) -> serde_json::Value {
        serde_json::json!([
            self.operation_id,
            self.receipt_revision,
            self.runtime_acceptance_sha256,
            self.workflow_task_id,
            self.definition_id,
            self.definition_version,
            self.node_id,
            self.source_revision
        ])
    }
}
