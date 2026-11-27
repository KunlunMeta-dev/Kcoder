use super::PluginManifestError;
use crate::model::PluginResource;
use kcoder_config::PrivateDirectory;
use serde_json::Value;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub(crate) fn resolve_resource(
    root: &Path,
    raw: &str,
) -> Result<PluginResource, PluginManifestError> {
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
    let relative = parse_relative_path(trimmed, trimmed)?;
    resolve_relative_resource(root, &relative)
}

/// Resolve a path assembled from native filesystem components, such as an
/// entry returned by a directory scan. Raw manifest strings use
/// `resolve_resource` and retain their portable slash-only syntax.
pub(crate) fn resolve_resource_path(
    root: &Path,
    native_relative: &Path,
) -> Result<PluginResource, PluginManifestError> {
    let parts = relative_components(native_relative)?;
    let mut relative = PathBuf::new();
    for part in parts {
        relative.push(part);
    }
    resolve_relative_resource(root, &relative)
}

fn resolve_relative_resource(
    root: &Path,
    relative: &Path,
) -> Result<PluginResource, PluginManifestError> {
    let absolute_root = resolve_root(root)?;
    let _ = inspect_resource_entry(&absolute_root, relative)?;

    Ok(PluginResource {
        absolute_path: absolute_root.join(relative),
        relative_path: relative.to_path_buf(),
    })
}

pub(crate) fn resolve_root(root: &Path) -> Result<PathBuf, PluginManifestError> {
    let absolute = absolute_path(root)?;
    match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) => {
            if is_reparse_or_symlink(&metadata) || !metadata.is_dir() {
                return Err(unsafe_path(
                    &absolute.display().to_string(),
                    "plugin root must be an ordinary directory, not a symlink or reparse point",
                ));
            }
            let Some(name) = absolute.file_name() else {
                let resolved =
                    dunce::canonicalize(&absolute).map_err(|source| PluginManifestError::Io {
                        path: absolute.clone(),
                        source,
                    })?;
                verify_resolved_root(&resolved)?;
                return Ok(resolved);
            };
            let parent = absolute.parent().ok_or_else(|| {
                unsafe_path(
                    &absolute.display().to_string(),
                    "plugin root has no parent directory",
                )
            })?;
            let canonical_parent =
                dunce::canonicalize(parent).map_err(|source| PluginManifestError::Io {
                    path: parent.to_path_buf(),
                    source,
                })?;
            let resolved = canonical_parent.join(name);
            verify_resolved_root(&resolved)?;
            Ok(resolved)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut candidate = absolute.clone();
            let mut missing = Vec::new();
            loop {
                match std::fs::symlink_metadata(&candidate) {
                    Ok(_) => {
                        let canonical = dunce::canonicalize(&candidate).map_err(|source| {
                            PluginManifestError::Io {
                                path: candidate.clone(),
                                source,
                            }
                        })?;
                        if !std::fs::metadata(&canonical)
                            .map_err(|source| PluginManifestError::Io {
                                path: canonical.clone(),
                                source,
                            })?
                            .is_dir()
                        {
                            return Err(unsafe_path(
                                &candidate.display().to_string(),
                                "nearest existing plugin root ancestor must be a directory",
                            ));
                        }
                        let mut resolved = canonical;
                        for component in missing.iter().rev() {
                            resolved.push(component);
                        }
                        verify_resolved_root(&resolved)?;
                        return Ok(resolved);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        let Some(name) = candidate.file_name() else {
                            return Err(PluginManifestError::Io {
                                path: candidate,
                                source: error,
                            });
                        };
                        missing.push(name.to_os_string());
                        let Some(parent) = candidate.parent() else {
                            return Err(PluginManifestError::Io {
                                path: candidate,
                                source: error,
                            });
                        };
                        candidate = parent.to_path_buf();
                    }
                    Err(source) => {
                        if source.kind() == std::io::ErrorKind::NotADirectory {
                            return Err(unsafe_path(
                                &candidate.display().to_string(),
                                "plugin root path contains a non-directory ancestor",
                            ));
                        }
                        return Err(PluginManifestError::Io {
                            path: candidate,
                            source,
                        });
                    }
                }
            }
        }
        Err(source) => Err(PluginManifestError::Io {
            path: absolute,
            source,
        }),
    }
}

