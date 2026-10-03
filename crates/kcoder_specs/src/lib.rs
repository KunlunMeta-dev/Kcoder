//! Spec-driven development support for KCoder.
//!
//! This crate ports the essential OpenSpec spec/change lifecycle into KCoder
//! Code's Rust implementation while staying compatible with KCoder's existing
//! skill system and its built-in workflow library.
//!
//! Directory layout under the project root:
//!
//! ```text
//! .kcoder/
//!   specs/
//!     specs/<domain>/spec.md          # authoritative behavior specs
//!     changes/<name>/                 # active change
//!       .spec.yaml                     # change metadata
//!       proposal.md
//!       specs/<domain>.md              # delta spec (ADDED/MODIFIED/REMOVED)
//!       design.md
//!       tasks.md
//!     changes/archive/<date>-<name>/  # completed change
//!   skills/using-specs/SKILL.md       # auto-triggered methodology skill
//! ```

use anyhow::{Context, Result};
use kcoder_skills::{
    ExpectedSkillRevision, SkillCommitRequest, SkillMetadataDelta, SkillMetadataPatch,
    SkillMutation, SkillMutationActor, SkillOperationKind, SkillPackage, SkillPackageFile,
    SkillStore, canonical_package_revision,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{debug, warn};

pub mod config;
pub mod fingerprint;
pub mod merge;
pub mod parse;
mod process;
pub mod sync;

use process::{
    resolve_program, resolve_shell_program, run_cargo_command, run_cargo_precheck, run_git_command,
    run_project_precheck,
};

pub use fingerprint::{BaseSnapshot, RequirementFingerprint, capture_base_snapshot, check_change};
pub use merge::merge_change;
pub use parse::{DeltaSpec, Rename, Requirement, Scenario, Spec, parse_delta, parse_spec};
pub use sync::{ReqRef, SyncReport, sync};

/// Relative path from a project root to the specs directory.
pub const SPECS_DIR: &str = ".kcoder/specs";
/// Relative path from a project root to the skill that auto-activates the spec workflow.
pub const SPEC_SKILL_DIR: &str = ".kcoder/skills/using-specs";

/// Companion files installed with the built-in workflow skills.
///
/// Paths are relative to each skill directory. These files contain reviewer prompts
/// Debugging resources and helper scripts require materializing more than only `SKILL.md` into the project.
#[derive(Debug, Clone, Copy)]
pub struct BundledSkillAsset {
    pub skill: &'static str,
    pub relative_path: &'static str,
    pub content: &'static str,
}

/// Metadata persisted in `.kcoder/specs/changes/<name>/.spec.yaml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeMetadata {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub status: ChangeStatus,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    #[default]
    Draft,
    InProgress,
    ReadyForArchive,
    Archived,
}

/// Description of whether a change artifact is present and complete.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactStatus {
    pub name: String,
    pub present: bool,
    pub non_empty: bool,
}

/// Summary returned by `status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeStatusSummary {
    pub name: String,
    pub title: Option<String>,
    pub schema: String,
    pub status: ChangeStatus,
    pub artifacts: Vec<ArtifactStatus>,
    pub tasks_complete: bool,
    pub drift_errors: Vec<String>,
    pub apply_blockers: Vec<String>,
    pub completion_blockers: Vec<String>,
    pub verification: SpecVerificationStatus,
}

/// Apply-time readiness report for a spec-driven change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecApplyPreflightReport {
    pub change_name: String,
    pub schema: String,
    pub ok: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub modes: SpecApplyModes,
    pub task_coverage: SpecTaskCoverage,
    pub validation_focus: Vec<String>,
    pub unmapped_validation_focus: Vec<String>,
    pub verification: SpecVerificationStatus,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpecApplyModes {
    pub readiness_decision: String,
    pub execution_mode: String,
    pub verification_mode: String,
    pub debug_mode: String,
    pub review_status: String,
    pub delegation_mode: String,
    pub parallelization_mode: String,
    pub worktree_mode: String,
    pub branch_finish_mode: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpecTaskCoverage {
    pub open_task_ids: Vec<String>,
    pub covered_task_ids: Vec<String>,
    pub uncovered_task_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpecVerificationStatus {
    pub present: bool,
    pub completion_decision: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpecVerificationRecord {
    pub completion_decision: String,
    #[serde(default)]
    pub commands_run: Vec<String>,
    #[serde(default)]
    pub manual_checks: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub residual_risks: Vec<String>,
}

/// Structured review findings to write back into spec-driven-superpowers artifacts.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpecReviewWritebackRecord {
    pub review_status: String,
    #[serde(default)]
    pub findings_summary: Vec<String>,
    #[serde(default)]
    pub accepted_followups: Vec<String>,
    #[serde(default)]
    pub verification_notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecReviewWritebackReport {
    pub change_name: String,
    pub review_status: String,
    pub review_path: PathBuf,
    pub tasks_updated: bool,
    pub plan_updated: bool,
    pub verification_updated: bool,
}

/// Coverage report produced by `verify`.
#[derive(Debug, Clone, Default)]
pub struct SpecVerifyReport {
    pub covered: Vec<String>,
    pub gaps: Vec<String>,
}

/// Review request report produced by `review`.
#[derive(Debug, Clone, Default)]
pub struct SpecReviewReport {
    pub change_name: String,
    pub title: Option<String>,
    pub proposal: String,
    pub design: String,
    pub tasks: String,
    pub deltas: Vec<(String, String)>,
    pub git_base: String,
    pub git_head: String,
    pub git_diff_stat: String,
    pub git_diff: String,
    pub precheck_summary: String,
    pub reviewer_prompt: String,
}

mod workspace_paths;
pub use workspace_paths::specs_dir_for;
use workspace_paths::*;

mod bundled_assets;
pub use bundled_assets::SUPERPOWER_EXECUTABLE_ASSETS;
pub use bundled_assets::SUPERPOWER_SKILL_ASSETS;
pub use bundled_assets::SUPERPOWER_SKILLS;
pub use bundled_assets::bundled_skill_asset_is_executable;
pub use bundled_assets::render_using_specs_skill;
use bundled_assets::*;

mod change_lifecycle;
pub use change_lifecycle::apply_plan;
pub use change_lifecycle::archive;
pub use change_lifecycle::list_changes;
pub use change_lifecycle::new_change;
use change_lifecycle::*;

mod installation;
pub use installation::init;
pub use installation::init_with_force;
pub use installation::init_with_force_report;
pub use installation::sync_using_specs_skill;
pub use installation::sync_using_specs_skill_report;

mod verification;
pub use verification::record_verification;
pub use verification::verify;
use verification::*;

mod validation;
pub use validation::validate;

mod change_status;
pub use change_status::status;

mod apply_preflight;
pub use apply_preflight::apply_preflight;
use apply_preflight::*;

mod review;
pub use review::review;
pub use review::review_writeback;

mod markdown;
use markdown::*;

#[cfg(test)]
#[rustfmt::skip]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
mod change_boundary_tests;
