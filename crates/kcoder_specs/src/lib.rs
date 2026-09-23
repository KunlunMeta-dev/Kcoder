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

pub fn specs_dir_for(cwd: &Path) -> PathBuf {
    cwd.join(SPECS_DIR)
}

fn validate_change_name(name: &str) -> Result<()> {
    // Windows device names are not regular files even with extensions; reject them consistently across platforms.
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    // Reject separators, drive/ADS syntax, wildcards, and control characters while retaining ordinary Unicode names.
    anyhow::ensure!(
        !name.trim().is_empty()
            && !reserved
            && !name.contains(['/', '\\', ':', '?', '*', '<', '>', '|', '"'])
            && !name.chars().any(char::is_control)
            && !name.ends_with(['.', ' '])
            && matches!(
                Path::new(name).components().next(),
                Some(std::path::Component::Normal(_))
            )
            && Path::new(name).components().count() == 1,
        "invalid change name: expected a non-empty single path component"
    );
    Ok(())
}

fn check_change_directory(path: &Path, workspace: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            anyhow::ensure!(
                !metadata.file_type().is_symlink(),
                "change path must not contain a symlink: {}",
                path.display()
            );
            anyhow::ensure!(
                metadata.is_dir(),
                "change path must be a directory: {}",
                path.display()
            );
            let resolved = path
                .canonicalize()
                .with_context(|| format!("failed to resolve change path {}", path.display()))?;
            anyhow::ensure!(
                resolved.starts_with(workspace),
                "change path escapes workspace: {}",
                path.display()
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to inspect change path {}", path.display()));
        }
    }
    Ok(())
}

fn checked_changes_dir(cwd: &Path) -> Result<PathBuf> {
    let workspace = cwd
        .canonicalize()
        .context("failed to resolve spec workspace")?;
    let mut path = cwd.to_path_buf();
    // Check only the static boundary at call time; this does not claim protection against concurrent parent replacement afterward.
    for part in [".kcoder", "specs", "changes"] {
        path.push(part);
        check_change_directory(&path, &workspace)?;
    }
    Ok(path)
}

fn checked_change_dir(cwd: &Path, name: &str) -> Result<PathBuf> {
    // Validate names before canonicalize, metadata, or any other I/O.
    validate_change_name(name)?;
    let path = checked_changes_dir(cwd)?.join(name);
    let workspace = cwd
        .canonicalize()
        .context("failed to resolve spec workspace")?;
    check_change_directory(&path, &workspace)?;
    Ok(path)
}

/// Superpowers skills bundled into the binary and installed by `init`.
pub const SUPERPOWER_SKILLS: &[(&str, &str)] = &[
    (
        "using-superpowers",
        include_str!("skills/using-superpowers/SKILL.md"),
    ),
    (
        "brainstorming",
        include_str!("skills/brainstorming/SKILL.md"),
    ),
    (
        "writing-plans",
        include_str!("skills/writing-plans/SKILL.md"),
    ),
    (
        "executing-plans",
        include_str!("skills/executing-plans/SKILL.md"),
    ),
    (
        "test-driven-development",
        include_str!("skills/test-driven-development/SKILL.md"),
    ),
    (
        "verification-before-completion",
        include_str!("skills/verification-before-completion/SKILL.md"),
    ),
    (
        "using-git-worktrees",
        include_str!("skills/using-git-worktrees/SKILL.md"),
    ),
    (
        "systematic-debugging",
        include_str!("skills/systematic-debugging/SKILL.md"),
    ),
    (
        "subagent-driven-development",
        include_str!("skills/subagent-driven-development/SKILL.md"),
    ),
    (
        "dispatching-parallel-agents",
        include_str!("skills/dispatching-parallel-agents/SKILL.md"),
    ),
    (
        "requesting-code-review",
        include_str!("skills/requesting-code-review/SKILL.md"),
    ),
    (
        "receiving-code-review",
        include_str!("skills/receiving-code-review/SKILL.md"),
    ),
    (
        "finishing-a-development-branch",
        include_str!("skills/finishing-a-development-branch/SKILL.md"),
    ),
    (
        "writing-skills",
        include_str!("skills/writing-skills/SKILL.md"),
    ),
];

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

