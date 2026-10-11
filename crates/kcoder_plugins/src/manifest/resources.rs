use super::PluginManifestError;
use crate::model::PluginResource;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub(super) fn resolve_resource(
    root: &Path,
    raw: &str,
) -> Result<PluginResource, PluginManifestError> {
    let raw = raw.trim();
    // These placeholders all denote the already validated plugin root, never an
    // arbitrary process environment path. Traversal checks below still apply.
    let anchored = [
        "CLAUDE_PLUGIN_ROOT",
        "CODEX_PLUGIN_ROOT",
        "CODEBUDDY_PLUGIN_ROOT",
        "GROK_PLUGIN_ROOT",
        "QODER_PLUGIN_ROOT",
        "TRAE_PLUGIN_ROOT",
        "PLUGIN_ROOT",
    ]
    .iter()
    .find_map(|name| raw.strip_prefix(&format!("${{{name}}}/")))
    .map(|rest| format!("./{rest}"));
    let trimmed = anchored.as_deref().unwrap_or(raw);
    if trimmed.is_empty() {
        return Err(PluginManifestError::Invalid(
            "plugin resource path cannot be empty".to_string(),
        ));
    }
    // Bare relative names (including dotfiles) and ./-prefixed paths are
    // equivalent. Enforce containment, not a vendor-specific spelling.
    if trimmed.contains(['\\', ':', '\0']) || trimmed.starts_with('$') {
        return Err(PluginManifestError::UnsafeResourcePath {
            path: trimmed.to_string(),
            message: "resource paths must be portable relative paths, not Windows roots, URLs, or alternate streams".to_string(),
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
) -> Result<Vec<PluginResource>, PluginManifestError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    match value {
        Value::String(path) => Ok(vec![resolve_resource(root, &path)?]),
        Value::Array(items) => items
            .into_iter()
            .map(|item| match item {
                Value::String(path) => resolve_resource(root, &path),
                other => Err(PluginManifestError::Invalid(format!(
                    "plugin field `{field}` must contain only string paths; got {other}"
                ))),
            })
            .collect(),
        Value::Object(entries) if matches!(field, "commands" | "agents") => entries.into_iter().map(|(name, entry)| {
            let path = match &entry {
                Value::String(path) => Some(path.as_str()),
                Value::Object(value) => value.get("source").and_then(Value::as_str),
                _ => None,
            }.ok_or_else(|| PluginManifestError::Invalid(format!("plugin field `{field}.{name}` must be a path or an object with a string source")))?;
            resolve_resource(root, path)
        }).collect(),
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

/// Some published skill bundles place each skill directly below the package root.
/// Only inspect immediate, real directories; never recursively discover examples.
pub(super) fn flat_skill_collection(
    root: &Path,
) -> Result<Vec<PluginResource>, PluginManifestError> {
    let io = |source| PluginManifestError::Io {
        path: root.to_path_buf(),
        source,
    };
    let mut skills = Vec::new();
    for (index, entry) in std::fs::read_dir(root).map_err(io)?.enumerate() {
        if index >= 4096 {
            return Err(PluginManifestError::Invalid(
                "Plugin root discovery exceeds 4096 entries".into(),
            ));
        }
        let entry = entry.map_err(io)?;
        if !entry.file_type().map_err(io)?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if regular_file(&entry.path().join("SKILL.md"))? {
            skills.push(resolve_resource(root, &format!("./{name}/SKILL.md"))?);
        }
    }
    skills.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(skills)
}
