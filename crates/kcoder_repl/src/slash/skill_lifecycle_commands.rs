use crate::ReplApp;
use kcoder_engine::QueryEngine;
use kcoder_tools::{SkillCuratorTool, SkillGuardPolicy, SkillHubTool, Tool, ToolContext};
use kcoder_types::{ContentBlock, MessageRole};
use serde_json::json;
use std::sync::Arc;

use super::{SlashCommand, SlashResult};

#[derive(Default)]
pub(super) struct SkillTelemetryCommand;

#[async_trait::async_trait]
impl SlashCommand for SkillTelemetryCommand {
    fn name(&self) -> &'static str {
        "/skill-usage"
    }
    fn description(&self) -> &'static str {
        "Inspect skill usage telemetry."
    }
    fn usage(&self) -> &'static str {
        "/skill-usage [list|view <skill-name>|pin <skill-name>|unpin <skill-name>|mark-state <skill-name> <active|stale|archived>|score-quality [skill-name]]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let input = match skill_telemetry_input(args) {
            Ok(input) => input,
            Err(usage) => {
                app.push_message(MessageRole::System, usage);
                return SlashResult::Handled;
            }
        };
        call_tool(app, engine, SkillCuratorTool, input).await;
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct CuratorCommand;

#[async_trait::async_trait]
impl SlashCommand for CuratorCommand {
    fn name(&self) -> &'static str {
        "/curator"
    }
    fn description(&self) -> &'static str {
        "Run or inspect the skill lifecycle curator."
    }
    fn usage(&self) -> &'static str {
        "/curator <status|run|pin|unpin|archive|restore|consolidate> [skill-name] [--dry-run]\n\
         /curator run [--dry-run] [--stale-after-days N] [--archive-after-days N] [--include-non-agent-created] [--include-bundled]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let input = match curator_input(args) {
            Ok(input) => input,
            Err(usage) => {
                app.push_message(MessageRole::System, usage);
                return SlashResult::Handled;
            }
        };
        call_tool(app, engine, SkillCuratorTool, input).await;
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct SkillBundledSyncCommand;

#[async_trait::async_trait]
impl SlashCommand for SkillBundledSyncCommand {
    fn name(&self) -> &'static str {
        "/skill-sync"
    }
    fn description(&self) -> &'static str {
        "Sync bundled workflow skills."
    }
    fn usage(&self) -> &'static str {
        "/skill-sync <status|sync> [--dry-run] [--force]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let input = match bundled_skills_input(args) {
            Ok(input) => input,
            Err(usage) => {
                app.push_message(MessageRole::System, usage);
                return SlashResult::Handled;
            }
        };
        call_tool(app, engine, SkillHubTool, input).await;
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct SkillsHubCommand;

#[async_trait::async_trait]
impl SlashCommand for SkillsHubCommand {
    fn name(&self) -> &'static str {
        "/skills-hub"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/skill-hub"]
    }
    fn description(&self) -> &'static str {
        "List, search, install, or uninstall hub skills."
    }
    fn usage(&self) -> &'static str {
        "/skills-hub <list|search|install|uninstall> [--user|--project] [query|url|skill-name]\n\
         /skills-hub install [--user|--project] [--force] [--trusted|--community] [--allow-medium-risk] [--allow-high-risk] <raw-skill-url|local-path>\n\
         /skills-hub install github <owner/repo> <path> [ref] [--user|--project] [--force] [--trusted|--community] [--allow-medium-risk] [--allow-high-risk]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let input = match skills_hub_input(args) {
            Ok(input) => input,
            Err(usage) => {
                app.push_message(MessageRole::System, usage);
                return SlashResult::Handled;
            }
        };
        call_tool(app, engine, SkillHubTool, input).await;
        SlashResult::Handled
    }
}

fn skill_telemetry_input(args: &str) -> Result<serde_json::Value, String> {
    let mut parts = args.split_whitespace();
    let Some(first) = parts.next() else {
        return Ok(json!({"action": "usage"}));
    };
    match first {
        "list" => {
            if parts.next().is_some() {
                return Err(skill_telemetry_usage());
            }
            Ok(json!({"action": "usage"}))
        }
        "view" => {
            let name = parse_single_skill_telemetry_name(parts)?;
            Ok(json!({"action": "usage", "name": name}))
        }
        "pin" | "unpin" => {
            let name = parse_single_skill_telemetry_name(parts)?;
            Ok(json!({"action": first, "name": name}))
        }
        "mark-state" | "mark_state" => {
            let Some(name) = parts.next() else {
                return Err(skill_telemetry_usage());
            };
            let Some(state) = parts.next() else {
                return Err(skill_telemetry_usage());
            };
            if parts.next().is_some() || !matches!(state, "active" | "stale" | "archived") {
                return Err(skill_telemetry_usage());
            }
            Ok(json!({"action": "mark_state", "name": name, "state": state}))
        }
        "score-quality" | "score_quality" => {
            let name = parts.next();
            if parts.next().is_some() {
                return Err(skill_telemetry_usage());
            }
            let mut input = json!({"action": "score_quality"});
            if let Some(name) = name {
                input["name"] = json!(name);
            }
            Ok(input)
        }
        _ => {
            if parts.next().is_some() {
                return Err(skill_telemetry_usage());
            }
            Ok(json!({"action": "usage", "name": first}))
        }
    }
}

