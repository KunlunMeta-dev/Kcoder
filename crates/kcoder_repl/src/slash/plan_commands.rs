use crate::{ReplApp, goal_pro_verifier_selection};
use kcoder_config::GoalProTestScope;
use kcoder_engine::QueryEngine;
use kcoder_state::{
    GOAL_OBJECTIVE_INLINE_CHAR_LIMIT, Goal, GoalMode, GoalStatus, GoalVerificationKind,
    goal_objective_text, prepare_goal_objective,
};
use kcoder_types::MessageRole;
use sha2::{Digest, Sha256};

use super::{SlashCommand, SlashResult};

const GOAL_USAGE: &str = "/goal [status|history|pause|resume|clear|edit [--budget <tokens>] <objective>|--budget <tokens> <objective>|<objective>]";
const ULTGOAL_USAGE: &str =
    "/ultgoal [status|history|pause|resume|clear|--budget <tokens> <objective>|<objective>]";
const GOAL_PRO_USAGE: &str = "/goal-pro [status|history|pause|resume|clear|edit [--budget <tokens>] <objective>|[--answer] [--budget <tokens>] [--] <objective>]";

#[derive(Default)]
pub(super) struct OrchestrateCommand;

#[async_trait::async_trait]
impl SlashCommand for OrchestrateCommand {
    fn name(&self) -> &'static str {
        "/orchestrate"
    }

    fn description(&self) -> &'static str {
        "Enter the permanent read-only orchestration mode for a new session."
    }

    fn usage(&self) -> &'static str {
        "/orchestrate"
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, self.usage());
            return SlashResult::Handled;
        }

        match engine.state.enter_orchestrate_before_first_message() {
            Ok(true) => app.push_message(
                MessageRole::System,
                "Orchestrate session started. This mode lasts for the entire session and cannot be exited. The main agent is a read-only orchestrator: it reads context and delegates planning, implementation, and verification instead of editing implementation files or running executable validation directly.",
            ),
            Ok(false) => app.push_message(
                MessageRole::System,
                "This session is already in Orchestrate mode.",
            ),
            Err(error) => app.push_message(
                MessageRole::System,
                format!(
                    "Orchestrate can only be entered before the first message. Start a new session and run `/orchestrate` first. ({error:#})"
                ),
            ),
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct OrchestrateWorkCommand;

#[async_trait::async_trait]
impl SlashCommand for OrchestrateWorkCommand {
    fn name(&self) -> &'static str {
        "/work"
    }

    fn description(&self) -> &'static str {
        "Show or select the active Orchestrate work plan."
    }

    fn usage(&self) -> &'static str {
        "/work [status|list|diagnostics|select <work_id>|evidence manual <statement>|evidence not-applicable <requirement> -- <rationale>]"
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !engine.state.session_mode().is_orchestrate() {
            app.push_message(
                MessageRole::System,
                "`/work` requires an Orchestrate session.",
            );
            return SlashResult::Handled;
        }
        let store = kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd());
        let args = args.trim();
        if args == "diagnostics" {
            match engine.state.write_orchestrate_runtime_diagnostics() {
                Ok(path) => app.push_message(
                    MessageRole::System,
                    format!(
                        "Exported redacted Orchestrate runtime diagnostics to `{}`. The file contains only bounded state summaries, retained-window metrics, and sanitized audit events.",
                        path.display()
                    ),
                ),
                Err(error) => app.push_message(
                    MessageRole::System,
                    format!("Could not export Orchestrate runtime diagnostics: {error:#}"),
                ),
            }
            return SlashResult::Handled;
        }
        if let Some(statement) = args.strip_prefix("evidence manual ").map(str::trim) {
            if statement.is_empty() {
                app.push_message(MessageRole::System, self.usage());
                return SlashResult::Handled;
            }
            let snapshot = match store.read_active_work() {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Could not record manual evidence: {error:#}"),
                    );
                    return SlashResult::Handled;
                }
            };
            let evidence_id = user_evidence_id(
                &engine.state.session_id(),
                &snapshot.work.work_id,
                snapshot.work.revision,
            );
            let result = store.append_evidence(
                &snapshot.work.work_id,
                kcoder_state::orchestrate_store::AgentEvidence {
                    evidence_id: evidence_id.clone(),
                    work_id: snapshot.work.work_id.clone(),
                    revision: snapshot.work.revision,
                    plan_sha256: snapshot.work.plan_sha256,
                    agent_id: "interactive-user".to_string(),
                    workspace_digest: format!("manual:{}", engine.state.session_id()),
                    recorded_at: chrono::Utc::now(),
                    evidence: kcoder_state::orchestrate_store::AgentEvidenceKind::Manual {
                        statement: statement.to_string(),
                        recorded_by: "interactive-user".to_string(),
                    },
                },
            );
            match result {
                Ok(saved) => {
                    engine.state.record_orchestrate_runtime_event_after_commit(
                        "evidence_recorded",
                        Some(&snapshot.work.work_id),
                        None,
                        None,
                        None,
                        serde_json::json!({
                            "evidence_id": saved.evidence_id,
                            "revision": saved.revision,
                            "evidence_kind": "manual",
                        }),
                    );
                    app.push_message(
                        MessageRole::System,
                        format!(
                            "Recorded trusted manual evidence `{evidence_id}` for the current revision."
                        ),
                    )
                }
                Err(error) => app.push_message(
                    MessageRole::System,
                    format!("Could not record manual evidence: {error:#}"),
                ),
            }
            return SlashResult::Handled;
        }
        if let Some(value) = args.strip_prefix("evidence not-applicable ") {
            let Some((requirement, rationale)) = value.split_once(" -- ") else {
                app.push_message(MessageRole::System, self.usage());
                return SlashResult::Handled;
            };
            if requirement.trim().is_empty() || rationale.trim().is_empty() {
                app.push_message(MessageRole::System, self.usage());
                return SlashResult::Handled;
            }
            let snapshot = match store.read_active_work() {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Could not approve NotApplicable evidence: {error:#}"),
                    );
                    return SlashResult::Handled;
                }
            };
            let evidence_id = user_evidence_id(
                &engine.state.session_id(),
                &snapshot.work.work_id,
                snapshot.work.revision,
            );
            let result = store.append_evidence(
                &snapshot.work.work_id,
                kcoder_state::orchestrate_store::AgentEvidence {
                    evidence_id: evidence_id.clone(),
                    work_id: snapshot.work.work_id.clone(),
                    revision: snapshot.work.revision,
                    plan_sha256: snapshot.work.plan_sha256,
                    agent_id: "interactive-user".to_string(),
                    workspace_digest: format!("manual:{}", engine.state.session_id()),
                    recorded_at: chrono::Utc::now(),
                    evidence: kcoder_state::orchestrate_store::AgentEvidenceKind::NotApplicable {
                        requirement: requirement.trim().to_string(),
                        rationale: rationale.trim().to_string(),
                        approved_by: "interactive-user".to_string(),
                    },
                },
            );
            match result {
                Ok(saved) => {
                    engine.state.record_orchestrate_runtime_event_after_commit(
                        "evidence_recorded",
                        Some(&snapshot.work.work_id),
                        None,
                        None,
                        None,
                        serde_json::json!({
                            "evidence_id": saved.evidence_id,
                            "revision": saved.revision,
                            "evidence_kind": "not_applicable",
                        }),
                    );
                    app.push_message(
                        MessageRole::System,
                        format!("Approved trusted NotApplicable evidence `{evidence_id}` for the current revision."),
                    )
                }
                Err(error) => app.push_message(
                    MessageRole::System,
                    format!("Could not approve NotApplicable evidence: {error:#}"),
                ),
            }
            return SlashResult::Handled;
        }
        if let Some(work_id) = args.strip_prefix("select ").map(str::trim) {
            match store.select_active_work(work_id) {
                Ok(()) => app.push_message(
                    MessageRole::System,
                    format!("Selected active Orchestrate work `{work_id}`."),
                ),
                Err(error) => app.push_message(
                    MessageRole::System,
                    format!("Could not select Orchestrate work: {error:#}"),
                ),
            }
            return SlashResult::Handled;
        }
        if args == "list" {
            match store.list_works() {
                Ok(works) if works.is_empty() => {
                    app.push_message(MessageRole::System, "No Orchestrate work exists.");
                }
                Ok(works) => {
                    let active = store.active_work_id().ok().flatten();
                    let lines = works
                        .into_iter()
                        .map(|snapshot| {
                            format!(
                                "{} {} ({}) r{} {}/{} {:?}",
                                if active.as_deref() == Some(snapshot.work.work_id.as_str()) {
                                    "*"
                                } else {
                                    "-"
                                },
                                snapshot.work.display_slug,
                                snapshot.work.work_id,
                                snapshot.work.revision,
                                snapshot.work.progress.completed,
                                snapshot.work.progress.total,
                                snapshot.work.status,
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    app.push_message(MessageRole::System, format!("Orchestrate works:\n{lines}"));
                }
                Err(error) => app.push_message(
                    MessageRole::System,
                    format!("Could not list Orchestrate works: {error:#}"),
                ),
            }
            return SlashResult::Handled;
        }
        if !args.is_empty() && args != "status" {
            app.push_message(MessageRole::System, self.usage());
            return SlashResult::Handled;
        }
        match store.read_active_work() {
            Ok(snapshot) => {
                let parsed = kcoder_state::orchestrate_store::parse_plan(&snapshot.plan).ok();
                let (todo_done, todo_total, wave_done, wave_total) =
                    parsed.map_or((0, 0, 0, 0), |parsed| {
                        let todo_total = parsed
                            .tasks
                            .iter()
                            .filter(|task| !task.is_final_verification)
                            .count();
                        let todo_done = parsed
                            .tasks
                            .iter()
                            .filter(|task| !task.is_final_verification && task.completed)
                            .count();
                        let wave_total = parsed
                            .tasks
                            .iter()
                            .filter(|task| task.is_final_verification)
                            .count();
                        let wave_done = parsed
                            .tasks
                            .iter()
                            .filter(|task| task.is_final_verification && task.completed)
                            .count();
                        (todo_done, todo_total, wave_done, wave_total)
                    });
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Orchestrate work: {} ({})\nrevision: {}\nplan_sha256: {}\nprogress: TODOs {}/{} · Wave {}/{} · {:?}\nplan: {}",
                        snapshot.work.display_slug,
                        snapshot.work.work_id,
                        snapshot.work.revision,
                        snapshot.work.plan_sha256,
                        todo_done,
                        todo_total,
                        wave_done,
                        wave_total,
                        snapshot.work.status,
                        store.root().join("works").join(&snapshot.work.work_id).join("revisions").join(snapshot.work.revision.to_string()).join("plan.md").display(),
                    ),
                );
            }
            Err(error) => app.push_message(
                MessageRole::System,
                format!("No readable active Orchestrate work: {error:#}"),
            ),
        }
        SlashResult::Handled
    }
}

