use super::PluginManifestError;
use super::codex;
use super::resources::resolve_resource;
use crate::model::{
    PluginContributionDeclarations, PluginInterface, PluginManifest, PluginManifestFormat,
    PluginMcpDeclaration,
};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgentPluginManifest {
    #[serde(rename = "$schema")]
    _schema: String,
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    author: Option<RawAuthor>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    keywords: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawAuthor {
    #[serde(default)]
    name: Option<String>,
}

pub(super) fn parse(
    root: &Path,
    contents: &str,
    codex_overlay: Option<&str>,
) -> Result<PluginManifest, PluginManifestError> {
    let raw: RawAgentPluginManifest = serde_json::from_str(contents)
        .map_err(|error| PluginManifestError::Json(error.to_string()))?;
    validate_name(&raw.name)?;

    let mut contributions = PluginContributionDeclarations::default();
    if existing_directory(&root.join("skills"))? {
        contributions
            .skills
            .push(resolve_resource(root, "./skills", true)?);
    }
    if existing_file(&root.join("mcp.json"))? {
        contributions.mcp_servers = Some(PluginMcpDeclaration::Path(resolve_resource(
            root,
            "./mcp.json",
            true,
        )?));
    }

    let mut interface = Some(PluginInterface {
        display_name: Some(raw.name.clone()),
        short_description: non_empty(raw.description.clone()),
        long_description: non_empty(raw.description.clone()),
        developer_name: raw.author.and_then(|author| non_empty(author.name)),
        website_url: non_empty(raw.homepage),
        category: Some("Other".to_string()),
        ..PluginInterface::default()
    });
    if let Some(overlay) = codex_overlay {
        let overlay = codex::parse(root, overlay)?;
        contributions.apps = overlay.contributions.apps;
        contributions.hooks = overlay.contributions.hooks;
        contributions.commands = overlay.contributions.commands;
        if overlay.interface.is_some() {
            interface = overlay.interface;
        }
    }

    Ok(PluginManifest {
        format: PluginManifestFormat::AgentPluginsV1,
        id: None,
        name: raw.name,
        version: non_empty(raw.version),
        description: non_empty(raw.description),
        keywords: raw.keywords,
        enabled_by_default: true,
        contributions,
        interface,
    })
}

fn validate_name(name: &str) -> Result<(), PluginManifestError> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && !name.contains("--")
        && !name.contains("..")
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-".contains(&byte)
        })
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric);
    if valid {
        Ok(())
    } else {
        Err(PluginManifestError::Invalid(format!(
            "invalid Agent Plugins name `{name}`; use lowercase letters, numbers, dots, or hyphens"
        )))
    }
}

fn existing_file(path: &Path) -> Result<bool, PluginManifestError> {
    existing_type(path, false)
}

fn existing_directory(path: &Path) -> Result<bool, PluginManifestError> {
    existing_type(path, true)
}

fn existing_type(path: &Path, directory: bool) -> Result<bool, PluginManifestError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(PluginManifestError::UnsafeResourcePath {
                path: path.display().to_string(),
                message: "Agent Plugins default resources cannot be symlinks".to_string(),
            })
        }
        Ok(metadata) => Ok(if directory {
            metadata.file_type().is_dir()
        } else {
            metadata.file_type().is_file()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(PluginManifestError::Io {
            path: path.to_path_buf(),
            source: error,
        }),
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}