fn parse_single_skill_telemetry_name<'a>(
    mut parts: impl Iterator<Item = &'a str>,
) -> Result<&'a str, String> {
    let Some(name) = parts.next() else {
        return Err(skill_telemetry_usage());
    };
    if parts.next().is_some() {
        return Err(skill_telemetry_usage());
    }
    Ok(name)
}

fn skill_telemetry_usage() -> String {
    "Usage: /skill-usage [list|view <skill-name>|pin <skill-name>|unpin <skill-name>|mark-state <skill-name> <active|stale|archived>|score-quality [skill-name]]".to_string()
}

fn curator_input(args: &str) -> Result<serde_json::Value, String> {
    let mut parts = args.split_whitespace();
    let action = parts.next().unwrap_or("status");
    if action == "run" {
        return curator_run_input(parts);
    }
    let mut name = None;
    let mut targets = Vec::new();
    for part in parts {
        if name.is_none() {
            name = Some(part);
        } else {
            targets.push(part.to_string());
        }
    }
    match action {
        "status" => Ok(json!({"action": "status"})),
        "pin" | "unpin" | "archive" | "restore" => {
            let Some(name) = name else {
                return Err(format!("Usage: /curator {action} <skill-name>"));
            };
            Ok(json!({"action": action, "name": name}))
        }
        "consolidate" => {
            let Some(into) = name else {
                return Err("Usage: /curator consolidate <into-skill> <target-skill>...".to_string());
            };
            if targets.len() < 2 {
                return Err("Usage: /curator consolidate <into-skill> <target-skill>...".to_string());
            }
            Ok(json!({"action": "consolidate", "into": into, "targets": targets}))
        }
        _ => Err(
            "Usage: /curator <status|run|pin|unpin|archive|restore|consolidate> [skill-name] [--dry-run]"
                .to_string(),
        ),
    }
}

fn curator_run_input<'a>(
    parts: impl IntoIterator<Item = &'a str>,
) -> Result<serde_json::Value, String> {
    let mut dry_run = false;
    let mut stale_after_days = None;
    let mut archive_after_days = None;
    let mut include_non_agent_created = false;
    let mut include_bundled = false;
    let mut iter = parts.into_iter();
    while let Some(part) = iter.next() {
        match part {
            "--dry-run" => dry_run = true,
            "--include-non-agent-created" => include_non_agent_created = true,
            "--include-bundled" => include_bundled = true,
            "--stale-after-days" => {
                stale_after_days =
                    Some(parse_curator_days_flag("--stale-after-days", iter.next())?);
            }
            "--archive-after-days" => {
                archive_after_days = Some(parse_curator_days_flag(
                    "--archive-after-days",
                    iter.next(),
                )?);
            }
            value if value.starts_with("--stale-after-days=") => {
                stale_after_days = Some(parse_curator_days_value(
                    "--stale-after-days",
                    value.trim_start_matches("--stale-after-days="),
                )?);
            }
            value if value.starts_with("--archive-after-days=") => {
                archive_after_days = Some(parse_curator_days_value(
                    "--archive-after-days",
                    value.trim_start_matches("--archive-after-days="),
                )?);
            }
            value if value.starts_with("--") => return Err(curator_run_usage()),
            _ => return Err(curator_run_usage()),
        }
    }

    let mut input = json!({"action": "run", "dry_run": dry_run});
    if let Some(days) = stale_after_days {
        input["stale_after_days"] = json!(days);
    }
    if let Some(days) = archive_after_days {
        input["archive_after_days"] = json!(days);
    }
    if include_non_agent_created {
        input["include_non_agent_created"] = json!(true);
    }
    if include_bundled {
        input["include_bundled"] = json!(true);
    }
    Ok(input)
}

fn parse_curator_days_flag(flag: &str, value: Option<&str>) -> Result<i64, String> {
    let Some(value) = value else {
        return Err(curator_run_usage());
    };
    parse_curator_days_value(flag, value)
}

fn parse_curator_days_value(flag: &str, value: &str) -> Result<i64, String> {
    value
        .parse::<i64>()
        .map_err(|_| format!("{flag} must be a number"))
}

fn curator_run_usage() -> String {
    "Usage: /curator run [--dry-run] [--stale-after-days N] [--archive-after-days N] [--include-non-agent-created] [--include-bundled]".to_string()
}

