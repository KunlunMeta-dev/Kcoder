use super::{PluginManifestError, external};
use crate::model::{PluginManifest, PluginManifestFormat};
use serde_json::Value;
use std::path::Path;

pub(super) fn parse(root: &Path, contents: &str) -> Result<PluginManifest, PluginManifestError> {
    let mut raw: Value = serde_json::from_str(contents)
        .map_err(|error| PluginManifestError::Json(error.to_string()))?;
    if raw.get("mcpServers").is_none()
        && let Some(mut mcp) = raw.get("mcp").cloned()
    {
        if let Some(path) = mcp.as_str()
            && !path.starts_with(['.', '/', '$'])
            && !path.contains(['\\', ':'])
        {
            mcp = Value::String(format!("./{path}"));
        }
        raw["mcpServers"] = mcp;
    }
    external::parse(root, &raw.to_string(), PluginManifestFormat::Trae)
}