fn user_evidence_id(session_id: &str, work_id: &str, revision: u64) -> String {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let digest = Sha256::digest(format!("{session_id}\0{work_id}\0{revision}\0{nonce}").as_bytes());
    format!("evidence_user_{digest:x}")
}

#[derive(Default)]
pub(super) struct RosterCommand;

#[async_trait::async_trait]
impl SlashCommand for RosterCommand {
    fn name(&self) -> &'static str {
        "/roster"
    }

    fn description(&self) -> &'static str {
        "Show the resolved Orchestrate persona roster and capability digests."
    }

    fn usage(&self) -> &'static str {
        "/roster"
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, self.usage());
            return SlashResult::Handled;
        }
        if !engine.state.session_mode().is_orchestrate() {
            app.push_message(
                MessageRole::System,
                "`/roster` requires an Orchestrate session.",
            );
            return SlashResult::Handled;
        }
        let settings = engine.settings.read().unwrap();
        let mut lines = vec![
            "name | base_role | resolved runtime | context | effective tool-set digest".to_string(),
        ];
        for (name, entry) in &settings.orchestrate.roster {
            let base_role = kcoder_config::orchestrate_persona_base_role(name).unwrap_or("invalid");
            let tier = settings.orchestrate.tiers.get(&entry.tier);
            let runtime = tier.map_or_else(
                || "invalid tier".to_string(),
                |slot| {
                    slot.profile
                        .as_ref()
                        .map(|profile| format!("profile:{profile}"))
                        .unwrap_or_else(|| {
                            format!(
                                "{}/{}",
                                slot.provider.as_deref().unwrap_or("current"),
                                slot.model.as_deref().unwrap_or("current")
                            )
                        })
                },
            );
            let mut tools = kcoder_config::orchestrate_persona_max_tools(name)
                .unwrap_or_default()
                .iter()
                .map(|tool| (*tool).to_string())
                .collect::<Vec<_>>();
            if let Some(allowlist) = entry.tool_allowlist.as_ref() {
                tools.retain(|tool| allowlist.contains(tool));
            }
            if name == "critic" {
                tools.push(kcoder_tools::REVIEW_VOTE_TOOL_NAME.to_string());
            }
            tools.sort();
            let digest = format!("{:x}", Sha256::digest(tools.join("\0").as_bytes()));
            lines.push(format!(
                "{} | {} | {} ({}) | {:?} | {}",
                name,
                base_role,
                runtime,
                entry.tier,
                entry.context_mode,
                &digest[..12],
            ));
        }
        app.push_message(MessageRole::System, lines.join("\n"));
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct PlanCommand;