fn verify_resolved_root(root: &Path) -> Result<(), PluginManifestError> {
    if let Some(directory) = open_root(root)? {
        let metadata =
            directory
                .directory_metadata()
                .map_err(|source| PluginManifestError::Io {
                    path: root.to_path_buf(),
                    source,
                })?;
        if is_reparse_or_symlink(&metadata) || !metadata.is_dir() {
            return Err(unsafe_path(
                &root.display().to_string(),
                "resolved plugin root must be an ordinary directory",
            ));
        }
    }
    Ok(())
}

fn parse_relative_path(raw: &str, display: &str) -> Result<PathBuf, PluginManifestError> {
    if raw.is_empty() {
        return Err(unsafe_path(display, "resource paths cannot be empty"));
    }
    if raw.contains(['\\', ':', '\0']) || raw.starts_with('$') {
        return Err(unsafe_path(
            display,
            "resource paths must be portable relative paths, not Windows roots, URLs, or alternate streams",
        ));
    }

    let stripped = raw.strip_prefix("./").unwrap_or(raw);
    let path = Path::new(stripped);
    if path.is_absolute() {
        return Err(unsafe_path(display, "absolute paths are not allowed"));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            _ => {
                return Err(unsafe_path(
                    display,
                    "resource paths cannot contain `.`, `..`, roots, or prefixes",
                ));
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(unsafe_path(
            display,
            "resource path must name an entry below the plugin root",
        ));
    }
    Ok(normalized)
}

pub(crate) fn regular_file_under(
    root: &Path,
    relative: &Path,
) -> Result<bool, PluginManifestError> {
    Ok(matches!(
        inspect_resource_entry(root, relative)?,
        Some(false)
    ))
}

pub(crate) fn directory_under(root: &Path, relative: &Path) -> Result<bool, PluginManifestError> {
    Ok(matches!(
        inspect_resource_entry(root, relative)?,
        Some(true)
    ))
}

pub(crate) fn entry_names_under(
    root: &Path,
    relative: &Path,
    limit: usize,
) -> Result<Option<Vec<OsString>>, PluginManifestError> {
    let parts = relative_components(relative)?;
    let absolute_root = resolve_root(root)?;
    let full_path = absolute_root.join(relative);
    let Some(mut directory) = open_root(&absolute_root)? else {
        return Ok(None);
    };
    for part in parts {
        directory = match directory.open_child(&part, false) {
            Ok(child) => child,
            Err(error) if is_not_found(&error) => return Ok(None),
            Err(error) => return Err(map_handle_error(&full_path, error)),
        };
    }
    directory
        .entry_names_bounded(limit)
        .map(Some)
        .map_err(|error| map_handle_error(&full_path, error))
}

pub(crate) fn read_resource(
    root: &Path,
    resource: &PluginResource,
    max_bytes: u64,
) -> Result<String, PluginManifestError> {
    let bytes = read_plugin_file(root, &resource.relative_path, max_bytes)?.ok_or_else(|| {
        PluginManifestError::Io {
            path: resource.absolute_path.clone(),
            source: std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "plugin resource does not exist",
            ),
        }
    })?;
    String::from_utf8(bytes).map_err(|error| PluginManifestError::Io {
        path: resource.absolute_path.clone(),
        source: std::io::Error::new(std::io::ErrorKind::InvalidData, error),
    })
}

