//! Settings-file compatibility belongs to this format, independently of releases.
//!
//! Preserve released transitions here. Unversioned settings are always v1, never
//! implicitly the latest version. Loading transforms a document in memory;
//! existing coordinated JSONC writers own any eventual publication.

pub(crate) mod legacy;

use anyhow::{Result, bail};
use serde_json::Value;

const UNVERSIONED_CONFIG_VERSION: u64 = 1;

pub(crate) fn validate_version(document: &Value) -> Result<()> {
    let root = document
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("settings root must be a JSON object"))?;
    let version = match root.get("meta") {
        None => UNVERSIONED_CONFIG_VERSION,
        Some(meta) => meta
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("settings meta must be an object"))?
            .get("config_version")
            .map(|value| {
                value.as_u64().ok_or_else(|| {
                    anyhow::anyhow!("settings meta.config_version must be a positive integer")
                })
            })
            .transpose()?
            .unwrap_or(UNVERSIONED_CONFIG_VERSION),
    };
    if version > crate::CURRENT_CONFIG_VERSION {
        bail!(
            "unsupported future settings meta.config_version={version}; current supported version is v{}",
            crate::CURRENT_CONFIG_VERSION
        );
    }
    if version != UNVERSIONED_CONFIG_VERSION {
        bail!("unsupported settings meta.config_version={version}");
    }

    Ok(())
}

pub fn migrate_settings_document(document: &mut Value) -> Result<()> {
    validate_version(document)?;
    // v1 includes released, unnumbered field migrations. New incompatible
    // versions must append their transition before publishing the new number.
    legacy::normalize_legacy_settings_document(document);
    if document.get("meta").is_none() {
        document["meta"] = serde_json::json!({});
    }
    document["meta"]["config_version"] = Value::from(UNVERSIONED_CONFIG_VERSION);
    Ok(())
}

#[cfg(test)]
mod tests;