#[async_trait::async_trait]
impl SlashCommand for PlanCommand {
    fn name(&self) -> &'static str {
        "/plan"
    }
    fn description(&self) -> &'static str {
        "Enter plan mode for complex tasks."
    }
    fn usage(&self) -> &'static str {
        "/plan [instructions]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let instructions = if args.trim().is_empty() {
            "Explore the codebase, compare approaches, and design a concrete implementation strategy. Do not write or edit files until you exit plan mode.".to_string()
        } else {
            args.trim().to_string()
        };
        engine.state.enter_plan_mode(&instructions);
        app.plan_mode = Some(instructions.clone());
        app.push_message(
            MessageRole::System,
            format!(
                "Entered plan mode. {}\n\nUse /unplan to exit when ready.",
                instructions
            ),
        );
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct UnplanCommand;

#[async_trait::async_trait]
impl SlashCommand for UnplanCommand {
    fn name(&self) -> &'static str {
        "/unplan"
    }
    fn description(&self) -> &'static str {
        "Exit plan mode and allow implementation."
    }
    fn usage(&self) -> &'static str {
        "/unplan"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        engine.state.exit_plan_mode();
        app.plan_mode = None;
        app.push_message(
            MessageRole::System,
            "Exited plan mode. You can now implement.",
        );
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct PlanStatusCommand;

#[async_trait::async_trait]
impl SlashCommand for PlanStatusCommand {
    fn name(&self) -> &'static str {
        "/planstatus"
    }
    fn description(&self) -> &'static str {
        "Show whether plan mode is active."
    }
    fn usage(&self) -> &'static str {
        "/planstatus"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        match engine.state.plan_mode() {
            Some(instructions) => {
                app.push_message(
                    MessageRole::System,
                    format!("Plan mode is active.\n\n{}", instructions),
                );
            }
            None => {
                app.push_message(MessageRole::System, "Plan mode is not active.");
            }
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct GoalCommand;

#[async_trait::async_trait]
impl SlashCommand for GoalCommand {
    fn name(&self) -> &'static str {
        "/goal"
    }

    fn description(&self) -> &'static str {
        "Run a persistent objective until it completes, blocks, or is interrupted."
    }

    fn usage(&self) -> &'static str {
        GOAL_USAGE
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !engine.settings.read().unwrap().goal_enabled {
            app.push_message(
                MessageRole::System,
                "Goal continuation is disabled. Run `/set goal_enabled true` to enable it.",
            );
            return SlashResult::Handled;
        }

        let args = args.trim();
        if args.is_empty() || args == "status" {
            app.push_message(MessageRole::System, format_goal_status(engine.state.goal()));
            return SlashResult::Handled;
        }

        match args {
            "history" => {
                app.push_message(
                    MessageRole::System,
                    format_goal_history(
                        engine.state.goal_history(),
                        engine.state.goal(),
                        GoalMode::Standard,
                    ),
                );
                return SlashResult::Handled;
            }
            "clear" => {
                if let Some(goal) = engine.state.clear_goal() {
                    app.push_message(
                        MessageRole::System,
                        format!("{} cleared.", goal_mode_display_name(goal.mode)),
                    );
                } else {
                    app.push_message(MessageRole::System, "No goal is currently defined.");
                }
                return SlashResult::Handled;
            }
            "pause" => {
                app.push_message(MessageRole::System, pause_goal_message(engine));
                return SlashResult::Handled;
            }
            "resume" => {
                match engine.state.goal() {
                    Some(goal) if goal.status.is_user_resumable() => {
                        let goal = engine
                            .state
                            .update_goal_status(GoalStatus::Active)
                            .unwrap_or(goal);
                        app.push_message(
                            MessageRole::System,
                            format!(
                                "{} resumed: {}",
                                goal_mode_display_name(goal.mode),
                                one_line(&goal.objective, 120)
                            ),
                        );
                    }
                    Some(goal) if goal.status == GoalStatus::Active => {
                        app.push_message(
                            MessageRole::System,
                            format!("{} is already active.", goal_mode_display_name(goal.mode)),
                        );
                    }
                    Some(goal) => {
                        let command = goal_mode_command(goal.mode);
                        app.push_message(
                            MessageRole::System,
                            format!(
                                "{} status is `{}` and cannot be resumed. Use `{command} clear` before starting a new {}.",
                                goal_mode_display_name(goal.mode),
                                goal.status.as_str(),
                                goal_mode_display_name(goal.mode).to_ascii_lowercase()
                            ),
                        );
                    }
                    None => app.push_message(MessageRole::System, "No goal is currently defined."),
                }
                return SlashResult::Handled;
            }
            _ => {}
        }

        if args == "edit" || args.starts_with("edit ") {
            let edit_args = args.strip_prefix("edit").unwrap_or_default().trim();
            let Some(existing) = engine.state.goal() else {
                app.push_message(MessageRole::System, "No goal is currently defined.");
                return SlashResult::Handled;
            };
            if !existing.status.is_unfinished() {
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Goal status is `{}` and cannot be edited. Use `/goal clear` before starting a new goal.",
                        existing.status.as_str()
                    ),
                );
                return SlashResult::Handled;
            }
            if edit_args.is_empty() {
                let objective = goal_objective_text(&existing).unwrap_or(existing.objective);
                app.prefill_input(format!("/goal edit {}", objective));
                app.push_message(
                    MessageRole::System,
                    "Current goal objective loaded into the composer. Edit it and press Enter to save.",
                );
                return SlashResult::Handled;
            }

            let (token_budget, objective) = match parse_goal_creation_args(edit_args) {
                Ok(parsed) => parsed,
                Err(message) => {
                    app.push_message(MessageRole::System, message);
                    return SlashResult::Handled;
                }
            };
            let prepared = match prepare_goal_objective(engine.state.cwd(), objective.trim()) {
                Ok(prepared) => prepared,
                Err(error) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Failed to prepare goal objective: {error:#}"),
                    );
                    return SlashResult::Handled;
                }
            };
            match engine.state.edit_goal(
                prepared.objective.clone(),
                prepared.objective_file.clone(),
                token_budget,
            ) {
                Some(goal) => {
                    let materialized = materialized_suffix(&prepared);
                    app.push_message(
                        MessageRole::System,
                        format!(
                            "Goal objective updated and paused{}. Use `/goal resume` to continue: {}",
                            materialized,
                            one_line(&goal.objective, 120)
                        ),
                    );
                }
                None => app.push_message(MessageRole::System, "No goal is currently defined."),
            }
            return SlashResult::Handled;
        }

        let (token_budget, objective) = match parse_goal_creation_args(args) {
            Ok(parsed) => parsed,
            Err(message) => {
                app.push_message(MessageRole::System, message);
                return SlashResult::Handled;
            }
        };
        if objective.trim().is_empty() {
            app.push_message(MessageRole::System, self.usage());
            return SlashResult::Handled;
        }
        if let Some(existing) = engine.state.goal()
            && existing.status.is_unfinished()
        {
            app.open_goal_replacement_confirmation(
                existing,
                objective.trim().to_string(),
                token_budget,
                GoalMode::Standard,
            );
            return SlashResult::Handled;
        }

        let prepared = match prepare_goal_objective(engine.state.cwd(), objective.trim()) {
            Ok(prepared) => prepared,
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to prepare goal objective: {error:#}"),
                );
                return SlashResult::Handled;
            }
        };
        let goal = engine.state.set_goal_prepared(
            prepared.objective.clone(),
            prepared.objective_file.clone(),
            token_budget,
        );
        let materialized = materialized_suffix(&prepared);
        app.push_message(
            MessageRole::System,
            format!(
                "Goal started{}{}: {}",
                goal.token_budget
                    .map(|budget| format!(" (budget: {budget} tokens)"))
                    .unwrap_or_default(),
                materialized,
                one_line(&goal.objective, 120)
            ),
        );
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct GoalProCommand;

