use crate::ReplApp;
use kcoder_engine::QueryEngine;
use std::collections::HashMap;

use super::{
    AgentCommand, AllowCommand, AppsCommand, BtwCommand, ClearCommand, CompactCommand,
    ContextCommand, CopyCommand, CuratorCommand, DebugCommand, DenyCommand, DiffCommand,
    ExportCommand, GoalCommand, GoalProCommand, HelpCommand, HistoryCommand, HooksCommand,
    ImportCommand, InitCommand, JumpCommand, KeysCommand, LearnCommand, LunaCommand, McpCommand,
    MemoriesCommand, MentionCommand, MoaCommand, MoaPlanCommand, ModelCommand, NewCommand,
    OcrCommand, OrchestrateCommand, OrchestrateWorkCommand, OutlineCommand, PermissionCommand,
    PlanCommand, PlanStatusCommand, PluginsCommand, PsCommand, QueueCommand, QuitCommand,
    RawCommand, RememberCommand, RenameCommand, ResumeCommand, ReviewCommand, RewindCommand,
    RolloutCommand, RosterCommand, SessionsCommand, SetCommand, SettingsCommand,
    SkillBundledSyncCommand, SkillCommand, SkillTelemetryCommand, SkillsCommand, SkillsHubCommand,
    SpecCommand, StatusCommand, StopCommand, TasksCommand, ThemeCommand, TodosCommand,
    ToolsCommand, UltGoalCommand, UndoCommand, UnplanCommand, UsageCommand, WorkflowCommand,
};

/// Result of executing a slash command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlashResult {
    /// Continue running the REPL (most commands).
    Handled,
    /// Submit a prompt to the model as if it came from the composer.
    Submit(String),
    /// Submit a model prompt while showing a shorter user-facing transcript line.
    SubmitWithDisplay {
        visible_text: String,
        model_text: String,
    },
    /// Start manual context compaction on the TUI-managed foreground task.
    StartCompact,
    /// Start an isolated side question without interrupting the foreground turn.
    StartSideQuestion(String),
    /// Start the foreground MoA plan operation.
    StartMoaPlan(String),
    /// Exit the REPL.
    Quit,
}

/// A slash command definition.
#[async_trait::async_trait]
pub trait SlashCommand: Send + Sync {
    /// Primary command name including the leading slash.
    fn name(&self) -> &'static str;
    /// Alternative names including the leading slash.
    fn aliases(&self) -> &[&'static str] {
        &[]
    }
    /// One-line description shown in /help.
    fn description(&self) -> &'static str;
    /// Usage example shown in /help.
    fn usage(&self) -> &'static str;
    /// Whether Enter should only complete the command and wait for arguments.
    /// Required arguments are explicit metadata, never inferred from usage text.
    fn needs_arguments(&self) -> bool {
        false
    }
    /// Execute the command. `args` is the remainder of the input line.
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult;
}

/// Registry of slash commands.
pub struct SlashRegistry {
    commands: Vec<Box<dyn SlashCommand>>,
    by_name: HashMap<String, usize>,
}

impl SlashRegistry {
    pub fn new() -> Self {
        let mut reg = Self {
            commands: Vec::new(),
            by_name: HashMap::new(),
        };
        // Bare slash Enter executes the selected item, so help must be the safe default.
        reg.register::<HelpCommand>()
            .register::<QuitCommand>()
            .register::<OutlineCommand>()
            .register::<JumpCommand>()
            .register::<AgentCommand>()
            .register::<NewCommand>()
            .register::<LunaCommand>()
            .register::<InitCommand>()
            .register::<ClearCommand>()
            .register::<CopyCommand>()
            .register::<RawCommand>()
            .register::<ModelCommand>()
            .register::<ThemeCommand>()
            .register::<MentionCommand>()
            .register::<PermissionCommand>()
            .register::<AllowCommand>()
            .register::<DenyCommand>()
            .register::<RememberCommand>()
            .register::<MemoriesCommand>()
            .register::<SkillCommand>()
            .register::<SkillsCommand>()
            .register::<SkillTelemetryCommand>()
            .register::<CuratorCommand>()
            .register::<SkillBundledSyncCommand>()
            .register::<SkillsHubCommand>()
            .register::<ToolsCommand>()
            .register::<HistoryCommand>()
            .register::<BtwCommand>()
            .register::<UndoCommand>()
            .register::<QueueCommand>()
            .register::<CompactCommand>()
            .register::<RewindCommand>()
            .register::<ReviewCommand>()
            .register::<OcrCommand>()
            .register::<LearnCommand>()
            .register::<MoaCommand>()
            .register::<MoaPlanCommand>()
            .register::<RenameCommand>()
            .register::<DiffCommand>()
            .register::<ContextCommand>()
            .register::<SettingsCommand>()
            .register::<SetCommand>()
            .register::<StatusCommand>()
            .register::<HooksCommand>()
            .register::<PluginsCommand>()
            .register::<AppsCommand>()
            .register::<RolloutCommand>()
            .register::<PsCommand>()
            .register::<StopCommand>()
            .register::<WorkflowCommand>()
            .register::<McpCommand>()
            .register::<PlanCommand>()
            .register::<UnplanCommand>()
            .register::<PlanStatusCommand>()
            .register::<GoalCommand>()
            .register::<GoalProCommand>()
            .register::<OrchestrateCommand>()
            .register::<OrchestrateWorkCommand>()
            .register::<RosterCommand>()
            .register::<UltGoalCommand>()
            .register::<SpecCommand>()
            .register::<ExportCommand>()
            .register::<ImportCommand>()
            .register::<DebugCommand>()
            .register::<TodosCommand>()
            .register::<TasksCommand>()
            .register::<SessionsCommand>()
            .register::<ResumeCommand>()
            .register::<KeysCommand>()
            .register::<UsageCommand>();
        reg
    }