pub(crate) fn read_plugin_file(
    root: &Path,
    relative: &Path,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, PluginManifestError> {
    let parts = relative_components(relative)?;
    let absolute_root = resolve_root(root)?;
    let full_path = absolute_root.join(relative);

    let Some((parent, leaf)) = open_parent(&absolute_root, &parts, &full_path)? else {
        return Ok(None);
    };
    let file = match parent.open_single_link_regular_file(&leaf) {
        Ok(file) => file,
        Err(error) if is_not_found(&error) => return Ok(None),
        Err(error) => return Err(map_handle_error(&full_path, error)),
    };
    let metadata = file.metadata().map_err(|source| PluginManifestError::Io {
        path: full_path.clone(),
        source,
    })?;
    if metadata.len() > max_bytes {
        return Err(PluginManifestError::Invalid(format!(
            "plugin resource exceeds {max_bytes} bytes: {}",
            full_path.display()
        )));
    }

    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|source| PluginManifestError::Io {
            path: full_path.clone(),
            source,
        })?;
    if bytes.len() as u64 > max_bytes {
        return Err(PluginManifestError::Invalid(format!(
            "plugin resource exceeds {max_bytes} bytes: {}",
            full_path.display()
        )));
    }
    Ok(Some(bytes))
}

fn inspect_resource_entry(
    root: &Path,
    relative: &Path,
) -> Result<Option<bool>, PluginManifestError> {
    let parts = relative_components(relative)?;
    let absolute_root = resolve_root(root)?;
    let full_path = absolute_root.join(relative);

    let Some((parent, leaf)) = open_parent(&absolute_root, &parts, &full_path)? else {
        return Ok(None);
    };
    let entry = match parent.open_entry_handle(&leaf) {
        Ok(entry) => entry,
        Err(error) if is_not_found(&error) => return Ok(None),
        Err(error) => return Err(map_handle_error(&full_path, error)),
    };
    let metadata = entry.metadata();
    if is_reparse_or_symlink(metadata) {
        return Err(unsafe_path(
            &full_path.display().to_string(),
            "plugin resources cannot be symlinks or reparse points",
        ));
    }
    if metadata.is_dir() {
        entry
            .open_child_directory()
            .map_err(|error| map_handle_error(&full_path, error))?;
        Ok(Some(true))
    } else if metadata.is_file() {
        parent
            .open_single_link_regular_file(&leaf)
            .map_err(|error| map_handle_error(&full_path, error))?;
        Ok(Some(false))
    } else {
        Err(unsafe_path(
            &full_path.display().to_string(),
            "plugin resources must be ordinary files or directories",
        ))
    }
}

fn open_parent(
    root: &Path,
    parts: &[OsString],
    full_path: &Path,
) -> Result<Option<(PrivateDirectory, OsString)>, PluginManifestError> {
    let Some(mut directory) = open_root(root)? else {
        return Ok(None);
    };
    for part in &parts[..parts.len() - 1] {
        match directory.open_child(part, false) {
            Ok(child) => directory = child,
            Err(error) if is_not_found(&error) => return Ok(None),
            Err(error) => return Err(map_handle_error(full_path, error)),
        }
    }
    Ok(Some((directory, parts.last().unwrap().clone())))
}

fn open_root(root: &Path) -> Result<Option<PrivateDirectory>, PluginManifestError> {
    match PrivateDirectory::open_existing(root) {
        Ok(directory) => Ok(Some(directory)),
        Err(error) if is_not_found(&error) => Ok(None),
        Err(error) => Err(map_handle_error(root, error)),
    }
}

fn relative_components(relative: &Path) -> Result<Vec<OsString>, PluginManifestError> {
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_os_string()),
            _ => {
                return Err(unsafe_path(
                    &relative.display().to_string(),
                    "resource paths must remain below the plugin root",
                ));
            }
        }
    }
    if parts.is_empty() {
        return Err(unsafe_path(
            &relative.display().to_string(),
            "resource path must name an entry below the plugin root",
        ));
    }
    Ok(parts)
}

fn absolute_path(path: &Path) -> Result<PathBuf, PluginManifestError> {
    let source = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| PluginManifestError::Io {
                path: path.to_path_buf(),
                source,
            })?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in source.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some() {
                    normalized.pop();
                }
            }
            Component::Normal(name) => normalized.push(name),
        }
    }
    if !normalized.is_absolute() {
        return Err(unsafe_path(
            &path.display().to_string(),
            "plugin paths must resolve to an absolute filesystem path",
        ));
    }
    Ok(normalized)
}