#[async_trait::async_trait]
impl SlashCommand for GoalProCommand {
    fn name(&self) -> &'static str {
        "/goal-pro"
    }

    fn description(&self) -> &'static str {
        "Run a persistent objective whose completion requires an independent verifier sub-agent."
    }

    fn usage(&self) -> &'static str {
        GOAL_PRO_USAGE
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !engine.settings.read().unwrap().goal_enabled {
            app.push_message(
                MessageRole::System,
                "Goal Pro is disabled because goal continuation is disabled. Run `/set goal_enabled true` to enable it.",
            );
            return SlashResult::Handled;
        }

        let args = args.trim();
        if args.is_empty() || args == "status" {
            app.push_message(MessageRole::System, format_goal_status(engine.state.goal()));
            return SlashResult::Handled;
        }

        match args {
            "history" => {
                app.push_message(
                    MessageRole::System,
                    format_goal_history(
                        engine.state.goal_history(),
                        engine.state.goal(),
                        GoalMode::Strict,
                    ),
                );
                return SlashResult::Handled;
            }
            "clear" => {
                if let Some(goal) = engine.state.clear_goal() {
                    app.push_message(
                        MessageRole::System,
                        format!("{} cleared.", goal_mode_display_name(goal.mode)),
                    );
                } else {
                    app.push_message(MessageRole::System, "No goal is currently defined.");
                }
                return SlashResult::Handled;
            }
            "pause" => {
                app.push_message(MessageRole::System, pause_goal_message(engine));
                return SlashResult::Handled;
            }
            "resume" => {
                match engine.state.goal() {
                    Some(goal) if goal.status.is_user_resumable() => {
                        let goal = engine
                            .state
                            .update_goal_status(GoalStatus::Active)
                            .unwrap_or(goal);
                        app.push_message(
                            MessageRole::System,
                            format!("Goal Pro resumed: {}", one_line(&goal.objective, 120)),
                        );
                    }
                    Some(goal) if goal.status == GoalStatus::Active => app.push_message(
                        MessageRole::System,
                        "Goal Pro is already active.",
                    ),
                    Some(goal) => app.push_message(
                        MessageRole::System,
                        format!(
                            "Goal Pro status is `{}` and cannot be resumed. Use `/goal-pro clear` before starting a new Goal Pro.",
                            goal.status.as_str()
                        ),
                    ),
                    None => app.push_message(MessageRole::System, "No goal is currently defined."),
                }
                return SlashResult::Handled;
            }
            _ => {}
        }

        if args == "edit" || args.starts_with("edit ") {
            let edit_args = args.strip_prefix("edit").unwrap_or_default().trim();
            let Some(existing) = engine.state.goal() else {
                app.push_message(MessageRole::System, "No goal is currently defined.");
                return SlashResult::Handled;
            };
            if !existing.status.is_unfinished() {
                app.push_message(
                    MessageRole::System,
                    "Goal Pro is terminal. Use `/goal-pro clear` before starting a new one.",
                );
                return SlashResult::Handled;
            }
            if edit_args.is_empty() {
                let objective = goal_objective_text(&existing).unwrap_or(existing.objective);
                app.prefill_input(format!("/goal-pro edit {objective}"));
                app.push_message(
                    MessageRole::System,
                    "Current Goal Pro objective loaded into the composer. Edit it and press Enter to save.",
                );
                return SlashResult::Handled;
            }
            let (token_budget, objective) = match parse_goal_creation_args(edit_args) {
                Ok(parsed) => parsed,
                Err(message) => {
                    app.push_message(MessageRole::System, message.replace("/goal", "/goal-pro"));
                    return SlashResult::Handled;
                }
            };
            let prepared = match prepare_goal_objective(engine.state.cwd(), objective.trim()) {
                Ok(prepared) => prepared,
                Err(error) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Failed to prepare Goal Pro objective: {error:#}"),
                    );
                    return SlashResult::Handled;
                }
            };
            match engine.state.edit_goal(
                prepared.objective.clone(),
                prepared.objective_file.clone(),
                token_budget,
            ) {
                Some(goal) => app.push_message(
                    MessageRole::System,
                    format!(
                        "Goal Pro objective updated and paused{}. Use `/goal-pro resume` to continue: {}",
                        materialized_suffix(&prepared),
                        one_line(&goal.objective, 120)
                    ),
                ),
                None => app.push_message(MessageRole::System, "No goal is currently defined."),
            }
            return SlashResult::Handled;
        }

        let (token_budget, verification_kind, objective) = match parse_goal_pro_creation_args(args)
        {
            Ok(parsed) => parsed,
            Err(message) => {
                app.push_message(MessageRole::System, message);
                return SlashResult::Handled;
            }
        };
        if let Some(existing) = engine.state.goal()
            && existing.status.is_unfinished()
        {
            app.open_goal_replacement_confirmation_with_verification(
                existing,
                objective.trim().to_string(),
                token_budget,
                GoalMode::Strict,
                verification_kind,
            );
            return SlashResult::Handled;
        }
        let prepared = match prepare_goal_objective(engine.state.cwd(), objective.trim()) {
            Ok(prepared) => prepared,
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to prepare Goal Pro objective: {error:#}"),
                );
                return SlashResult::Handled;
            }
        };
        let context_snapshot = kcoder_state::goal_context_snapshot(&engine.state.messages());
        let goal = match engine
            .state
            .set_goal_prepared_with_mode_and_verification_and_verifier(
                prepared.objective.clone(),
                prepared.objective_file.clone(),
                token_budget,
                GoalMode::Strict,
                verification_kind,
                goal_pro_verifier_selection(engine),
            ) {
            Ok(goal) => goal,
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to create Goal Pro: {error:#}"),
                );
                return SlashResult::Handled;
            }
        };
        let goal = engine
            .state
            .set_goal_context_snapshot(context_snapshot)
            .unwrap_or(goal);
        let goal = match kcoder_engine::agent::ensure_goal_pro_workspace_baseline(
            &engine.state,
            &goal,
        )
        .await
        {
            Ok(goal) => goal,
            Err(error) => {
                engine.state.clear_goal();
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Failed to capture the Goal Pro verifier baseline; the goal was not started: {error}"
                    ),
                );
                return SlashResult::Handled;
            }
        };
        app.push_message(
            MessageRole::System,
            format!(
                "Goal Pro started in Strict mode ({}){}{}: {}\n\nCompletion requires an independent verifier sub-agent. A limited semantic snapshot of the preceding conversation was captured to resolve contextual references. Semantic completion rejections keep the goal active until the frozen rejection limit is reached; reaching that limit blocks the goal automatically.",
                goal.verification_kind.as_str(),
                goal.token_budget
                    .map(|budget| format!(" (budget: {budget} tokens)"))
                    .unwrap_or_default(),
                materialized_suffix(&prepared),
                one_line(&goal.objective, 120)
            ),
        );
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct UltGoalCommand;