fn bundled_skills_input(args: &str) -> Result<serde_json::Value, String> {
    let mut action = "status";
    let mut dry_run = false;
    let mut force = false;
    for part in args.split_whitespace() {
        match part {
            "status" | "sync" => action = part,
            "--dry-run" => dry_run = true,
            "--force" => force = true,
            _ => return Err(bundled_skills_usage()),
        }
    }
    let action = if action == "status" {
        "sync_status"
    } else {
        "sync"
    };
    Ok(json!({"action": action, "dry_run": dry_run, "force": force}))
}

fn bundled_skills_usage() -> String {
    "Usage: /skill-sync <status|sync> [--dry-run] [--force]".to_string()
}

fn skills_hub_input(args: &str) -> Result<serde_json::Value, String> {
    let mut parts = args.splitn(2, char::is_whitespace);
    let action = parts.next().unwrap_or("list").trim();
    let rest = parts.next().unwrap_or("").trim();
    match action {
        "" | "list" => {
            let (positionals, scope) = parse_hub_scope_args(rest)?;
            if !positionals.is_empty() {
                return Err(hub_usage());
            }
            let mut input = json!({"action": "list"});
            apply_hub_scope(&mut input, scope);
            Ok(input)
        }
        "search" => {
            let (positionals, scope) = parse_hub_scope_args(rest)?;
            let mut input = json!({"action": "search", "query": positionals.join(" ")});
            apply_hub_scope(&mut input, scope);
            Ok(input)
        }
        "install" => skills_hub_install_input(rest),
        "uninstall" => {
            let (positionals, scope) = parse_hub_scope_args(rest)?;
            if positionals.len() != 1 {
                return Err(
                    "Usage: /skills-hub uninstall [--user|--project] <skill-name>".to_string(),
                );
            }
            let mut input = json!({"action": "uninstall", "name": positionals[0]});
            apply_hub_scope(&mut input, scope);
            Ok(input)
        }
        _ => Err(hub_usage()),
    }
}

fn skills_hub_install_input(rest: &str) -> Result<serde_json::Value, String> {
    if rest.is_empty() {
        return Err(hub_install_usage());
    }
    let (positionals, flags) = parse_hub_install_args(rest)?;
    if positionals.first().copied() == Some("github") {
        if positionals.len() < 3 || positionals.len() > 4 {
            return Err(hub_install_usage());
        }
        let repo = positionals[1];
        let path = positionals[2];
        let mut input = json!({
            "action": "install",
            "source": "github",
            "repo": repo,
            "path": path
        });
        if let Some(git_ref) = positionals.get(3) {
            input["ref"] = json!(git_ref);
        }
        apply_hub_install_flags(&mut input, flags);
        Ok(input)
    } else {
        if positionals.len() != 1 {
            return Err(hub_install_usage());
        }
        let mut input = json!({"action": "install", "source": "url", "url": positionals[0]});
        apply_hub_install_flags(&mut input, flags);
        Ok(input)
    }
}

#[derive(Debug, Default)]
struct HubInstallFlags {
    scope: Option<&'static str>,
    force: bool,
    trust_level: Option<&'static str>,
    allow_medium_risk: bool,
    allow_high_risk: bool,
}

fn parse_hub_install_args(rest: &str) -> Result<(Vec<&str>, HubInstallFlags), String> {
    let mut positionals = Vec::new();
    let mut flags = HubInstallFlags::default();
    for part in rest.split_whitespace() {
        match part {
            "--user" | "--scope=user" => set_hub_scope(&mut flags.scope, "user")?,
            "--project" | "--scope=project" => set_hub_scope(&mut flags.scope, "project")?,
            "--force" => flags.force = true,
            "--trusted" => flags.trust_level = Some("trusted"),
            "--community" => flags.trust_level = Some("community"),
            "--allow-medium-risk" => flags.allow_medium_risk = true,
            "--allow-high-risk" => flags.allow_high_risk = true,
            value if value == "--trust=trusted" || value == "--trust-level=trusted" => {
                flags.trust_level = Some("trusted");
            }
            value if value == "--trust=community" || value == "--trust-level=community" => {
                flags.trust_level = Some("community");
            }
            value if value.starts_with("--") => return Err(hub_install_usage()),
            value => positionals.push(value),
        }
    }
    Ok((positionals, flags))
}

fn apply_hub_install_flags(input: &mut serde_json::Value, flags: HubInstallFlags) {
    apply_hub_scope(input, flags.scope);
    if flags.force {
        input["force"] = json!(true);
    }
    if let Some(trust_level) = flags.trust_level {
        input["trust_level"] = json!(trust_level);
    }
    if flags.allow_medium_risk {
        input["allow_medium_risk"] = json!(true);
    }
    if flags.allow_high_risk {
        input["allow_high_risk"] = json!(true);
    }
}

fn parse_hub_scope_args(rest: &str) -> Result<(Vec<&str>, Option<&'static str>), String> {
    let mut positionals = Vec::new();
    let mut scope = None;
    for part in rest.split_whitespace() {
        match part {
            "--user" | "--scope=user" => set_hub_scope(&mut scope, "user")?,
            "--project" | "--scope=project" => set_hub_scope(&mut scope, "project")?,
            value if value.starts_with("--") => return Err(hub_usage()),
            value => positionals.push(value),
        }
    }
    Ok((positionals, scope))
}