fn contains_reparse_component(path: &Path) -> bool {
    let Ok(path) = absolute_path(path) else {
        return false;
    };
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir | Component::ParentDir => return false,
            Component::Normal(name) => {
                current.push(name);
                match std::fs::symlink_metadata(&current) {
                    Ok(metadata) if is_reparse_or_symlink(&metadata) => return true,
                    Ok(_) => {}
                    Err(_) => return false,
                }
            }
        }
    }
    false
}

fn is_reparse_or_symlink(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<std::io::Error>())
        .is_some_and(|source| source.kind() == std::io::ErrorKind::NotFound)
}

fn map_handle_error(path: &Path, error: anyhow::Error) -> PluginManifestError {
    if contains_reparse_component(path) {
        return unsafe_path(
            &path.display().to_string(),
            "plugin paths cannot traverse symlinks or reparse points",
        );
    }
    if let Some(source) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<std::io::Error>())
    {
        if source.kind() == std::io::ErrorKind::NotADirectory {
            return unsafe_path(
                &path.display().to_string(),
                "plugin path parent components must be ordinary directories",
            );
        }
        return PluginManifestError::Io {
            path: path.to_path_buf(),
            source: std::io::Error::new(source.kind(), source.to_string()),
        };
    }
    unsafe_path(&path.display().to_string(), &error.to_string())
}

fn unsafe_path(path: &str, message: &str) -> PluginManifestError {
    PluginManifestError::UnsafeResourcePath {
        path: path.to_string(),
        message: message.to_string(),
    }
}

pub(super) fn regular_file(path: &Path) -> Result<bool, PluginManifestError> {
    let absolute = absolute_path(path)?;
    let Some(leaf) = absolute.file_name() else {
        return Err(unsafe_path(
            &absolute.display().to_string(),
            "plugin file path must name a file below a directory",
        ));
    };
    let Some(root) = absolute.parent() else {
        return Ok(false);
    };
    regular_file_under(root, Path::new(leaf))
}

pub(super) fn flat_skill_collection(
    root: &Path,
) -> Result<Vec<PluginResource>, PluginManifestError> {
    let Some(directory) = open_root(&resolve_root(root)?)? else {
        return Err(PluginManifestError::Io {
            path: root.to_path_buf(),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "plugin root does not exist"),
        });
    };
    let entries = directory
        .entry_names_bounded(4097)
        .map_err(|error| map_handle_error(root, error))?;
    if entries.len() > 4096 {
        return Err(PluginManifestError::Invalid(
            "Plugin root discovery exceeds 4096 entries".into(),
        ));
    }

    let mut skills = Vec::new();
    for name in entries {
        let Some(name_text) = name.to_str() else {
            continue;
        };
        if name_text.starts_with('.') {
            continue;
        }
        let directory = match directory_under(root, Path::new(&name)) {
            Ok(directory) => directory,
            Err(PluginManifestError::UnsafeResourcePath { .. }) => continue,
            Err(error) => return Err(error),
        };
        if !directory {
            continue;
        }
        let skill_path = Path::new(&name).join("SKILL.md");
        match regular_file_under(root, &skill_path) {
            Ok(true) => skills.push(resolve_resource_path(root, &skill_path)?),
            Ok(false) | Err(PluginManifestError::UnsafeResourcePath { .. }) => {}
            Err(error) => return Err(error),
        }
    }
    skills.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(skills)
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
        Value::Object(entries) if matches!(field, "commands" | "agents") => {
            entries
                .into_iter()
                .map(|(name, entry)| {
                    let path = match &entry {
                        Value::String(path) => Some(path.as_str()),
                        Value::Object(value) => value.get("source").and_then(Value::as_str),
                        _ => None,
                    }
                    .ok_or_else(|| {
                        PluginManifestError::Invalid(format!(
                            "plugin field `{field}.{name}` must be a path or an object with a string source"
                        ))
                    })?;
                    resolve_resource(root, path)
                })
                .collect()
        }
        other => Err(PluginManifestError::Invalid(format!(
            "plugin field `{field}` must be a string path or array; got {other}"
        ))),
    }
}
