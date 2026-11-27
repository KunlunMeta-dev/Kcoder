//! Shared domain-independent support for KCoder project-level tests.
//!
//! This crate depends on no `kcoder_*` product crate and owns only test run
//! directories, evidence, fixtures, child processes, and retention policy.
//! Domain fixtures and assertions belong in their respective suites.

mod fixture;
mod manifest;
mod owned_process;
mod prerequisite;
mod redaction;
mod retention;
mod run_context;

pub use fixture::{FixtureMetadata, MaterializedFixture, WorkspaceFixture};
pub use manifest::{
    MANIFEST_SCHEMA_VERSION, ModelPolicy, RunManifest, RunMetadata, RunStatus, TestTier,
};
pub use owned_process::OwnedProcess;
pub use prerequisite::{Prerequisite, PrerequisiteResult};
pub use redaction::{SecretRedactor, StreamingRedactor};
pub use retention::{RetentionPolicy, RetentionReport, prune_runs};
pub use run_context::{CleanupReport, RunContext};

/// Return the workspace root for the current Cargo invocation.
///
/// Resolve this path at test runtime rather than using a checkout absolute path cached in build artifacts.
pub fn workspace_root() -> anyhow::Result<std::path::PathBuf> {
    let configured = std::env::var_os("KCODER_WORKSPACE_ROOT")
        .ok_or_else(|| anyhow::anyhow!("Cargo 未提供 KCODER_WORKSPACE_ROOT"))?;
    let root = std::path::PathBuf::from(configured)
        .canonicalize()
        .map_err(|error| anyhow::anyhow!("无法解析 KCoder 工作区根目录: {error}"))?;
    anyhow::ensure!(
        root.join("Cargo.toml").is_file()
            && root.join("tests/harness/Cargo.toml").is_file()
            && root.join("tests/matrix.toml").is_file(),
        "KCODER_WORKSPACE_ROOT 不是 KCoder 工作区: {}",
        root.display()
    );
    Ok(root)
}
