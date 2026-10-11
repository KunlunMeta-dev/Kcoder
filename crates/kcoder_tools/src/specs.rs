//! Spec-driven development tools for KCoder.
//!
//! These tools expose the `kcoder_specs` crate operations to the model so it
//! can initialize, create, validate, and archive spec-driven changes.

use crate::agent::{MAX_AGENT_MAX_TURNS, MIN_AGENT_MAX_TURNS, clamp_agent_max_turns};
use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::task::JoinSet;

/// Initialize the spec subsystem for the current project.
#[derive(Debug, Default)]
pub struct SpecInitTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecInitInput {
    /// Overwrite existing skill files with the bundled versions.
    #[serde(default)]
    pub force_update: bool,
}

/// Update bundled spec workflow skills for the current project.
#[derive(Debug, Default)]
pub struct SpecUpdateTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecUpdateInput {
    /// Report planned updates without writing files.
    #[serde(default)]
    pub dry_run: bool,
    /// Overwrite bundled Superpowers skills even when local content differs.
    #[serde(default)]
    pub force_update: bool,
}

/// Create a new spec-driven change.
#[derive(Debug, Default)]
pub struct SpecNewChangeTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecNewChangeInput {
    /// Kebab-case change name.
    pub name: String,
    /// Optional human-readable title.
    pub title: Option<String>,
}

/// Archive a completed change.
#[derive(Debug, Default)]
pub struct SpecArchiveTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecArchiveInput {
    /// Name of the change to archive.
    pub name: String,
}

/// Show the status of a change.
#[derive(Debug, Default)]
pub struct SpecStatusTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecStatusInput {
    /// Name of the change to report on using the quick dashboard.
    #[serde(default)]
    pub name: Option<String>,
    /// Name of the change to read deeply, including its artifact files.
    #[serde(default)]
    pub change: Option<String>,
    /// Include delta spec markdown files for a deep read. Defaults to true.
    #[serde(default = "default_include_specs")]
    pub include_specs: bool,
    /// Maximum bytes to return per file during a deep read.
    #[serde(default = "default_spec_show_max_bytes")]
    pub max_file_bytes: usize,
}

/// Show structured details and files for a spec-driven change.
#[derive(Debug, Default)]
pub struct StatusDeepRead;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct StatusDeepReadInput {
    /// Name of the change to show.
    pub name: String,
    /// Include delta spec markdown files under specs/**. Defaults to true.
    #[serde(default = "default_include_specs")]
    pub include_specs: bool,
    /// Maximum bytes to return per file. Defaults to 65536.
    #[serde(default = "default_spec_show_max_bytes")]
    pub max_file_bytes: usize,
}

/// Run apply-time preflight checks for a spec-driven change.
#[derive(Debug, Default)]
pub struct SpecPreflightOperation;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecPreflightOperationInput {
    /// Name of the change to check.
    pub name: String,
}

/// Validate a change or the whole spec subsystem.
#[derive(Debug, Default)]
pub struct CheckValidateStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CheckValidateStageInput {
    /// Optional specific change to validate. If omitted, all active changes are validated.
    pub change: Option<String>,
}

/// Compare spec scenarios against the project's test suite.
#[derive(Debug, Default)]
pub struct CheckVerifyStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CheckVerifyStageInput {}

