use super::PluginManifestError;
use super::codex;
use super::resources::{
    directory_under, entry_names_under, regular_file_under, resolve_resource, resolve_resource_path,
};
use crate::model::{
    CompatibilityIssue, PluginContributionDeclarations, PluginInterface, PluginManifest,
    PluginManifestFormat, PluginMcpDeclaration,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

const AGENT_PLUGIN_SCHEMA_SOURCE: &str = include_str!("agent_plugins_v1.schema.json");
const AGENT_PLUGIN_FIELDS: [&str; 10] = [
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
];

static AGENT_PLUGIN_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();

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
) -> Result<(PluginManifest, Vec<CompatibilityIssue>), PluginManifestError> {
    let mut document: Value = serde_json::from_str(contents)
        .map_err(|error| PluginManifestError::Json(error.to_string()))?;
    let fields = document.as_object_mut().ok_or_else(|| {
        PluginManifestError::Invalid("Agent Plugins v1 manifest must be a JSON object".to_string())
    })?;
    let ignored_fields = fields
        .keys()
        .filter(|field| !AGENT_PLUGIN_FIELDS.contains(&field.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for field in &ignored_fields {
        fields.remove(field);
    }
    let ignored_extensions = fields
        .get("extensions")
        .is_some_and(|extensions| !extensions.is_object());
    if ignored_extensions {
        fields.remove("extensions");
    }
    let mut warnings = ignored_fields
        .into_iter()
        .map(|field| CompatibilityIssue {
            code: "manifest_field_ignored".to_string(),
            capability: None,
            message: format!("unknown top-level Agent Plugins v1 field `{field}` was ignored"),
        })
        .collect::<Vec<_>>();
    if ignored_extensions {
        warnings.push(CompatibilityIssue {
            code: "manifest_field_ignored".to_string(),
            capability: None,
            message: "Agent Plugins v1 `extensions` was not an object and was ignored".to_string(),
        });
    }

    validate_agent_plugin_manifest(&document)?;
    let raw: RawAgentPluginManifest = serde_json::from_value(document)
        .map_err(|error| PluginManifestError::Json(error.to_string()))?;

    let mut contributions = PluginContributionDeclarations {
        skills: discover_fixed_skills(root, &mut warnings),
        mcp_servers: discover_fixed_mcp(root, &mut warnings),
        ..PluginContributionDeclarations::default()
    };

    for (field, target) in [
        ("commands", &mut contributions.commands),
        ("agents", &mut contributions.agents),
    ] {
        if let Some(resource) = discover_optional_directory(root, field, &mut warnings) {
            target.push(resource);
        }
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
        contributions.agents = overlay.contributions.agents;
        if overlay.interface.is_some() {
            interface = overlay.interface;
        }
    }

    Ok((
        PluginManifest {
            format: PluginManifestFormat::AgentPluginsV1,
            id: None,
            name: raw.name,
            version: non_empty(raw.version),
            description: non_empty(raw.description),
            keywords: raw.keywords,
            enabled_by_default: true,
            contributions,
            interface,
        },
        warnings,
    ))
}

fn validate_agent_plugin_manifest(document: &Value) -> Result<(), PluginManifestError> {
    let validator = match AGENT_PLUGIN_VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(AGENT_PLUGIN_SCHEMA_SOURCE)
            .expect("embedded Agent Plugins v1 schema must be valid JSON");
        jsonschema::validator_for(&schema).map_err(|error| error.to_string())
    }) {
        Ok(validator) => validator,
        Err(error) => {
            return Err(PluginManifestError::Invalid(format!(
                "embedded Agent Plugins v1 schema could not be compiled: {error}"
            )));
        }
    };
    // Agent Plugins assigns no validation semantics to extension namespaces a
    // client does not implement. Validate the required outer object above, but
    // leave its namespace values opaque as required by the specification text.
    let mut validation_document = document.clone();
    if let Some(fields) = validation_document.as_object_mut() {
        fields.remove("extensions");
    }
    let errors = validator
        .iter_errors(&validation_document)
        .take(8)
        .map(|error| {
            let path = error.instance_path().to_string();
            if path.is_empty() {
                "top-level value does not satisfy the Agent Plugins v1 schema".to_string()
            } else {
                format!("field `{path}` does not satisfy the Agent Plugins v1 schema")
            }
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(PluginManifestError::Invalid(format!(
            "Agent Plugins v1 manifest is invalid: {}",
            errors.join("; ")
        )))
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

const MAX_FIXED_SKILL_ENTRIES: usize = 4096;

fn discover_fixed_skills(
    root: &Path,
    warnings: &mut Vec<CompatibilityIssue>,
) -> Vec<crate::model::PluginResource> {
    let skills_root = Path::new("skills");
    let mut entries = match entry_names_under(root, skills_root, MAX_FIXED_SKILL_ENTRIES + 1) {
        Ok(Some(entries)) => entries,
        Ok(None) => return Vec::new(),
        Err(error) => {
            push_skill_warning(
                warnings,
                "component_invalid",
                format!("Agent Plugins v1 `skills` component was skipped: {error}"),
            );
            return Vec::new();
        }
    };
    if entries.len() > MAX_FIXED_SKILL_ENTRIES {
        push_skill_warning(
            warnings,
            "component_invalid",
            format!(
                "Agent Plugins v1 `skills` component exceeds the {MAX_FIXED_SKILL_ENTRIES}-entry limit"
            ),
        );
        return Vec::new();
    }
    entries.sort();

    let mut skills = Vec::new();
    for entry in entries {
        let Some(name) = entry.to_str() else {
            push_skill_warning(
                warnings,
                "component_entry_invalid",
                "Agent Plugins v1 skipped a skill directory with a non-Unicode name",
            );
            continue;
        };
        let relative_directory = skills_root.join(name);
        let is_directory = match directory_under(root, &relative_directory) {
            Ok(is_directory) => is_directory,
            Err(error) => {
                push_skill_warning(
                    warnings,
                    "component_entry_invalid",
                    format!("Agent Plugins v1 skill directory `{name}` was skipped: {error}"),
                );
                continue;
            }
        };
        if !is_directory {
            continue;
        }

        let entry_file = relative_directory.join("SKILL.md");
        let is_file = match regular_file_under(root, &entry_file) {
            Ok(is_file) => is_file,
            Err(error) => {
                push_skill_warning(
                    warnings,
                    "component_entry_invalid",
                    format!("Agent Plugins v1 skill `{name}` was skipped: {error}"),
                );
                continue;
            }
        };
        if !is_file {
            match directory_under(root, &entry_file) {
                Ok(false) => {}
                Ok(true) => push_skill_warning(
                    warnings,
                    "component_entry_invalid",
                    format!(
                        "Agent Plugins v1 skill `{name}` has a non-file `SKILL.md` and was skipped"
                    ),
                ),
                Err(error) => push_skill_warning(
                    warnings,
                    "component_entry_invalid",
                    format!("Agent Plugins v1 skill `{name}` was skipped: {error}"),
                ),
            }
            continue;
        }

        match resolve_resource_path(root, &relative_directory) {
            Ok(resource) => skills.push(resource),
            Err(error) => push_skill_warning(
                warnings,
                "component_entry_invalid",
                format!("Agent Plugins v1 skill directory `{name}` was skipped: {error}"),
            ),
        }
    }
    skills
}

fn discover_optional_directory(
    root: &Path,
    capability: &str,
    warnings: &mut Vec<CompatibilityIssue>,
) -> Option<crate::model::PluginResource> {
    let relative = Path::new(capability);
    match directory_under(root, relative) {
        Ok(true) => match resolve_resource(root, &format!("./{capability}")) {
            Ok(resource) => Some(resource),
            Err(error) => {
                push_component_warning(
                    warnings,
                    "component_invalid",
                    capability,
                    format!("Agent Plugins v1 `{capability}` component was skipped: {error}"),
                );
                None
            }
        },
        Ok(false) => match regular_file_under(root, relative) {
            Ok(false) => None,
            Ok(true) => {
                push_component_warning(
                    warnings,
                    "component_invalid",
                    capability,
                    format!("Agent Plugins v1 `{capability}` component is not a directory"),
                );
                None
            }
            Err(error) => {
                push_component_warning(
                    warnings,
                    "component_invalid",
                    capability,
                    format!("Agent Plugins v1 `{capability}` component was skipped: {error}"),
                );
                None
            }
        },
        Err(error) => {
            push_component_warning(
                warnings,
                "component_invalid",
                capability,
                format!("Agent Plugins v1 `{capability}` component was skipped: {error}"),
            );
            None
        }
    }
}

fn push_skill_warning(
    warnings: &mut Vec<CompatibilityIssue>,
    code: &str,
    message: impl Into<String>,
) {
    push_component_warning(warnings, code, "skills", message);
}

fn discover_fixed_mcp(
    root: &Path,
    warnings: &mut Vec<CompatibilityIssue>,
) -> Option<PluginMcpDeclaration> {
    let mcp_path = Path::new("mcp.json");
    match regular_file_under(root, mcp_path) {
        Ok(true) => match resolve_resource(root, "./mcp.json") {
            Ok(resource) => Some(PluginMcpDeclaration::Path(resource)),
            Err(error) => {
                push_component_warning(
                    warnings,
                    "component_invalid",
                    "mcp_servers",
                    format!("Agent Plugins v1 `mcp.json` component was skipped: {error}"),
                );
                None
            }
        },
        Ok(false) => match directory_under(root, mcp_path) {
            Ok(false) => None,
            Ok(true) => {
                push_component_warning(
                    warnings,
                    "component_invalid",
                    "mcp_servers",
                    "Agent Plugins v1 `mcp.json` component is not a file",
                );
                None
            }
            Err(error) => {
                push_component_warning(
                    warnings,
                    "component_invalid",
                    "mcp_servers",
                    format!("Agent Plugins v1 `mcp.json` component was skipped: {error}"),
                );
                None
            }
        },
        Err(error) => {
            push_component_warning(
                warnings,
                "component_invalid",
                "mcp_servers",
                format!("Agent Plugins v1 `mcp.json` component was skipped: {error}"),
            );
            None
        }
    }
}

fn push_component_warning(
    warnings: &mut Vec<CompatibilityIssue>,
    code: &str,
    capability: &str,
    message: impl Into<String>,
) {
    warnings.push(CompatibilityIssue {
        code: code.into(),
        capability: Some(capability.into()),
        message: message.into(),
    });
}
