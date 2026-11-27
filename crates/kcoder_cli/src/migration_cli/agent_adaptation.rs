//! Reviewed Agent choices remain data until the ordinary Native plan and disabled publication.
use super::guide::GuideIo;
use anyhow::{Result, ensure};
use kcoder_types::migration_agent::{
    ImportedAgentExecution, ImportedAgentModel, MigrationAgentAdaptation,
    MigrationAgentCompatibility,
};
use serde_json::json;
use std::collections::BTreeSet;

pub(super) fn requested(io: &GuideIo) -> Result<bool> {
    io.yes("agent_adapt", "Review and explicitly adapt this static Agent? By default, only pending definitions are saved. Adapted Agents remain disabled; source tools, Hooks and models are not executed, and approval or directory permissions are not expanded.")
}

pub(super) fn inspect(io: &GuideIo, value: &MigrationAgentCompatibility) -> Result<bool> {
    validate(value)?;
    io.state("agent_compatibility", value)?;
    if !value.can_adapt {
        io.notice("migration_agent_pending_only", "The original definition contains unsupported semantics and cannot compile into a native Agent. You may separately confirm saving the pending original; it is not an executable migration.")?;
    }
    Ok(value.can_adapt)
}

fn validate(value: &MigrationAgentCompatibility) -> Result<()> {
    let tools = value.available_tools.iter().collect::<BTreeSet<_>>();
    ensure!(
        value.source_sha256.len() == 64
            && value
                .source_sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            && value.available_tools.len() <= 64
            && tools.len() == value.available_tools.len()
            && tools.iter().all(|name| known_tool(name))
            && (!value.can_adapt || value.problem.is_none()),
        "migration_agent_invalid_preview"
    );
    Ok(())
}

fn known_tool(name: &str) -> bool {
    // A remote target may use another OS; its reported subset is still authoritative.
    matches!(
        name,
        "read"
            | "write"
            | "edit"
            | "glob"
            | "grep"
            | "WebSearch"
            | "WebFetch"
            | "TodoWrite"
            | "bash"
            | "PowerShell"
    )
}

pub(super) fn choose(
    io: &GuideIo,
    value: &MigrationAgentCompatibility,
) -> Result<MigrationAgentAdaptation> {
    validate(value)?;
    ensure!(value.can_adapt, "migration_agent_pending_only");
    io.notice("migration_agent_model_boundary", "The source model is an unresolved alias. Explicitly inherit the current session model or enter exact IDs for a configured target Provider/model. Native validation still runs at startup; no first catalog entry or substitute model is selected.")?;
    let model = loop {
        match io
            .ask(
                "agent_model_kind",
                "Choose inherit or target; back abandons adaptation.",
                json!([
                    {"value":"inherit","label":"Explicitly inherit the runtime session model"},
                    {"value":"target","label":"Explicitly set the target Provider/model"}
                ]),
                None,
            )?
            .as_str()
        {
            "inherit" => break ImportedAgentModel::Inherit,
            "target" => {
                let model = ImportedAgentModel::Target {
                    provider: io.text(
                        "agent_provider",
                        "Exact target Provider ID (case-sensitive; do not enter credentials)",
                        None,
                    )?,
                    model: io.text(
                        "agent_model",
                        "Exact target model ID (not inferred from the source alias)",
                        None,
                    )?,
                };
                ensure!(
                    ImportedAgentExecution {
                        adapter_revision: "static-agent/v1".into(),
                        source_sha256: value.source_sha256.clone(),
                        model: model.clone()
                    }
                    .is_supported(),
                    "migration_agent_invalid_model_mapping"
                );
                break model;
            }
            "back" => anyhow::bail!("migration_agent_not_selected"),
            _ => io.notice(
                "migration_agent_invalid_selection",
                "Choose inherit or target; the original plan was not changed.",
            )?,
        }
    };
    let tools = tools(io, &value.available_tools)?;
    ensure!(
        io.text(
            "agent_reviewed_sha256",
            "Enter the original SHA256 from the report to confirm reviewing this definition, model mapping and selected tools. The import remains disabled.",
            None
        )? == value.source_sha256,
        "migration_agent_review_changed"
    );
    Ok(MigrationAgentAdaptation {
        reviewed_source_sha256: value.source_sha256.clone(),
        model,
        tools,
    })
}

fn tools(io: &GuideIo, available: &[String]) -> Result<Vec<String>> {
    let mut selected = BTreeSet::<String>::new();
    let mut page = 0;
    loop {
        let rows = available
            .iter()
            .skip(page * 10)
            .take(10)
            .enumerate()
            .map(|(at, name)| json!({"number":at+1,"tool":name,"selected":selected.contains(name)}))
            .collect::<Vec<_>>();
        let answer = io.ask("agent_tools", "Select only canonical tools allowed by the original definition and reported by the target. Default: none. toggle N selects/deselects; next/prev changes pages; done confirms (no tools is valid); back abandons. No MCP/dynamic tools are added and native approvals are not relaxed.", json!({"page":page,"items":rows,"selected":selected.len(),"hasNextPage":(page+1)*10<available.len()}), None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "done" => return Ok(selected.into_iter().collect()),
            "back" => anyhow::bail!("migration_agent_not_selected"),
            "next" if (page + 1) * 10 < available.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            "toggle" => {
                if let Some(name) = words
                    .next()
                    .and_then(|n| n.parse::<usize>().ok())
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| available.get(page * 10 + n - 1))
                {
                    if !selected.remove(name) {
                        selected.insert(name.clone());
                    }
                } else {
                    io.notice(
                        "migration_agent_invalid_selection",
                        "Select a reported tool number on this page; invented tool names are not accepted.",
                    )?;
                }
            }
            _ => io.notice(
                "migration_agent_invalid_selection",
                "Choose a listed operation; no tools are selected by default.",
            )?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_guard_binds_a_complete_hash_unique_known_target_tools_and_compatible_semantics() {
        let mut value = MigrationAgentCompatibility {
            source_sha256: "a".repeat(64),
            can_adapt: true,
            available_tools: vec!["PowerShell".into(), "read".into()],
            source_model_reference: true,
            problem: None,
        };
        validate(&value).unwrap();
        value.available_tools.push("read".into());
        assert!(validate(&value).is_err());
        value.available_tools = vec!["mcp_unreviewed_server".into()];
        assert!(validate(&value).is_err());
        value.available_tools.clear();
        value.source_sha256 = "a".repeat(63);
        assert!(validate(&value).is_err());
        value.source_sha256 = "a".repeat(64);
        value.problem =
            Some(kcoder_types::migration_agent::MigrationAgentProblem::UnsupportedSemantics);
        assert!(validate(&value).is_err());
        value.can_adapt = false;
        validate(&value).unwrap();
    }
}
