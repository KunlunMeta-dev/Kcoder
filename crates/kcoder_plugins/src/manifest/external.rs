use super::PluginManifestError;
use super::resources::{parse_resource_list, resolve_resource};
use crate::model::{
    PluginAsset, PluginContributionDeclarations, PluginHookDeclaration, PluginInterface,
    PluginManifest, PluginManifestFormat, PluginMcpDeclaration,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawExternalManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    skills: Option<Value>,
    #[serde(default)]
    mcp_servers: Option<Value>,
    #[serde(default)]
    apps: Option<String>,
    #[serde(default)]
    hooks: Option<Value>,
    #[serde(default)]
    commands: Option<Value>,
    #[serde(default)]
    interface: Option<RawPluginInterface>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPluginInterface {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    short_description: Option<String>,
    #[serde(default)]
    long_description: Option<String>,
    #[serde(default)]
    developer_name: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default, alias = "websiteURL")]
    website_url: Option<String>,
    #[serde(default, alias = "privacyPolicyURL")]
    privacy_policy_url: Option<String>,
    #[serde(default, alias = "termsOfServiceURL")]
    terms_of_service_url: Option<String>,
    #[serde(default)]
    default_prompt: Option<Value>,
    #[serde(default)]
    brand_color: Option<String>,
    #[serde(default)]
    composer_icon: Option<String>,
    #[serde(default)]
    logo: Option<String>,
    #[serde(default)]
    logo_dark: Option<String>,
    #[serde(default)]
    screenshots: Vec<String>,
}

pub(super) fn parse(
    root: &Path,
    contents: &str,
    format: PluginManifestFormat,
) -> Result<PluginManifest, PluginManifestError> {
    let raw: RawExternalManifest = serde_json::from_str(contents)
        .map_err(|error| PluginManifestError::Json(error.to_string()))?;
    let name = if raw.name.trim().is_empty() {
        root.file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| {
                PluginManifestError::Invalid(
                    "external plugin manifest has no usable name".to_string(),
                )
            })?
            .to_string()
    } else {
        raw.name
    };

    let skills = match raw.skills {
        Some(skills) => parse_resource_list(root, Some(skills), "skills", true)?,
        None => conventional_directory(root, "skills")?,
    };
    let commands = match raw.commands {
        Some(commands) => parse_resource_list(root, Some(commands), "commands", true)?,
        None => conventional_directory(root, "commands")?,
    };
    let mcp_servers = match raw.mcp_servers {
        Some(mcp_servers) => parse_mcp(root, Some(mcp_servers))?,
        None => conventional_mcp(root)?,
    };
    let apps = raw
        .apps
        .map(|path| resolve_resource(root, &path, true))
        .transpose()?;
    let mut hooks = Vec::new();
    if let Some(value) = raw.hooks {
        parse_hooks(root, value, &mut hooks)?;
    } else if root.join("hooks/hooks.json").is_file() {
        hooks.push(PluginHookDeclaration::Path(resolve_resource(
            root,
            "./hooks/hooks.json",
            true,
        )?));
    }
    let interface = raw
        .interface
        .map(|interface| parse_interface(root, interface))
        .transpose()?;

    Ok(PluginManifest {
        format,
        id: None,
        name,
        version: non_empty(raw.version),
        description: non_empty(raw.description),
        keywords: raw.keywords,
        enabled_by_default: true,
        contributions: PluginContributionDeclarations {
            skills,
            mcp_servers,
            apps,
            hooks,
            commands,
        },
        interface,
    })
}

fn parse_mcp(
    root: &Path,
    value: Option<Value>,
) -> Result<Option<PluginMcpDeclaration>, PluginManifestError> {
    match value {
        None => Ok(None),
        Some(Value::String(path)) => Ok(Some(PluginMcpDeclaration::Path(resolve_resource(
            root, &path, true,
        )?))),
        Some(Value::Object(map)) => Ok(Some(PluginMcpDeclaration::Inline(Value::Object(map)))),
        Some(other) => Err(PluginManifestError::Invalid(format!(
            "plugin field `mcpServers` must be a string path or object; got {other}"
        ))),
    }
}

