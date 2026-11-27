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
            peer(
                "SendSessionMessage",
                "to message an independent session rather than your own sub-agent",
            );
        }
        "SendSessionMessage" => {
            peer(
                "SendMessage",
                "to follow up with your own tracked sub-agent instead of another session",
            );
            peer(
                "GetSessionMessageReceipt",
                "to reconcile an uncertain send by its clientMessageId",
            );
            peer("ListSessions", "to find a recipient's threadId and address");
        }
        "GetSessionMessageReceipt" => peer(
            "ListSessionMessageReceipts",
            "in the original sending session to recover an outgoing ID, including for a separately sent reply",
        ),
        "ListSessionMessageReceipts" => peer(
            "GetSessionMessageReceipt",
            "to read one receipt by its recovered clientMessageId in the same sending session",
        ),
        "ListSessions" | "ReadSession" => {
            peer("ListSessions", "to find a threadId and address");
            peer(
                "ReadSession",
                "to read recent visible turns using the row's threadId and its entire address as targetAddress when present",
            );
            peer(
                "SendSessionMessage",
                "to send a reply or a new message to a peer session",
            );
            peer(
                "TaskList",
                "for this session's own tasks, sub-agents and background jobs",
            );
            peer(
                "ContextHistory",
                "to recover details from this session's own compacted history",
            );
        }
        "Sleep" => {
            peer(
                "wait",
                "when a tracked sub-agent's completion blocks the next step",
            );
            peer("TaskOutput", "to read a managed background job's output");
        }
        "ContextHistory" | "Snip" => {
            if name == "Snip" {
                peer(
                    "ContextHistory",
                    "to search this session's compacted history",
                );
                peer(
                    "CtxInspect",
                    "to identify a message in a fresh active snapshot; add 1 to the row's zero-based index for its Snip message ID",
                );
            } else {
                peer("CtxInspect", "to inspect the current active context");
            }
            peer("memory_search", "for durable facts stored across sessions");
        }
        "CtxInspect" => peer("ContextHistory", "to read this session's compacted history"),
        "AskUserQuestionAsync" => peer(
            "AskUserQuestion",
            "when an immediate decision blocks the next action and no useful independent work can continue",
        ),
        "tool_search" => peer(
            "DiscoverSkills",
            "to find skills (workflow instructions) rather than deferred tools",
        ),
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
        "review" => {
            peer("TaskOutput", "to inspect background output");
            peer("TaskStop", "to cancel a running background job");
        }
        "Workflow" => {
            peer(
                "TaskOutput",
                "with task_id equal to the returned run_id to inspect this run's output",
            );
            peer("TaskStop", "to cancel a running workflow job");
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
            peer(
                "WritePlan",
                "to author a plan artifact within the permitted role",
            );
        }
        "Wiki" => peer("WikiManage", "for explicitly requested Wiki organization"),
        "WikiManage" => peer("Wiki", "for ordinary retrieval from the knowledge library"),
        "SpecInit" => {
            peer("SpecStatus", "to inspect the current project setup");
            peer(
                "SpecUpdate",
                "to refresh bundled skills in an initialized project",
            );
        }
        "SpecNewChange" => peer(
            "SpecStatus",
            "to inspect an existing change before creating a new one",
        ),
        "SpecParallelDraft" => {
            peer(
                "TaskOutput",
                "with the returned task ID to inspect the background drafting result",
            );
            peer(
                "SpecCheck",
                "to validate the drafted change after the task finishes",
            );
        }
        "SpecStatus" => peer("SpecCheck", "for validation or apply preflight"),
        "SpecCheck" => {
            peer("SpecStatus", "for non-enforcing state inspection");
            peer(
                "SpecRecordVerification",
                "to retain evidence from checks that actually ran",
            );
        }
        "EditWorkPlan" | "ReopenTask" | "RecordTaskAcceptance" | "RecordTaskAcceptances" => {
            peer(
                "PlanProgress",
                "to obtain the current work_id, revision and available evidence IDs",
            );
            if name == "EditWorkPlan" {
                peer("ReopenTask", "before editing an accepted task's body");
            } else if name == "RecordTaskAcceptance" {
                peer(
                    "RecordTaskAcceptances",
                    "to accept multiple tasks in one revision-bound verification wave",
                );
            }
        }
        "remember" | "memory_get" | "memory_search" | "LocalMemoryRecall" => {
            peer("memory_search", "to search structured memories");
            peer("memory_get", "to fetch a structured memory by ID");
            peer("remember", "to store a new durable fact");
            peer("LocalMemoryRecall", "to read user-managed curated notes");
            peer(
                "ContextHistory",
                "to recover details from this session's compacted history",
            );
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
        "DiscoverSkills" => {
            peer(
                "skill",
                "to activate the selected skill before applying its workflow",
            );
            peer("tool_search", "to find deferred extension tools");
        }
        "WebBrowser" | "WebSearch" => {
            peer("WebFetch", "to retrieve source documents and HTTP metadata")
        }
        "WebFetch" => peer(
            "WebBrowser",
            "to read a page title and server-rendered text (no JavaScript)",
        ),
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

    #[test]
    fn specialized_peer_hints_follow_request_availability() {
        for (name, peer, purpose) in [
            ("ListSessions", "ReadSession", "targetAddress"),
            (
                "GetSessionMessageReceipt",
                "ListSessionMessageReceipts",
                "recover an outgoing ID",
            ),
            ("Workflow", "TaskOutput", "returned run_id"),
            ("RecordTaskAcceptance", "PlanProgress", "revision"),
            ("SpecInit", "SpecUpdate", "refresh bundled skills"),
        ] {
            let mut definition = ToolDefinition {
                name: name.into(),
                description: String::new(),
                input_schema: serde_json::json!({}),
            };
            let mut ctx = ToolDescriptionContext {
                permission_mode: crate::ToolPermissionMode::Ask,
                is_non_interactive: false,
                active_skills: vec![],
                available_tools: [name.to_string()].into_iter().collect(),
            };
            project_builtin_peer_guidance(&mut definition, &ctx);
            assert!(definition.description.is_empty(), "{name}");

            ctx.available_tools.insert(peer.into());
            project_builtin_peer_guidance(&mut definition, &ctx);
            assert!(definition.description.contains(&format!("Use {peer}")));
            assert!(definition.description.contains(purpose));
        }
    }

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
            crate::ToolRegistry::new()
                .register(crate::ConfigTool)
                .register(crate::PowerShellTool)
                .register(crate::verifier_vote::VerifierVoteTool)
                .register(crate::review_vote::ReviewVoteTool),
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
                    violations.push(format!(
                        "singleton {name} directs an unavailable {target}: {text}"
                    ));
                }
            }
        }
        assert!(violations.is_empty(), "{}", violations.join("\n"));
    }
}
