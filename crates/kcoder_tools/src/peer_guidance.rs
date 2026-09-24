//! Request-scoped peer-tool routing. Static descriptions state capabilities;
//! this explicit table names only peers actually attached to the same request.
use crate::ToolDescriptionContext;
use kcoder_types::ToolDefinition;

pub fn project_builtin_peer_guidance(
    definition: &mut ToolDefinition,
    ctx: &ToolDescriptionContext,
) {
    let name = definition.name.as_str();
    let mut hints = Vec::new();
    let mut peer = |tool: &str, purpose: &str| {
        if tool != name && ctx.available_tools.contains(tool) {
            hints.push(format!("Use {tool} {purpose}."));
        }
    };
    match name {
        "spawn_agent" | "explore_agent" | "PlanAgent" => {
            peer(
                "wait",
                "when waiting for a tracked agent completion blocks the next step",
            );
            peer(
                "TaskOutput",
                "for incremental output of a running managed job",
            );
            peer("TaskStop", "to cancel a running managed job");
            peer(
                "SendMessage",
                "to send a durable follow-up to a tracked agent without re-inheriting parent context",
            );
            peer(
                "close_agent",
                "to release a finished agent that is no longer needed",
            );
            if name == "spawn_agent" {
                peer("explore_agent", "for dedicated read-only reconnaissance");
            }
        }
        "TaskList" | "TaskGet" | "TaskUpdate" | "TaskStop" | "wait" | "close_agent" => {
            if name == "TaskUpdate" {
                peer(
                    "TaskGet",
                    "to inspect the latest task state before updating",
                );
            }
            peer("TaskOutput", "to inspect a managed job's live output");
            peer("TaskStop", "to cancel a running managed job");
        }
        "TaskOutput" => peer("wait", "when only tracked-agent completion is needed"),
        "SendMessage" => {
            peer(
                "TaskOutput",
                "for background command output; agent messages do not control shell jobs",
            );
            peer("TaskStop", "to cancel a background command");
        }
        "bash" | "PowerShell" => {
            for (tool, purpose) in [
                ("glob", "for file enumeration"),
                ("grep", "for content search"),
                ("read", "for file reading"),
                ("edit", "for targeted text edits"),
                ("apply_patch", "for patch-based changes"),
                ("write", "for file creation or complete replacement"),
            ] {
                peer(tool, purpose);
            }
            peer("TaskOutput", "to inspect managed background output");
            peer("TaskStop", "to cancel managed background commands");
        }
        "ocr" | "Workflow" => {
            peer("TaskOutput", "to inspect background output");
            peer("TaskStop", "to cancel a running background job");
        }
        "TaskCreate" => {
            peer(
                "TaskUpdate",
                "to update task status, ownership or dependencies",
            );
            peer("TodoWrite", "for a current-session execution checklist");
        }
        "glob" => peer("grep", "for content rather than filename search"),
        "skill_manage" | "skill_hub" | "skill_curator" => {
            peer("skill", "to activate a known skill");
            peer("skill_manage", "to author project skills");
            peer("skill_hub", "for installation or bundled synchronization");
            peer("skill_curator", "for skill lifecycle housekeeping");
        }
        "WriteReport" => {
            peer("PlanAgent", "to delegate a new plan artifact");
            peer("WritePlan", "to author a plan artifact within the permitted role");
        }
        "SpecStatus" => peer("SpecCheck", "for validation or apply preflight"),
        "SpecCheck" => peer("SpecStatus", "for non-enforcing state inspection"),
        "RecordTaskAcceptance" => peer(
            "RecordTaskAcceptances",
            "for one atomic multi-task acceptance wave",
        ),
        "remember" | "memory_get" | "memory_search" | "LocalMemoryRecall" => {
            peer("memory_search", "to search structured memories");
            peer("memory_get", "to fetch a structured memory by ID");
            peer("remember", "to store a new durable fact");
            peer("LocalMemoryRecall", "to read user-managed curated notes");
        }
        "EnterWorktree" | "ExitWorktree" | "WorktreeCreate" | "WorktreeRemove" => {
            peer("EnterWorktree", "to enter a managed worktree session");
            peer("ExitWorktree", "to leave the managed worktree session");
            peer(
                "WorktreeCreate",
                "to create a worktree without changing session cwd",
            );
            peer(
                "WorktreeRemove",
                "to explicitly remove a worktree outside the current session cwd",
            );
            peer(
                "spawn_agent",
                "with isolation=worktree for independent delegated changes",
            );
        }
        "TodoWrite" => peer(
            "TaskCreate",
            "for cross-turn work with owners or dependencies",
        ),
        "skill" => {
            peer("DiscoverSkills", "to find the exact skill name");
            peer("skill_manage", "to create or edit skill resources");
            peer("skill_hub", "to install community skills");
            peer("skill_curator", "for lifecycle housekeeping");
        }
        "DiscoverSkills" => peer(
            "skill",
            "to activate the selected skill before applying its workflow",
        ),
        "WebBrowser" | "WebSearch" => {
            peer("WebFetch", "to retrieve source documents and HTTP metadata")
        }
        "read" => peer("grep", "for content search beyond a bounded read"),
        "write" => peer("edit", "when a targeted edit is sufficient"),
        "edit" => peer("write", "for new files or complete replacement"),
        _ => {}
    }
    if !hints.is_empty() {
        definition
            .description
            .push_str("\n\nAvailable peer operations: ");
        definition.description.push_str(&hints.join(" "));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn builtin_singletons_never_direct_calls_to_unattached_peers() {
        let mut tools = std::collections::BTreeMap::new();
        for registry in [
            crate::default_registry(),
            crate::core_registry(),
            crate::nano_registry(),
            crate::arrangement_orchestrator_registry(),
            crate::orchestrate_orchestrator_registry(),
            crate::arrangement_subagent_registry(),
            crate::orchestrate_subagent_registry(),
            crate::ToolRegistry::new().register(crate::ConfigTool).register(crate::PowerShellTool)
                .register(crate::verifier_vote::VerifierVoteTool).register(crate::review_vote::ReviewVoteTool),
        ] {
            for tool in registry.all() {
                tools.insert(tool.name(), tool);
            }
        }
        let known = tools
            .keys()
            .map(|name| name.to_ascii_lowercase())
            .collect::<std::collections::HashSet<_>>();
        let direct_call = regex::Regex::new(
            r#"(?i:(?:^|[.!?;,]\s+|\band\s+)(?:use|call|invoke|prefer)\s+)[`"']?([A-Za-z][A-Za-z0-9_]*)"#,
        )
        .unwrap();
        fn descriptions(value: &serde_json::Value, output: &mut Vec<String>) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, child) in map {
                        if key == "description" {
                            if let Some(text) = child.as_str() {
                                output.push(text.to_string());
                            }
                        } else {
                            descriptions(child, output);
                        }
                    }
                }
                serde_json::Value::Array(items) => {
                    for item in items {
                        descriptions(item, output);
                    }
                }
                _ => {}
            }
        }
        let mut violations = Vec::new();
        for (name, tool) in tools {
            let ctx = ToolDescriptionContext {
                permission_mode: crate::ToolPermissionMode::Ask,
                is_non_interactive: false,
                active_skills: vec![],
                available_tools: [name.clone()].into_iter().collect(),
            };
            let schema = crate::inline_local_schema_refs_for_model(
                &crate::schema_with_parameter_guidance(&name, &tool.input_schema()),
            );
            let mut definition = ToolDefinition {
                name: name.clone(),
                description: tool.description_for_model(None, &ctx).await,
                input_schema: schema,
            };
            project_builtin_peer_guidance(&mut definition, &ctx);
            let mut texts = vec![definition.description];
            descriptions(&definition.input_schema, &mut texts);
            for text in texts {
                for found in direct_call.captures_iter(&text) {
                    let target = &found[1];
                    if target.eq_ignore_ascii_case(&name)
                        || !known.contains(&target.to_ascii_lowercase())
                    {
                        continue;
                    }
                    // The parent delegates artifact creation to a child with a real WritePlan capability.
                    if name == "PlanAgent" && target == "WritePlan" {
                        continue;
                    }
                    violations.push(format!("singleton {name} directs an unavailable {target}: {text}"));
                }
            }
        }
        assert!(violations.is_empty(), "{}", violations.join("\n"));
    }
}
