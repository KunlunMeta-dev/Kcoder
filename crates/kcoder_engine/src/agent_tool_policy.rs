//! One expert tool-selection policy for task execution and Native admission.
use anyhow::Result;
use kcoder_types::integrations::office::OfficeAssistantDefinition;
use std::collections::{BTreeMap, BTreeSet};

/// In-memory explanation of the same restrictions used by execution.
pub struct AgentToolPolicy {
    pub allowed_tools: Vec<String>,
    pub excluded_by_expert: BTreeSet<String>,
    pub excluded_by_skills: BTreeMap<String, Vec<String>>,
}

/// A task expert has one user selection. Luna supplies the inherited default.
pub fn task_expert_tool_selection<'a>(
    definition: &'a OfficeAssistantDefinition,
    luna: &'a [String],
) -> &'a [String] {
    definition.allowed_tools.as_deref().unwrap_or(luna)
}

/// Intersect expert and enabled-skill restrictions with an already permitted baseline.
/// The caller owns the baseline's authority; this pure resolver never registers tools.
pub fn resolve_agent_tool_names(
    definition: &OfficeAssistantDefinition,
    baseline: &[String],
) -> Result<Vec<String>> {
    Ok(resolve(definition, baseline, false)?.allowed_tools)
}

pub fn resolve_agent_tool_policy(
    definition: &OfficeAssistantDefinition,
    baseline: &[String],
) -> Result<AgentToolPolicy> {
    resolve(definition, baseline, true)
}

fn resolve(
    definition: &OfficeAssistantDefinition,
    baseline: &[String],
    explain: bool,
) -> Result<AgentToolPolicy> {
    definition.validate()?;
    let available = baseline.iter().cloned().collect::<BTreeSet<_>>();
    let mut ceiling = match &definition.allowed_tools {
        Some(names) => names
            .iter()
            .filter(|name| available.contains(*name))
            .cloned()
            .collect::<BTreeSet<_>>(),
        None => available.clone(),
    };
    let excluded_by_expert = if explain {
        available.difference(&ceiling).cloned().collect()
    } else {
        BTreeSet::new()
    };
    let mut excluded_by_skills = BTreeMap::<String, Vec<String>>::new();
    for skill in definition.skills.iter().filter(|skill| skill.enabled) {
        let selected = skill
            .allowed_tools
            .clone()
            .or(kcoder_skills::skill_tool_selection(&skill.content)?);
        if let Some(allowed) = selected {
            let mut selected = allowed
                .iter()
                .map(|name| {
                    match name.as_str() {
                        "Read" => "read",
                        "Grep" => "grep",
                        "Glob" => "glob",
                        "Bash" => "bash",
                        "Edit" => "edit",
                        "Write" => "write",
                        other => other,
                    }
                    .to_owned()
                })
                .collect::<BTreeSet<_>>();
            if !allowed.is_empty() {
                // A nonempty skill restriction retains only loaders already permitted above.
                for control in ["skill", "DiscoverSkills"] {
                    if ceiling.contains(control) {
                        selected.insert(control.into());
                    }
                }
            }
            if explain {
                for name in ceiling.difference(&selected) {
                    excluded_by_skills
                        .entry(name.clone())
                        .or_default()
                        .push(skill.slug.clone());
                }
            }
            ceiling.retain(|name| selected.contains(name));
        }
    }
    // Keep the caller's existing order so admission fingerprints do not drift.
    let mut seen = BTreeSet::new();
    let allowed_tools = baseline
        .iter()
        .filter(|name| ceiling.contains(*name) && seen.insert((*name).clone()))
        .cloned()
        .collect();
    Ok(AgentToolPolicy {
        allowed_tools,
        excluded_by_expert,
        excluded_by_skills,
    })
}
