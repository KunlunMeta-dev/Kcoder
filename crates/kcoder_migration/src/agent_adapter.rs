//! Compile reviewed static Agent data into a disabled native, permission-bound launcher.
use anyhow::{Result, ensure};
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_skills::{SkillActivation, SkillPackage, SkillPackageFile};
use kcoder_types::{
    migration_agent::{ImportedAgentExecution, MigrationAgentAdaptation},
    migration_definitions::MigrationDefinitionFormat as Format,
    plugin_prompt::PluginPromptProfile,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(crate) fn package(
    format: Format,
    bytes: &[u8],
    name: &str,
    token: &str,
    scope: &ImportedContextScope,
    choice: &MigrationAgentAdaptation,
) -> Result<SkillPackage> {
    kcoder_skills::store::validate_skill_name(name)
        .map_err(|_| anyhow::anyhow!("migration_invalid_asset_name"))?;
    let execution = ImportedAgentExecution {
        adapter_revision: "static-agent/v1".into(),
        source_sha256: format!("{:x}", Sha256::digest(bytes)),
        model: choice.model.clone(),
    };
    ensure!(
        execution.is_supported(),
        "migration_agent_invalid_model_mapping"
    );
    ensure!(
        choice.reviewed_source_sha256 == execution.source_sha256,
        "migration_agent_review_changed"
    );
    let StaticDefinition {
        document,
        instructions,
        source_tools,
        denied_tools,
        max_turns,
    } = inspect(format, bytes)?;
    let fields = document.0.as_object().expect("validated Agent document");
    let selected = choice.tools.iter().cloned().collect::<BTreeSet<_>>();
    ensure!(
        choice.tools.len() <= 64
            && selected.len() == choice.tools.len()
            && selected
                .iter()
                .all(|tool| kcoder_types::migration_agent::is_imported_agent_tool(tool)),
        "migration_agent_invalid_tools"
    );
    ensure!(
        selected.iter().all(|tool| source_tools
            .as_ref()
            .is_none_or(|allowed| allowed.contains(tool))
            && !denied_tools.contains(tool)),
        "migration_agent_tool_restriction"
    );
    let profile = PluginPromptProfile {
        imported_agent: Some(execution),
        instructions: instructions.to_string(),
        argument_names: Vec::new(),
        plugin_root: String::new(),
        source: String::new(),
        kind: "agent".into(),
        allowed_tools: Some(choice.tools.clone()),
        max_turns,
    };
    let activation = SkillActivation {
        token: token.into(),
        default_enabled: false,
        workspace: match scope {
            ImportedContextScope::Global => None,
            ImportedContextScope::Project { root } => Some(root.clone()),
        },
    };
    let header = serde_yaml::to_string(&serde_json::json!({
        "name": name, "description": fields["description"],
        "metadata": { "kcoder": { "category": "plugin-prompt" } }, "activation": activation,
    }))?;
    let launcher = format!(
        "---\n{header}---\nRun this reviewed native Agent with spawn_agent(plugin_agent={name:?}, message=<the user's task>). The child alone receives the imported instructions. Native permissions, source tool restrictions and the explicit native model mapping remain authoritative. Do not interpret this launcher as permission to ask the user or bypass approval.\n"
    );
    let package = SkillPackage {
        name: name.into(),
        files: vec![
            SkillPackageFile {
                relative_path: "SKILL.md".into(),
                content: launcher.into_bytes(),
                executable: false,
            },
            SkillPackageFile {
                relative_path: "plugin-agent.json".into(),
                content: serde_json::to_vec(&profile)?,
                executable: false,
            },
        ],
    };
    kcoder_skills::canonical_package_revision(&package)
        .map_err(|_| anyhow::anyhow!("migration_invalid_skill_package"))?;
    Ok(package)
}

struct StaticDefinition {
    document: crate::definition_adapter::PrivateValue,
    instructions: zeroize::Zeroizing<String>,
    source_tools: Option<BTreeSet<String>>,
    denied_tools: BTreeSet<String>,
    max_turns: Option<usize>,
}
fn inspect(format: Format, bytes: &[u8]) -> Result<StaticDefinition> {
    let (document, instructions) = crate::definition_adapter::agent_document(format, bytes)?;
    let encoded_instructions = zeroize::Zeroizing::new(serde_json::to_vec(instructions.as_str())?);
    ensure!(
        encoded_instructions.len() <= 256 * 1024 - 8192,
        "migration_agent_parse_budget"
    );
    let fields = document
        .0
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("migration_agent_format"))?;
    let allowed = match format {
        Format::ClaudeAgentMarkdown => &[
            "name",
            "description",
            "tools",
            "disallowedTools",
            "model",
            "maxTurns",
            "color",
        ][..],
        Format::CodexAgentToml => &["name", "description", "developer_instructions", "model"][..],
        _ => anyhow::bail!("migration_not_an_agent"),
    };
    // Unknown behavior, hooks, permission modes and dependency surfaces stay pending.
    ensure!(
        fields.keys().all(|key| allowed.contains(&key.as_str())),
        "migration_agent_semantics_require_review"
    );
    for field in ["name", "description"] {
        ensure!(
            fields
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty()
                    && text.len() <= 4096
                    && !text.contains('\0')),
            "migration_agent_format"
        );
    }
    for field in ["model", "color"] {
        ensure!(
            fields
                .get(field)
                .is_none_or(
                    |value| value.as_str().is_some_and(|text| !text.trim().is_empty()
                        && text.len() <= 256
                        && !text.chars().any(char::is_control))
                ),
            "migration_agent_format"
        );
    }
    let source_tools = fields.get("tools").map(tool_list).transpose()?;
    let denied_tools = fields
        .get("disallowedTools")
        .map(tool_list)
        .transpose()?
        .unwrap_or_default();
    let max_turns = fields
        .get("maxTurns")
        .map(|value| {
            value
                .as_u64()
                .filter(|count| (1..=100).contains(count))
                .map(|count| count as usize)
                .ok_or_else(|| anyhow::anyhow!("migration_agent_turn_limit"))
        })
        .transpose()?;
    Ok(StaticDefinition {
        document,
        instructions,
        source_tools,
        denied_tools,
        max_turns,
    })
}

