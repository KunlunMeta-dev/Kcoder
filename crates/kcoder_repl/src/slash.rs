mod agent_commands;
mod navigation_commands;
use navigation_commands::{JumpCommand, OutlineCommand};
mod basic_commands;
mod context_commands;
mod conversation_commands;
mod info_commands;
mod memory_commands;
mod moa_commands;
mod parser;
mod permission_commands;
mod plan_commands;
mod registry;
mod session_commands;
mod settings_commands;
mod skill_commands;
mod skill_lifecycle_commands;
mod spec_commands;
mod workflow_commands;

pub use context_commands::ContextBreakdown;
pub use parser::parse_slash_input;
pub use registry::{SlashCommand, SlashRegistry, SlashResult};

use agent_commands::AgentCommand;
pub(crate) use agent_commands::refresh_agent_picker;
use basic_commands::{
    ClearCommand, CopyCommand, InitCommand, LunaCommand, MentionCommand, ModelCommand, NewCommand,
    QueueCommand, QuitCommand, RawCommand, ThemeCommand,
};
use context_commands::ContextCommand;
use conversation_commands::{
    BtwCommand, CompactCommand, DiffCommand, HistoryCommand, LearnCommand, OcrCommand,
    RenameCommand, ReviewCommand, RewindCommand, UndoCommand,
};
use info_commands::{
    AppsCommand, HelpCommand, HooksCommand, KeysCommand, McpCommand, PluginsCommand, PsCommand,
    RolloutCommand, StatusCommand, StopCommand, TasksCommand, TodosCommand, UsageCommand,
};
use memory_commands::{MemoriesCommand, RememberCommand};
use moa_commands::{MoaCommand, MoaPlanCommand};
use permission_commands::{AllowCommand, DenyCommand, PermissionCommand};
use plan_commands::{
    GoalCommand, GoalProCommand, OrchestrateCommand, OrchestrateWorkCommand, PlanCommand,
    PlanStatusCommand, RosterCommand, UltGoalCommand, UnplanCommand,
};
use session_commands::{
    DebugCommand, ExportCommand, ImportCommand, ResumeCommand, SessionsCommand,
};
use settings_commands::{SetCommand, SettingsCommand};
use skill_commands::{SkillCommand, SkillsCommand, ToolsCommand};
use skill_lifecycle_commands::{
    CuratorCommand, SkillBundledSyncCommand, SkillTelemetryCommand, SkillsHubCommand,
};
use spec_commands::SpecCommand;
use workflow_commands::WorkflowCommand;