#[async_trait::async_trait]
impl SlashCommand for UltGoalCommand {
    fn name(&self) -> &'static str {
        "/ultgoal"
    }

    fn description(&self) -> &'static str {
        "Deprecated compatibility entry for Arrangement goals; prefer /orchestrate then /goal or /goal-pro."
    }

    fn usage(&self) -> &'static str {
        ULTGOAL_USAGE
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !engine.settings.read().unwrap().goal_enabled {
            app.push_message(
                MessageRole::System,
                "UltGoal is disabled because goal continuation is disabled. Run `/set goal_enabled true` to enable it.",
            );
            return SlashResult::Handled;
        }

        let args = args.trim();
        if args.is_empty() || args == "status" {
            app.push_message(MessageRole::System, format_goal_status(engine.state.goal()));
            return SlashResult::Handled;
        }

        match args {
            "history" => {
                app.push_message(
                    MessageRole::System,
                    format_goal_history(
                        engine.state.goal_history(),
                        engine.state.goal(),
                        GoalMode::Arrangement,
                    ),
                );
                return SlashResult::Handled;
            }
            "clear" => {
                if let Some(goal) = engine.state.clear_goal() {
                    app.push_message(
                        MessageRole::System,
                        format!("{} cleared.", goal_mode_display_name(goal.mode)),
                    );
                } else {
                    app.push_message(MessageRole::System, "No goal is currently defined.");
                }
                return SlashResult::Handled;
            }
            "pause" => {
                app.push_message(MessageRole::System, pause_goal_message(engine));
                return SlashResult::Handled;
            }
            "resume" => {
                match engine.state.goal() {
                    Some(goal) if goal.status.is_user_resumable() => {
                        let goal = engine
                            .state
                            .update_goal_status(GoalStatus::Active)
                            .unwrap_or(goal);
                        app.push_message(
                            MessageRole::System,
                            format!(
                                "{} resumed: {}",
                                goal_mode_display_name(goal.mode),
                                one_line(&goal.objective, 120)
                            ),
                        );
                    }
                    Some(goal) if goal.status == GoalStatus::Active => {
                        app.push_message(
                            MessageRole::System,
                            format!("{} is already active.", goal_mode_display_name(goal.mode)),
                        );
                    }
                    Some(goal) => {
                        let command = goal_mode_command(goal.mode);
                        app.push_message(
                            MessageRole::System,
                            format!(
                                "{} status is `{}` and cannot be resumed. Use `{command} clear` before starting a new {}.",
                                goal_mode_display_name(goal.mode),
                                goal.status.as_str(),
                                goal_mode_display_name(goal.mode).to_ascii_lowercase()
                            ),
                        );
                    }
                    None => app.push_message(MessageRole::System, "No goal is currently defined."),
                }
                return SlashResult::Handled;
            }
            _ => {}
        }

        let (token_budget, objective) = match parse_goal_creation_args(args) {
            Ok(parsed) => parsed,
            Err(message) => {
                app.push_message(MessageRole::System, message.replace("/goal", "/ultgoal"));
                return SlashResult::Handled;
            }
        };
        if objective.trim().is_empty() {
            app.push_message(MessageRole::System, self.usage());
            return SlashResult::Handled;
        }
        if let Some(existing) = engine.state.goal()
            && existing.status.is_unfinished()
        {
            app.open_goal_replacement_confirmation(
                existing,
                objective.trim().to_string(),
                token_budget,
                GoalMode::Arrangement,
            );
            return SlashResult::Handled;
        }

        let prepared = match prepare_goal_objective(engine.state.cwd(), objective.trim()) {
            Ok(prepared) => prepared,
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to prepare ultgoal objective: {error:#}"),
                );
                return SlashResult::Handled;
            }
        };
        let goal = engine.state.set_goal_prepared_with_mode(
            prepared.objective.clone(),
            prepared.objective_file.clone(),
            token_budget,
            GoalMode::Arrangement,
        );
        let materialized = materialized_suffix(&prepared);
        app.push_message(
            MessageRole::System,
            format!(
                "UltGoal started in Arrangement mode{}{}: {}\n\nMain agent will orchestrate: it reads context, delegates planning, implementation, and verification to sub-agents, and does not edit implementation files directly.\n\nDeprecated compatibility command: for new sessions use `/orchestrate` before the first message, then start `/goal` or `/goal-pro` when persistent objective tracking is needed.",
                goal.token_budget
                    .map(|budget| format!(" (budget: {budget} tokens)"))
                    .unwrap_or_default(),
                materialized,
                one_line(&goal.objective, 120)
            ),
        );
        SlashResult::Handled
    }
}

