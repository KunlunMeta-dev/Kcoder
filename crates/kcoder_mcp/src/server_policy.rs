//! Apply shared server policy and bound native transport startup.

pub use kcoder_mcp_policy::{CredentialContext, validate, validate_references};
pub(crate) use kcoder_mcp_policy::{check_workspace, prepare, prepare_in};

use anyhow::Result;

pub(crate) async fn startup<T>(
    seconds: Option<u64>,
    future: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    match seconds {
        Some(seconds) => tokio::time::timeout(std::time::Duration::from_secs(seconds), future)
            .await
            .map_err(|_| crate::failure::timeout("MCP server startup timed out"))?,
        None => future.await,
    }
}
