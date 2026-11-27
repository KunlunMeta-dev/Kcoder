//! Wire input for the Skill Curator tool.

use crate::skill_telemetry::SkillState;
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillCuratorAction {
    Status,
    Run,
    Pin,
    Unpin,
    Archive,
    Restore,
    Consolidate,
    ReviewAndPatch,
    Usage,
    MarkState,
    ScoreQuality,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SkillCuratorInput {
    /// Action to perform. `run` marks eligible AgentCreated skills stale and
    /// archives eligible stale AgentCreated skills; `status` reports usage/provenance; `pin`/`unpin`
    /// protect a skill from automatic archiving; `archive`/`restore` move a
    /// project skill into or out of `.kcoder/skills/.archive/`; `consolidate`
    /// creates an umbrella skill from multiple targets and archives them.
    pub action: SkillCuratorAction,
    /// Skill name. Required for pin/unpin/archive/restore. Also accepted as
    /// the destination name for consolidate when `into` is omitted.
    #[serde(default)]
    pub name: Option<String>,
    /// New lifecycle state. Required for mark_state.
    #[serde(default)]
    pub state: Option<SkillState>,
    /// Destination umbrella skill name for consolidate.
    #[serde(default)]
    pub into: Option<String>,
    /// Source skill names for consolidate.
    #[serde(default)]
    pub targets: Vec<String>,
    /// File to patch for review_and_patch. Defaults to SKILL.md. Supporting
    /// files must be under references/, templates/, scripts/, or assets/.
    #[serde(default)]
    pub file_path: Option<String>,
    /// Exact existing string to replace for review_and_patch.
    #[serde(default)]
    pub old_string: Option<String>,
    /// Replacement string for review_and_patch.
    #[serde(default)]
    pub new_string: Option<String>,
    /// Replace every occurrence instead of the first occurrence.
    #[serde(default)]
    pub replace_all: bool,
    /// Short explanation from the reviewer/sub-agent for audit logs.
    #[serde(default)]
    pub review_notes: Option<String>,
    /// Override stale threshold in days for `run`. Defaults to 30.
    #[serde(default)]
    pub stale_after_days: Option<i64>,
    /// Override archive threshold in days for `run`. Defaults to 90.
    #[serde(default)]
    pub archive_after_days: Option<i64>,
    /// If true, `run` and `review_and_patch` only report planned changes
    /// without writing files.
    #[serde(default)]
    pub dry_run: bool,
    /// If true, `run`, manual `archive`, and `consolidate` may process
    /// non-AgentCreated, non-bundled skills. Defaults to false so user,
    /// hub-installed, and external-dir skills are not archived by accident.
    #[serde(default)]
    pub include_non_agent_created: bool,
    /// If true, `run`, manual `archive`, and `consolidate` may process bundled
    /// skills. This is intentionally separate from `include_non_agent_created`
    /// so built-in skills are only archived by an explicit prune_builtins path.
    #[serde(default)]
    pub include_bundled: bool,
}