fn parse_goal_creation_args(args: &str) -> Result<(Option<u64>, String), String> {
    if args == "--budget" || args == "budget" || args.starts_with("--budget=") {
        return Err(format!(
            "Missing goal token budget value and objective.\nUsage: {GOAL_USAGE}"
        ));
    }
    if let Some(rest) = args.strip_prefix("--budget ") {
        return parse_goal_budget_args(rest);
    }
    if let Some(rest) = args.strip_prefix("budget ") {
        return parse_goal_budget_args(rest);
    }
    Ok((None, args.to_string()))
}

fn parse_goal_pro_creation_args(
    args: &str,
) -> Result<(Option<u64>, GoalVerificationKind, String), String> {
    let tokens = args.split_whitespace().collect::<Vec<_>>();
    let mut index = 0usize;
    let mut token_budget = None;
    let mut verification_kind = GoalVerificationKind::Artifact;
    let mut answer_seen = false;

    while index < tokens.len() {
        match tokens[index] {
            "--" => {
                index += 1;
                break;
            }
            "--answer" => {
                if answer_seen {
                    return Err(format!("Duplicate --answer flag. Usage: {GOAL_PRO_USAGE}"));
                }
                answer_seen = true;
                verification_kind = GoalVerificationKind::Answer;
                index += 1;
            }
            "--budget" => {
                if token_budget.is_some() {
                    return Err(format!("Duplicate --budget flag. Usage: {GOAL_PRO_USAGE}"));
                }
                let raw = tokens.get(index + 1).ok_or_else(|| {
                    format!("Missing Goal Pro token budget value. Usage: {GOAL_PRO_USAGE}")
                })?;
                let budget = raw.parse::<u64>().map_err(|_| {
                    format!("Invalid Goal Pro token budget. Usage: {GOAL_PRO_USAGE}")
                })?;
                if budget == 0 {
                    return Err("Goal Pro token budget must be greater than 0.".to_string());
                }
                token_budget = Some(budget);
                index += 2;
            }
            token if token.starts_with("--") => {
                return Err(format!(
                    "Unknown Goal Pro flag `{token}`. Usage: {GOAL_PRO_USAGE}"
                ));
            }
            _ => break,
        }
    }

    let objective = tokens[index..].join(" ");
    if objective.is_empty() {
        return Err(format!(
            "Missing Goal Pro objective. Usage: {GOAL_PRO_USAGE}"
        ));
    }
    Ok((token_budget, verification_kind, objective))
}

fn parse_goal_budget_args(rest: &str) -> Result<(Option<u64>, String), String> {
    let mut parts = rest.trim_start().splitn(2, char::is_whitespace);
    let budget = parts
        .next()
        .unwrap_or_default()
        .parse::<u64>()
        .map_err(|_| {
            "Invalid goal token budget. Usage: /goal --budget <tokens> <objective>".to_string()
        })?;
    if budget == 0 {
        return Err("Goal token budget must be greater than 0.".to_string());
    }
    let objective = parts.next().unwrap_or_default().trim_start().to_string();
    if objective.is_empty() {
        return Err(
            "Missing goal objective. Usage: /goal --budget <tokens> <objective>".to_string(),
        );
    }
    Ok((Some(budget), objective))
}

fn goal_mode_display_name(mode: GoalMode) -> &'static str {
    if mode.is_arrangement() {
        "UltGoal"
    } else if mode.is_strict() {
        "Goal Pro"
    } else {
        "Goal"
    }
}

fn goal_mode_command(mode: GoalMode) -> &'static str {
    if mode.is_arrangement() {
        "/ultgoal"
    } else if mode.is_strict() {
        "/goal-pro"
    } else {
        "/goal"
    }
}

fn pause_goal_message(engine: &QueryEngine) -> String {
    let Some(existing) = engine.state.goal() else {
        return "No goal is currently defined.".to_string();
    };
    if !existing.status.is_unfinished() {
        let command = goal_mode_command(existing.mode);
        return format!(
            "{} status is `{}` and cannot be paused. Use `{command} clear` before starting a new {}.",
            goal_mode_display_name(existing.mode),
            existing.status.as_str(),
            goal_mode_display_name(existing.mode).to_ascii_lowercase()
        );
    }
    let goal = engine
        .state
        .update_goal_status(GoalStatus::Paused)
        .unwrap_or(existing);
    format!(
        "{} paused: {}",
        goal_mode_display_name(goal.mode),
        one_line(&goal.objective, 120)
    )
}

