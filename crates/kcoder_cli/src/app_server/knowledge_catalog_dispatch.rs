use anyhow::{Context, Result};
use serde_json::Value;
use std::path::Path;

#[path = "knowledge_requests/read_compat.rs"]
mod read_compat;

pub(super) fn request_owned(path: &Path, cwd: &Path, method: &str, params: Value) -> Result<Value> {
    if read_compat::supports(method) {
        let profile = path
            .parent()
            .context("knowledge profile storage unavailable")?;
        if let Some(observed) =
            crate::app_server::integrations::core::ObservedReadScope::capture(profile, cwd)?
        {
            return read_compat::request(path, method, params, &observed);
        }
    }
    kcoder_knowledge_rpc::knowledge_requests::request(path, method, params)
}