pub(crate) fn preview(
    format: Format,
    bytes: &[u8],
) -> kcoder_types::migration_agent::MigrationAgentCompatibility {
    use kcoder_types::migration_agent::{MigrationAgentCompatibility, MigrationAgentProblem};
    let mut result = MigrationAgentCompatibility {
        source_sha256: format!("{:x}", Sha256::digest(bytes)),
        can_adapt: false,
        available_tools: vec![],
        source_model_reference: false,
        problem: None,
    };
    match inspect(format, bytes) {
        Ok(definition) => {
            result.can_adapt = true;
            result.source_model_reference = definition.document.0.get("model").is_some();
            result.available_tools = [
                "read",
                "write",
                "edit",
                "glob",
                "grep",
                "WebSearch",
                "WebFetch",
                "TodoWrite",
                "bash",
                "PowerShell",
            ]
            .into_iter()
            .filter(|name| kcoder_types::migration_agent::is_imported_agent_tool(name))
            .filter(|name| {
                definition
                    .source_tools
                    .as_ref()
                    .is_none_or(|tools| tools.contains(*name))
                    && !definition.denied_tools.contains(*name)
            })
            .map(str::to_owned)
            .collect();
        }
        Err(error) => {
            result.problem = Some(match error.to_string().as_str() {
                "migration_agent_parse_budget" => MigrationAgentProblem::Budget,
                "migration_agent_semantics_require_review" => {
                    MigrationAgentProblem::UnsupportedSemantics
                }
                "migration_agent_tool_unsupported" => MigrationAgentProblem::UnsupportedTools,
                _ => MigrationAgentProblem::InvalidDefinition,
            })
        }
    }
    result
}

fn tool_list(value: &Value) -> Result<BTreeSet<String>> {
    let words = match value {
        Value::String(text) => text
            .split(|c: char| c == ',' || c.is_ascii_whitespace())
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("migration_agent_invalid_tools"))
            })
            .collect::<Result<Vec<_>>>()?,
        _ => anyhow::bail!("migration_agent_invalid_tools"),
    };
    ensure!(words.len() <= 64, "migration_agent_invalid_tools");
    words
        .into_iter()
        .map(|word| {
            Ok(match word {
                "Read" => "read",
                "Write" => "write",
                "Edit" => "edit",
                "Glob" => "glob",
                "Grep" => "grep",
                "Bash" if cfg!(unix) => "bash",
                "PowerShell" if cfg!(windows) => "PowerShell",
                "WebSearch" => "WebSearch",
                "WebFetch" => "WebFetch",
                "TodoWrite" => "TodoWrite",
                _ => anyhow::bail!("migration_agent_tool_unsupported"),
            }
            .to_owned())
        })
        .collect()
}
#[cfg(test)]
mod tests;
