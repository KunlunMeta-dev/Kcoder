use super::PluginManifestError;
use super::resources::{regular_file, resolve_resource};
use crate::model::{
    PluginContributionDeclarations, PluginHookDeclaration, PluginManifest, PluginManifestFormat,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawKcoderManifest {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    hooks: Option<Value>,
}

fn default_enabled() -> bool {
    true
}

pub(super) fn parse(
    root: &Path,
    contents: &str,
    format: PluginManifestFormat,
) -> Result<PluginManifest, PluginManifestError> {
    let raw: RawKcoderManifest = serde_json::from_str(contents)
        .map_err(|error| PluginManifestError::Json(error.to_string()))?;
    if raw.name.trim().is_empty() {
        return Err(PluginManifestError::Invalid(
            "plugin name cannot be empty".to_string(),
        ));
    }

    let mut hooks = Vec::new();
    let default_hooks = root.join("hooks/hooks.json");
    if regular_file(&default_hooks)? {
        hooks.push(PluginHookDeclaration::Path(resolve_resource(
            root,
            "./hooks/hooks.json",
            false,
        )?));
    }
    if let Some(value) = raw.hooks {
        parse_hooks(root, value, &mut hooks)?;
    }

    Ok(PluginManifest {
        format,
        id: raw.id,
        name: raw.name,
        version: raw.version,
        description: raw.description,
        keywords: Vec::new(),
        enabled_by_default: raw.enabled,
        contributions: PluginContributionDeclarations {
            hooks,
            ..PluginContributionDeclarations::default()
        },
        interface: None,
    })
}

fn parse_hooks(
    root: &Path,
    value: Value,
    out: &mut Vec<PluginHookDeclaration>,
) -> Result<(), PluginManifestError> {
    match value {
        Value::String(path) => out.push(PluginHookDeclaration::Path(resolve_resource(
            root, &path, false,
        )?)),
        Value::Array(items) => {
            for item in items {
                parse_hooks(root, item, out)?;
            }
        }
        Value::Object(_) => out.push(PluginHookDeclaration::Inline(value)),
        other => {
            return Err(PluginManifestError::Invalid(format!(
                "plugin hooks must be an object, string path, or array; got {other}"
            )));
        }
    }
    Ok(())
}