/// Validate, verify, or preflight the spec subsystem.
#[derive(Debug, Default)]
pub struct SpecCheckTool;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpecCheckAction {
    Validate,
    Verify,
    Preflight,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecCheckInput {
    pub action: SpecCheckAction,
    /// Optional change for validate; required for preflight.
    #[serde(default)]
    pub change: Option<String>,
    /// Compatibility field accepted as the preflight change name.
    #[serde(default)]
    pub name: Option<String>,
}

/// Record retained verification evidence for a spec-driven change.
#[derive(Debug, Default)]
pub struct SpecRecordVerificationTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecRecordVerificationInput {
    /// Name of the change whose verification.md should be updated.
    pub name: String,
    /// Completion decision, e.g. `complete`, `verified`, `pending`, or `failed`.
    pub completion_decision: String,
    /// Commands that were run and their outcome.
    #[serde(default)]
    pub commands_run: Vec<String>,
    /// Manual checks that were performed.
    #[serde(default)]
    pub manual_checks: Vec<String>,
    /// Evidence paths, logs, screenshots, or other supporting references.
    #[serde(default)]
    pub evidence: Vec<String>,
    /// Known residual risks or `none`.
    #[serde(default)]
    pub residual_risks: Vec<String>,
}

/// Write review findings back into spec-driven-superpowers artifacts.
#[derive(Debug, Default)]
pub struct ReviewWritebackStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReviewWritebackStageInput {
    /// Name of the change whose review findings should be written back.
    pub name: String,
    /// Review status to record, e.g. `findings-received`, `approved`, or `changes-requested`.
    pub review_status: String,
    /// Finding disposition summary lines for review.md.
    #[serde(default)]
    pub findings_summary: Vec<String>,
    /// Accepted findings that require implementation follow-up in tasks.md and plan.md.
    #[serde(default)]
    pub accepted_followups: Vec<String>,
    /// Accepted findings or risks that should be retained in verification.md.
    #[serde(default)]
    pub verification_notes: Vec<String>,
}

/// Build a code-review request for a spec-driven change.
#[derive(Debug, Default)]
pub struct SpecReviewTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecReviewInput {
    /// Review stage. Defaults to prepare.
    #[serde(default)]
    pub action: SpecReviewAction,
    /// Name of the change to review.
    pub name: String,
    /// Optional git base SHA or ref (defaults to origin/main or HEAD~1).
    #[serde(default)]
    pub base_sha: Option<String>,
    /// Maximum turns for dispatch.
    #[serde(default = "default_review_turns")]
    pub max_turns: usize,
    /// Review status for writeback.
    #[serde(default)]
    pub review_status: Option<String>,
    #[serde(default)]
    pub findings_summary: Vec<String>,
    #[serde(default)]
    pub accepted_followups: Vec<String>,
    #[serde(default)]
    pub verification_notes: Vec<String>,
}

#[derive(Debug, Default, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpecReviewAction {
    #[default]
    Prepare,
    Dispatch,
    Writeback,
}

/// Dispatch a code reviewer subagent for a spec-driven change.
#[derive(Debug, Default)]
pub struct ReviewDispatchStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReviewDispatchStageInput {
    /// Name of the change to review.
    pub name: String,
    /// Optional git base SHA or ref.
    #[serde(default)]
    pub base_sha: Option<String>,
    /// Maximum turns for the reviewer subagent.
    #[serde(default = "default_review_turns")]
    pub max_turns: usize,
}

const USING_SPECS_SKILL_NAME: &str = "using-specs";
const SUPERPOWERS_ROOT_SKILL_NAME: &str = "using-superpowers";

struct UsingSpecsUpdatePlan {
    action: String,
    conflict: bool,
    new_file: PathBuf,
}

/// Delegate delta-spec drafting for multiple independent domains to parallel subagents.
#[derive(Debug, Default)]
pub struct SpecParallelDraftTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecParallelDraftInput {
    /// Name of the change whose deltas should be drafted.
    pub name: String,
    /// Independent capability domains to draft in parallel.
    pub domains: Vec<String>,
    /// Maximum turns per subagent.
    #[serde(default = "default_review_turns")]
    pub max_turns: usize,
}

/// Read a value from .kcoder/specs/config.yaml.
#[derive(Debug, Default)]
pub struct ConfigGetStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConfigGetStageInput {
    /// Config key to read (`schema`, `context`, `precheck`, `rules.<artifact>`).
    /// If omitted, returns the whole config file.
    #[serde(default)]
    pub key: Option<String>,
}

/// Set a value in .kcoder/specs/config.yaml.
#[derive(Debug, Default)]
pub struct ConfigSetStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConfigSetStageInput {
    /// Config key to set (`schema`, `context`, `precheck`, `rules.<artifact>`).
    pub key: String,
    /// New value. For `rules.<artifact>` use a YAML list of strings.
    pub value: String,
}

#[derive(Debug, Default)]
pub struct SpecConfigTool;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpecConfigAction {
    Get,
    Set,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecConfigInput {
    pub action: SpecConfigAction,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
}

/// Rebase a spec-driven change against the current authoritative specs.
#[derive(Debug, Default)]
pub struct SpecSyncTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecSyncInput {
    /// Name of the change to sync.
    pub name: String,
}

mod input_schema;
use input_schema::*;

mod skill_updates;
use skill_updates::*;

mod render;
use render::*;

mod lifecycle_tools;

mod query_tools;

mod verification_tools;

mod parallel_tools;

mod configuration_tools;

#[cfg(test)]
mod tests;
