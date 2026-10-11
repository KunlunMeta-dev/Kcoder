//! Orchestration configuration types and their defaults.

use crate::*;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestratePolicyMode {
    #[default]
    Advisory,
    Enforce,
    Auto,
    Off,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrateContextMode {
    #[default]
    None,
    Fork,
    Full,
}

/// Optional tool configuration for the primary orchestration agent. The runtime
/// always retains core orchestration tools; settings only select non-core tools.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateMainSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optional_tool_allowlist: Option<Vec<String>>,
}

/// Capabilities that the primary orchestration agent cannot disable. They define
/// the mode: reading context, delegating and controlling agents, maintaining the
/// PlanStore, recording acceptance, and integrating with the goal state machine.
pub fn orchestrate_main_core_tools() -> &'static [&'static str] {
    &[
        "read",
        "glob",
        "grep",
        "spawn_agent",
        "SendMessage",
        "AgentFleet",
        "ControlAgent",
        "wait",
        "close_agent",
        "AskUserQuestion",
        "CreateWorkPlan",
        "EditWorkPlan",
        "AppendWorkNotepad",
        "RecordTaskAcceptance",
        "RecordTaskAcceptances",
        "ReopenTask",
        "SelectActiveWork",
        "PlanProgress",
        "get_goal",
        "update_goal",
    ]
}

