mod agent_plugins_v1;
mod claude;
mod codex;
mod cursor;
mod external;
mod kcoder;
mod resources;

use crate::model::{LoadedPluginManifest, PluginManifest, PluginManifestFormat};
use resources::regular_file;
use serde_json::Value;
use std::fmt;
use std::path::{Path, PathBuf};

const AGENT_PLUGIN_SCHEMA_URI: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_PLUGIN_SCHEMA_PREFIX: &str = "https://agent-plugins.org/schemas/";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

const ROOT_AGENT_OR_LEGACY: &str = "plugin.json";
const ROOT_KCODER_LEGACY: &str = "kcoder-plugin.json";
const KCODER_MANIFEST: &str = ".kcoder-plugin/plugin.json";
const CODEX_MANIFEST: &str = ".codex-plugin/plugin.json";
const CLAUDE_MANIFEST: &str = ".claude-plugin/plugin.json";
const CURSOR_MANIFEST: &str = ".cursor-plugin/plugin.json";

type ManifestParser = fn(&Path, &str) -> Result<PluginManifest, PluginManifestError>;

#[derive(Debug)]
pub enum PluginManifestError {
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Json(String),
    Invalid(String),
    UnsupportedSchema(String),
    UnsafeResourcePath {
        path: String,
        message: String,
    },
}

impl PluginManifestError {
    pub fn diagnostic_code(&self) -> &'static str {
        match self {
            Self::Io { .. } => "manifest_io",
            Self::Json(_) | Self::Invalid(_) => "invalid_manifest",
            Self::UnsupportedSchema(_) => "unsupported_schema",
            Self::UnsafeResourcePath { .. } => "unsafe_resource_path",
        }
    }
}

impl fmt::Display for PluginManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => {
                write!(formatter, "failed to read `{}`: {source}", path.display())
            }
            Self::Json(message) => write!(formatter, "invalid plugin manifest JSON: {message}"),
            Self::Invalid(message) => formatter.write_str(message),
            Self::UnsupportedSchema(schema) => {
                write!(formatter, "unsupported plugin schema `{schema}`")
            }
            Self::UnsafeResourcePath { path, message } => {
                write!(formatter, "unsafe plugin resource path `{path}`: {message}")
            }
        }
    }
}

impl std::error::Error for PluginManifestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

pub fn load_plugin_manifest(
    root: &Path,
) -> Result<Option<LoadedPluginManifest>, PluginManifestError> {
    let root_manifest = root.join(ROOT_AGENT_OR_LEGACY);
    let root_contents = if regular_file(&root_manifest)? {
        Some(read_manifest(&root_manifest)?)
    } else {
        None
    };

    if let Some(contents) = root_contents.as_deref()
        && let Some(schema) = declared_schema(contents)
    {
        if schema == AGENT_PLUGIN_SCHEMA_URI {
            let overlay_path = root.join(CODEX_MANIFEST);
            let overlay = if regular_file(&overlay_path)? {
                Some(read_manifest(&overlay_path)?)
            } else {
                None
            };
            let manifest = agent_plugins_v1::parse(root, contents, overlay.as_deref())?;
            let shadowed = shadowed_manifests(root, &root_manifest, Some(&overlay_path))?;
            return Ok(Some(LoadedPluginManifest::new(
                manifest,
                root_manifest,
                shadowed,
            )));
        }
        if schema.starts_with(AGENT_PLUGIN_SCHEMA_PREFIX) {
            return Err(PluginManifestError::UnsupportedSchema(schema));
        }
    }

    let external_candidates: [(&str, ManifestParser); 4] = [
        (KCODER_MANIFEST, |root, contents| {
            external::parse(root, contents, PluginManifestFormat::Kcoder)
        }),
        (CODEX_MANIFEST, codex::parse),
        (CLAUDE_MANIFEST, claude::parse),
        (CURSOR_MANIFEST, cursor::parse),
    ];
    for (relative, parser) in external_candidates {
        let path = root.join(relative);
        if regular_file(&path)? {
            let manifest = parser(root, &read_manifest(&path)?)?;
            let shadowed = shadowed_manifests(root, &path, None)?;
            return Ok(Some(LoadedPluginManifest::new(manifest, path, shadowed)));
        }
    }

    if let Some(contents) = root_contents {
        let manifest = kcoder::parse(root, &contents, PluginManifestFormat::KcoderLegacy)?;
        let shadowed = shadowed_manifests(root, &root_manifest, None)?;
        return Ok(Some(LoadedPluginManifest::new(
            manifest,
            root_manifest,
            shadowed,
        )));
    }

    let legacy_path = root.join(ROOT_KCODER_LEGACY);
    if regular_file(&legacy_path)? {
        let manifest = kcoder::parse(
            root,
            &read_manifest(&legacy_path)?,
            PluginManifestFormat::KcoderLegacy,
        )?;
        let shadowed = shadowed_manifests(root, &legacy_path, None)?;
        return Ok(Some(LoadedPluginManifest::new(
            manifest,
            legacy_path,
            shadowed,
        )));
    }

    Ok(None)
}

fn declared_schema(contents: &str) -> Option<String> {
    let value: Value = serde_json::from_str(contents).ok()?;
    value.get("$schema")?.as_str().map(str::to_string)
}

fn read_manifest(path: &Path) -> Result<String, PluginManifestError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|source| PluginManifestError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(PluginManifestError::Invalid(format!(
            "plugin manifest exceeds {MAX_MANIFEST_BYTES} bytes: {}",
            path.display()
        )));
    }
    std::fs::read_to_string(path).map_err(|source| PluginManifestError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn shadowed_manifests(
    root: &Path,
    selected: &Path,
    consumed_overlay: Option<&Path>,
) -> Result<Vec<PathBuf>, PluginManifestError> {
    let mut shadowed = Vec::new();
    for relative in [
        ROOT_AGENT_OR_LEGACY,
        KCODER_MANIFEST,
        CODEX_MANIFEST,
        CLAUDE_MANIFEST,
        CURSOR_MANIFEST,
        ROOT_KCODER_LEGACY,
    ] {
        let path = root.join(relative);
        if path != selected
            && consumed_overlay.is_none_or(|overlay| path != overlay)
            && regular_file(&path)?
        {
            shadowed.push(path);
        }
    }
    Ok(shadowed)
}
