//! Extension preflight for the shared CLI composition root.

use crate::build_identity;
use anyhow::{Result, bail};
use kcoder_cli_commands::{cli_args::TrustAction, credentials::canonicalize_cli_cwd};
use kcoder_config::{PermissionMode, Settings};
use kcoder_permissions::{PermissionDecision, PermissionEngine};
use kcoder_skills::SkillRegistry;
use kcoder_tools::ToolRegistry;
use std::path::{Path, PathBuf};
use tracing::warn;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequiredSkillPreflightFailure {
    pub skill: String,
    pub reason: &'static str,
    pub message: String,
    pub remediation: String,
}

/// True when the working directory exposes a project-level executable
/// extension surface (hooks/MCP settings, skills, plugins).
pub fn project_has_extension_surface(cwd: &Path) -> bool {
    cwd.join(".kcoder").join("settings.json").is_file()
        || cwd.join(".kcoder").join("settings.local.json").is_file()
        || cwd.join(".kcoder").join("skills").is_dir()
        || cwd.join(".kcoder").join("plugins").is_dir()
}

pub fn run_trust_action(action: TrustAction, cwd: &Path) -> Result<()> {
    let config_dir = Settings::config_dir()?;
    let mut store = kcoder_config::FolderTrustStore::load(&config_dir);
    let requested_path = match &action {
        TrustAction::Status { path }
        | TrustAction::Add { path }
        | TrustAction::Revoke { path }
        | TrustAction::Never { path } => path.clone(),
    };
    let path = canonicalize_cli_cwd(if requested_path.is_absolute() {
        requested_path
    } else {
        cwd.join(requested_path)
    });

    match action {
        TrustAction::Status { .. } => {
            let decision = match store.check(&path) {
                kcoder_config::FolderTrust::Trusted => "trusted",
                kcoder_config::FolderTrust::Never => "never",
                kcoder_config::FolderTrust::Unknown => "unknown",
            };
            println!("{}\t{}", decision, path.display());
        }
        TrustAction::Add { .. } => {
            if !path.is_dir() {
                bail!(
                    "trust target is not an existing directory: {}",
                    path.display()
                );
            }
            store.trust(&path)?;
            println!("trusted\t{}", path.display());
        }
        TrustAction::Revoke { .. } => {
            store.revoke(&path)?;
            println!("unknown\t{}", path.display());
        }
        TrustAction::Never { .. } => {
            if !path.is_dir() {
                bail!(
                    "trust target is not an existing directory: {}",
                    path.display()
                );
            }
            store.never(&path)?;
            println!("never\t{}", path.display());
        }
    }
    Ok(())
}

pub fn required_skill_preflight(
    required_skills: &[String],
    folder_trusted: bool,
    registry: &SkillRegistry,
    tools: &ToolRegistry,
    permissions: &PermissionEngine,
    cwd: &Path,
    headless: bool,
) -> std::result::Result<(), RequiredSkillPreflightFailure> {
    let mut names = required_skills
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    names.sort_unstable();
    names.dedup();

    for name in names {
        if registry.get_active(name).is_none() {
            let project_copy = find_project_skill_file(cwd, name);
            let (reason, remediation) = if !folder_trusted && project_copy.is_some() {
                (
                    "project_not_trusted",
                    format!("kcoder trust add --path {}", cwd.display()),
                )
            } else {
                (
                    "required_skill_missing",
                    format!("install or create the `{name}` skill before starting this run"),
                )
            };
            return Err(RequiredSkillPreflightFailure {
                skill: name.to_string(),
                reason,
                message: format!(
                    "required skill `{name}` is unavailable before model startup ({reason})"
                ),
                remediation,
            });
        }

        let skill = registry.get_active(name).expect("checked above");
        let missing_tools = skill
            .requires_tools
            .iter()
            .filter(|required| tools.get(required).is_none())
            .cloned()
            .collect::<Vec<_>>();
        if skill.requires_inline_widgets() || !missing_tools.is_empty() {
            return Err(RequiredSkillPreflightFailure {
                skill: name.to_string(),
                reason: "required_skill_capability_unavailable",
                message: format!(
                    "required skill `{name}` needs tools or client capabilities unavailable in this CLI run"
                ),
                remediation: if skill.requires_inline_widgets() {
                    "open a kworker conversation in KCoder Studio with inline visualizations enabled".to_string()
                } else {
                    format!(
                        "enable the required tools in this run: {}",
                        missing_tools.join(", ")
                    )
                },
            });
        }

        let Some(skill_tool) = tools.get("skill") else {
            return Err(RequiredSkillPreflightFailure {
                skill: name.to_string(),
                reason: "skill_tool_unavailable",
                message: format!(
                    "required skill `{name}` is loaded, but the `skill` tool is not in the active tool profile"
                ),
                remediation: "use --tool-profile full so the skill tool is available".to_string(),
            });
        };
        let decision = permissions.decide(skill_tool.as_ref(), &serde_json::json!({"skill": name}));
        if decision == PermissionDecision::Deny
            || (headless
                && decision == PermissionDecision::Ask
                && matches!(
                    permissions.mode,
                    PermissionMode::Ask | PermissionMode::DontAsk
                ))
        {
            return Err(RequiredSkillPreflightFailure {
                skill: name.to_string(),
                reason: "skill_permission_denied",
                message: format!(
                    "required skill `{name}` is loaded, but current permissions deny the `skill` tool"
                ),
                remediation: "allow the `skill` tool in the selected project permission profile"
                    .to_string(),
            });
        }
    }
    Ok(())
}