/// Non-core tools that configuration may remove from the primary orchestration
/// surface. Registered tools absent from this list are core capabilities and
/// cannot be disabled through `orchestrate.main`.
pub fn orchestrate_main_optional_tools() -> &'static [&'static str] {
    &[
        "memory_search",
        "memory_get",
        "PlanAgent",
        "explore_agent",
        "Workflow",
        "WorkflowDraft",
        "TodoWrite",
        "WriteReport",
        "EditReport",
        "WebFetch",
        "WebSearch",
        "CtxInspect",
        "skill",
        "DiscoverSkills",
        "cron_create",
        "cron_delete",
        "cron_list",
        "Sleep",
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateRosterOverride {
    pub tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub context_mode: OrchestrateContextMode,
}

/// Persona capability identity fixed at compile time. Settings may select the
/// tier, context, and restrictive allowlist, but cannot override security fields.
pub fn orchestrate_persona_base_role(name: &str) -> Option<&'static str> {
    match name {
        "junior" => Some("implementer"),
        "oracle" | "critic" => Some("review"),
        "librarian" => Some("explore"),
        _ => None,
    }
}

/// Maximum tool set aligned with the engine base-role policy, used to reject additive privilege expansion while loading configuration.
pub fn orchestrate_persona_max_tools(name: &str) -> Option<&'static [&'static str]> {
    const READ_ONLY: &[&str] = &[
        "read",
        "glob",
        "grep",
        "WebSearch",
        "WebFetch",
        "CtxInspect",
        "Snip",
        "skill",
        "DiscoverSkills",
        "PlanProgress",
    ];
    const IMPLEMENTER: &[&str] = &[
        "read",
        "glob",
        "grep",
        "WebSearch",
        "WebFetch",
        "CtxInspect",
        "Snip",
        "bash",
        "PowerShell",
        "edit",
        "write",
        "TodoWrite",
        "skill",
        "DiscoverSkills",
        "EnterWorktree",
        "ExitWorktree",
        "WorktreeCreate",
        "WorktreeRemove",
        "Sleep",
        "AppendWorkNotepad",
        "PlanProgress",
    ];
    match name {
        "junior" => Some(IMPLEMENTER),
        "oracle" | "librarian" | "critic" => Some(READ_ONLY),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestratePoliciesSettings {
    #[serde(default = "default_orchestrate_evidence_gate")]
    pub evidence_gate: OrchestratePolicyMode,
    #[serde(default)]
    pub delegation_contract: OrchestratePolicyMode,
}

impl Default for OrchestratePoliciesSettings {
    fn default() -> Self {
        Self {
            evidence_gate: default_orchestrate_evidence_gate(),
            delegation_contract: OrchestratePolicyMode::Advisory,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateNotepadSettings {
    #[serde(default = "default_true")]
    pub inject: bool,
    #[serde(default = "default_orchestrate_notepad_max_inject_bytes")]
    pub max_inject_bytes: usize,
}

impl Default for OrchestrateNotepadSettings {
    fn default() -> Self {
        Self {
            inject: true,
            max_inject_bytes: default_orchestrate_notepad_max_inject_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateContinuationSettings {
    #[serde(default = "default_orchestrate_cooldown_seconds")]
    pub cooldown_seconds: u64,
    #[serde(default = "default_orchestrate_max_stalled_rounds")]
    pub max_stalled_rounds: u32,
    #[serde(default = "default_orchestrate_max_consecutive_failures")]
    pub max_consecutive_failures: u32,
    #[serde(default = "default_orchestrate_max_auto_turns")]
    pub max_auto_turns: u32,
}

impl Default for OrchestrateContinuationSettings {
    fn default() -> Self {
        Self {
            cooldown_seconds: default_orchestrate_cooldown_seconds(),
            max_stalled_rounds: default_orchestrate_max_stalled_rounds(),
            max_consecutive_failures: default_orchestrate_max_consecutive_failures(),
            max_auto_turns: default_orchestrate_max_auto_turns(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateDeliverySettings {
    #[serde(default = "default_orchestrate_delivery_lease_timeout_seconds")]
    pub lease_timeout_seconds: u64,
    #[serde(default = "default_orchestrate_delivery_max_attempts")]
    pub max_attempts: u32,
}

impl Default for OrchestrateDeliverySettings {
    fn default() -> Self {
        Self {
            lease_timeout_seconds: default_orchestrate_delivery_lease_timeout_seconds(),
            max_attempts: default_orchestrate_delivery_max_attempts(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateFleetSettings {
    #[serde(default = "default_true")]
    pub inject: bool,
    #[serde(default = "default_orchestrate_fleet_max_members")]
    pub max_members: usize,
    #[serde(default = "default_orchestrate_fleet_max_inject_bytes")]
    pub max_inject_bytes: usize,
}

impl Default for OrchestrateFleetSettings {
    fn default() -> Self {
        Self {
            inject: true,
            max_members: default_orchestrate_fleet_max_members(),
            max_inject_bytes: default_orchestrate_fleet_max_inject_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateControlSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for OrchestrateControlSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateBreakerSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub hard_stop: bool,
    #[serde(default = "default_orchestrate_breaker_repeated_action_threshold")]
    pub repeated_action_threshold: u32,
    #[serde(default = "default_orchestrate_breaker_consecutive_error_threshold")]
    pub consecutive_error_threshold: u32,
    #[serde(default = "default_orchestrate_breaker_no_progress_rounds")]
    pub no_progress_rounds: u32,
}

impl Default for OrchestrateBreakerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            hard_stop: false,
            repeated_action_threshold: default_orchestrate_breaker_repeated_action_threshold(),
            consecutive_error_threshold: default_orchestrate_breaker_consecutive_error_threshold(),
            no_progress_rounds: default_orchestrate_breaker_no_progress_rounds(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateAuditSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_orchestrate_audit_max_events")]
    pub max_events: usize,
    #[serde(default = "default_orchestrate_audit_max_event_bytes")]
    pub max_event_bytes: usize,
}

impl Default for OrchestrateAuditSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_events: default_orchestrate_audit_max_events(),
            max_event_bytes: default_orchestrate_audit_max_event_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrateSettings {
    #[serde(default)]
    pub main: OrchestrateMainSettings,
    #[serde(default)]
    pub tiers: BTreeMap<String, ModelSlotConfig>,
    #[serde(default = "default_orchestrate_roster")]
    pub roster: BTreeMap<String, OrchestrateRosterOverride>,
    #[serde(default = "default_orchestrate_critic_max_cycles")]
    pub critic_max_cycles: usize,
    #[serde(default = "default_orchestrate_critic_max_infrastructure_retries")]
    pub critic_max_infrastructure_retries: usize,
    #[serde(default)]
    pub policies: OrchestratePoliciesSettings,
    #[serde(default)]
    pub notepad: OrchestrateNotepadSettings,
    #[serde(default)]
    pub continuation: OrchestrateContinuationSettings,
    #[serde(default)]
    pub delivery: OrchestrateDeliverySettings,
    #[serde(default)]
    pub fleet: OrchestrateFleetSettings,
    #[serde(default)]
    pub control: OrchestrateControlSettings,
    #[serde(default)]
    pub breaker: OrchestrateBreakerSettings,
    #[serde(default)]
    pub audit: OrchestrateAuditSettings,
}

impl Default for OrchestrateSettings {
    fn default() -> Self {
        Self {
            main: OrchestrateMainSettings::default(),
            tiers: BTreeMap::new(),
            roster: default_orchestrate_roster(),
            critic_max_cycles: default_orchestrate_critic_max_cycles(),
            critic_max_infrastructure_retries:
                default_orchestrate_critic_max_infrastructure_retries(),
            policies: OrchestratePoliciesSettings::default(),
            notepad: OrchestrateNotepadSettings::default(),
            continuation: OrchestrateContinuationSettings::default(),
            delivery: OrchestrateDeliverySettings::default(),
            fleet: OrchestrateFleetSettings::default(),
            control: OrchestrateControlSettings::default(),
            breaker: OrchestrateBreakerSettings::default(),
            audit: OrchestrateAuditSettings::default(),
        }
    }
}

pub(crate) fn default_orchestrate_roster() -> BTreeMap<String, OrchestrateRosterOverride> {
    [
        ("junior", "standard"),
        ("oracle", "max"),
        ("librarian", "fast"),
        ("critic", "max"),
    ]
    .into_iter()
    .map(|(name, tier)| {
        (
            name.to_string(),
            OrchestrateRosterOverride {
                tier: tier.to_string(),
                tool_allowlist: None,
                context_mode: OrchestrateContextMode::None,
            },
        )
    })
    .collect()
}

pub(crate) fn default_orchestrate_evidence_gate() -> OrchestratePolicyMode {
    OrchestratePolicyMode::Auto
}

pub(crate) fn default_orchestrate_notepad_max_inject_bytes() -> usize {
    8192
}

pub(crate) fn default_orchestrate_cooldown_seconds() -> u64 {
    30
}

pub(crate) fn default_orchestrate_max_stalled_rounds() -> u32 {
    5
}

pub(crate) fn default_orchestrate_max_consecutive_failures() -> u32 {
    3
}

pub(crate) fn default_orchestrate_max_auto_turns() -> u32 {
    8
}

pub(crate) fn default_orchestrate_critic_max_cycles() -> usize {
    3
}

pub(crate) fn default_orchestrate_critic_max_infrastructure_retries() -> usize {
    2
}

pub(crate) fn default_orchestrate_delivery_lease_timeout_seconds() -> u64 {
    120
}

pub(crate) fn default_orchestrate_delivery_max_attempts() -> u32 {
    8
}

pub(crate) fn default_orchestrate_fleet_max_members() -> usize {
    24
}

pub(crate) fn default_orchestrate_fleet_max_inject_bytes() -> usize {
    8192
}

pub(crate) fn default_orchestrate_breaker_repeated_action_threshold() -> u32 {
    8
}

pub(crate) fn default_orchestrate_breaker_consecutive_error_threshold() -> u32 {
    5
}

pub(crate) fn default_orchestrate_breaker_no_progress_rounds() -> u32 {
    4
}

pub(crate) fn default_orchestrate_audit_max_events() -> usize {
    4096
}

pub(crate) fn default_orchestrate_audit_max_event_bytes() -> usize {
    4096
}