pub const SUPERPOWER_SKILL_ASSETS: &[BundledSkillAsset] = &[
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/frame-template.html",
        content: include_str!("skills/brainstorming/scripts/frame-template.html"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/helper.js",
        content: include_str!("skills/brainstorming/scripts/helper.js"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/server.cjs",
        content: include_str!("skills/brainstorming/scripts/server.cjs"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/start-server.sh",
        content: include_str!("skills/brainstorming/scripts/start-server.sh"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/stop-server.sh",
        content: include_str!("skills/brainstorming/scripts/stop-server.sh"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "spec-document-reviewer-prompt.md",
        content: include_str!("skills/brainstorming/spec-document-reviewer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "visual-companion.md",
        content: include_str!("skills/brainstorming/visual-companion.md"),
    },
    BundledSkillAsset {
        skill: "requesting-code-review",
        relative_path: "code-reviewer.md",
        content: include_str!("skills/requesting-code-review/code-reviewer.md"),
    },
    BundledSkillAsset {
        skill: "subagent-driven-development",
        relative_path: "code-quality-reviewer-prompt.md",
        content: include_str!("skills/subagent-driven-development/code-quality-reviewer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "subagent-driven-development",
        relative_path: "implementer-prompt.md",
        content: include_str!("skills/subagent-driven-development/implementer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "subagent-driven-development",
        relative_path: "spec-reviewer-prompt.md",
        content: include_str!("skills/subagent-driven-development/spec-reviewer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "CREATION-LOG.md",
        content: include_str!("skills/systematic-debugging/CREATION-LOG.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "condition-based-waiting-example.ts",
        content: include_str!("skills/systematic-debugging/condition-based-waiting-example.ts"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "condition-based-waiting.md",
        content: include_str!("skills/systematic-debugging/condition-based-waiting.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "defense-in-depth.md",
        content: include_str!("skills/systematic-debugging/defense-in-depth.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "find-polluter.sh",
        content: include_str!("skills/systematic-debugging/find-polluter.sh"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "root-cause-tracing.md",
        content: include_str!("skills/systematic-debugging/root-cause-tracing.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "test-academic.md",
        content: include_str!("skills/systematic-debugging/test-academic.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "test-pressure-1.md",
        content: include_str!("skills/systematic-debugging/test-pressure-1.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "test-pressure-2.md",
        content: include_str!("skills/systematic-debugging/test-pressure-2.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "test-pressure-3.md",
        content: include_str!("skills/systematic-debugging/test-pressure-3.md"),
    },
    BundledSkillAsset {
        skill: "test-driven-development",
        relative_path: "testing-anti-patterns.md",
        content: include_str!("skills/test-driven-development/testing-anti-patterns.md"),
    },
    BundledSkillAsset {
        skill: "writing-plans",
        relative_path: "plan-document-reviewer-prompt.md",
        content: include_str!("skills/writing-plans/plan-document-reviewer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "agent-best-practices.md",
        content: include_str!("skills/writing-skills/agent-best-practices.md"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "examples/AGENTS_MD_TESTING.md",
        content: include_str!("skills/writing-skills/examples/AGENTS_MD_TESTING.md"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "graphviz-conventions.dot",
        content: include_str!("skills/writing-skills/graphviz-conventions.dot"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "persuasion-principles.md",
        content: include_str!("skills/writing-skills/persuasion-principles.md"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "render-graphs.js",
        content: include_str!("skills/writing-skills/render-graphs.js"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "testing-skills-with-subagents.md",
        content: include_str!("skills/writing-skills/testing-skills-with-subagents.md"),
    },
];

/// Companion scripts that must retain execute permissions on Unix.
pub const SUPERPOWER_EXECUTABLE_ASSETS: &[(&str, &str)] = &[
    ("brainstorming", "scripts/start-server.sh"),
    ("brainstorming", "scripts/stop-server.sh"),
    ("systematic-debugging", "find-polluter.sh"),
    ("writing-skills", "render-graphs.js"),
];

pub fn bundled_skill_asset_is_executable(skill: &str, relative_path: &str) -> bool {
    SUPERPOWER_EXECUTABLE_ASSETS
        .iter()
        .any(|(asset_skill, asset_path)| *asset_skill == skill && *asset_path == relative_path)
}

fn read_validated_project_config(specs_dir: &Path) -> Result<config::ProjectConfig> {
    let config = config::read_or_default(specs_dir)?;
    let errors = config::validate_schema(&config);
    if !errors.is_empty() {
        anyhow::bail!("invalid spec configuration: {}", errors.join("; "));
    }
    Ok(config)
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

impl ChangeMetadata {
    pub fn new(name: impl Into<String>, title: Option<String>) -> Self {
        Self {
            name: name.into(),
            title,
            schema: None,
            created_at: chrono::Local::now().to_rfc3339(),
            status: ChangeStatus::Draft,
        }
    }
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

/// Initialize the spec subsystem for a project.
///
/// Creates the default directory layout, a starter spec, and the auto-triggered
/// `using-specs` skill. Existing skill files are left untouched.
pub fn init(cwd: &Path) -> Result<PathBuf> {
    init_with_force(cwd, false)
}

/// Initialize the spec subsystem, optionally overwriting existing skill files.
///
/// When `force_update` is true, bundled Superpowers skills are reinstalled even
/// if they already exist on disk. Project-owned configuration and authoritative
/// specs are always preserved. This is useful after upgrading KCoder.
pub fn init_with_force(cwd: &Path, force_update: bool) -> Result<PathBuf> {
    init_with_force_report(cwd, force_update).map(|(path, _)| path)
}

/// Same as init_with_force, while also returning the skill transaction receipt produced by this run.
pub fn init_with_force_report(
    cwd: &Path,
    force_update: bool,
) -> Result<(PathBuf, Vec<kcoder_skills::SkillCommitReceipt>)> {
    let specs_dir = specs_dir_for(cwd);
    let domain_dir = specs_dir.join("specs").join("core");
    let changes_dir = specs_dir.join("changes");
    let archive_dir = changes_dir.join("archive");
    let skills_root = cwd.join(".kcoder").join("skills");

    fs::create_dir_all(&domain_dir)
        .with_context(|| format!("failed to create {:?}", domain_dir))?;
    fs::create_dir_all(&changes_dir)
        .with_context(|| format!("failed to create {:?}", changes_dir))?;
    fs::create_dir_all(&archive_dir)
        .with_context(|| format!("failed to create {:?}", archive_dir))?;

    let spec_path = domain_dir.join("spec.md");
    if !spec_path.exists() {
        fs::write(&spec_path, DEFAULT_SPEC)
            .with_context(|| format!("failed to write {:?}", spec_path))?;
    }

    let config_path = specs_dir.join(config::CONFIG_FILE);
    if !config_path.exists() {
        fs::write(&config_path, config::DEFAULT_CONFIG)
            .with_context(|| format!("failed to write {:?}", config_path))?;
    }
    let config = read_validated_project_config(&specs_dir)?;

    let store = SkillStore::open(&skills_root).context("failed to open spec skill store")?;
    let mut mutations = Vec::new();
    let mut metadata = SkillMetadataDelta::default();

    let using_specs = SkillPackage {
        name: "using-specs".to_string(),
        files: vec![SkillPackageFile {
            relative_path: PathBuf::from("SKILL.md"),
            content: render_using_specs_skill(Some(&config)).into_bytes(),
            executable: false,
        }],
    };
    plan_spec_package(
        &store,
        using_specs,
        force_update,
        false,
        &mut mutations,
        &mut metadata,
    )?;

    // Stage and publish each built-in skill body and all companion files as one complete package.
    for (name, content) in SUPERPOWER_SKILLS {
        let mut files = vec![SkillPackageFile {
            relative_path: PathBuf::from("SKILL.md"),
            content: content.as_bytes().to_vec(),
            executable: false,
        }];
        for asset in SUPERPOWER_SKILL_ASSETS
            .iter()
            .filter(|asset| asset.skill == *name)
        {
            files.push(SkillPackageFile {
                relative_path: PathBuf::from(asset.relative_path),
                content: asset.content.as_bytes().to_vec(),
                executable: bundled_skill_asset_is_executable(name, asset.relative_path),
            });
        }
        plan_spec_package(
            &store,
            SkillPackage {
                name: (*name).to_string(),
                files,
            },
            force_update,
            true,
            &mut mutations,
            &mut metadata,
        )?;
    }

    let mut receipts = Vec::new();
    if !mutations.is_empty() || metadata != SkillMetadataDelta::default() {
        let operation_id = spec_operation_id("init", force_update, &store, &mutations)?;
        let receipt = store
            .commit(SkillCommitRequest {
                operation_id,
                actor: SkillMutationActor::SpecInit {
                    session_id: None,
                    force_update,
                },
                operation: SkillOperationKind::SpecSync,
                preconditions: Vec::new(),
                mutations,
                metadata,
            })
            .context("failed to publish spec skills")?;
        receipts.push(receipt);
    }

    debug!("initialized spec subsystem at {:?}", specs_dir);
    Ok((specs_dir, receipts))
}

/// Regenerate the auto-triggered `using-specs` skill from config.yaml.
pub fn sync_using_specs_skill(cwd: &Path) -> Result<PathBuf> {
    sync_using_specs_skill_report(cwd).map(|(path, _)| path)
}

/// Same as sync_using_specs_skill, while also returning the on-disk commit receipt.
pub fn sync_using_specs_skill_report(
    cwd: &Path,
) -> Result<(PathBuf, kcoder_skills::SkillCommitReceipt)> {
    let specs_dir = specs_dir_for(cwd);
    let skills_root = cwd.join(".kcoder").join("skills");
    let skill_dir = skills_root.join("using-specs");
    let config = read_validated_project_config(&specs_dir)?;
    let skill_path = skill_dir.join("SKILL.md");
    let store = SkillStore::open(&skills_root).context("failed to open spec skill store")?;
    let desired = SkillPackage {
        name: "using-specs".to_string(),
        files: vec![SkillPackageFile {
            relative_path: PathBuf::from("SKILL.md"),
            content: render_using_specs_skill(Some(&config)).into_bytes(),
            executable: false,
        }],
    };
    let expected = store
        .current_revision("using-specs")
        .context("failed to read using-specs revision")?
        .map(ExpectedSkillRevision::Exact)
        .unwrap_or(ExpectedSkillRevision::Absent);
    let mut metadata = SkillMetadataDelta::default();
    record_spec_metadata(&mut metadata, &desired, false)?;
    let mutations = vec![SkillMutation::PutPackage {
        package: desired,
        expected,
    }];
    let receipt = store
        .commit(SkillCommitRequest {
            operation_id: spec_operation_id("sync", false, &store, &mutations)?,
            actor: SkillMutationActor::SpecInit {
                session_id: None,
                force_update: false,
            },
            operation: SkillOperationKind::SpecSync,
            preconditions: Vec::new(),
            mutations,
            metadata,
        })
        .context("failed to publish using-specs skill")?;
    Ok((skill_path, receipt))
}

fn plan_spec_package(
    store: &SkillStore,
    desired: SkillPackage,
    force_update: bool,
    manage_bundled_assets: bool,
    mutations: &mut Vec<SkillMutation>,
    metadata: &mut SkillMetadataDelta,
) -> Result<()> {
    let live = store.root().join(&desired.name);
    if force_update {
        record_spec_metadata(metadata, &desired, true)?;
        mutations.push(SkillMutation::PutPackage {
            package: desired,
            expected: ExpectedSkillRevision::Unconditional,
        });
        return Ok(());
    }

    if !live.join("SKILL.md").is_file() {
        record_spec_metadata(metadata, &desired, false)?;
        mutations.push(SkillMutation::PutPackage {
            package: desired,
            expected: ExpectedSkillRevision::Absent,
        });
        return Ok(());
    }
    if !manage_bundled_assets {
        return Ok(());
    }

    // Fill in missing assets only when the body still exactly matches the embedded version; do not inject files into user-modified skills.
    let desired_main = desired
        .files
        .iter()
        .find(|file| file.relative_path == Path::new("SKILL.md"))
        .expect("spec package always has SKILL.md");
    let current_main = fs::read(live.join("SKILL.md"))
        .with_context(|| format!("failed to read bundled skill '{}'", desired.name))?;
    if current_main != desired_main.content {
        return Ok(());
    }
    let mut current = store
        .read_package(&desired.name)
        .with_context(|| format!("failed to read bundled skill '{}'", desired.name))?
        .context("bundled skill disappeared while planning")?;
    let current_revision = canonical_package_revision(&current)?;
    let missing = desired
        .files
        .iter()
        .filter(|file| {
            file.relative_path != Path::new("SKILL.md")
                && !current
                    .files
                    .iter()
                    .any(|current_file| current_file.relative_path == file.relative_path)
        })
        .cloned()
        .collect::<Vec<_>>();
    let changed = !missing.is_empty();
    current.files.extend(missing);
    if changed {
        record_spec_metadata(metadata, &current, false)?;
        mutations.push(SkillMutation::PutPackage {
            package: current,
            expected: ExpectedSkillRevision::Exact(current_revision),
        });
    }
    Ok(())
}

fn record_spec_metadata(
    metadata: &mut SkillMetadataDelta,
    package: &SkillPackage,
    force_update: bool,
) -> Result<()> {
    let revision = canonical_package_revision(package)?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut provenance = SkillMetadataPatch::default();
    provenance
        .create
        .insert("created_at".to_string(), Value::String(now.clone()));
    provenance.create.insert(
        "created_by".to_string(),
        Value::String("kcoder".to_string()),
    );
    provenance
        .update
        .insert("origin".to_string(), Value::String("bundled".to_string()));
    provenance.update.insert(
        "write_origin".to_string(),
        Value::String(if force_update {
            "spec_init_force".to_string()
        } else {
            "spec_init".to_string()
        }),
    );
    provenance
        .update
        .insert("bundled_hash".to_string(), Value::String(revision.0));
    metadata.provenance.insert(package.name.clone(), provenance);

    let mut usage = SkillMetadataPatch::default();
    usage
        .create
        .insert("created_at".to_string(), Value::String(now));
    usage
        .create
        .insert("state".to_string(), Value::String("active".to_string()));
    usage
        .create
        .insert("pinned".to_string(), Value::Bool(false));
    metadata.usage.insert(package.name.clone(), usage);
    Ok(())
}

fn spec_operation_id(
    kind: &str,
    force_update: bool,
    store: &SkillStore,
    mutations: &[SkillMutation],
) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([u8::from(force_update)]);
    hasher.update(serde_json::to_vec(mutations).context("failed to hash spec mutation plan")?);
    for name in mutation_skill_names(mutations) {
        hasher.update(name.as_bytes());
        match store.current_revision(&name) {
            Ok(Some(revision)) => hasher.update(revision.0.as_bytes()),
            Ok(None) => hasher.update(b"absent"),
            Err(_) => hasher.update(b"invalid"),
        }
    }
    Ok(format!("spec-{kind}-{:x}", hasher.finalize()))
}

fn mutation_skill_names(mutations: &[SkillMutation]) -> Vec<String> {
    let mut names = mutations
        .iter()
        .flat_map(|mutation| match mutation {
            SkillMutation::PutPackage { package, .. } => vec![package.name.clone()],
            SkillMutation::PatchFile { name, .. }
            | SkillMutation::PatchText { name, .. }
            | SkillMutation::RemoveFile { name, .. }
            | SkillMutation::Archive { name, .. }
            | SkillMutation::Restore { name, .. } => vec![name.clone()],
            SkillMutation::Consolidate {
                sources,
                destination,
                ..
            } => sources
                .iter()
                .map(|(name, _)| name.clone())
                .chain(std::iter::once(destination.name.clone()))
                .collect(),
        })
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

/// Render the `using-specs` skill, including project-specific config guidance
/// when `.kcoder/specs/config.yaml` is available.
pub fn render_using_specs_skill(config: Option<&config::ProjectConfig>) -> String {
    let mut text = USING_SPECS_SKILL.trim_end().to_string();
    text.push_str(
        "\n\n## Tool Preference\n\n\
Use `SpecStatus` to check artifact/task/drift state before archiving or reporting progress. \
Use `SpecStatus` with `change` to inspect a change's proposal, tasks, design, and delta specs before editing. \
Use `SpecCheck` with `action=preflight` before implementing `spec-driven-superpowers` changes. \
Use `SpecRecordVerification` to write retained evidence into `verification.md`. \
Prefer structured spec tools over guessing paths under `.kcoder/specs/changes/`.\n",
    );
    if let Some(config) = config {
        text.push_str("\n## Project Spec Configuration\n\n");
        let schema = if config.schema.trim().is_empty() {
            "spec-driven"
        } else {
            config.schema.as_str()
        };
        text.push_str(&format!("- Schema: `{schema}`\n"));
        if config::is_superpowers_schema(schema) {
            text.push_str(
                "- `review.md` is the readiness gate; do not implement while it is `blocked`.\n\
- `plan.md` is the execution driver; keep `tasks.md` as the coarse-grained source of truth.\n\
- Map high-priority `Validation Focus` items into `plan.md` execution or verification steps.\n",
            );
        }
        if let Some(precheck) = config
            .precheck
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            text.push_str(&format!("- Precheck: `{precheck}`\n"));
        }
        if let Some(context) = config
            .context
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            text.push_str("\nProject context:\n\n");
            text.push_str(context.trim());
            text.push('\n');
        }
        if let Some(rules) = &config.rules
            && !rules.is_empty()
        {
            text.push_str("\nArtifact rules:\n");
            for (artifact, artifact_rules) in rules {
                text.push_str(&format!("- `{artifact}`:\n"));
                for rule in artifact_rules {
                    text.push_str(&format!("  - {rule}\n"));
                }
            }
        }
    }
    text
}

fn project_schema(specs_dir: &Path) -> Result<String> {
    let config = read_validated_project_config(specs_dir)?;
    Ok(normalize_schema_name(&config.schema))
}

fn metadata_schema_or_default(meta: &ChangeMetadata) -> String {
    if let Some(schema) = meta
        .schema
        .as_deref()
        .filter(|schema| !schema.trim().is_empty())
    {
        normalize_schema_name(schema)
    } else {
        "spec-driven".to_string()
    }
}

fn normalize_schema_name(schema: &str) -> String {
    let trimmed = schema.trim();
    if trimmed.is_empty() {
        "spec-driven".to_string()
    } else {
        trimmed.to_string()
    }
}

fn required_artifacts_for_schema(schema: &str) -> &'static [&'static str] {
    if config::is_superpowers_schema(schema) {
        &[
            "proposal.md",
            "specs",
            "design.md",
            "review.md",
            "tasks.md",
            "plan.md",
        ]
    } else {
        &["proposal.md", "specs", "design.md", "tasks.md"]
    }
}

fn template_artifacts_for_schema(schema: &str) -> Vec<(&'static str, &'static str)> {
    let mut artifacts = vec![
        ("proposal.md", PROPOSAL_TEMPLATE),
        ("design.md", DESIGN_TEMPLATE),
    ];
    if config::is_superpowers_schema(schema) {
        artifacts.push(("review.md", REVIEW_TEMPLATE));
    }
    artifacts.push(("tasks.md", TASKS_TEMPLATE));
    if config::is_superpowers_schema(schema) {
        artifacts.push(("plan.md", PLAN_TEMPLATE));
    }
    artifacts
}

/// Create a new change scaffold.
pub fn new_change(cwd: &Path, name: &str, title: Option<String>) -> Result<PathBuf> {
    let change_dir = checked_change_dir(cwd, name)?;
    if change_dir.exists() {
        anyhow::bail!("change '{}' already exists", name);
    }

    fs::create_dir_all(change_dir.join("specs"))
        .with_context(|| format!("failed to create change directory {:?}", change_dir))?;

    let specs_dir = specs_dir_for(cwd);
    let schema = project_schema(&specs_dir)?;
    let mut metadata = ChangeMetadata::new(name, title);
    metadata.schema = Some(schema.clone());
    let meta_path = change_dir.join(".spec.yaml");
    fs::write(&meta_path, serde_yaml::to_string(&metadata)?)
        .with_context(|| format!("failed to write {:?}", meta_path))?;

    for (file_name, content) in template_artifacts_for_schema(&schema) {
        let path = change_dir.join(file_name);
        fs::write(&path, content).with_context(|| format!("failed to write {:?}", path))?;
    }

    // Create a starter delta spec so the change has a concrete place to write
    // ADDED/MODIFIED/REMOVED/RENAMED requirements. Default to the first existing
    // authoritative domain (usually "core" after init).
    let default_domain =
        first_authoritative_domain(&specs_dir).unwrap_or_else(|| "core".to_string());
    let delta_dir = change_dir.join("specs").join(&default_domain);
    fs::create_dir_all(&delta_dir)
        .with_context(|| format!("failed to create delta directory {:?}", delta_dir))?;
    let delta_path = delta_dir.join("spec.md");
    if !delta_path.exists() {
        fs::write(&delta_path, DEFAULT_DELTA_TEMPLATE)
            .with_context(|| format!("failed to write {:?}", delta_path))?;
    }

    // Snapshot the current authoritative specs so we can detect drift before
    // archiving this change.
    fingerprint::capture_base_snapshot(&specs_dir, &change_dir)
        .with_context(|| "failed to capture base spec snapshot")?;

    debug!("created change {:?}", change_dir);
    Ok(change_dir)
}

/// Archive a completed change.
///
/// First merges the change's delta specs into the authoritative specs under
/// `.kcoder/specs/specs/`, then moves the change directory into
/// `.kcoder/specs/changes/archive/` and marks it as archived.
pub fn archive(cwd: &Path, name: &str) -> Result<PathBuf> {
    let change_dir = checked_change_dir(cwd, name)?;
    let archive_root = checked_change_dir(cwd, "archive")?;
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let summary = status(cwd, name)?;
    let mut readiness_blockers = Vec::new();
    if !summary.tasks_complete {
        readiness_blockers.push("tasks.md contains incomplete tasks".to_string());
    }
    readiness_blockers.extend(summary.apply_blockers);
    readiness_blockers.extend(summary.completion_blockers);
    if !readiness_blockers.is_empty() {
        let mut message = format!(
            "cannot archive change '{}'; readiness blockers must be resolved:",
            name
        );
        for blocker in readiness_blockers {
            message.push_str(&format!("\n- {blocker}"));
        }
        anyhow::bail!(message);
    }

    let specs_dir = specs_dir_for(cwd);

    // Automatically fast-forward any unchanged deltas before checking drift.
    // If there are real conflicts, surface them now so the user can resolve.
    let sync_report = sync::sync(cwd, name)
        .with_context(|| format!("failed to sync change '{}' before archiving", name))?;
    if !sync_report.conflicts.is_empty() {
        let mut msg = format!(
            "cannot archive change '{}'; unresolved spec conflicts detected. Run SpecSync to resolve them:",
            name
        );
        for r in &sync_report.conflicts {
            msg.push_str(&format!("\n- specs/{}: {}", r.domain, r.name));
        }
        anyhow::bail!(msg);
    }

    run_precheck(cwd, &specs_dir)
        .with_context(|| format!("verification failed for change '{}'", name))?;

    let drift_errors = fingerprint::check_change(&specs_dir, &change_dir)?;
    if !drift_errors.is_empty() {
        let mut msg = format!(
            "cannot archive change '{}'; the live spec has drifted from the change base:",
            name
        );
        for err in drift_errors {
            msg.push_str("\n- ");
            msg.push_str(&err);
        }
        msg.push_str("\nRebase the change against the current specs before archiving (SpecSync).");
        anyhow::bail!(msg);
    }

    let merged = merge::merge_change(&specs_dir, &change_dir)
        .with_context(|| format!("failed to merge change '{}' into authoritative specs", name))?;
    debug!("merged change {} into {:?}", name, merged);

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let archive_name = format!("{}-{}", date, name);
    let archive_dir = archive_root.join(&archive_name);
    if archive_dir.exists() {
        anyhow::bail!("archive target {:?} already exists", archive_dir);
    }

    fs::rename(&change_dir, &archive_dir)
        .with_context(|| format!("failed to archive {:?} to {:?}", change_dir, archive_dir))?;

    let meta_path = archive_dir.join(".spec.yaml");
    if let Ok(mut meta) = read_metadata(&meta_path) {
        meta.status = ChangeStatus::Archived;
        if let Err(e) = fs::write(&meta_path, serde_yaml::to_string(&meta)?) {
            warn!("failed to update archived metadata: {}", e);
        }
    }

    debug!("archived change {} to {:?}", name, archive_dir);
    Ok(archive_dir)
}

/// Run the project's verification suite before archiving.
///
/// Uses the `precheck` command from `.kcoder/specs/config.yaml` if present.
/// If omitted, it falls back to `cargo test` when a `Cargo.toml` exists.
/// `KCODER_SPEC_SKIP_TESTS` skips the fallback but not an explicit precheck.
fn run_precheck(cwd: &Path, specs_dir: &Path) -> Result<()> {
    if let Some(config) = config::read_project_config(specs_dir)?
        && let Some(cmd) = &config.precheck
    {
        // Keep the old fallback behavior for the default `cargo test` command
        // when the project is not a Rust workspace.
        if cmd.trim() == "cargo test" && !cwd.join("Cargo.toml").exists() {
            return Ok(());
        }
        let shell_path = resolve_shell_program()?;
        let output = run_project_precheck(cwd, &shell_path, cmd)
            .with_context(|| format!("failed to spawn precheck command: {}", cmd))?;
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!(
                "precheck command failed; archive blocked.\ncommand: {}\nstdout:\n{}\nstderr:\n{}",
                cmd,
                stdout,
                stderr
            );
        }
        return Ok(());
    }

    run_verification_tests(cwd)
}

fn run_verification_tests(cwd: &Path) -> Result<()> {
    if std::env::var("KCODER_SPEC_SKIP_TESTS").is_ok() {
        return Ok(());
    }
    if !cwd.join("Cargo.toml").exists() {
        return Ok(());
    }

    let cargo_path = resolve_program("cargo")?;
    let output =
        run_cargo_precheck(cwd, &cargo_path).with_context(|| "failed to spawn cargo test")?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "cargo test failed; archive blocked.\nstdout:\n{}\nstderr:\n{}",
            stdout,
            stderr
        );
    }
    Ok(())
}

/// Validate a change or the entire spec subsystem.
pub fn validate(cwd: &Path, change_name: Option<&str>) -> Result<Vec<String>> {
    let checked_change = change_name
        .map(|name| checked_change_dir(cwd, name))
        .transpose()?;
    let mut errors = Vec::new();

    let specs_dir = specs_dir_for(cwd);
    if !specs_dir.exists() {
        errors.push("spec subsystem has not been initialized".to_string());
        return Ok(errors);
    }

    if let Some(name) = change_name {
        let change_dir = checked_change.as_ref().expect("已校验指定的 change");
        if !change_dir.exists() {
            errors.push(format!("change '{}' does not exist", name));
            return Ok(errors);
        }
        validate_change(change_dir, &mut errors)?;
    } else {
        let changes_dir = checked_changes_dir(cwd)?;
        for entry in fs::read_dir(&changes_dir)
            .with_context(|| format!("failed to read {:?}", changes_dir))?
        {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() || path.file_name() == Some(std::ffi::OsStr::new("archive")) {
                continue;
            }
            let name = entry.file_name();
            let checked =
                checked_change_dir(cwd, name.to_str().context("change name is not UTF-8")?)?;
            if let Err(e) = validate_change(&checked, &mut errors) {
                errors.push(format!("{}: {}", path.display(), e));
            }
        }
    }

    // Structural validation of authoritative specs and deltas.
    validate_authoritative_specs(&specs_dir, &mut errors)?;
    if let Some(change_dir) = checked_change {
        validate_change_deltas(&specs_dir, &change_dir, &mut errors)?;
        validate_config_rules(&specs_dir, &change_dir, &mut errors)?;
    } else {
        let changes_dir = checked_changes_dir(cwd)?;
        for entry in fs::read_dir(&changes_dir)
            .with_context(|| format!("failed to read {:?}", changes_dir))?
        {
            let path = entry?.path();
            if !path.is_dir() || path.file_name() == Some(std::ffi::OsStr::new("archive")) {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .context("change name is not UTF-8")?;
            let path = checked_change_dir(cwd, name)?;
            validate_change_deltas(&specs_dir, &path, &mut errors)?;
            validate_config_rules(&specs_dir, &path, &mut errors)?;
        }
    }

    if let Some(config) = config::read_project_config(&specs_dir)? {
        errors.extend(config::validate_schema(&config));
    }

    Ok(errors)
}

fn validate_authoritative_specs(specs_dir: &Path, errors: &mut Vec<String>) -> Result<()> {
    match parse::load_authoritative_specs(specs_dir) {
        Ok(specs) => {
            for spec in specs {
                if spec.domain.trim().is_empty() {
                    errors.push("spec: missing domain".to_string());
                }
                if spec.purpose.trim().is_empty() {
                    errors.push(format!("specs/{}: missing purpose", spec.domain));
                }
                for req in &spec.requirements {
                    validate_requirement_structure(&spec.domain, req, errors);
                }
            }
        }
        Err(e) => errors.push(format!("failed to parse authoritative specs: {}", e)),
    }
    Ok(())
}

fn validate_change_deltas(
    specs_dir: &Path,
    change_dir: &Path,
    errors: &mut Vec<String>,
) -> Result<()> {
    let change_name = change_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("?");
    scan_unresolved_conflict_markers(change_dir, change_name, errors)?;
    match parse::load_change_deltas(change_dir) {
        Ok(deltas) => {
            for (domain, delta) in deltas {
                for req in &delta.added {
                    validate_requirement_structure(&domain, req, errors);
                }
                for req in &delta.modified {
                    validate_requirement_structure(&domain, req, errors);
                }
                for name in &delta.removed {
                    if name.trim().is_empty() {
                        errors.push(format!(
                            "change {} specs/{}: empty removed requirement name",
                            change_name, domain
                        ));
                    }
                }
                for rename in &delta.renamed {
                    if rename.from.trim().is_empty() || rename.to.trim().is_empty() {
                        errors.push(format!(
                            "change {} specs/{}: empty rename pair",
                            change_name, domain
                        ));
                    }
                }
            }
        }
        Err(e) => errors.push(format!(
            "change {}: failed to parse delta specs: {}",
            change_name, e
        )),
    }

    // Cross-check: modified/removed/renamed.from requirements must exist.
    match fingerprint::check_change(specs_dir, change_dir) {
        Ok(drift_errors) => errors.extend(drift_errors),
        Err(e) => errors.push(format!(
            "change {}: failed to cross-check spec drift: {}",
            change_name, e
        )),
    }
    Ok(())
}

fn scan_unresolved_conflict_markers(
    change_dir: &Path,
    change_name: &str,
    errors: &mut Vec<String>,
) -> Result<()> {
    let specs_dir = change_dir.join("specs");
    if !specs_dir.exists() {
        return Ok(());
    }

    for path in collect_markdown_files(&specs_dir)? {
        let content =
            fs::read_to_string(&path).with_context(|| format!("failed to read {:?}", path))?;
        if content.contains("<<<<<<<")
            || content.contains("=======")
            || content.contains(">>>>>>>")
            || content.contains("|||||||")
        {
            let rel = path.strip_prefix(change_dir).unwrap_or(path.as_path());
            errors.push(format!(
                "change {} {}: unresolved conflict marker",
                change_name,
                rel.display()
            ));
        }
    }

    Ok(())
}

fn collect_markdown_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_markdown_files_inner(root, &mut files)?;
    Ok(files)
}

fn collect_markdown_files_inner(root: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(root).with_context(|| format!("failed to read {:?}", root))? {
        let path = entry?.path();
        if path.is_dir() {
            collect_markdown_files_inner(&path, files)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            files.push(path);
        }
    }
    Ok(())
}

fn validate_requirement_structure(
    domain: &str,
    req: &parse::Requirement,
    errors: &mut Vec<String>,
) {
    if req.name.trim().is_empty() {
        errors.push(format!("specs/{}: requirement name is empty", domain));
        return;
    }
    let desc = req.description.trim();
    if desc.is_empty() {
        errors.push(format!(
            "specs/{}: requirement '{}' has no description",
            domain, req.name
        ));
    } else if !desc.to_ascii_lowercase().contains("shall")
        && !desc.to_ascii_lowercase().contains("must")
        && !desc.to_ascii_lowercase().contains("should")
        && !desc.to_ascii_lowercase().contains("may")
    {
        errors.push(format!(
            "specs/{}: requirement '{}' description lacks SHALL/MUST/SHOULD/MAY",
            domain, req.name
        ));
    }

    for scenario in &req.scenarios {
        if scenario.title.trim().is_empty() {
            errors.push(format!(
                "specs/{}: requirement '{}' has scenario without title",
                domain, req.name
            ));
        }
        let body = scenario.body.to_ascii_lowercase();
        if !body.contains("when") || !body.contains("then") {
            errors.push(format!(
                "specs/{}: requirement '{}' scenario '{}' missing WHEN/THEN",
                domain, req.name, scenario.title
            ));
        }
    }
}

fn validate_config_rules(
    specs_dir: &Path,
    change_dir: &Path,
    errors: &mut Vec<String>,
) -> Result<()> {
    let config = match config::read_project_config(specs_dir)? {
        Some(c) => c,
        None => return Ok(()),
    };

    let specs = match parse::load_authoritative_specs(specs_dir) {
        Ok(s) => s,
        Err(e) => {
            errors.push(format!("failed to parse authoritative specs: {}", e));
            return Ok(());
        }
    };
    let deltas = match parse::load_change_deltas(change_dir) {
        Ok(d) => d,
        Err(e) => {
            errors.push(format!("failed to parse delta specs: {}", e));
            return Ok(());
        }
    };
    let mut merged = specs.clone();
    for (domain, delta) in deltas {
        let mut reqs = delta.added;
        reqs.extend(delta.modified);
        if !reqs.is_empty() {
            merged.push(Spec {
                domain,
                purpose: String::new(),
                requirements: reqs,
                sections: Vec::new(),
            });
        }
    }

    config::apply_rules(&config, &merged, change_dir, errors)?;
    Ok(())
}

fn validate_change(change_dir: &Path, errors: &mut Vec<String>) -> Result<()> {
    let meta_path = change_dir.join(".spec.yaml");
    if !meta_path.exists() {
        errors.push(format!("{}: missing .spec.yaml", change_dir.display()));
        return Ok(());
    }
    let meta =
        read_metadata(&meta_path).with_context(|| format!("failed to read {:?}", meta_path))?;

    let schema = metadata_schema_or_default(&meta);
    for &artifact in required_artifacts_for_schema(&schema) {
        let path = change_dir.join(artifact);
        if !path.exists() {
            errors.push(format!(
                "{}: missing artifact {}",
                change_dir.display(),
                artifact
            ));
        }
    }

    if meta.status == ChangeStatus::ReadyForArchive || meta.status == ChangeStatus::Archived {
        let tasks_path = change_dir.join("tasks.md");
        if tasks_path.exists() {
            let tasks = fs::read_to_string(&tasks_path)?;
            if tasks.contains("[ ]") {
                errors.push(format!(
                    "{}: incomplete tasks cannot be archived",
                    change_dir.display()
                ));
            }
        }
    }

    Ok(())
}

/// Return the status summary for a single change.
pub fn status(cwd: &Path, name: &str) -> Result<ChangeStatusSummary> {
    let change_dir = checked_change_dir(cwd, name)?;
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let meta = read_metadata(&change_dir.join(".spec.yaml"))
        .with_context(|| format!("failed to read metadata for change '{}'", name))?;
    let specs_dir = specs_dir_for(cwd);
    let schema = metadata_schema_or_default(&meta);

    let artifacts = required_artifacts_for_schema(&schema)
        .iter()
        .map(|artifact| {
            let path = change_dir.join(*artifact);
            let present = path.exists();
            let non_empty = present
                && if path.is_dir() {
                    fs::read_dir(&path)
                        .ok()
                        .map(|mut d| d.next().is_some())
                        .unwrap_or(false)
                } else {
                    fs::metadata(&path)
                        .ok()
                        .map(|m| m.len() > 0)
                        .unwrap_or(false)
                };
            ArtifactStatus {
                name: (*artifact).to_string(),
                present,
                non_empty,
            }
        })
        .collect();

    let tasks_path = change_dir.join("tasks.md");
    let tasks_complete = if tasks_path.exists() {
        match fs::read_to_string(&tasks_path) {
            Ok(text) => !text.contains("[ ]") && text.contains("[x]"),
            Err(_) => false,
        }
    } else {
        false
    };

    let drift_errors = fingerprint::check_change(&specs_dir, &change_dir).unwrap_or_default();
    let apply_blockers = apply_blockers_for_schema(&schema, &change_dir);
    let verification = verification_status(&change_dir);
    let completion_blockers = completion_blockers_for_schema(&schema, &change_dir, &verification);

    Ok(ChangeStatusSummary {
        name: meta.name,
        title: meta.title,
        schema,
        status: meta.status,
        artifacts,
        tasks_complete,
        drift_errors,
        apply_blockers,
        completion_blockers,
        verification,
    })
}

fn apply_blockers_for_schema(schema: &str, change_dir: &Path) -> Vec<String> {
    if !config::is_superpowers_schema(schema) {
        return Vec::new();
    }

    let mut blockers = Vec::new();
    let review_path = change_dir.join("review.md");
    let Ok(review) = fs::read_to_string(&review_path) else {
        blockers.push("review.md is missing or unreadable".to_string());
        return blockers;
    };

    if markdown_section(&review, "Readiness Decision")
        .map(first_meaningful_line)
        .is_some_and(|line| line.eq_ignore_ascii_case("blocked"))
    {
        blockers.push("review.md Readiness Decision is blocked".to_string());
    }

    if markdown_section(&review, "Blocked By")
        .map(first_meaningful_line)
        .is_some_and(|line| !line.is_empty() && !line.eq_ignore_ascii_case("none"))
    {
        blockers.push("review.md Blocked By is not none".to_string());
    }

    let plan_path = change_dir.join("plan.md");
    let Ok(plan) = fs::read_to_string(&plan_path) else {
        blockers.push("plan.md is missing or unreadable".to_string());
        return blockers;
    };
    if markdown_section(&plan, "Covers")
        .map(first_meaningful_line)
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push("plan.md Covers has no task mapping".to_string());
    }

    blockers
}

fn markdown_section(content: &str, title: &str) -> Option<String> {
    let wanted = format!("## {}", title);
    let mut collecting = false;
    let mut lines = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case(&wanted) {
            collecting = true;
            continue;
        }
        if collecting && trimmed.starts_with("## ") {
            break;
        }
        if collecting {
            lines.push(line);
        }
    }
    collecting.then(|| lines.join("\n").trim().to_string())
}

fn first_meaningful_line(section: String) -> String {
    section
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("<!--") && !line.starts_with("-->"))
        .map(|line| {
            line.trim_start_matches("- ")
                .trim_start_matches("* ")
                .trim()
        })
        .unwrap_or("")
        .to_string()
}

/// Check whether an enhanced spec-driven change is ready for apply-time work.
pub fn apply_preflight(cwd: &Path, name: &str) -> Result<SpecApplyPreflightReport> {
    let change_dir = checked_change_dir(cwd, name)?;
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let meta = read_metadata(&change_dir.join(".spec.yaml"))
        .with_context(|| format!("failed to read metadata for change '{}'", name))?;
    let schema = metadata_schema_or_default(&meta);
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();

    if !config::is_superpowers_schema(&schema) {
        warnings.push(format!(
            "schema `{schema}` does not use the enhanced review/plan apply preflight"
        ));
        return Ok(SpecApplyPreflightReport {
            change_name: meta.name,
            schema,
            ok: true,
            blockers,
            warnings,
            modes: SpecApplyModes::default(),
            task_coverage: SpecTaskCoverage::default(),
            validation_focus: Vec::new(),
            unmapped_validation_focus: Vec::new(),
            verification: verification_status(&change_dir),
        });
    }

    for artifact in required_artifacts_for_schema(&schema) {
        let path = change_dir.join(artifact);
        if !path.exists() {
            blockers.push(format!("{artifact}: missing required apply artifact"));
        } else if artifact_has_no_content(&path) {
            blockers.push(format!("{artifact}: required apply artifact is empty"));
        }
    }

    let review = read_change_file_or_block(&change_dir, "review.md", &mut blockers);
    let plan = read_change_file_or_block(&change_dir, "plan.md", &mut blockers);
    let tasks = read_change_file_or_block(&change_dir, "tasks.md", &mut blockers);

    let modes = SpecApplyModes {
        readiness_decision: section_value(review.as_deref(), "Readiness Decision", ""),
        execution_mode: section_value(review.as_deref(), "Execution Mode", "standard"),
        verification_mode: section_value(review.as_deref(), "Verification Mode", "inline-only"),
        debug_mode: section_value(review.as_deref(), "Debug Mode", "standard"),
        review_status: section_value(review.as_deref(), "Review Status", "not-requested"),
        delegation_mode: section_value(review.as_deref(), "Delegation Mode", "single-agent"),
        parallelization_mode: section_value(
            review.as_deref(),
            "Parallelization Mode",
            "serial-only",
        ),
        worktree_mode: section_value(review.as_deref(), "Worktree Mode", "same-tree"),
        branch_finish_mode: section_value(review.as_deref(), "Branch Finish Mode", "standard"),
    };

    if modes.readiness_decision.is_empty() {
        blockers.push("review.md Readiness Decision is missing".to_string());
    } else if modes.readiness_decision.eq_ignore_ascii_case("blocked") {
        blockers.push("review.md Readiness Decision is blocked".to_string());
    } else if modes
        .readiness_decision
        .eq_ignore_ascii_case("ready with conditions")
    {
        warnings.push(
            "review.md is ready with conditions; conditions must be tracked in tasks.md or plan.md"
                .to_string(),
        );
    }

    let blocked_by = section_value(review.as_deref(), "Blocked By", "none");
    if !is_none_like(&blocked_by) {
        blockers.push("review.md Blocked By is not none".to_string());
    }

    let open_task_ids = tasks
        .as_deref()
        .map(open_task_ids_from_tasks)
        .unwrap_or_default();
    let covered_task_ids = plan
        .as_deref()
        .and_then(|text| markdown_section(text, "Covers"))
        .map(|section| numbered_ids(&section))
        .unwrap_or_default();
    let uncovered_task_ids = open_task_ids
        .iter()
        .filter(|id| !covered_task_ids.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    if !open_task_ids.is_empty() && covered_task_ids.is_empty() {
        blockers.push("plan.md Covers has no task mapping".to_string());
    } else if !uncovered_task_ids.is_empty() {
        blockers.push(format!(
            "plan.md Covers does not include open task ids: {}",
            uncovered_task_ids.join(", ")
        ));
    }

    let validation_focus = review
        .as_deref()
        .and_then(|text| markdown_section(text, "Validation Focus"))
        .map(section_items)
        .unwrap_or_default();
    if !validation_focus.is_empty()
        && plan
            .as_deref()
            .and_then(|text| markdown_section(text, "Validation Per Step"))
            .map(first_meaningful_line)
            .unwrap_or_default()
            .is_empty()
    {
        blockers.push("plan.md Validation Per Step does not map Validation Focus".to_string());
    }
    let verification_text = fs::read_to_string(change_dir.join("verification.md")).ok();
    let unmapped_validation_focus = unmapped_high_priority_validation_focus(
        &validation_focus,
        plan.as_deref(),
        verification_text.as_deref(),
    );
    if !unmapped_validation_focus.is_empty() {
        blockers.push(format!(
            "high-priority Validation Focus items are not mapped into plan.md or verification.md: {}",
            unmapped_validation_focus.join("; ")
        ));
    }

    check_mode_requirements(
        &modes,
        plan.as_deref(),
        review.as_deref(),
        &mut blockers,
        &mut warnings,
    );
    let verification = verification_status(&change_dir);
    if modes
        .review_status
        .eq_ignore_ascii_case("findings-received")
        && review
            .as_deref()
            .is_some_and(findings_summary_has_accepted_items)
        && !has_review_finding_writeback(plan.as_deref(), tasks.as_deref(), &change_dir)
    {
        blockers.push(
            "accepted review findings must be written back into tasks.md, plan.md, or verification.md"
                .to_string(),
        );
    }
    if modes
        .verification_mode
        .eq_ignore_ascii_case("retained-required")
        && !verification.present
    {
        warnings.push(
            "verification.md evidence is missing; completion will remain pending".to_string(),
        );
    }

    let task_coverage = SpecTaskCoverage {
        open_task_ids,
        covered_task_ids,
        uncovered_task_ids,
    };
    let ok = blockers.is_empty();

    Ok(SpecApplyPreflightReport {
        change_name: meta.name,
        schema,
        ok,
        blockers,
        warnings,
        modes,
        task_coverage,
        validation_focus,
        unmapped_validation_focus,
        verification,
    })
}

fn artifact_has_no_content(path: &Path) -> bool {
    if path.is_dir() {
        fs::read_dir(path)
            .ok()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    } else {
        fs::metadata(path).map(|m| m.len() == 0).unwrap_or(true)
    }
}

fn read_change_file_or_block(
    change_dir: &Path,
    file_name: &str,
    blockers: &mut Vec<String>,
) -> Option<String> {
    let path = change_dir.join(file_name);
    match fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) => {
            blockers.push(format!("{file_name}: failed to read apply artifact ({e})"));
            None
        }
    }
}

fn section_value(content: Option<&str>, title: &str, default: &str) -> String {
    content
        .and_then(|text| markdown_section(text, title))
        .map(first_meaningful_line)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn is_none_like(value: &str) -> bool {
    let value = value.trim();
    value.is_empty()
        || value.eq_ignore_ascii_case("none")
        || value.eq_ignore_ascii_case("not-needed")
        || value.eq_ignore_ascii_case("not-requested")
}

fn open_task_ids_from_tasks(tasks: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for line in tasks.lines().map(str::trim_start) {
        if !line.starts_with("- [ ]") {
            continue;
        }
        for id in numbered_ids(line) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

fn numbered_ids(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut current = String::new();
    for ch in text.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() || ch == '.' {
            current.push(ch);
        } else if !current.is_empty() {
            let candidate = current.trim_matches('.');
            if is_numbered_id(candidate) && !ids.iter().any(|id| id == candidate) {
                ids.push(candidate.to_string());
            }
            current.clear();
        }
    }
    ids
}

fn is_numbered_id(candidate: &str) -> bool {
    candidate.contains('.')
        && candidate
            .split('.')
            .all(|segment| !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_digit()))
}

fn section_items(section: String) -> Vec<String> {
    section
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("<!--") && !line.starts_with("-->"))
        .map(|line| {
            line.trim_start_matches("- ")
                .trim_start_matches("* ")
                .trim()
                .to_string()
        })
        .filter(|line| !is_none_like(line))
        .collect()
}

fn check_mode_requirements(
    modes: &SpecApplyModes,
    plan: Option<&str>,
    review: Option<&str>,
    blockers: &mut Vec<String>,
    warnings: &mut Vec<String>,
) {
    let ordered_steps = plan
        .and_then(|text| markdown_section(text, "Ordered Steps"))
        .unwrap_or_default();
    if modes.execution_mode.eq_ignore_ascii_case("tdd-required")
        && !contains_any(&ordered_steps, &["fail", "failing", "red", "test"])
    {
        blockers.push(
            "plan.md Ordered Steps must include a failing/test-first step for tdd-required"
                .to_string(),
        );
    } else if modes.execution_mode.eq_ignore_ascii_case("tdd-preferred")
        && !contains_any(&ordered_steps, &["fail", "failing", "red", "test"])
    {
        warnings.push(
            "plan.md Ordered Steps does not visibly encode a test-first step for tdd-preferred"
                .to_string(),
        );
    }

    if modes
        .verification_mode
        .eq_ignore_ascii_case("retained-required")
    {
        require_plan_section(plan, "Completion Verification", blockers);
        warnings.push(
            "Verification Mode is retained-required; verification.md evidence is required before full completion"
                .to_string(),
        );
    } else if modes
        .verification_mode
        .eq_ignore_ascii_case("retained-recommended")
    {
        require_plan_section(plan, "Completion Verification", blockers);
    }

    if modes
        .debug_mode
        .eq_ignore_ascii_case("systematic-debugging")
    {
        require_review_section(review, "Observed Failure", blockers);
        require_plan_section(plan, "Debugging Trail", blockers);
    }

    if modes
        .review_status
        .eq_ignore_ascii_case("findings-received")
    {
        require_review_section(review, "Findings Summary", blockers);
    }

    if !modes.delegation_mode.eq_ignore_ascii_case("single-agent") {
        require_plan_section(plan, "Delegation Units", blockers);
    }
    if !modes
        .parallelization_mode
        .eq_ignore_ascii_case("serial-only")
    {
        require_plan_section(plan, "Parallel Units", blockers);
        require_plan_section(plan, "Isolation Boundaries", blockers);
    }
    if !modes.worktree_mode.eq_ignore_ascii_case("same-tree") {
        require_plan_section(plan, "Worktree Units", blockers);
        require_plan_section(plan, "Isolation Reason", blockers);
        require_plan_section(plan, "Integration Owner", blockers);
    }
    if modes
        .branch_finish_mode
        .to_ascii_lowercase()
        .starts_with("finish-")
    {
        require_plan_section(plan, "Finish Checklist", blockers);
        require_plan_section(plan, "Delivery Handoff", blockers);
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    let lower = text.to_ascii_lowercase();
    needles.iter().any(|needle| lower.contains(needle))
}

fn findings_summary_has_accepted_items(review: &str) -> bool {
    let Some(summary) = markdown_section(review, "Findings Summary") else {
        return false;
    };
    let lower = summary.to_ascii_lowercase();
    lower.contains("accepted")
        && !lower.contains("no accepted")
        && !lower.contains("accepted: none")
        && !lower.contains("accepted findings: none")
}

fn has_review_finding_writeback(
    plan: Option<&str>,
    tasks: Option<&str>,
    change_dir: &Path,
) -> bool {
    let plan_has_followup = plan
        .and_then(|text| markdown_section(text, "Review Follow-Up"))
        .map(section_items)
        .is_some_and(|items| !items.is_empty());
    if plan_has_followup {
        return true;
    }

    let tasks_has_followup = tasks.map(tasks_have_review_followup_items).unwrap_or(false);
    if tasks_has_followup {
        return true;
    }

    fs::read_to_string(change_dir.join("verification.md"))
        .ok()
        .map(|text| {
            markdown_section(&text, "Residual Risks")
                .map(section_items)
                .is_some_and(|items| !items.is_empty())
                || markdown_section(&text, "Evidence")
                    .map(section_items)
                    .is_some_and(|items| !items.is_empty())
        })
        .unwrap_or(false)
}

fn tasks_have_review_followup_items(tasks: &str) -> bool {
    let mut in_review_followup = false;
    for line in tasks.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("## ") {
            in_review_followup = trimmed.to_ascii_lowercase().contains("review follow-up");
            continue;
        }
        if in_review_followup
            && (trimmed.starts_with("- [ ]") || trimmed.starts_with("- [x]"))
            && !numbered_ids(trimmed).is_empty()
        {
            return true;
        }
    }
    false
}

fn unmapped_high_priority_validation_focus(
    validation_focus: &[String],
    plan: Option<&str>,
    verification: Option<&str>,
) -> Vec<String> {
    let mapping_text = validation_mapping_text(plan, verification);
    validation_focus
        .iter()
        .filter(|item| is_high_priority_validation_focus(item))
        .filter(|item| !validation_focus_item_is_mapped(item, &mapping_text))
        .cloned()
        .collect()
}

fn validation_mapping_text(plan: Option<&str>, verification: Option<&str>) -> String {
    let mut text = String::new();
    if let Some(plan) = plan {
        for title in [
            "Ordered Steps",
            "Validation Per Step",
            "Completion Checkpoint",
            "Completion Verification",
        ] {
            if let Some(section) = markdown_section(plan, title) {
                text.push_str(&section);
                text.push('\n');
            }
        }
    }
    if let Some(verification) = verification {
        for title in [
            "Commands Run",
            "Manual Checks",
            "Evidence",
            "Residual Risks",
        ] {
            if let Some(section) = markdown_section(verification, title) {
                text.push_str(&section);
                text.push('\n');
            }
        }
    }
    text
}

fn is_high_priority_validation_focus(item: &str) -> bool {
    let lower = item.to_ascii_lowercase();
    ["required", "must", "critical", "high-priority", "blocker"]
        .iter()
        .any(|marker| lower.contains(marker))
}

fn validation_focus_item_is_mapped(item: &str, mapping_text: &str) -> bool {
    let tokens = significant_validation_tokens(item);
    if tokens.is_empty() {
        return mapping_text
            .to_ascii_lowercase()
            .contains(&item.to_ascii_lowercase());
    }
    let mapping_text = mapping_text.to_ascii_lowercase();
    let matches = tokens
        .iter()
        .filter(|token| mapping_text.contains(token.as_str()))
        .count();
    let required = if tokens.len() <= 2 { 1 } else { 2 };
    matches >= required
}

fn significant_validation_tokens(text: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "required",
        "must",
        "should",
        "critical",
        "high",
        "priority",
        "blocker",
        "validation",
        "focus",
        "verify",
        "check",
        "confirm",
    ];
    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(str::trim)
        .filter(|token| token.len() >= 4)
        .map(|token| token.to_ascii_lowercase())
        .filter(|token| !STOPWORDS.contains(&token.as_str()))
        .fold(Vec::new(), |mut tokens, token| {
            if !tokens.contains(&token) {
                tokens.push(token);
            }
            tokens
        })
}

fn require_plan_section(plan: Option<&str>, title: &str, blockers: &mut Vec<String>) {
    if plan
        .and_then(|text| markdown_section(text, title))
        .map(first_meaningful_line)
        .filter(|value| !is_none_like(value))
        .is_none()
    {
        blockers.push(format!("plan.md {title} is required by active mode"));
    }
}

fn require_review_section(review: Option<&str>, title: &str, blockers: &mut Vec<String>) {
    if review
        .and_then(|text| markdown_section(text, title))
        .map(first_meaningful_line)
        .filter(|value| !is_none_like(value))
        .is_none()
    {
        blockers.push(format!("review.md {title} is required by active mode"));
    }
}

fn verification_status(change_dir: &Path) -> SpecVerificationStatus {
    let path = change_dir.join("verification.md");
    let Ok(content) = fs::read_to_string(&path) else {
        return SpecVerificationStatus::default();
    };
    let completion_decision = markdown_section(&content, "Completion Decision")
        .map(first_meaningful_line)
        .filter(|value| !value.trim().is_empty());
    SpecVerificationStatus {
        present: true,
        completion_decision,
    }
}

fn completion_blockers_for_schema(
    schema: &str,
    change_dir: &Path,
    verification: &SpecVerificationStatus,
) -> Vec<String> {
    if !config::is_superpowers_schema(schema) {
        return Vec::new();
    }
    let review = fs::read_to_string(change_dir.join("review.md")).ok();
    let verification_mode = section_value(review.as_deref(), "Verification Mode", "inline-only");
    if !verification_mode.eq_ignore_ascii_case("retained-required") {
        return Vec::new();
    }

    let mut blockers = Vec::new();
    if !verification.present {
        blockers.push("verification.md is required by retained-required mode".to_string());
    } else if match verification.completion_decision.as_deref() {
        Some(decision) => !completion_decision_is_complete(decision),
        None => true,
    } {
        blockers.push("verification.md Completion Decision is not complete".to_string());
    }
    blockers
}

fn completion_decision_is_complete(decision: &str) -> bool {
    matches!(
        decision.trim().to_ascii_lowercase().as_str(),
        "complete" | "completed" | "verified" | "passed" | "pass" | "ready" | "done"
    )
}

/// Write retained completion evidence for a spec-driven change.
pub fn record_verification(
    cwd: &Path,
    name: &str,
    record: SpecVerificationRecord,
) -> Result<PathBuf> {
    let change_dir = checked_change_dir(cwd, name)?;
    if record.completion_decision.trim().is_empty() {
        anyhow::bail!("completion_decision cannot be empty");
    }

    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let path = change_dir.join("verification.md");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let manual_adjustments =
        markdown_section(&existing, "Manual Adjustments").unwrap_or_else(|| "none".to_string());
    let previous_iterations = markdown_section(&existing, "Previous Iterations");

    let mut content = String::new();
    content.push_str("# Verification\n\n");
    write_markdown_value(
        &mut content,
        "Completion Decision",
        record.completion_decision.trim(),
    );
    write_markdown_list(&mut content, "Commands Run", &record.commands_run);
    write_markdown_list(&mut content, "Manual Checks", &record.manual_checks);
    write_markdown_list(&mut content, "Evidence", &record.evidence);
    write_markdown_list(&mut content, "Residual Risks", &record.residual_risks);
    if let Some(previous_iterations) = previous_iterations {
        write_markdown_value(
            &mut content,
            "Previous Iterations",
            previous_iterations.trim(),
        );
    }
    write_markdown_value(
        &mut content,
        "Manual Adjustments",
        manual_adjustments.trim(),
    );

    fs::write(&path, content).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(path)
}

/// Write review findings back into the canonical spec-driven-superpowers artifacts.
pub fn review_writeback(
    cwd: &Path,
    name: &str,
    record: SpecReviewWritebackRecord,
) -> Result<SpecReviewWritebackReport> {
    let change_dir = checked_change_dir(cwd, name)?;
    let review_status = record.review_status.trim();
    if review_status.is_empty() {
        anyhow::bail!("review_status cannot be empty");
    }
    let findings = clean_markdown_items(&record.findings_summary);
    if review_status.eq_ignore_ascii_case("findings-received") && findings.is_empty() {
        anyhow::bail!("findings_summary cannot be empty when review_status is findings-received");
    }

    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let meta = read_metadata(&change_dir.join(".spec.yaml"))
        .with_context(|| format!("failed to read metadata for change '{}'", name))?;
    let schema = metadata_schema_or_default(&meta);
    if !config::is_superpowers_schema(&schema) {
        anyhow::bail!(
            "SpecReview action=writeback requires a spec-driven-superpowers schema change"
        );
    }

    let review_path = change_dir.join("review.md");
    let review = fs::read_to_string(&review_path)
        .with_context(|| format!("failed to read {}", review_path.display()))?;
    let review = upsert_markdown_section(&review, "Review Status", review_status);
    let review = upsert_markdown_section(
        &review,
        "Findings Summary",
        &markdown_list_body(&record.findings_summary),
    );
    fs::write(&review_path, review)
        .with_context(|| format!("failed to write {}", review_path.display()))?;

    let accepted_followups = clean_markdown_items(&record.accepted_followups);
    let tasks_updated = if accepted_followups.is_empty() {
        false
    } else {
        let tasks_path = change_dir.join("tasks.md");
        let tasks = fs::read_to_string(&tasks_path)
            .with_context(|| format!("failed to read {}", tasks_path.display()))?;
        let updated = append_review_followup_tasks(&tasks, &accepted_followups);
        if updated != tasks {
            fs::write(&tasks_path, updated)
                .with_context(|| format!("failed to write {}", tasks_path.display()))?;
            true
        } else {
            false
        }
    };

    let plan_updated = if accepted_followups.is_empty() {
        false
    } else {
        let plan_path = change_dir.join("plan.md");
        let plan = fs::read_to_string(&plan_path)
            .with_context(|| format!("failed to read {}", plan_path.display()))?;
        let updated = append_markdown_list_section(&plan, "Review Follow-Up", &accepted_followups);
        if updated != plan {
            fs::write(&plan_path, updated)
                .with_context(|| format!("failed to write {}", plan_path.display()))?;
            true
        } else {
            false
        }
    };

    let verification_notes = clean_markdown_items(&record.verification_notes);
    let verification_updated = if verification_notes.is_empty() {
        false
    } else {
        let verification_path = change_dir.join("verification.md");
        let existing = fs::read_to_string(&verification_path).unwrap_or_default();
        let updated = append_verification_notes(&existing, &verification_notes);
        if updated != existing {
            fs::write(&verification_path, updated)
                .with_context(|| format!("failed to write {}", verification_path.display()))?;
            true
        } else {
            false
        }
    };

    Ok(SpecReviewWritebackReport {
        change_name: meta.name,
        review_status: review_status.to_string(),
        review_path,
        tasks_updated,
        plan_updated,
        verification_updated,
    })
}

fn append_markdown_list_section(content: &str, title: &str, additions: &[String]) -> String {
    let mut items = markdown_section(content, title)
        .map(section_items)
        .unwrap_or_default();
    push_unique_markdown_items(&mut items, additions);
    upsert_markdown_section(content, title, &markdown_items_body(&items))
}

fn append_review_followup_tasks(tasks: &str, followups: &[String]) -> String {
    let followups = clean_markdown_items(followups)
        .into_iter()
        .filter(|item| !tasks.contains(item))
        .collect::<Vec<_>>();
    if followups.is_empty() {
        return tasks.to_string();
    }

    let group = next_task_group_number(tasks);
    let mut out = tasks.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!("## {group}. Review Follow-Up\n\n"));
    for (idx, item) in followups.iter().enumerate() {
        out.push_str(&format!("- [ ] {group}.{} {}\n", idx + 1, item));
    }
    out
}

fn next_task_group_number(tasks: &str) -> usize {
    numbered_ids(tasks)
        .into_iter()
        .filter_map(|id| id.split('.').next().and_then(|group| group.parse().ok()))
        .max()
        .unwrap_or(0)
        + 1
}

fn append_verification_notes(existing: &str, notes: &[String]) -> String {
    let mut content = if existing.trim().is_empty() {
        "# Verification\n".to_string()
    } else {
        existing.to_string()
    };

    let completion_decision = section_value(Some(&content), "Completion Decision", "pending");
    let commands_run = markdown_section(&content, "Commands Run").unwrap_or_else(|| "none".into());
    let manual_checks =
        markdown_section(&content, "Manual Checks").unwrap_or_else(|| "none".into());
    let evidence = markdown_section(&content, "Evidence").unwrap_or_else(|| "none".into());
    let manual_adjustments =
        markdown_section(&content, "Manual Adjustments").unwrap_or_else(|| "none".into());
    let previous_iterations = markdown_section(&content, "Previous Iterations");

    let mut residual_risks = markdown_section(&content, "Residual Risks")
        .map(section_items)
        .unwrap_or_default();
    push_unique_markdown_items(&mut residual_risks, notes);

    content = upsert_markdown_section(&content, "Completion Decision", &completion_decision);
    content = upsert_markdown_section(&content, "Commands Run", &commands_run);
    content = upsert_markdown_section(&content, "Manual Checks", &manual_checks);
    content = upsert_markdown_section(&content, "Evidence", &evidence);
    content = upsert_markdown_section(
        &content,
        "Residual Risks",
        &markdown_items_body(&residual_risks),
    );
    if let Some(previous_iterations) = previous_iterations {
        content = upsert_markdown_section(&content, "Previous Iterations", &previous_iterations);
    }
    upsert_markdown_section(&content, "Manual Adjustments", &manual_adjustments)
}

fn push_unique_markdown_items(items: &mut Vec<String>, additions: &[String]) {
    for item in clean_markdown_items(additions) {
        if !items
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&item))
        {
            items.push(item);
        }
    }
}

fn markdown_list_body(items: &[String]) -> String {
    markdown_items_body(&clean_markdown_items(items))
}

fn markdown_items_body(items: &[String]) -> String {
    if items.is_empty() {
        return "none".to_string();
    }
    items
        .iter()
        .map(|item| format!("- {}", item.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn clean_markdown_items(items: &[String]) -> Vec<String> {
    items
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty() && !is_none_like(item))
        .map(ToString::to_string)
        .collect()
}

fn upsert_markdown_section(content: &str, title: &str, body: &str) -> String {
    let heading = format!("## {title}");
    let body = normalize_markdown_body(body);
    let lines = content.lines().collect::<Vec<_>>();
    let mut out = Vec::new();
    let mut idx = 0;
    let mut replaced = false;

    while idx < lines.len() {
        if lines[idx].trim().eq_ignore_ascii_case(&heading) {
            push_markdown_section(&mut out, &heading, &body);
            replaced = true;
            idx += 1;
            while idx < lines.len() && !lines[idx].trim_start().starts_with("## ") {
                idx += 1;
            }
        } else {
            out.push(lines[idx].to_string());
            idx += 1;
        }
    }

    if !replaced {
        while out.last().is_some_and(|line| line.trim().is_empty()) {
            out.pop();
        }
        if !out.is_empty() {
            out.push(String::new());
        }
        push_markdown_section(&mut out, &heading, &body);
    }

    let mut result = out.join("\n");
    if !result.ends_with('\n') {
        result.push('\n');
    }
    result
}

fn normalize_markdown_body(body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        "none".to_string()
    } else {
        body.to_string()
    }
}

fn push_markdown_section(out: &mut Vec<String>, heading: &str, body: &str) {
    out.push(heading.to_string());
    out.push(String::new());
    out.extend(body.lines().map(ToString::to_string));
    out.push(String::new());
}

fn write_markdown_value(content: &mut String, title: &str, value: &str) {
    content.push_str("## ");
    content.push_str(title);
    content.push_str("\n\n");
    if value.trim().is_empty() {
        content.push_str("none\n\n");
    } else {
        content.push_str(value.trim());
        content.push_str("\n\n");
    }
}

fn write_markdown_list(content: &mut String, title: &str, items: &[String]) {
    content.push_str("## ");
    content.push_str(title);
    content.push_str("\n\n");
    let mut wrote = false;
    for item in items
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        content.push_str("- ");
        content.push_str(item);
        content.push('\n');
        wrote = true;
    }
    if !wrote {
        content.push_str("none\n");
    }
    content.push('\n');
}

/// Coverage report produced by `verify`.
#[derive(Debug, Clone, Default)]
pub struct SpecVerifyReport {
    pub covered: Vec<String>,
    pub gaps: Vec<String>,
}

/// Compare spec scenarios against the project's test suite.
///
/// Runs `cargo test -- --list` and checks whether each scenario title is
/// reflected in at least one test name. Returns covered scenarios and gaps.
/// Non-Rust projects (no `Cargo.toml`) are not supported and return an error.
pub fn verify(cwd: &Path) -> Result<SpecVerifyReport> {
    let specs_dir = specs_dir_for(cwd);
    if !specs_dir.exists() {
        anyhow::bail!("spec subsystem has not been initialized");
    }
    if !cwd.join("Cargo.toml").exists() {
        anyhow::bail!("SpecCheck action=verify only supports Rust projects with a Cargo.toml");
    }

    let specs = parse::load_authoritative_specs(&specs_dir)?;
    let mut scenarios: Vec<(String, String)> = Vec::new(); // (domain, title)
    for spec in specs {
        for req in &spec.requirements {
            for scenario in &req.scenarios {
                scenarios.push((spec.domain.clone(), scenario.title.clone()));
            }
        }
    }

    let cargo_path = resolve_program("cargo")?;
    let output = run_cargo_command(cwd, &cargo_path, &["test", "--", "--list"])
        .with_context(|| "failed to run cargo test -- --list")?;
    if !output.status.success() {
        anyhow::bail!(
            "cargo test -- --list failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let test_names = parse_cargo_test_names(&String::from_utf8_lossy(&output.stdout));

    let mut report = SpecVerifyReport::default();
    for (domain, title) in scenarios {
        let keyword = normalize_scenario_keyword(&title);
        if keyword.is_empty() {
            report
                .gaps
                .push(format!("specs/{}: '{}' (empty title)", domain, title));
            continue;
        }
        if test_names
            .iter()
            .any(|name| name.to_ascii_lowercase().contains(&keyword))
        {
            report.covered.push(format!("specs/{}: {}", domain, title));
        } else {
            report.gaps.push(format!("specs/{}: {}", domain, title));
        }
    }

    Ok(report)
}

fn parse_cargo_test_names(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("test result:") {
                return None;
            }
            if let Some(name) = trimmed.strip_suffix(": test") {
                let name = name.trim();
                return (!name.is_empty()).then(|| name.to_string());
            }
            let legacy = trimmed.strip_prefix("test ")?;
            let (name, status) = legacy.rsplit_once(" ... ")?;
            (!name.trim().is_empty() && matches!(status, "ok" | "FAILED" | "ignored"))
                .then(|| name.trim().to_string())
        })
        .collect()
}

fn normalize_scenario_keyword(title: &str) -> String {
    title
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
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

/// Build a code-review request for a completed spec change.
///
/// Gathers the change metadata, delta specs, git diff, and pre-check results,
/// then produces a populated reviewer prompt that can be passed to a review
/// subagent.
pub fn review(cwd: &Path, name: &str, base_sha: Option<&str>) -> Result<SpecReviewReport> {
    let change_dir = checked_change_dir(cwd, name)?;
    let specs_dir = specs_dir_for(cwd);
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let meta = read_metadata(&change_dir.join(".spec.yaml"))
        .with_context(|| format!("failed to read metadata for change '{}'", name))?;

    let read = |file: &str| -> String {
        change_dir
            .join(file)
            .to_str()
            .and_then(|p| fs::read_to_string(p).ok())
            .unwrap_or_default()
    };

    let deltas = parse::load_change_deltas_with_paths(&change_dir)?
        .into_iter()
        .map(|(domain, _delta, path)| {
            let content = fs::read_to_string(&path)
                .with_context(|| format!("failed to read {}", path.display()))?;
            Ok((domain, content))
        })
        .collect::<Result<Vec<_>>>()?;

    let git_base = base_sha
        .map(|s| s.to_string())
        .or_else(|| infer_review_base(cwd))
        .unwrap_or_else(|| "HEAD".to_string());
    let git_head = git_rev_parse(cwd, "HEAD").unwrap_or_else(|| "HEAD".to_string());

    let git_diff_stat = git_diff(cwd, &git_base, &git_head, true).unwrap_or_default();
    let git_diff = git_diff(cwd, &git_base, &git_head, false).unwrap_or_default();

    let summary = build_precheck_summary(cwd, &specs_dir, &change_dir);

    let reviewer_prompt = populate_reviewer_prompt(
        &meta,
        &read("proposal.md"),
        &read("design.md"),
        &read("tasks.md"),
        &deltas,
        &git_base,
        &git_head,
        &git_diff_stat,
        &git_diff,
        &summary,
    );

    Ok(SpecReviewReport {
        change_name: meta.name,
        title: meta.title,
        proposal: read("proposal.md"),
        design: read("design.md"),
        tasks: read("tasks.md"),
        deltas,
        git_base,
        git_head,
        git_diff_stat,
        git_diff,
        precheck_summary: summary,
        reviewer_prompt,
    })
}

fn infer_review_base(cwd: &Path) -> Option<String> {
    git_output(cwd, &["merge-base", "HEAD", "origin/main"])
        .or_else(|| git_output(cwd, &["rev-parse", "HEAD~1"]))
        .or_else(|| git_output(cwd, &["rev-list", "--max-parents=0", "HEAD"]))
}

fn git_rev_parse(cwd: &Path, rev: &str) -> Option<String> {
    git_output(cwd, &["rev-parse", rev])
}

fn git_output(cwd: &Path, args: &[&str]) -> Option<String> {
    let git_path = resolve_program("git").ok()?;
    run_git_command(cwd, &git_path, args)
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn git_diff(cwd: &Path, base: &str, head: &str, stat_only: bool) -> Option<String> {
    let range = format!("{}..{}", base, head);
    if stat_only {
        git_output(cwd, &["diff", "--stat", &range])
    } else {
        git_output(cwd, &["diff", &range])
    }
}

fn build_precheck_summary(cwd: &Path, specs_dir: &Path, change_dir: &Path) -> String {
    let mut lines = Vec::new();

    let tasks_path = change_dir.join("tasks.md");
    if tasks_path.exists() {
        let tasks = fs::read_to_string(&tasks_path).unwrap_or_default();
        let total = tasks.matches("- [").count();
        let checked = tasks.matches("- [x]").count() + tasks.matches("- [X]").count();
        lines.push(format!("Tasks: {}/{} checked", checked, total));
    } else {
        lines.push("Tasks: tasks.md missing".to_string());
    }

    let drift = fingerprint::check_change(specs_dir, change_dir).unwrap_or_default();
    if drift.is_empty() {
        lines.push("Spec drift: none".to_string());
    } else {
        lines.push(format!("Spec drift: {} issue(s)", drift.len()));
    }

    if cwd.join("Cargo.toml").exists() && std::env::var("KCODER_SPEC_SKIP_TESTS").is_err() {
        let cargo_output = resolve_program("cargo")
            .and_then(|cargo_path| run_cargo_command(cwd, &cargo_path, &["test", "--quiet"]));
        match cargo_output {
            Ok(output) if output.status.success() => lines.push("Tests: passing".to_string()),
            Ok(output) => lines.push(format!(
                "Tests: failing\n{}",
                String::from_utf8_lossy(&output.stderr)
            )),
            Err(e) => lines.push(format!("Tests: could not run ({})", e)),
        }
    } else {
        lines.push("Tests: skipped (no Cargo.toml or KCODER_SPEC_SKIP_TESTS set)".to_string());
    }

    lines.join("\n")
}

#[allow(clippy::too_many_arguments)]
fn populate_reviewer_prompt(
    meta: &ChangeMetadata,
    proposal: &str,
    design: &str,
    tasks: &str,
    deltas: &[(String, String)],
    base: &str,
    head: &str,
    diff_stat: &str,
    diff: &str,
    precheck: &str,
) -> String {
    let title = meta.title.as_deref().unwrap_or(meta.name.as_str());
    let deltas_text = deltas
        .iter()
        .map(|(domain, content)| format!("## specs/{}\n\n{}", domain, content))
        .collect::<Vec<_>>()
        .join("\n\n");
    let description = format!(
        "Change: {}\n\nProposal:\n{}\n\nDesign:\n{}\n\nTasks:\n{}",
        meta.name, proposal, design, tasks
    );
    CODE_REVIEWER_PROMPT_TEMPLATE
        .replace("{TITLE}", title)
        .replace("{DESCRIPTION}", &description)
        .replace("{PLAN_OR_REQUIREMENTS}", &deltas_text)
        .replace("{BASE_SHA}", base)
        .replace("{HEAD_SHA}", head)
        .replace("{DIFF_STAT}", diff_stat)
        .replace("{DIFF}", diff)
        .replace("{PRECHECK}", precheck)
}

const CODE_REVIEWER_PROMPT_TEMPLATE: &str = r#"You are a Senior Code Reviewer reviewing a spec-driven change.

## Change

{TITLE}

## What Was Implemented

{DESCRIPTION}

## Requirements / Plan

{PLAN_OR_REQUIREMENTS}

## Pre-Review Checks

{PRECHECK}

## Git Range

Base: {BASE_SHA}
Head: {HEAD_SHA}

```bash
git diff --stat {BASE_SHA}..{HEAD_SHA}
```

{DIFF_STAT}

```bash
git diff {BASE_SHA}..{HEAD_SHA}
```

{DIFF}

## Review Process

Conduct the review in two explicit phases. Do not mix phase-1 and phase-2 findings until the final summary.

### Phase 1: Spec Compliance

Verify that the implementation faithfully satisfies the approved spec change.

- Does the git diff realize every ADDED/MODIFIED/REMOVED/RENAMED requirement in the delta specs?
- Are there unimplemented requirements or scope creep not covered by the deltas?
- Do new tests map to specific spec scenarios (WHEN/THEN)?
- Is the design.md consistent with the actual changes?

### Phase 2: Code Quality

Only after confirming spec compliance, evaluate the implementation itself.

- Type safety, error handling, and panic paths.
- Edge cases, cross-platform behavior, and async correctness.
- Test quality: do tests verify real behavior, not just existence?
- No obvious bugs, security issues, or unnecessary complexity.

## Output Format

### Strengths
[What's well done? Be specific.]

### Issues
#### Critical (Must Fix)
#### Important (Should Fix)
#### Minor (Nice to Have)

### Assessment
**Ready to merge?** [Yes | No | With fixes]
**Reasoning:** [1-2 sentence technical assessment]
"#;

/// List active change names.
pub fn list_changes(cwd: &Path) -> Result<Vec<String>> {
    let changes_dir = checked_changes_dir(cwd)?;
    if !changes_dir.exists() {
        return Ok(Vec::new());
    }

    let mut names = Vec::new();
    for entry in
        fs::read_dir(&changes_dir).with_context(|| format!("failed to read {:?}", changes_dir))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir()
            && path.join(".spec.yaml").exists()
            && path.file_name() != Some(std::ffi::OsStr::new("archive"))
            && let Some(name) = path.file_name().and_then(|n| n.to_str())
        {
            checked_change_dir(cwd, name)?;
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

fn first_authoritative_domain(specs_dir: &Path) -> Option<String> {
    let auth_dir = specs_dir.join("specs");
    if !auth_dir.exists() {
        return None;
    }
    let mut domains: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&auth_dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir()
            && path.join("spec.md").is_file()
            && let Some(name) = path.file_name().and_then(|n| n.to_str())
        {
            domains.push(name.to_string());
        }
    }
    domains.sort();
    domains.into_iter().next()
}

/// Apply a plan text to the `tasks.md` of an active spec change.
///
/// If `change_name` is omitted and there is exactly one active change, the plan
/// is written there. Each non-empty plan line is converted into a `- [ ]`
/// task if it is not already a checkbox or a markdown heading.
pub fn apply_plan(cwd: &Path, change_name: Option<&str>, plan: &str) -> Result<PathBuf> {
    let name = match change_name {
        Some(n) => n.to_string(),
        None => {
            let changes = list_changes(cwd)?;
            match changes.len() {
                0 => anyhow::bail!(
                    "no active spec changes; create one with SpecNewChange or pass change_name"
                ),
                1 => changes.into_iter().next().unwrap(),
                _ => anyhow::bail!(
                    "multiple active spec changes: {}; pass change_name to choose one",
                    changes.join(", ")
                ),
            }
        }
    };

    let change_dir = checked_change_dir(cwd, &name)?;
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let meta = read_metadata(&change_dir.join(".spec.yaml"))
        .with_context(|| format!("failed to read metadata for change '{}'", name))?;
    let schema = metadata_schema_or_default(&meta);
    if config::is_superpowers_schema(&schema) {
        let plan_path = change_dir.join("plan.md");
        fs::write(&plan_path, plan)
            .with_context(|| format!("failed to write {}", plan_path.display()))?;
        debug!("wrote plan to {:?}", plan_path);
        return Ok(plan_path);
    }

    let tasks_path = change_dir.join("tasks.md");
    let tasks = plan
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty()
                || trimmed.starts_with('#')
                || trimmed.starts_with("- [")
                || trimmed.starts_with("* [")
            {
                return line.to_string();
            }
            let indent = &line[..line.len() - trimmed.len()];
            if let Some(rest) = trimmed.strip_prefix("- ") {
                format!("{}- [ ] {}", indent, rest)
            } else if let Some(rest) = trimmed.strip_prefix("* ") {
                format!("{}- [ ] {}", indent, rest)
            } else {
                format!("{}- [ ] {}", indent, trimmed)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    fs::write(&tasks_path, tasks)
        .with_context(|| format!("failed to write {}", tasks_path.display()))?;
    debug!("wrote plan to {:?}", tasks_path);
    Ok(tasks_path)
}

fn read_metadata(path: &Path) -> Result<ChangeMetadata> {
    let text = fs::read_to_string(path).with_context(|| format!("failed to read {:?}", path))?;
    serde_yaml::from_str(&text).with_context(|| format!("failed to parse {:?}", path))
}

const DEFAULT_SPEC: &str = r#"# Spec: core

## Purpose

Core domain behavior for the project.

## Requirements

### Requirement: example

The system MUST behave correctly in the example scenario.

#### Scenario: happy path

- **WHEN** an action happens
- **THEN** an expected result occurs
"#;

const PROPOSAL_TEMPLATE: &str = r#"# Proposal

## Problem

What problem does this change solve?

## Approach

High-level approach.

## Acceptance criteria

- [ ] Criterion one
- [ ] Criterion two
"#;

const DESIGN_TEMPLATE: &str = r#"# Design

## Overview

Design overview.

## Key decisions

- Decision one
- Decision two

## Risks

- Risk one
"#;

const TASKS_TEMPLATE: &str = r#"# Tasks

## 1. Understand and reproduce
- [ ] 1.1 Read the relevant specs and code.
- [ ] 1.2 List edge cases and platform-specific behavior.

## 2. Design
- [ ] 2.1 Write or update delta specs under `changes/<name>/specs/`.
- [ ] 2.2 Update `design.md` with key decisions and risks.

## 3. Implement
- [ ] 3.1 Add production code.
- [ ] 3.2 Add or update tests for every new/changed requirement.

## 4. Verify
- [ ] 4.1 Run the project test suite.
- [ ] 4.2 Run SpecCheck with action=verify and close any coverage gaps.
"#;

const REVIEW_TEMPLATE: &str = r#"# Review

## Readiness Decision

ready with conditions

## Execution Mode

standard

## Verification Mode

inline-only

## Debug Mode

standard

## Review Request

not-requested

## Review Scope

none

## Review Focus

none

## Review Status

not-requested

## Delegation Mode

single-agent

## Parallelization Mode

serial-only

## Worktree Mode

same-tree

## Branch Finish Mode

standard

## Blocked By

none

## Observed Failure

none

## Validation Focus

- Run the project precheck.
- Run SpecCheck with action=validate and close any structural errors.

## Key Risks

- Unknown until design and tasks are finalized.

## Findings Summary

none

## Manual Adjustments

none
"#;

const PLAN_TEMPLATE: &str = r#"# Plan

## Scope

Describe the part of the change this execution plan covers.

## Covers

- 1.1

## Plan Type

lightweight

## Execution Strategy

standard

## Ordered Steps

1. Inspect the relevant specs and code.
2. Implement the smallest coherent change.
3. Run the focused validation.

## Validation Per Step

1. Confirm the affected requirements and current behavior.
2. Confirm code changes match the accepted design.
3. Confirm tests, SpecCheck action=validate, and any configured precheck pass.

## Files / Owners

- `TBD`

## Completion Checkpoint

All covered tasks are complete, validation has passed, and residual risks are recorded.

## Completion Verification

Record final commands or evidence here when retained verification is recommended or required.

## Debugging Trail

none

## Review Follow-Up

none

## Delegation Units

none

## Parallel Units

none

## Isolation Boundaries

none

## Worktree Units

none

## Isolation Reason

none

## Integration Owner

main agent

## Finish Checklist

none

## Delivery Handoff

none

## Execution Notes

none

## Manual Adjustments

none
"#;

const DEFAULT_DELTA_TEMPLATE: &str = r#"# Delta: core

Describe changes to the authoritative spec using the four sections below.
Each requirement MUST use SHALL/MUST/SHOULD/MAY and each scenario MUST use WHEN/THEN.

## ADDED Requirements

### Requirement: <name>
The system MUST ...

#### Scenario: <title>
- **WHEN** ...
- **THEN** ...

## MODIFIED Requirements

<!-- List requirements whose behavior changes. Use `### Requirement: <name>` blocks. -->

## REMOVED Requirements

<!-- List requirements to remove. Use `### Requirement: <name>` blocks or a bullet list. -->

## RENAMED Requirements

<!-- Use FROM/TO pairs: `- FROM: ### Requirement: <old-name>` / `- TO: ### Requirement: <new-name>`. -->
"#;

const USING_SPECS_SKILL: &str = r#"---
name: using-specs
description: Use when the project has a .kcoder/specs directory and you are doing spec-driven development.
paths:
  - ".kcoder/specs/**"
---

# Using Specs (OpenSpec + Superpowers fusion)

This project uses spec-driven development. The authoritative behavior specs live
under `.kcoder/specs/specs/`. Changes are tracked under `.kcoder/specs/changes/`.

The Superpowers discipline skills are installed under `.kcoder/skills/`. Invoke
them with the Skill tool before taking action:

- `using-superpowers` — root protocol; check for applicable skills before every response.
- `brainstorming` — HARD-GATE for creative work; present a design and get approval first.
- `writing-plans` — turn a spec into a numbered, bite-sized implementation plan.
- `test-driven-development` — follow RED / GREEN / REFACTOR for every feature or fix.
- `verification-before-completion` — run verification commands and confirm output before claiming done.
- `using-git-worktrees` — isolate feature work in a clean worktree when appropriate.

Workflow:

1. **Check skills** — invoke `using-superpowers` to see which discipline applies.
2. **Brainstorm** — if the problem is ambiguous or creative, invoke `brainstorming`.
3. **Create a change** — call `SpecNewChange` with a kebab-case name and optional title.
4. **Propose** — fill in `proposal.md` with the problem, approach, and acceptance criteria.
5. **Spec** — write delta specs under `changes/<name>/specs/<capability>/spec.md` describing ADDED,
   MODIFIED, or REMOVED requirements relative to `.kcoder/specs/specs/`.
   - If the change spans multiple independent capability domains, invoke
     `dispatching-parallel-agents` to draft each domain's delta spec in parallel.
6. **Design** — document key decisions and risks in `design.md`.
7. **Review readiness** — when the schema is `spec-driven-superpowers`, fill
   `review.md` before implementation planning. Treat `Readiness Decision:
   blocked` as a stop sign, and carry `Validation Focus` into the plan.
8. **Plan execution** — invoke `writing-plans`, then use `ExitPlanMode` with the
   plan text. Default `spec-driven` changes sync the plan to `tasks.md` as
   checkboxes. `spec-driven-superpowers` changes sync the plan to `plan.md`;
   keep `tasks.md` as the coarse-grained progress source of truth.
9. **Preflight** — when the schema is `spec-driven-superpowers`, call
   `SpecCheck` with `action=preflight` and resolve blockers before implementation.
10. **Implement** — invoke `test-driven-development` and follow its RED/GREEN/REFACTOR cycle.
   Prefer `EnterWorktree` for isolated branches.
11. **Verify** — invoke `verification-before-completion`; run tests and ensure all tasks are checked (`- [x]`).
    If retained evidence is recommended or required, call `SpecRecordVerification`
    so `verification.md` records the completion decision, commands, checks,
    evidence, and residual risks.
12. **Review writeback** — after code-review findings are received, call
    `SpecReview` with `action=writeback` so accepted findings are written into `review.md`,
    `tasks.md`, `plan.md`, or `verification.md` rather than a parallel notes tree.
13. **Rebase if needed** — if `SpecArchive` reports drift, call `SpecSync` to
    fast-forward unchanged deltas or surface conflicts, resolve them, then re-sync.
14. **Archive** — call `SpecArchive` to finalize the change.

Never skip the spec and design steps for non-trivial changes. If a requirement
conflicts with an existing spec, update the spec delta and explain why.
"#;

#[cfg(test)]
#[rustfmt::skip]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
mod change_boundary_tests {
    use super::*;

    fn public_change_operations(cwd: &Path, name: &str) -> Vec<(&'static str, Result<()>)> {
        vec![
            ("new_change", new_change(cwd, name, None).map(|_| ())),
            ("archive", archive(cwd, name).map(|_| ())),
            ("validate", validate(cwd, Some(name)).map(|_| ())),
            ("status", status(cwd, name).map(|_| ())),
            ("apply_preflight", apply_preflight(cwd, name).map(|_| ())),
            (
                "record_verification",
                record_verification(
                    cwd,
                    name,
                    SpecVerificationRecord {
                        completion_decision: "pending".to_string(),
                        ..Default::default()
                    },
                )
                .map(|_| ()),
            ),
            (
                "review_writeback",
                review_writeback(
                    cwd,
                    name,
                    SpecReviewWritebackRecord {
                        review_status: "pending".to_string(),
                        ..Default::default()
                    },
                )
                .map(|_| ()),
            ),
            ("review", review(cwd, name, None).map(|_| ())),
            (
                "apply_plan",
                apply_plan(cwd, Some(name), "- task").map(|_| ()),
            ),
            ("sync", sync::sync(cwd, name).map(|_| ())),
        ]
    }

    #[test]
    fn public_change_operations_reject_unsafe_names_before_io() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("workspace");
        fs::create_dir(&cwd).unwrap();
        for name in [
            "",
            " ",
            ".",
            "..",
            ". ",
            ".. ",
            "../escape",
            "a/b",
            r"a\b",
            r"C:\escape",
            r"C:escape",
            r"\\server\share",
            "CON",
            "NUL",
            "AUX",
            "PRN",
            "COM1",
            "COM9.txt",
            "LPT1",
            "LPT9.txt",
            "con.txt",
            "a?b",
            "a*b",
            "a<b",
            "a>b",
            "a|b",
            "a\"b",
            "a\u{0001}b",
            "a\nb",
            "a\u{007f}b",
        ] {
            for (operation, result) in public_change_operations(&cwd, name) {
                let error = result.expect_err(&format!("{operation} 不得接受 {name:?}"));
                assert!(
                    error.to_string().contains("invalid change name"),
                    "{operation}: {error:#}"
                );
            }
        }
        assert!(!cwd.join(".kcoder").exists(), "非法名称不得先创建目录");
    }

    #[cfg(unix)]
    #[test]
    fn public_change_operations_reject_posix_absolute_path() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("workspace");
        fs::create_dir(&cwd).unwrap();
        let external = root.path().join("external");
        fs::create_dir(&external).unwrap();
        let sentinel = external.join("verification.md");
        fs::write(&sentinel, "untouched").unwrap();
        for (operation, result) in public_change_operations(&cwd, external.to_str().unwrap()) {
            let error = result.expect_err(&format!("{operation} 不得接受 POSIX 绝对路径"));
            assert!(
                error.to_string().contains("invalid change name"),
                "{operation}: {error:#}"
            );
        }
        assert!(!cwd.join(".kcoder").exists(), "非法名称不得先创建目录");
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "untouched");
    }

    #[cfg(unix)]
    #[test]
    fn public_change_operations_reject_existing_change_symlink() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("workspace");
        let external = root.path().join("external");
        fs::create_dir(&cwd).unwrap();
        fs::create_dir(&external).unwrap();
        let change = new_change(&external, "target", None).unwrap();
        let sentinel = change.join("verification.md");
        fs::write(&sentinel, "untouched").unwrap();
        let changes = cwd.join(SPECS_DIR).join("changes");
        fs::create_dir_all(&changes).unwrap();
        std::os::unix::fs::symlink(&change, changes.join("linked")).unwrap();
        for (operation, result) in public_change_operations(&cwd, "linked") {
            let error = result.expect_err(&format!("{operation} 不得接受 change symlink"));
            assert!(
                error.to_string().contains("symlink"),
                "{operation}: {error:#}"
            );
        }
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "untouched");
    }

    #[cfg(unix)]
    #[test]
    fn new_change_rejects_symlinked_changes_parent() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("workspace");
        let specs = cwd.join(SPECS_DIR);
        fs::create_dir_all(&specs).unwrap();
        let external = root.path().join("external");
        fs::create_dir(&external).unwrap();
        std::os::unix::fs::symlink(&external, specs.join("changes")).unwrap();
        assert!(new_change(&cwd, "escape", None).is_err());
        assert!(!external.join("escape").exists());
    }

    #[test]
    fn unicode_change_name_keeps_normal_lifecycle() {
        let root = tempfile::tempdir().unwrap();
        init(root.path()).unwrap();
        let name = "修复-记忆";
        let change = new_change(root.path(), name, None).unwrap();
        apply_plan(root.path(), Some(name), "- [x] done").unwrap();
        assert_eq!(status(root.path(), name).unwrap().name, name);
        validate(root.path(), Some(name)).unwrap();
        let archived = archive(root.path(), name).unwrap();
        assert!(archived.is_dir());
        assert!(!change.exists());
    }
}
