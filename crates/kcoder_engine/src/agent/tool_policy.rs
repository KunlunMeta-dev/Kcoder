use kcoder_config::PermissionMode;
use kcoder_tools::{AgentKind, ToolRegistry};
use std::collections::HashSet;

/// Tools disallowed for all agents.
pub fn all_agent_disallowed_tools() -> HashSet<&'static str> {
    let mut set = HashSet::new();
    // Canonical tool names.
    set.insert("AskUserQuestion");
    set.insert("EnterPlanMode");
    set.insert("ExitPlanMode");
    set.insert("TaskOutput");
    set.insert("TaskStop");
    set.insert("LocalMemoryRecall");
    // A workflow already owns sub-agent concurrency. Allowing a workflow agent
    // to start another top-level workflow would bypass the script's local fan-out
    // limit and make cancellation/resume semantics ambiguous.
    set.insert("Workflow");
    // Legacy aliases kept here so dynamic tool providers using older names
    // are still filtered out.
    set.insert("task_output");
    set.insert("enter_plan_mode");
    set.insert("exit_plan_mode_v2");
    set.insert("ask_user_question");
    set.insert("task_stop");
    set.insert("local_memory_recall");
    set.insert("vault_http_fetch");
    set
}

pub(super) fn subagent_permission_mode(agent_kind: AgentKind) -> PermissionMode {
    match agent_kind {
        AgentKind::General | AgentKind::Implementer | AgentKind::Verifier => {
            PermissionMode::AcceptEdits
        }
        AgentKind::Explore | AgentKind::Plan | AgentKind::Review | AgentKind::ToolAgent => {
            PermissionMode::Auto
        }
    }
}

pub(super) fn subagent_session_allowed_tools(agent_kind: AgentKind) -> Vec<String> {
    let mut allowed = vec!["skill".to_string(), "DiscoverSkills".to_string()];
    // PlanAgent owns this single Arrangement artifact mutation. The registry
    // remains role-filtered and parent deny rules still win.
    if agent_kind == AgentKind::Plan {
        allowed.push("WritePlan".to_string());
        allowed.push("CreateWorkPlan".to_string());
    }
    // The structured Goal Pro verifier verdict channel must be allowed without interaction.
    // Verifier sessions are unattended, so an Ask-mode prompt for VerifierVote would be rejected automatically or stall validation.
    if agent_kind == AgentKind::Verifier {
        allowed.push(kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string());
    }
    allowed
}

pub(super) fn subagent_session_allowed_shell_prefixes(agent_kind: AgentKind) -> Vec<String> {
    match agent_kind {
        // This role is explicitly delegated execution/validation work.
        // Plan, Explore, Review, ToolAgent, and General receive no implicit
        // executable-code grant.
        AgentKind::Verifier => [
            "cargo test",
            "cargo check",
            "cargo clippy",
            "cargo fmt -- --check",
            "rustfmt --check",
            "pytest",
            "python -m pytest",
            "python3 -m pytest",
            "go test",
            "npm test",
            "npm run test",
            "pnpm test",
            "yarn test",
            "dotnet test",
            "mvn test",
            "mvn verify",
            "gradle test",
            "./gradlew test",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
        _ => Vec::new(),
    }
}

fn insert_tools(set: &mut HashSet<&'static str>, names: &[&'static str]) {
    for name in names {
        set.insert(*name);
    }
}

/// Tools allowed for asynchronous agents.
pub fn async_agent_allowed_tools() -> HashSet<&'static str> {
    agent_kind_allowed_tools(AgentKind::General)
}

/// Tools allowed for a role-specialized asynchronous agent.
pub fn agent_kind_allowed_tools(agent_kind: AgentKind) -> HashSet<&'static str> {
    let mut set = HashSet::new();
    let read_search = [
        "read",
        "glob",
        "grep",
        "WebSearch",
        "WebFetch",
        "CtxInspect",
        "Snip",
    ];
    let shell = ["bash", "PowerShell"];
    let writes = ["edit", "write", "apply_patch"];
    let planning = ["TodoWrite"];
    let plan_artifacts = ["WritePlan", "CreateWorkPlan"];
    let skills = ["skill", "DiscoverSkills"];
    let worktree = [
        "EnterWorktree",
        "ExitWorktree",
        "WorktreeCreate",
        "WorktreeRemove",
    ];

    match agent_kind {
        AgentKind::General => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            insert_tools(&mut set, &writes);
            insert_tools(&mut set, &planning);
            insert_tools(&mut set, &skills);
            insert_tools(&mut set, &worktree);
            set.insert("Sleep");
        }
        AgentKind::Explore | AgentKind::Review => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &skills);
        }
        AgentKind::Plan => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            insert_tools(&mut set, &plan_artifacts);
            insert_tools(&mut set, &skills);
        }
        AgentKind::Implementer => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            insert_tools(&mut set, &writes);
            insert_tools(&mut set, &planning);
            insert_tools(&mut set, &skills);
            insert_tools(&mut set, &worktree);
            set.insert("Sleep");
        }
        AgentKind::Verifier => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            insert_tools(&mut set, &skills);
            set.insert("Sleep");
        }
        AgentKind::ToolAgent => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            set.insert("Sleep");
        }
    }
    set
}