    fn register<T: SlashCommand + Default + 'static>(&mut self) -> &mut Self {
        let cmd = T::default();
        let idx = self.commands.len();
        self.by_name.insert(cmd.name().to_lowercase(), idx);
        for alias in cmd.aliases() {
            self.by_name.insert(alias.to_lowercase(), idx);
        }
        self.commands.push(Box::new(cmd));
        self
    }

    /// Look up a command by its primary name or alias.
    pub fn get(&self, name: &str) -> Option<&dyn SlashCommand> {
        self.by_name
            .get(&name.to_lowercase())
            .and_then(|&idx| self.commands.get(idx))
            .map(|b| b.as_ref())
    }

    /// Iterator over all registered commands.
    pub fn iter(&self) -> impl Iterator<Item = &dyn SlashCommand> {
        self.commands.iter().map(|b| b.as_ref())
    }
}

impl Default for SlashRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_includes_skill_lifecycle_commands() {
        let registry = SlashRegistry::new();

        for command in [
            "/new",
            "/btw",
            "/luna",
            "/init",
            "/exit",
            "/copy",
            "/raw",
            "/review",
            "/ocr",
            "/learn",
            "/moa-plan",
            "/rename",
            "/diff",
            "/theme",
            "/mention",
            "/status",
            "/hooks",
            "/plugins",
            "/apps",
            "/rollout",
            "/ps",
            "/stop",
            "/clean",
            "/workflow",
            "/workflows",
            "/permissions",
            "/debug-config",
            "/goal",
            "/orchestrate",
            "/ultgoal",
            "/agent",
            "/subagents",
            "/keymap",
            "/skill-usage",
            "/curator",
            "/skill-sync",
            "/skills-hub",
        ] {
            assert!(
                registry.get(command).is_some(),
                "missing slash command {command}"
            );
        }
        assert_eq!(registry.get("/exit").unwrap().name(), "/quit");
        assert_eq!(registry.get("/clean").unwrap().name(), "/stop");
        assert_eq!(registry.get("/workflows").unwrap().name(), "/workflow");
        assert_eq!(registry.get("/permissions").unwrap().name(), "/permission");
        assert_eq!(registry.get("/debug-config").unwrap().name(), "/debug");
        assert_eq!(registry.get("/goal").unwrap().name(), "/goal");
        let removed_command = format!("/{}{}", "lo", "op");
        assert!(registry.get(&removed_command).is_none());
        let removed_arrangement_command = format!("/ult{}{}", "lo", "op");
        assert!(registry.get(&removed_arrangement_command).is_none());
        assert_eq!(registry.get("/agent").unwrap().name(), "/agent");
        assert_eq!(registry.get("/subagents").unwrap().name(), "/tasks");
        assert_eq!(registry.get("/keymap").unwrap().name(), "/keys");
        assert_eq!(registry.get("/skill-hub").unwrap().name(), "/skills-hub");
        assert!(registry.get("/models").is_none());
    }

    #[test]
    fn registry_includes_goal_pro() {
        let registry = SlashRegistry::new();
        let command = registry.get("/goal-pro").expect("goal-pro command");
        assert!(command.description().contains("independent verifier"));
    }
}