fn set_hub_scope(scope: &mut Option<&'static str>, value: &'static str) -> Result<(), String> {
    if scope.is_some_and(|current| current != value) {
        return Err("/skills-hub accepts only one of --user or --project".to_string());
    }
    *scope = Some(value);
    Ok(())
}

fn apply_hub_scope(input: &mut serde_json::Value, scope: Option<&str>) {
    if let Some(scope) = scope {
        input["scope"] = json!(scope);
    }
}

fn hub_install_usage() -> String {
    "Usage: /skills-hub install [--user|--project] [--force] [--trusted|--community] [--allow-medium-risk] [--allow-high-risk] <raw-skill-url|local-path> OR /skills-hub install github <owner/repo> <path> [ref] [flags]".to_string()
}

fn hub_usage() -> String {
    "Usage: /skills-hub <list|search|install|uninstall> [--user|--project] [query|url|skill-name]"
        .to_string()
}

async fn call_tool<T>(app: &mut ReplApp, engine: &QueryEngine, tool: T, input: serde_json::Value)
where
    T: Tool,
{
    let (external_skill_dirs, trust_external_skills, skill_guard_policy, auto_lessons_learned) = {
        let settings = engine.settings.read().unwrap();
        (
            settings.skills.external_dirs.clone(),
            settings.skills.trust_external,
            SkillGuardPolicy {
                enabled: settings.skills.guard.enabled,
                block_high_risk: settings.skills.guard.block_high_risk,
                block_medium_risk_for_community: settings
                    .skills
                    .guard
                    .block_medium_risk_for_community,
            },
            settings.skills.auto_lessons_learned,
        )
    };
    let ctx = ToolContext::new(engine.state.clone())
        .with_skill_registry(Arc::clone(&engine.skill_registry))
        .with_active_skills(Arc::clone(&engine.active_skills))
        .with_external_skill_dirs(external_skill_dirs)
        .with_trust_external_skills(trust_external_skills)
        .with_skill_guard_policy(skill_guard_policy)
        .with_auto_lessons_learned(auto_lessons_learned);
    match tool.call(input, &ctx).await {
        Ok(output) => {
            let text = output
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            app.push_message(MessageRole::System, text);
        }
        Err(error) => app.push_message(MessageRole::System, format!("Error: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
    use kcoder_config::Settings;
    use kcoder_memory::{MemoryManager, MemoryStore};
    use kcoder_permissions::PermissionEngine;
    use kcoder_skills::SkillRegistry;
    use kcoder_state::AppState;
    use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
    use kcoder_types::MessagesRequest;
    use std::path::Path;
    use std::sync::Arc;

    #[test]
    fn skill_lifecycle_slash_inputs_match_tools() {
        assert_eq!(
            skill_telemetry_input("").unwrap(),
            json!({"action": "usage"})
        );
        assert_eq!(
            skill_telemetry_input("list").unwrap(),
            json!({"action": "usage"})
        );
        assert_eq!(
            skill_telemetry_input("demo").unwrap(),
            json!({"action": "usage", "name": "demo"})
        );
        assert_eq!(
            skill_telemetry_input("view demo").unwrap(),
            json!({"action": "usage", "name": "demo"})
        );
        assert_eq!(
            skill_telemetry_input("pin demo").unwrap(),
            json!({"action": "pin", "name": "demo"})
        );
        assert_eq!(
            skill_telemetry_input("unpin demo").unwrap(),
            json!({"action": "unpin", "name": "demo"})
        );
        assert_eq!(
            skill_telemetry_input("mark-state demo stale").unwrap(),
            json!({"action": "mark_state", "name": "demo", "state": "stale"})
        );
        assert_eq!(
            skill_telemetry_input("score-quality demo").unwrap(),
            json!({"action": "score_quality", "name": "demo"})
        );
        assert_eq!(
            skill_telemetry_input("score-quality").unwrap(),
            json!({"action": "score_quality"})
        );
        assert_eq!(curator_input("").unwrap(), json!({"action": "status"}));
        assert_eq!(
            curator_input("run --dry-run").unwrap(),
            json!({"action": "run", "dry_run": true})
        );
        assert_eq!(
            curator_input(
                "run --dry-run --stale-after-days 0 --archive-after-days=7 --include-non-agent-created --include-bundled"
            )
            .unwrap(),
            json!({
                "action": "run",
                "dry_run": true,
                "stale_after_days": 0,
                "archive_after_days": 7,
                "include_non_agent_created": true,
                "include_bundled": true
            })
        );
        assert_eq!(
            curator_input("pin demo").unwrap(),
            json!({"action": "pin", "name": "demo"})
        );
        assert_eq!(
            curator_input("consolidate umbrella alpha beta").unwrap(),
            json!({"action": "consolidate", "into": "umbrella", "targets": ["alpha", "beta"]})
        );
        assert_eq!(
            bundled_skills_input("sync --dry-run --force").unwrap(),
            json!({"action": "sync", "dry_run": true, "force": true})
        );
        assert_eq!(skills_hub_input("").unwrap(), json!({"action": "list"}));
        assert_eq!(
            skills_hub_input("list --user").unwrap(),
            json!({"action": "list", "scope": "user"})
        );
        assert_eq!(
            skills_hub_input("search --user anthropic").unwrap(),
            json!({"action": "search", "query": "anthropic", "scope": "user"})
        );
        assert_eq!(
            skills_hub_input("install https://example.test/SKILL.md").unwrap(),
            json!({"action": "install", "source": "url", "url": "https://example.test/SKILL.md"})
        );
        assert_eq!(
            skills_hub_input(
                "install --force --trusted --allow-medium-risk https://example.test/SKILL.md"
            )
            .unwrap(),
            json!({
                "action": "install",
                "source": "url",
                "url": "https://example.test/SKILL.md",
                "force": true,
                "trust_level": "trusted",
                "allow_medium_risk": true
            })
        );
        assert_eq!(
            skills_hub_input("install github owner/repo skills/demo main").unwrap(),
            json!({"action": "install", "source": "github", "repo": "owner/repo", "path": "skills/demo", "ref": "main"})
        );
        assert_eq!(
            skills_hub_input(
                "install github owner/repo skills/demo main --user --force --community --allow-high-risk"
            )
            .unwrap(),
            json!({
                "action": "install",
                "source": "github",
                "repo": "owner/repo",
                "path": "skills/demo",
                "ref": "main",
                "scope": "user",
                "force": true,
                "trust_level": "community",
                "allow_high_risk": true
            })
        );
        assert_eq!(
            skills_hub_input("uninstall --user demo").unwrap(),
            json!({"action": "uninstall", "name": "demo", "scope": "user"})
        );
    }

    #[test]
    fn skill_lifecycle_slash_inputs_report_usage_errors() {
        assert!(
            skill_telemetry_input("list extra")
                .unwrap_err()
                .contains("/skill-usage")
        );
        assert!(
            skill_telemetry_input("view")
                .unwrap_err()
                .contains("/skill-usage")
        );
        assert!(
            skill_telemetry_input("mark-state demo unknown")
                .unwrap_err()
                .contains("/skill-usage")
        );
        assert!(
            skill_telemetry_input("score-quality alpha beta")
                .unwrap_err()
                .contains("/skill-usage")
        );
        assert!(curator_input("pin").unwrap_err().contains("/curator pin"));
        assert!(
            curator_input("consolidate umbrella alpha")
                .unwrap_err()
                .contains("consolidate")
        );
        assert!(
            curator_input("run --stale-after-days")
                .unwrap_err()
                .contains("/curator run")
        );
        assert!(
            curator_input("run now")
                .unwrap_err()
                .contains("/curator run")
        );
        assert!(
            bundled_skills_input("syncc")
                .unwrap_err()
                .contains("/skill-sync")
        );
        assert!(
            bundled_skills_input("sync --unknown")
                .unwrap_err()
                .contains("/skill-sync")
        );
        assert!(
            skills_hub_input("install")
                .unwrap_err()
                .contains("/skills-hub install")
        );
        assert!(
            skills_hub_input("install github owner/repo")
                .unwrap_err()
                .contains("install github")
        );
        assert!(
            skills_hub_input("install --unknown https://example.test/SKILL.md")
                .unwrap_err()
                .contains("/skills-hub install")
        );
        assert!(
            skills_hub_input("uninstall")
                .unwrap_err()
                .contains("uninstall")
        );
    }

    #[tokio::test]
    async fn curator_slash_run_executes_tool_and_archives_agent_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder/skills/slash-curated");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: slash-curated\ndescription: Slash curated\n---\n\n# Slash Curated\n\nUse this workflow.",
        )
        .unwrap();
        kcoder_tools::skill_telemetry::record_skill_created(tmp.path(), "slash-curated");
        kcoder_tools::skill_provenance::record_agent_created(tmp.path(), "slash-curated");

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = CuratorCommand
            .run(
                "run --stale-after-days 0 --archive-after-days 0",
                &mut app,
                &engine,
            )
            .await;

        assert_eq!(result, SlashResult::Handled);
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/slash-curated/SKILL.md")
                .is_file()
        );
        assert!(!tmp.path().join(".kcoder/skills/slash-curated").exists());
        let message = app
            .messages
            .last()
            .expect("slash command should report tool output");
        assert_eq!(message.role, MessageRole::System);
        assert!(
            message.text.contains("\"success\": true"),
            "unexpected slash output: {}",
            message.text
        );
        assert!(
            message.text.contains("archive: slash-curated"),
            "unexpected slash output: {}",
            message.text
        );
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(
            usage.skills.get("slash-curated").unwrap().state,
            kcoder_tools::skill_telemetry::SkillState::Archived
        );
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"run\""));
    }

    #[tokio::test]
    async fn curator_slash_manual_lifecycle_actions_execute_tool() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder/skills/slash-lifecycle");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: slash-lifecycle\ndescription: Slash lifecycle\n---\n\n# Slash Lifecycle\n",
        )
        .unwrap();
        kcoder_tools::skill_telemetry::record_skill_created(tmp.path(), "slash-lifecycle");
        kcoder_tools::skill_provenance::record_agent_created(tmp.path(), "slash-lifecycle");

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        assert_eq!(
            CuratorCommand
                .run("pin slash-lifecycle", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert!(usage.skills.get("slash-lifecycle").unwrap().pinned);

        assert_eq!(
            CuratorCommand
                .run("unpin slash-lifecycle", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert!(!usage.skills.get("slash-lifecycle").unwrap().pinned);

        assert_eq!(
            CuratorCommand
                .run("archive slash-lifecycle", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert!(!skill_dir.exists());
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/slash-lifecycle/SKILL.md")
                .is_file()
        );
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(
            usage.skills.get("slash-lifecycle").unwrap().state,
            kcoder_tools::skill_telemetry::SkillState::Archived
        );

        assert_eq!(
            CuratorCommand
                .run("restore slash-lifecycle", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        assert!(skill_dir.join("SKILL.md").is_file());
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(
            usage.skills.get("slash-lifecycle").unwrap().state,
            kcoder_tools::skill_telemetry::SkillState::Active
        );
        let message = app
            .messages
            .last()
            .expect("slash command should report restore output");
        assert_eq!(message.role, MessageRole::System);
        assert!(
            message.text.contains("Skill 'slash-lifecycle' restored"),
            "unexpected slash output: {}",
            message.text
        );
    }

    #[tokio::test]
    async fn bundled_skills_slash_sync_executes_tool_and_writes_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let status = SkillBundledSyncCommand
            .run("status", &mut app, &engine)
            .await;

        assert_eq!(status, SlashResult::Handled);
        assert!(
            !tmp.path()
                .join(".kcoder/skills/using-superpowers/SKILL.md")
                .exists(),
            "status should not install bundled skills"
        );
        assert!(
            !tmp.path().join(".kcoder/skills/.bundled_manifest").exists(),
            "status should not write the bundled manifest"
        );
        let status_message = app
            .messages
            .last()
            .expect("slash command should report status output");
        assert_eq!(status_message.role, MessageRole::System);
        assert!(
            status_message.text.contains("\"success\": true"),
            "unexpected slash output: {}",
            status_message.text
        );
        assert!(
            status_message.text.contains("Skill sync dry-run found"),
            "unexpected slash output: {}",
            status_message.text
        );

        let result = SkillBundledSyncCommand.run("sync", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        assert!(
            tmp.path()
                .join(".kcoder/skills/using-superpowers/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/.bundled_manifest")
                .is_file()
        );
        let message = app
            .messages
            .last()
            .expect("slash command should report tool output");
        assert_eq!(message.role, MessageRole::System);
        assert!(
            message.text.contains("\"success\": true"),
            "unexpected slash output: {}",
            message.text
        );
        assert!(
            message.text.contains("install: using-superpowers"),
            "unexpected slash output: {}",
            message.text
        );

        let provenance =
            kcoder_tools::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let using_superpowers = provenance.skills.get("using-superpowers").unwrap();
        assert_eq!(
            using_superpowers.origin,
            kcoder_tools::skill_provenance::SkillOrigin::Bundled
        );
    }

    #[tokio::test]
    async fn skill_telemetry_slash_view_executes_tool_and_reports_project_counts() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_tools::skill_telemetry::record_skill_view(tmp.path(), "usage-demo");
        kcoder_tools::skill_telemetry::record_skill_use(tmp.path(), "usage-demo");
        kcoder_tools::skill_telemetry::record_skill_use(tmp.path(), "usage-demo");

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = SkillTelemetryCommand
            .run("usage-demo", &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        let message = app
            .messages
            .last()
            .expect("slash command should report tool output");
        assert_eq!(message.role, MessageRole::System);
        let report: serde_json::Value =
            serde_json::from_str(&message.text).unwrap_or_else(|error| {
                panic!(
                    "expected JSON skill usage output, got {error}: {}",
                    message.text
                )
            });
        assert_eq!(report["success"], true);
        assert_eq!(report["scope"], "project");
        assert_eq!(report["usage"]["name"], "usage-demo");
        assert_eq!(report["usage"]["view_count"], 1);
        assert_eq!(report["usage"]["use_count"], 2);
        assert_eq!(report["usage"]["state"], "active");
    }

    #[tokio::test]
    async fn skill_telemetry_slash_list_executes_tool_and_reports_project_records() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_tools::skill_telemetry::record_skill_view(tmp.path(), "usage-alpha");
        kcoder_tools::skill_telemetry::record_skill_use(tmp.path(), "usage-alpha");
        kcoder_tools::skill_telemetry::record_skill_created(tmp.path(), "usage-beta");

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = SkillTelemetryCommand.run("", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        let message = app
            .messages
            .last()
            .expect("slash command should report tool output");
        assert_eq!(message.role, MessageRole::System);
        let report: serde_json::Value =
            serde_json::from_str(&message.text).unwrap_or_else(|error| {
                panic!(
                    "expected JSON skill usage output, got {error}: {}",
                    message.text
                )
            });
        assert_eq!(report["success"], true);
        let skills = report["skills"]
            .as_array()
            .expect("list output should include project skills");
        assert_eq!(skills.len(), 2);
        assert!(skills.iter().any(|skill| {
            skill["name"] == "usage-alpha" && skill["view_count"] == 1 && skill["use_count"] == 1
        }));
        assert!(
            skills
                .iter()
                .any(|skill| { skill["name"] == "usage-beta" && skill["state"] == "active" })
        );
        let records = report["records"]
            .as_array()
            .expect("list output should include source-tagged records");
        assert!(records.iter().any(|record| {
            record["scope"] == "project" && record["usage"]["name"] == "usage-alpha"
        }));
    }

    #[tokio::test]
    async fn skill_telemetry_slash_governance_actions_execute_tool() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder/skills/usage-governed");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: usage-governed\ndescription: Usage governed\n---\n\n# Usage Governed\n\n1. Run `cargo test`.\n2. Run `cargo fmt`.\n3. Verify output.\n",
        )
        .unwrap();
        kcoder_tools::skill_telemetry::record_skill_created(tmp.path(), "usage-governed");

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        assert_eq!(
            SkillTelemetryCommand
                .run("pin usage-governed", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert!(usage.skills.get("usage-governed").unwrap().pinned);

        assert_eq!(
            SkillTelemetryCommand
                .run("mark-state usage-governed stale", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(
            usage.skills.get("usage-governed").unwrap().state,
            kcoder_tools::skill_telemetry::SkillState::Stale
        );

        assert_eq!(
            SkillTelemetryCommand
                .run("unpin usage-governed", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert!(!usage.skills.get("usage-governed").unwrap().pinned);

        assert_eq!(
            SkillTelemetryCommand
                .run("score-quality usage-governed", &mut app, &engine)
                .await,
            SlashResult::Handled
        );
        let message = app
            .messages
            .last()
            .expect("slash command should report score-quality output");
        assert_eq!(message.role, MessageRole::System);
        let report: serde_json::Value = serde_json::from_str(&message.text).unwrap();
        assert_eq!(report["success"], true);
        assert_eq!(report["scored"], json!(["usage-governed"]));
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let quality = usage
            .skills
            .get("usage-governed")
            .unwrap()
            .quality
            .as_ref()
            .expect("score-quality should write quality scores");
        assert!(quality.specificity_score.unwrap_or_default() > 0.0);
    }

    #[tokio::test]
    async fn skills_hub_slash_install_executes_tool_and_records_install() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source-skill");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: slash-demo\ndescription: Slash demo\n---\n\n# Slash Demo\n\nUse this after repeatable work.",
        )
        .unwrap();

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();
        let source_arg = source.display().to_string();

        let result = SkillsHubCommand
            .run(
                &format!("install --trusted {source_arg}"),
                &mut app,
                &engine,
            )
            .await;

        assert_eq!(result, SlashResult::Handled);
        assert!(
            tmp.path()
                .join(".kcoder/skills/slash-demo/SKILL.md")
                .is_file()
        );
        let message = app
            .messages
            .last()
            .expect("slash command should report tool output");
        assert_eq!(message.role, MessageRole::System);
        assert!(
            message.text.contains("\"success\": true"),
            "unexpected slash output: {}",
            message.text
        );
        assert!(
            message.text.contains("Skill 'slash-demo' installed"),
            "unexpected slash output: {}",
            message.text
        );

        let provenance =
            kcoder_tools::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let record = provenance
            .skills
            .get("slash-demo")
            .expect("install should record hub provenance");
        assert_eq!(
            record.origin,
            kcoder_tools::skill_provenance::SkillOrigin::HubInstalled
        );
        assert_eq!(record.installed_from.as_deref(), Some(source_arg.as_str()));
    }

    #[tokio::test]
    async fn skills_hub_slash_blocks_risky_install_without_partial_write() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("risky-source-skill");
        std::fs::create_dir_all(source.join("scripts")).unwrap();
        std::fs::write(
            source.join("SKILL.md"),
            "---\nname: risky-slash-demo\ndescription: Risky slash demo\n---\n\n# Risky Slash Demo\n",
        )
        .unwrap();
        std::fs::write(
            source.join("scripts/install.sh"),
            "#!/usr/bin/env bash\nrm -rf /\n",
        )
        .unwrap();

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();
        let source_arg = source.display().to_string();

        let result = SkillsHubCommand
            .run(&format!("install {source_arg}"), &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        assert!(
            !tmp.path().join(".kcoder/skills/risky-slash-demo").exists(),
            "blocked install should not leave a live skill directory"
        );
        let message = app
            .messages
            .last()
            .expect("slash command should report guard output");
        assert_eq!(message.role, MessageRole::System);
        assert!(
            message.text.contains("\"success\": false"),
            "unexpected slash output: {}",
            message.text
        );
        assert!(
            message.text.contains("skill_guard"),
            "blocked install should mention guard findings: {}",
            message.text
        );
    }

    #[tokio::test]
    async fn skills_hub_slash_list_and_search_execute_tool() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(".kcoder/skills");
        for name in ["slash-hub-alpha", "slash-hub-beta", "slash-user-skill"] {
            let dir = root.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {name}\n---\n\n# {name}\n"),
            )
            .unwrap();
        }
        kcoder_tools::skill_provenance::record_hub_installed(
            tmp.path(),
            "slash-hub-alpha",
            "file:///team-alpha",
        );
        kcoder_tools::skill_provenance::record_hub_installed(
            tmp.path(),
            "slash-hub-beta",
            "file:///team-beta",
        );
        kcoder_tools::skill_provenance::record_user_created(tmp.path(), "slash-user-skill");
        kcoder_tools::skill_provenance::record_hub_installed(
            tmp.path(),
            "slash-missing-hub",
            "file:///missing",
        );

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = SkillsHubCommand.run("list", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        let list_report: serde_json::Value = serde_json::from_str(
            &app.messages
                .last()
                .expect("slash command should report list output")
                .text,
        )
        .unwrap();
        assert_eq!(list_report["success"], true);
        let listed = list_report["skills"].as_array().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(
            listed
                .iter()
                .any(|skill| skill["name"] == "slash-hub-alpha")
        );
        assert!(listed.iter().any(|skill| skill["name"] == "slash-hub-beta"));
        assert!(
            !listed
                .iter()
                .any(|skill| skill["name"] == "slash-user-skill")
        );
        assert!(
            !listed
                .iter()
                .any(|skill| skill["name"] == "slash-missing-hub")
        );

        let result = SkillsHubCommand
            .run("search team-alpha", &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        let search_report: serde_json::Value = serde_json::from_str(
            &app.messages
                .last()
                .expect("slash command should report search output")
                .text,
        )
        .unwrap();
        assert_eq!(search_report["success"], true);
        let searched = search_report["skills"].as_array().unwrap();
        assert_eq!(searched.len(), 1);
        assert_eq!(searched[0]["name"], "slash-hub-alpha");
    }

    #[tokio::test]
    async fn skills_hub_slash_uninstall_executes_tool_and_archives_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder/skills/slash-uninstall");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: slash-uninstall\ndescription: Slash uninstall\n---\n\n# Slash Uninstall\n",
        )
        .unwrap();
        kcoder_tools::skill_provenance::record_hub_installed(
            tmp.path(),
            "slash-uninstall",
            "file:///slash-uninstall",
        );
        kcoder_tools::skill_telemetry::record_skill_created(tmp.path(), "slash-uninstall");

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = SkillsHubCommand
            .run("uninstall slash-uninstall", &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        assert!(!skill_dir.exists());
        let archive_root = tmp.path().join(".kcoder/skills/.archive");
        let archived = std::fs::read_dir(archive_root)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("slash-uninstall.uninstalled.")
                    && entry.path().join("SKILL.md").is_file()
            });
        assert!(archived, "uninstall should archive the hub skill directory");
        let message = app
            .messages
            .last()
            .expect("slash command should report tool output");
        assert_eq!(message.role, MessageRole::System);
        assert!(
            message.text.contains("\"success\": true"),
            "unexpected slash output: {}",
            message.text
        );
        assert!(
            message.text.contains("Skill 'slash-uninstall' uninstalled"),
            "unexpected slash output: {}",
            message.text
        );
        let usage = kcoder_tools::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(
            usage.skills.get("slash-uninstall").unwrap().state,
            kcoder_tools::skill_telemetry::SkillState::Archived
        );
    }

    fn test_engine(cwd: &Path) -> QueryEngine {
        let settings = Settings::default();
        QueryEngine::new(
            Arc::new(EmptyProvider),
            AppState::new(cwd),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::load(cwd).unwrap(),
            Arc::new(DenyAllUserQuestioner),
            cwd.to_path_buf(),
        )
    }

    struct EmptyProvider;

    impl Provider for EmptyProvider {
        fn name(&self) -> &'static str {
            "empty"
        }

        fn stream_messages(
            &self,
            _request: MessagesRequest,
        ) -> Result<ProviderStream, ApiErrorKind> {
            Ok(Box::pin(futures::stream::empty()))
        }
    }
}