fn format_goal_status(goal: Option<Goal>) -> String {
    let Some(goal) = goal else {
        return "No goal is currently defined.".to_string();
    };
    let command = goal_mode_command(goal.mode);
    let name = goal_mode_display_name(goal.mode);
    let mode = if goal.mode.is_arrangement() {
        "Arrangement"
    } else if goal.mode.is_strict() {
        "Strict"
    } else {
        "Standard"
    };
    let budget = goal
        .token_budget
        .map(|budget| format!(" / {budget}"))
        .unwrap_or_default();
    let file = goal
        .objective_file
        .as_ref()
        .map(|path| format!(". Objective file: {}", path.display()))
        .unwrap_or_default();
    let mut rendered = format!(
        "{name} `{}` ({mode}) verification={} is {}. Turn: {}. Tokens: {}{}. Time: {}s. Stop: Esc pauses, `{command} resume` continues. Objective: {}",
        goal.goal_id,
        goal.verification_kind.as_str(),
        goal.status.as_str(),
        goal.turn_count,
        goal.tokens_used,
        budget,
        goal.time_used_seconds,
        one_line(&goal.objective, 180)
    ) + &file;
    if goal.mode.is_strict() {
        let policy = &goal.verifier_selection.verification;
        let scope = match policy.minimum_test_scope {
            GoalProTestScope::Focused => "focused",
            GoalProTestScope::TargetSuite => "target_suite",
        };
        rendered.push_str(&format!(
            "\nVerifier policy: max_turns={}, semantic_rejections={}/{}, require_tests={}, minimum_test_scope={}, raw_exit={}, isolated_workspace={}, isolated_environment={}, dependency_changes={}, network_only_failures={}.",
            goal.verifier_selection.verifier_max_turns,
            goal.semantic_completion_rejected_count,
            goal.verifier_selection
                .completion_rejection_limit
                .map_or_else(|| "unlimited".to_string(), |limit| limit.to_string()),
            policy.require_tests,
            scope,
            policy.require_raw_exit_code,
            !policy.allow_workspace_changes,
            policy.isolate_environment,
            policy.allow_dependency_changes,
            policy.allow_network_only_failures,
        ));
    }
    if !goal.events.is_empty() {
        rendered.push_str("\nRecent events:");
        for event in goal.events.iter().rev().take(5).rev() {
            rendered.push_str(&format!(
                "\n- {}: {}",
                event.kind.as_str(),
                one_line(&event.summary, 160)
            ));
        }
    }
    rendered
}

fn format_goal_history(
    mut history: Vec<Goal>,
    current: Option<Goal>,
    requested_mode: GoalMode,
) -> String {
    if let Some(goal) = current
        && goal.status.is_history_worthy()
        && !history.iter().any(|entry| entry.goal_id == goal.goal_id)
    {
        history.push(goal);
    }
    if history.is_empty() {
        return format!(
            "No completed, blocked, or budget-limited {} history for this session.",
            goal_mode_display_name(requested_mode)
        );
    }

    history.sort_by_key(|goal| goal.updated_at_ms);
    let mut lines = vec![format!(
        "{} history:",
        goal_mode_display_name(requested_mode)
    )];
    for goal in history.iter().rev().take(20) {
        let budget = goal
            .token_budget
            .map(|budget| format!("/{budget}"))
            .unwrap_or_default();
        let mode = if goal.mode.is_arrangement() {
            "arrangement"
        } else if goal.mode.is_strict() {
            "strict"
        } else {
            "standard"
        };
        lines.push(format!(
            "- `{}` {} · {} · {} · tokens {}{} · {}s · {}",
            goal.goal_id,
            goal.status.as_str(),
            mode,
            goal.verification_kind.as_str(),
            goal.tokens_used,
            budget,
            goal.time_used_seconds,
            one_line(&goal.objective, 140)
        ));
    }
    lines.join("\n")
}

fn materialized_suffix(prepared: &kcoder_state::PreparedGoalObjective) -> String {
    if !prepared.materialized {
        return String::new();
    }
    prepared
        .objective_file
        .as_ref()
        .map(|path| {
            format!(
                " (objective exceeded {GOAL_OBJECTIVE_INLINE_CHAR_LIMIT} chars and was saved to {})",
                path.display()
            )
        })
        .unwrap_or_default()
}

