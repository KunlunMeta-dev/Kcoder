//! Compiles the production snapshot and process owner without the full model stack.
extern crate self as kcoder_tools;
#[path = "../../../../../kcoder_tools/src/owned_process.rs"]
pub mod owned_process;
#[path = "../../../../src/orchestrate/workspace_evidence.rs"]
mod workspace_evidence;

/// The synchronous policy uses the same production snapshot as the async recorder.
pub fn fingerprint_sync(root: &std::path::Path) -> anyhow::Result<String> {
    workspace_evidence::digest_sync(root)
}

pub async fn fingerprint(root: &std::path::Path) -> anyhow::Result<String> {
    workspace_evidence::digest(root).await
}
