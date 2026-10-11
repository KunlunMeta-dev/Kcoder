//! Internal recovery entry, before ordinary configuration/extension startup.
use anyhow::Result;
use std::path::Path;

pub fn run(path: &Path, expected_pipe: &str) -> Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?
        .block_on(kcoder_mcp::desktop_recovery::run(path, expected_pipe))
}