fn one_line(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }

    let mut out = String::new();
    let mut pending_space = false;
    let mut chars = 0usize;
    let truncate_at = max_chars.saturating_sub(1);

    for ch in text.chars() {
        if ch.is_whitespace() {
            if !out.is_empty() {
                pending_space = true;
            }
            continue;
        }

        if pending_space {
            if chars == max_chars {
                let truncate_to = out
                    .char_indices()
                    .nth(truncate_at)
                    .map(|(idx, _)| idx)
                    .unwrap_or(out.len());
                out.truncate(truncate_to);
                out.push('…');
                return out;
            }
            out.push(' ');
            chars += 1;
            pending_space = false;
        }

        if chars == max_chars {
            let truncate_to = out
                .char_indices()
                .nth(truncate_at)
                .map(|(idx, _)| idx)
                .unwrap_or(out.len());
            out.truncate(truncate_to);
            out.push('…');
            return out;
        }
        out.push(ch);
        chars += 1;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::{
        GoalProCommand, OrchestrateCommand, OrchestrateWorkCommand, RosterCommand, SlashCommand,
        SlashResult, format_goal_history, format_goal_status, one_line, parse_goal_creation_args,
        parse_goal_pro_creation_args,
    };
    use crate::{ReplApp, test_support::test_engine};
    use kcoder_state::{Goal, GoalMode, GoalStatus, GoalVerificationKind, SessionMode};
    use kcoder_types::{Message, MessageRole};

    #[tokio::test]
    async fn orchestrate_command_enters_only_before_first_message() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = OrchestrateCommand.run("", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        assert_eq!(engine.state.session_mode(), SessionMode::Orchestrate);
        let message = app.messages.last().unwrap();
        assert_eq!(message.role, MessageRole::System);
        assert!(message.text.contains("Orchestrate session started"));
        assert!(message.text.contains("cannot be exited"));
    }

    #[tokio::test]
    async fn goal_pro_command_captures_baseline_in_non_git_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("app.txt"), "before\n").unwrap();
        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = GoalProCommand
            .run("change app.txt", &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        let goal = engine.state.goal().expect("Goal Pro should start");
        let baseline = goal
            .workspace_baseline
            .expect("non-Git Goal Pro should persist a baseline");
        assert!(baseline.bundle_path.is_file());
        assert!(!tmp.path().join(".git").exists());
        assert!(
            app.messages
                .last()
                .unwrap()
                .text
                .contains("Goal Pro started")
        );
    }

    #[tokio::test]
    async fn orchestrate_command_rejects_started_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path());
        engine
            .state
            .add_message(Message::user_text("already started"));
        let mut app = ReplApp::default();

        let result = OrchestrateCommand.run("", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        assert_eq!(engine.state.session_mode(), SessionMode::Default);
        assert!(app.messages.last().unwrap().text.contains("new session"));
    }

    #[tokio::test]
    async fn roster_command_is_mode_gated_and_reports_resolved_capability_digests() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        assert_eq!(
            RosterCommand.run("", &mut app, &engine).await,
            SlashResult::Handled
        );
        assert!(
            app.messages
                .last()
                .unwrap()
                .text
                .contains("requires an Orchestrate session")
        );

        engine
            .state
            .enter_orchestrate_before_first_message()
            .unwrap();
        assert_eq!(
            RosterCommand.run("", &mut app, &engine).await,
            SlashResult::Handled
        );
        let output = &app.messages.last().unwrap().text;
        assert!(output.contains("effective tool-set digest"));
        for persona in ["critic", "junior", "librarian", "oracle"] {
            assert!(output.lines().any(|line| line.starts_with(persona)));
        }
        // Show a summary without expanding tool permissions; `/roster` is not a capability entry point.
        assert!(!output.contains("ReviewVote,"));
    }

    #[tokio::test]
    async fn work_diagnostics_exports_a_managed_redacted_file() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path());
        engine
            .state
            .with_history_path(tmp.path().join("orchestrate-session.jsonl"));
        engine
            .state
            .enter_orchestrate_before_first_message()
            .unwrap();
        let mut app = ReplApp::default();

        assert_eq!(
            OrchestrateWorkCommand
                .run("diagnostics", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        let output = &app.messages.last().unwrap().text;
        assert!(output.contains("Exported redacted Orchestrate runtime diagnostics"));
        let path = engine
            .state
            .session_state_path()
            .unwrap()
            .parent()
            .unwrap()
            .join("orchestrate-runtime-diagnostics.json");
        assert!(path.is_file());
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("runtime_metrics"));
    }

    #[test]
    fn one_line_collapses_whitespace_without_trailing_space() {
        assert_eq!(
            one_line("  alpha\n\n beta\tgamma  ", 80),
            "alpha beta gamma"
        );
    }

    #[test]
    fn one_line_truncates_to_requested_width() {
        let rendered = one_line("abcdefghijklmnopqrstuvwxyz", 10);

        assert_eq!(rendered, "abcdefghi…");
        assert_eq!(rendered.chars().count(), 10);
    }

    #[test]
    fn one_line_truncates_when_collapsed_space_crosses_limit() {
        assert_eq!(one_line("abc   def", 4), "abc…");
    }

    #[test]
    fn parse_goal_budget_rejects_zero_budget() {
        let err = parse_goal_creation_args("--budget 0 finish").unwrap_err();

        assert!(err.contains("greater than 0"));
    }

    #[test]
    fn parse_goal_budget_rejects_missing_budget_value() {
        let err = parse_goal_creation_args("--budget").unwrap_err();

        assert!(err.contains("Missing goal token budget value"));
        assert!(err.contains("Usage: /goal"));
        assert!(err.contains("--budget <tokens> <objective>"));
    }

    #[test]
    fn parse_goal_budget_rejects_missing_objective() {
        let err = parse_goal_creation_args("--budget 100").unwrap_err();

        assert!(err.contains("Missing goal objective"));
        assert!(err.contains("Usage: /goal --budget <tokens> <objective>"));
    }

    #[test]
    fn goal_pro_answer_and_budget_flags_accept_either_order() {
        for input in [
            "--answer --budget 100 research architecture",
            "--budget 100 --answer research architecture",
        ] {
            let parsed = parse_goal_pro_creation_args(input).unwrap();
            assert_eq!(parsed.0, Some(100));
            assert_eq!(parsed.1, GoalVerificationKind::Answer);
            assert_eq!(parsed.2, "research architecture");
        }
    }

    #[test]
    fn goal_pro_flag_parser_rejects_duplicates_and_supports_terminator() {
        assert!(parse_goal_pro_creation_args("--answer --answer research").is_err());
        assert!(parse_goal_pro_creation_args("--budget 1 --budget 2 research").is_err());
        assert!(parse_goal_pro_creation_args("--unknown research").is_err());
        let parsed = parse_goal_pro_creation_args("--answer -- --literal objective").unwrap();
        assert_eq!(parsed.1, GoalVerificationKind::Answer);
        assert_eq!(parsed.2, "--literal objective");
    }

    #[test]
    fn goal_status_mentions_turn_and_goal_controls() {
        let mut goal = Goal::new("ship the feature", Some(100));
        goal.turn_count = 3;

        let rendered = format_goal_status(Some(goal));

        assert!(rendered.starts_with("Goal `"));
        assert!(rendered.contains("Turn: 3"));
        assert!(rendered.contains("Esc pauses"));
        assert!(rendered.contains("`/goal resume` continues"));
        assert!(!rendered.contains("UltGoal"));
    }

    #[test]
    fn ultgoal_status_mentions_arrangement_controls() {
        let mut goal = Goal::new_with_file_and_mode(
            "ship the orchestrated feature",
            None,
            Some(100),
            GoalMode::Arrangement,
        );
        goal.turn_count = 3;

        let rendered = format_goal_status(Some(goal));

        assert!(rendered.starts_with("UltGoal `"));
        assert!(rendered.contains("(Arrangement)"));
        assert!(rendered.contains("Turn: 3"));
        assert!(rendered.contains("`/ultgoal resume` continues"));
        assert!(!rendered.contains("`/goal resume` continues"));
    }

    #[test]
    fn goal_pro_status_mentions_strict_verifier_controls() {
        let mut goal = Goal::new_with_file_and_mode(
            "finish the remaining work",
            None,
            Some(100),
            GoalMode::Strict,
        );
        goal.turn_count = 2;
        goal.semantic_completion_rejected_count = 2;
        goal.verifier_selection.completion_rejection_limit = Some(5);
        let rendered = format_goal_status(Some(goal));
        assert!(rendered.starts_with("Goal Pro `"));
        assert!(rendered.contains("(Strict)"));
        assert!(rendered.contains("`/goal-pro resume` continues"));
        assert!(rendered.contains("minimum_test_scope=target_suite"));
        assert!(rendered.contains("semantic_rejections=2/5"));
        assert!(rendered.contains("isolated_workspace=true"));
    }

    #[test]
    fn goal_history_empty_state_uses_requested_mode_label() {
        assert_eq!(
            format_goal_history(Vec::new(), None, GoalMode::Standard),
            "No completed, blocked, or budget-limited Goal history for this session."
        );
        assert_eq!(
            format_goal_history(Vec::new(), None, GoalMode::Arrangement),
            "No completed, blocked, or budget-limited UltGoal history for this session."
        );
    }

    #[test]
    fn goal_history_includes_current_terminal_goal_once() {
        let mut goal = Goal::new("ship the feature", Some(100));
        goal.status = GoalStatus::Complete;
        goal.tokens_used = 42;

        let rendered = format_goal_history(Vec::new(), Some(goal), GoalMode::Standard);

        assert!(rendered.contains("Goal history:"));
        assert!(rendered.contains("complete"));
        assert!(rendered.contains("ship the feature"));
    }
}
