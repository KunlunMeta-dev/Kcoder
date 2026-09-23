use super::PluginManifestError;
use crate::model::PluginResource;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub(super) fn resolve_resource(
    root: &Path,
    raw: &str,
    require_dot_prefix: bool,
) -> Result<PluginResource, PluginManifestError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(PluginManifestError::Invalid(
            "plugin resource path cannot be empty".to_string(),
        ));
    }
    if require_dot_prefix && !trimmed.starts_with("./") {
        return Err(PluginManifestError::UnsafeResourcePath {
            path: trimmed.to_string(),
            message: "external plugin resource paths must start with `./`".to_string(),
        });
    }
    let stripped = trimmed.strip_prefix("./").unwrap_or(trimmed);
    let relative = Path::new(stripped);
    if relative.is_absolute() {
        return Err(PluginManifestError::UnsafeResourcePath {
            path: trimmed.to_string(),
            message: "absolute paths are not allowed".to_string(),
        });
    }

    let mut normalized = PathBuf::new();
    let mut absolute = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err(PluginManifestError::UnsafeResourcePath {
                path: trimmed.to_string(),
                message: "resource paths cannot contain `.`, `..`, roots, or prefixes".to_string(),
            });
        };
        normalized.push(part);
        absolute.push(part);
        if let Ok(metadata) = std::fs::symlink_metadata(&absolute)
            && metadata.file_type().is_symlink()
        {
            return Err(PluginManifestError::UnsafeResourcePath {
                path: trimmed.to_string(),
                message: format!("resource path traverses symlink `{}`", absolute.display()),
            });
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(PluginManifestError::UnsafeResourcePath {
            path: trimmed.to_string(),
            message: "resource path must name an entry below the plugin root".to_string(),
        });
    }

    Ok(PluginResource {
        relative_path: normalized,
        absolute_path: absolute,
    })
}

pub(super) fn parse_resource_list(
    root: &Path,
    value: Option<Value>,
    field: &str,
    require_dot_prefix: bool,
) -> Result<Vec<PluginResource>, PluginManifestError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    match value {
        Value::String(path) => Ok(vec![resolve_resource(root, &path, require_dot_prefix)?]),
        Value::Array(items) => items
            .into_iter()
            .map(|item| match item {
                Value::String(path) => resolve_resource(root, &path, require_dot_prefix),
                other => Err(PluginManifestError::Invalid(format!(
                    "plugin field `{field}` must contain only string paths; got {other}"
                ))),
            })
            .collect(),
        other => Err(PluginManifestError::Invalid(format!(
            "plugin field `{field}` must be a string path or array; got {other}"
        ))),
    }
}

pub(super) fn regular_file(path: &Path) -> Result<bool, PluginManifestError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(PluginManifestError::UnsafeResourcePath {
                path: path.display().to_string(),
                message: "manifest files cannot be symlinks".to_string(),
            })
        }
        Ok(metadata) => Ok(metadata.file_type().is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(PluginManifestError::Io {
            path: path.to_path_buf(),
            source: error,
        }),
    }
}
