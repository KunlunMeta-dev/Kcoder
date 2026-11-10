//! Infrastructure preparation retains the original UI request, never a service grant.
use super::super::*;

/// Only fixed stages and bounded error digests enter the original stderr lane.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OriginalPreparationStage {
    OriginalUiCall,
}
pub(crate) fn report_original_failure(stage: OriginalPreparationStage, error: &anyhow::Error) {
    use sha2::{Digest, Sha256};
    let chain: Vec<_> = error
        .chain()
        .take(6)
        .map(|cause| format!("{:x}", Sha256::digest(cause.to_string())))
        .collect();
    eprintln!(
        "{}",
        serde_json::json!({"event":"native_scope_original_preparation_unconfirmed",
        "stage":stage,"reasonSha256":chain})
    );
}