fn parse_hooks(
    root: &Path,
    value: Value,
    out: &mut Vec<PluginHookDeclaration>,
) -> Result<(), PluginManifestError> {
    match value {
        Value::String(path) => out.push(PluginHookDeclaration::Path(resolve_resource(
            root, &path, true,
        )?)),
        Value::Array(items) => {
            for item in items {
                parse_hooks(root, item, out)?;
            }
        }
        Value::Object(map) => out.push(PluginHookDeclaration::Inline(Value::Object(map))),
        other => {
            return Err(PluginManifestError::Invalid(format!(
                "plugin field `hooks` must be a string path, object, or array; got {other}"
            )));
        }
    }
    Ok(())
}

fn parse_interface(
    root: &Path,
    raw: RawPluginInterface,
) -> Result<PluginInterface, PluginManifestError> {
    let default_prompt = match raw.default_prompt {
        None => Vec::new(),
        Some(Value::String(prompt)) => vec![prompt],
        Some(Value::Array(items)) => items
            .into_iter()
            .map(|item| match item {
                Value::String(prompt) => Ok(prompt),
                other => Err(PluginManifestError::Invalid(format!(
                    "plugin interface defaultPrompt must contain only strings; got {other}"
                ))),
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(other) => {
            return Err(PluginManifestError::Invalid(format!(
                "plugin interface defaultPrompt must be a string or array; got {other}"
            )));
        }
    };

    Ok(PluginInterface {
        display_name: non_empty(raw.display_name),
        short_description: non_empty(raw.short_description),
        long_description: non_empty(raw.long_description),
        developer_name: non_empty(raw.developer_name),
        category: non_empty(raw.category),
        capabilities: raw.capabilities,
        website_url: non_empty(raw.website_url),
        privacy_policy_url: non_empty(raw.privacy_policy_url),
        terms_of_service_url: non_empty(raw.terms_of_service_url),
        default_prompt,
        brand_color: non_empty(raw.brand_color),
        composer_icon: raw
            .composer_icon
            .map(|path| parse_asset(root, &path))
            .transpose()?,
        logo: raw.logo.map(|path| parse_asset(root, &path)).transpose()?,
        logo_dark: raw
            .logo_dark
            .map(|path| parse_asset(root, &path))
            .transpose()?,
        screenshots: raw
            .screenshots
            .into_iter()
            .map(|path| parse_asset(root, &path))
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn conventional_directory(
    root: &Path,
    name: &str,
) -> Result<Vec<crate::model::PluginResource>, PluginManifestError> {
    if root.join(name).is_dir() {
        Ok(vec![resolve_resource(root, &format!("./{name}"), true)?])
    } else {
        Ok(Vec::new())
    }
}

fn conventional_mcp(root: &Path) -> Result<Option<PluginMcpDeclaration>, PluginManifestError> {
    for relative in ["./.mcp.json", "./mcp.json"] {
        if root.join(relative.trim_start_matches("./")).is_file() {
            return Ok(Some(PluginMcpDeclaration::Path(resolve_resource(
                root, relative, true,
            )?)));
        }
    }
    Ok(None)
}

fn parse_asset(root: &Path, value: &str) -> Result<PluginAsset, PluginManifestError> {
    if value.starts_with("https://") {
        let url = url::Url::parse(value).map_err(|error| {
            PluginManifestError::Invalid(format!("invalid HTTPS plugin asset URL: {error}"))
        })?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(PluginManifestError::Invalid(
                "plugin asset URL may not contain credentials, query, or fragment".to_string(),
            ));
        }
        return Ok(PluginAsset::RemoteUrl(url.to_string()));
    }
    Ok(PluginAsset::Local(resolve_resource(root, value, true)?))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}