fn arrangement_agent_kind_allowed_tools(agent_kind: AgentKind) -> HashSet<&'static str> {
    let mut set = HashSet::new();
    let read_search = [
        "read",
        "glob",
        "grep",
        "WebSearch",
        "WebFetch",
        "CtxInspect",
        "Snip",
    ];
    let shell = ["bash", "PowerShell"];
    let writes = ["edit", "write", "apply_patch"];
    let planning = ["TodoWrite"];
    let plan_artifacts = ["WritePlan", "CreateWorkPlan"];
    let orchestrate_state = ["PlanProgress"];
    let orchestrate_notepad = ["AppendWorkNotepad"];
    let skills = ["skill", "DiscoverSkills"];
    let worktree = [
        "EnterWorktree",
        "ExitWorktree",
        "WorktreeCreate",
        "WorktreeRemove",
    ];

    match agent_kind {
        AgentKind::General => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            insert_tools(&mut set, &skills);
            set.insert("Sleep");
        }
        AgentKind::Explore | AgentKind::Review => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &orchestrate_state);
            insert_tools(&mut set, &skills);
        }
        AgentKind::Plan => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            insert_tools(&mut set, &plan_artifacts);
            insert_tools(&mut set, &orchestrate_state);
            insert_tools(&mut set, &orchestrate_notepad);
            insert_tools(&mut set, &skills);
        }
        AgentKind::Implementer => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            insert_tools(&mut set, &writes);
            insert_tools(&mut set, &planning);
            insert_tools(&mut set, &orchestrate_state);
            insert_tools(&mut set, &orchestrate_notepad);
            insert_tools(&mut set, &skills);
            insert_tools(&mut set, &worktree);
            set.insert("Sleep");
        }
        AgentKind::Verifier => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            insert_tools(&mut set, &writes);
            insert_tools(&mut set, &planning);
            insert_tools(&mut set, &orchestrate_state);
            insert_tools(&mut set, &orchestrate_notepad);
            insert_tools(&mut set, &skills);
            insert_tools(&mut set, &worktree);
            set.insert("Sleep");
        }
        AgentKind::ToolAgent => {
            insert_tools(&mut set, &read_search);
            insert_tools(&mut set, &shell);
            set.insert("Sleep");
        }
    }
    set
}

pub fn filter_tools_for_agent_kind_in_mode(
    tools: &ToolRegistry,
    agent_kind: AgentKind,
    is_async: bool,
    arrangement_mode: bool,
) -> ToolRegistry {
    if arrangement_mode && (is_async || agent_kind != AgentKind::General) {
        filter_tools_for_allowed_names(
            tools,
            &all_agent_disallowed_tools(),
            &arrangement_agent_kind_allowed_tools(agent_kind),
        )
    } else {
        filter_tools_for_agent_kind(tools, agent_kind, is_async)
    }
}

/// Tools allowed for background self-improvement reviews.
pub fn background_review_allowed_tools() -> HashSet<&'static str> {
    let mut set = HashSet::new();
    set.insert("remember");
    set.insert("skill");
    set.insert("skill_manage");
    set.insert("DiscoverSkills");
    set
}

/// Filter a tool registry for use by an agent.
pub fn filter_tools_for_agent(
    tools: &ToolRegistry,
    agent_type: Option<&str>,
    is_async: bool,
) -> ToolRegistry {
    let agent_kind = AgentKind::from_agent_type(agent_type);
    filter_tools_for_agent_kind(tools, agent_kind, is_async)
}

pub fn filter_tools_for_agent_kind(
    tools: &ToolRegistry,
    agent_kind: AgentKind,
    is_async: bool,
) -> ToolRegistry {
    let disallowed = all_agent_disallowed_tools();
    let role_allowed = if is_async || agent_kind != AgentKind::General {
        Some(agent_kind_allowed_tools(agent_kind))
    } else {
        None
    };
    let names = tools
        .names()
        .into_iter()
        .filter(|name| {
            !disallowed.contains(name.as_str())
                && role_allowed
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(name.as_str()))
        })
        .collect::<Vec<_>>();
    tools.filtered_to_names(&names)
}

pub fn filter_tools_by_names(
    tools: &ToolRegistry,
    allowed: &HashSet<&'static str>,
) -> ToolRegistry {
    filter_tools_for_allowed_names(tools, &HashSet::new(), allowed)
}

pub fn filter_tools_by_owned_names(
    tools: &ToolRegistry,
    allowed: &HashSet<String>,
) -> ToolRegistry {
    let names = tools
        .names()
        .into_iter()
        .filter(|name| allowed.contains(name))
        .collect::<Vec<_>>();
    tools.filtered_to_names(&names)
}

fn filter_tools_for_allowed_names(
    tools: &ToolRegistry,
    disallowed: &HashSet<&'static str>,
    allowed: &HashSet<&'static str>,
) -> ToolRegistry {
    let names = tools
        .names()
        .into_iter()
        .filter(|name| !disallowed.contains(name.as_str()) && allowed.contains(name.as_str()))
        .collect::<Vec<_>>();
    tools.filtered_to_names(&names)
}