pub fn find_project_skill_file(cwd: &Path, skill_name: &str) -> Option<PathBuf> {
    let relative_name = skill_name.replace(':', "/");
    for directory in cwd.ancestors() {
        let candidate = directory
            .join(".kcoder")
            .join("skills")
            .join(&relative_name)
            .join("SKILL.md");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn emit_required_skill_preflight_failure(
    failure: &RequiredSkillPreflightFailure,
    json: bool,
    session_id: String,
) {
    if json {
        let mut event = serde_json::json!({
            "type": "preflight_failed",
            "check": "required_skill",
            "skill": failure.skill,
            "reason": failure.reason,
            "remediation": failure.remediation,
            "state_mutated": false,
        });
        build_identity::add_to_json(&mut event);
        println!("{event}");

        let mut result = serde_json::json!({
            "type": "result",
            "subtype": "error",
            "run_status": "completed",
            "task_status": "blocked",
            "termination_reason": "required_skill_unavailable",
            "session_id": session_id,
            "timed_out": false,
            "retryable": false,
            "resume_safe": true,
            "nudge_sent": false,
            "work_remaining": [format!("load required skill `{}`", failure.skill)],
            "error": failure.message,
        });
        build_identity::add_to_json(&mut result);
        println!("{result}");
    } else {
        eprintln!("[preflight blocked] {}", failure.message);
        eprintln!("Remediation: {}", failure.remediation);
    }
}

/// One-time interactive trust prompt shown before the TUI starts. Non-TTY
/// stdin (headless/CI) means "skip", matching headless permission behavior.
pub fn prompt_folder_trust(cwd: &Path, store: &mut kcoder_config::FolderTrustStore) -> bool {
    use std::io::IsTerminal as _;
    if !std::io::stdin().is_terminal() {
        return false;
    }
    eprintln!();
    eprintln!(
        "This project contains executable extensions (.kcoder hooks/MCP settings, skills, plugins)."
    );
    eprintln!("They can run commands inside this session.");
    eprint!(
        "Trust {}? [y] trust / [n] skip / [never] never: ",
        cwd.display()
    );
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    match line.trim() {
        "y" | "Y" | "yes" => {
            if let Err(error) = store.trust(cwd) {
                warn!("failed to persist folder trust: {error}");
            }
            true
        }
        "never" | "N" => {
            if let Err(error) = store.never(cwd) {
                warn!("failed to persist folder trust: {error}");
            }
            false
        }
        _ => false,
    }
}

pub use kcoder_cli_commands::training_isolation::apply_training_skill_isolation;

#[cfg(test)]
mod project_mcp_tests {
    use kcoder_cli_commands::entry_modes::project_mcp_server_names;

    #[test]
    fn missing_project_mcp_names_do_not_create_project_configuration() {
        let workspace = tempfile::tempdir().unwrap();
        assert!(project_mcp_server_names(workspace.path()).is_empty());
        assert!(!workspace.path().join(".kcoder").exists());
    }

    #[test]
    fn project_mcp_names_preserve_project_and_local_documents() {
        let workspace = tempfile::tempdir().unwrap();
        let directory = workspace.path().join(".kcoder");
        std::fs::create_dir(&directory).unwrap();
        let project = br#"{"mcp_servers":[{"name":"project-fixture"}]}"#;
        let local = br#"{"mcp_servers":[{"name":"local-fixture"}]}"#;
        std::fs::write(directory.join("settings.json"), project).unwrap();
        std::fs::write(directory.join("settings.local.json"), local).unwrap();
        assert_eq!(
            project_mcp_server_names(workspace.path()),
            std::collections::BTreeSet::from(["project-fixture".into(), "local-fixture".into()])
        );
        assert_eq!(
            std::fs::read(directory.join("settings.json")).unwrap(),
            project
        );
        assert_eq!(
            std::fs::read(directory.join("settings.local.json")).unwrap(),
            local
        );
    }
}
