use crate::{ReplApp, ResumeSessionEntry};
use kcoder_config::Settings;
use kcoder_engine::QueryEngine;
use kcoder_state::{
    load_history, prune_session_history, recent_session_candidates, session_first_prompt,
};
use kcoder_types::MessageRole;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use super::{SlashCommand, SlashResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionDiscoveryScope {
    SameRepo,
    AllProjects,
}

#[derive(Debug, Clone)]
struct RecentSession {
    session_id: String,
    path: PathBuf,
    message_count: usize,
    preview: Option<String>,
}

fn legacy_history_override_enabled(settings: &Settings) -> bool {
    settings.history_directory.is_some() || std::env::var_os("KCODER_HISTORY_DIR").is_some()
}

fn push_unique_dir(dirs: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, dir: PathBuf) {
    if seen.insert(dir.clone()) {
        dirs.push(dir);
    }
}

fn session_project_dirs_for_path(path: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    for dir in Settings::project_data_dirs_for_read(path)? {
        push_unique_dir(&mut dirs, &mut seen, dir);
    }
    Ok(dirs)
}

fn project_dir_key(dir: &Path) -> Option<String> {
    dir.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
}

fn session_project_key_prefixes(path: &Path) -> anyhow::Result<Vec<(String, &'static str)>> {
    let mut prefixes = Vec::new();
    let legacy = Settings::legacy_project_data_dir(path)?;
    for dir in Settings::project_data_dirs_for_read(path)? {
        if let Some(key) = project_dir_key(&dir) {
            let separator = if dir == legacy { "_" } else { "-" };
            if !prefixes.iter().any(|(existing, _)| existing == &key) {
                prefixes.push((key, separator));
            }
        }
    }
    Ok(prefixes)
}

fn push_project_dirs_matching_prefixes(
    dirs: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
    prefixes: &[(String, &'static str)],
) -> anyhow::Result<()> {
    let projects_dir = Settings::projects_dir()?;
    if !projects_dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(projects_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        let matches_prefix = prefixes.iter().any(|(prefix, separator)| {
            name == *prefix || name.starts_with(&format!("{prefix}{separator}"))
        });
        if matches_prefix {
            push_unique_dir(dirs, seen, entry.path());
        }
    }
    Ok(())
}

fn git_worktree_paths(cwd: &Path) -> Vec<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["worktree", "list", "--porcelain"])
        .output();
    let Ok(output) = output else {
        return vec![cwd.to_path_buf()];
    };
    if !output.status.success() {
        return vec![cwd.to_path_buf()];
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut paths = Vec::new();
    for line in stdout.lines() {
        let Some(path) = line.strip_prefix("worktree ") else {
            continue;
        };
        paths.push(PathBuf::from(path));
    }
    if paths.is_empty() {
        paths.push(cwd.to_path_buf());
    }
    paths
}

fn same_repo_session_dirs(cwd: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    for dir in session_project_dirs_for_path(cwd)? {
        push_unique_dir(&mut dirs, &mut seen, dir);
    }
    for path in git_worktree_paths(cwd) {
        for dir in session_project_dirs_for_path(&path)? {
            push_unique_dir(&mut dirs, &mut seen, dir);
        }
        let prefixes = session_project_key_prefixes(&path)?;
        push_project_dirs_matching_prefixes(&mut dirs, &mut seen, &prefixes)?;
    }
    Ok(dirs)
}

fn all_project_session_dirs() -> anyhow::Result<Vec<PathBuf>> {
    let projects_dir = Settings::projects_dir()?;
    let mut dirs = Vec::new();
    if !projects_dir.is_dir() {
        return Ok(dirs);
    }
    for entry in fs::read_dir(projects_dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            dirs.push(path);
        }
    }
    Ok(dirs)
}

fn session_discovery_dirs(
    settings: &Settings,
    cwd: &Path,
    scope: SessionDiscoveryScope,
) -> anyhow::Result<Vec<PathBuf>> {
    if legacy_history_override_enabled(settings) {
        return settings.history_dir().map(|dir| vec![dir]);
    }
    match scope {
        SessionDiscoveryScope::SameRepo => same_repo_session_dirs(cwd),
        SessionDiscoveryScope::AllProjects => all_project_session_dirs(),
    }
}

fn modified_time(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn recent_sessions_in_dirs(dirs: &[PathBuf], limit: usize) -> anyhow::Result<Vec<RecentSession>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    for dir in dirs {
        candidates.extend(recent_session_candidates(dir)?);
    }
    candidates.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.1.cmp(&a.1)));

    let mut accepted_ids = HashSet::new();
    let mut sessions = Vec::with_capacity(limit.min(candidates.len()));
    for (session_id, path, _) in candidates {
        if accepted_ids.contains(&session_id) {
            continue;
        }
        let message_count = match load_history(&path) {
            Ok(entries) if !entries.is_empty() => entries.len(),
            Ok(_) => continue,
            Err(error) => {
                tracing::warn!(?path, %error, "failed to read session history candidate");
                continue;
            }
        };
        accepted_ids.insert(session_id.clone());
        // /resume picker labels show the first user prompt, capped at 36 chars
        // (the helper appends an ellipsis when the prompt is longer).
        let preview = session_first_prompt(&path, 36);
        sessions.push(RecentSession {
            session_id,
            path,
            message_count,
            preview,
        });
        if sessions.len() == limit {
            break;
        }
    }
    Ok(sessions)
}

fn find_session_path_in_dirs(session_id: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let mut matches: Vec<(PathBuf, SystemTime)> = dirs
        .iter()
        .map(|dir| {
            dir.join(format!(
                "{}.jsonl",
                kcoder_state::artifact_id_path_component(session_id)
            ))
        })
        .filter(|path| path.is_file())
        .map(|path| {
            let modified = modified_time(&path);
            (path, modified)
        })
        .collect();
    matches.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    matches.into_iter().next().map(|(path, _)| path)
}

fn find_resume_session_path(
    settings: &Settings,
    cwd: &Path,
    scope: SessionDiscoveryScope,
    session_id: &str,
) -> anyhow::Result<Option<PathBuf>> {
    let dirs = session_discovery_dirs(settings, cwd, scope)?;
    Ok(find_session_path_in_dirs(session_id, &dirs))
}

fn resume_target_looks_like_path(target: &str) -> bool {
    let path = Path::new(target);
    path.is_absolute() || target.starts_with('.') || target.contains('/') || target.contains('\\')
}

fn normalize_resume_history_path(cwd: &Path, target: &str) -> anyhow::Result<PathBuf> {
    let path = PathBuf::from(target);
    let path = if path.extension().is_none() {
        path.with_extension("jsonl")
    } else {
        path
    };
    if path.is_absolute() {
        Ok(path)
    } else {
        anyhow::ensure!(
            !path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir)),
            "relative resume path must not escape the current workspace"
        );
        Ok(cwd.join(path))
    }
}

fn resolve_resume_session_path(
    settings: &Settings,
    cwd: &Path,
    scope: SessionDiscoveryScope,
    target: &str,
) -> anyhow::Result<Option<PathBuf>> {
    if target.ends_with(".jsonl") || resume_target_looks_like_path(target) {
        return Ok(Some(normalize_resume_history_path(cwd, target)?));
    }
    find_resume_session_path(settings, cwd, scope, target)
}

fn parse_scope_arg(args: &str) -> (SessionDiscoveryScope, &str) {
    let trimmed = args.trim();
    if let Some(rest) = trimmed.strip_prefix("--all")
        && (rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace))
    {
        return (SessionDiscoveryScope::AllProjects, rest.trim());
    }
    if let Some(rest) = trimmed.strip_prefix("-a")
        && (rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace))
    {
        return (SessionDiscoveryScope::AllProjects, rest.trim());
    }
    (SessionDiscoveryScope::SameRepo, trimmed)
}

#[derive(Default)]
pub(super) struct ExportCommand;

#[async_trait::async_trait]
impl SlashCommand for ExportCommand {
    fn name(&self) -> &'static str {
        "/export"
    }
    fn description(&self) -> &'static str {
        "Export the current conversation and state to a JSON file."
    }
    fn usage(&self) -> &'static str {
        "/export [path]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let path = if args.trim().is_empty() {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            engine
                .cwd
                .join(".kcoder")
                .join("exports")
                .join(format!("session-{}.json", timestamp))
        } else {
            engine.cwd.join(args.trim())
        };

        match engine.state.export_snapshot(&path) {
            Ok(()) => {
                app.push_message(
                    MessageRole::System,
                    format!("Exported session snapshot to {}", path.display()),
                );
            }
            Err(e) => {
                app.push_message(MessageRole::System, format!("Export failed: {}", e));
            }
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct ImportCommand;

#[async_trait::async_trait]
impl SlashCommand for ImportCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/import"
    }
    fn description(&self) -> &'static str {
        "Import a conversation and state from a JSON snapshot file."
    }
    fn usage(&self) -> &'static str {
        "/import <path>"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let path = args.trim();
        if path.is_empty() {
            app.push_message(MessageRole::System, "Usage: /import <path>".to_string());
            return SlashResult::Handled;
        }
        let path = engine.cwd.join(path);
        match engine.state.import_snapshot(&path) {
            Ok(count) => {
                let messages = engine.state.messages();
                app.replace_transcript_from_history(&messages);
                app.plan_mode = engine.state.plan_mode();
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Imported session snapshot from {} ({} messages).",
                        path.display(),
                        count
                    ),
                );
                app.snap_to_bottom();
            }
            Err(e) => {
                app.push_message(MessageRole::System, format!("Import failed: {}", e));
            }
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct DebugCommand;

#[async_trait::async_trait]
impl SlashCommand for DebugCommand {
    fn name(&self) -> &'static str {
        "/debug"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/debug-config"]
    }
    fn description(&self) -> &'static str {
        "Dump a debug snapshot of the current session to a file."
    }
    fn usage(&self) -> &'static str {
        "/debug [path]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let path = if args.trim().is_empty() {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            engine
                .cwd
                .join(".kcoder")
                .join("debug")
                .join(format!("debug-{}.json", timestamp))
        } else {
            engine.cwd.join(args.trim())
        };

        match engine.state.export_snapshot(&path) {
            Ok(()) => {
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Debug snapshot written to {} ({} messages, {} todos, {} tasks).",
                        path.display(),
                        engine.state.messages().len(),
                        engine.state.todos().len(),
                        engine.state.tasks().len()
                    ),
                );
            }
            Err(e) => {
                app.push_message(MessageRole::System, format!("Debug dump failed: {}", e));
            }
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct SessionsCommand;

#[async_trait::async_trait]
impl SlashCommand for SessionsCommand {
    fn name(&self) -> &'static str {
        "/sessions"
    }
    fn description(&self) -> &'static str {
        "List or prune recent sessions."
    }
    fn usage(&self) -> &'static str {
        "/sessions [limit]\n/sessions --all [limit]\n/sessions prune <keep>"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let trimmed = args.trim();
        let mut parts = trimmed.split_whitespace();
        if parts.next() == Some("prune") {
            let keep = match parts.next().and_then(|value| value.parse::<usize>().ok()) {
                Some(value) if value > 0 => value,
                _ => {
                    app.push_message(
                        MessageRole::System,
                        "Usage: /sessions prune <keep>".to_string(),
                    );
                    return SlashResult::Handled;
                }
            };
            let settings = engine.settings.read().unwrap().clone();
            let cwd = engine.state.base_cwd();
            match session_discovery_dirs(&settings, &cwd, SessionDiscoveryScope::SameRepo) {
                Ok(dirs) => {
                    let mut kept_sessions = 0usize;
                    let mut deleted_sessions = 0usize;
                    let mut deleted_files = 0usize;
                    let mut failed = None;
                    for dir in dirs {
                        match prune_session_history(&dir, keep) {
                            Ok(report) => {
                                kept_sessions += report.kept_sessions;
                                deleted_sessions += report.deleted_sessions;
                                deleted_files += report.deleted_files.len();
                            }
                            Err(e) => {
                                failed = Some(e);
                                break;
                            }
                        }
                    }
                    if let Some(e) = failed {
                        app.push_message(
                            MessageRole::System,
                            format!("Failed to prune sessions: {}", e),
                        );
                    } else {
                        app.push_message(
                            MessageRole::System,
                            format!(
                                "Pruned {} old session(s); kept {} latest session(s); removed {} file(s).",
                                deleted_sessions, kept_sessions, deleted_files
                            ),
                        );
                    }
                }
                Err(e) => app.push_message(
                    MessageRole::System,
                    format!("Session directory unavailable: {}", e),
                ),
            }
            return SlashResult::Handled;
        }

        let (scope, rest) = parse_scope_arg(trimmed);
        let limit: usize = rest.parse().unwrap_or(10);
        let settings = engine.settings.read().unwrap().clone();
        let cwd = engine.state.base_cwd();
        match session_discovery_dirs(&settings, &cwd, scope) {
            Ok(dirs) => match recent_sessions_in_dirs(&dirs, limit) {
                Ok(sessions) if sessions.is_empty() => {
                    app.push_message(MessageRole::System, "No previous sessions found.");
                }
                Ok(sessions) => {
                    let lines: Vec<String> = sessions
                        .iter()
                        .map(|session| {
                            format!(
                                "{}  ({} messages)  {}",
                                session.session_id,
                                session.message_count,
                                session.preview.as_deref().unwrap_or("?")
                            )
                        })
                        .collect();
                    app.push_message(
                        MessageRole::System,
                        format!("Recent sessions:\n{}", lines.join("\n")),
                    );
                }
                Err(e) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Failed to list sessions: {}", e),
                    );
                }
            },
            Err(e) => {
                app.push_message(
                    MessageRole::System,
                    format!("Session directory unavailable: {}", e),
                );
            }
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct ResumeCommand;

#[async_trait::async_trait]
impl SlashCommand for ResumeCommand {
    fn name(&self) -> &'static str {
        "/resume"
    }
    fn description(&self) -> &'static str {
        "Resume a previous session."
    }
    fn usage(&self) -> &'static str {
        "/resume [--all] [session-id]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let (scope, target) = parse_scope_arg(args);
        let settings = engine.settings.read().unwrap().clone();
        let cwd = engine.state.base_cwd();

        if target.is_empty() {
            let session_dirs = match session_discovery_dirs(&settings, &cwd, scope) {
                Ok(dirs) => dirs,
                Err(e) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Session directory unavailable: {}", e),
                    );
                    return SlashResult::Handled;
                }
            };
            match recent_sessions_in_dirs(&session_dirs, 50) {
                Ok(sessions) if sessions.is_empty() => {
                    app.push_message(MessageRole::System, "No previous session to resume.");
                    return SlashResult::Handled;
                }
                Ok(sessions) => {
                    let current_session_id = engine.state.artifact_session_id();
                    let entries: Vec<ResumeSessionEntry> = sessions
                        .into_iter()
                        .filter(|session| session.session_id != current_session_id)
                        .map(|session| ResumeSessionEntry {
                            session_id: session.session_id,
                            path: session.path,
                            message_count: session.message_count,
                            preview: session.preview,
                        })
                        .collect();
                    if entries.is_empty() {
                        app.push_message(MessageRole::System, "No previous session to resume.");
                        return SlashResult::Handled;
                    }
                    app.open_resume_session_picker(entries);
                    return SlashResult::Handled;
                }
                Err(e) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Failed to find session: {}", e),
                    );
                    return SlashResult::Handled;
                }
            }
        }

        let path = match resolve_resume_session_path(&settings, &cwd, scope, target) {
            Ok(Some(path)) => path,
            Ok(None) => {
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Session history not found for {target}. Run /resume without arguments to browse same-project sessions, or /resume --all to browse all projects."
                    ),
                );
                return SlashResult::Handled;
            }
            Err(e) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to find session: {}", e),
                );
                return SlashResult::Handled;
            }
        };

        if !path.exists() {
            app.push_message(
                MessageRole::System,
                format!("Session history not found: {}", path.display()),
            );
            return SlashResult::Handled;
        }

        crate::resume_session_from_history_path(&path, engine, app);
        SlashResult::Handled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_absolute_jsonl_resume_path_verbatim() {
        let settings = Settings::default();
        let cwd = Path::new("/workspace");
        let target = "/root/.config/kcoder/history/1783475084624.jsonl";

        let resolved =
            resolve_resume_session_path(&settings, cwd, SessionDiscoveryScope::SameRepo, target)
                .unwrap();

        assert_eq!(resolved, Some(PathBuf::from(target)));
    }

    #[test]
    fn resolve_absolute_resume_path_adds_jsonl_suffix() {
        let settings = Settings::default();
        let cwd = Path::new("/workspace");
        let target = "/root/.config/kcoder/projects/_workspace_project/1783577470834";

        let resolved =
            resolve_resume_session_path(&settings, cwd, SessionDiscoveryScope::SameRepo, target)
                .unwrap();

        assert_eq!(resolved, Some(PathBuf::from(format!("{target}.jsonl"))));
    }

    #[test]
    fn resolve_relative_jsonl_resume_path_against_cwd() {
        let settings = Settings::default();
        let cwd = Path::new("/workspace");

        let resolved = resolve_resume_session_path(
            &settings,
            cwd,
            SessionDiscoveryScope::SameRepo,
            "sessions/demo.jsonl",
        )
        .unwrap();

        assert_eq!(
            resolved,
            Some(PathBuf::from("/workspace/sessions/demo.jsonl"))
        );

        assert!(
            resolve_resume_session_path(
                &settings,
                cwd,
                SessionDiscoveryScope::SameRepo,
                "../../outside.jsonl",
            )
            .is_err()
        );
    }

    #[test]
    fn resolve_bare_session_id_uses_history_directory_lookup() {
        let tmp = tempfile::tempdir().unwrap();
        let history_path = tmp.path().join("1783475084624.jsonl");
        fs::write(&history_path, "").unwrap();
        let settings = Settings {
            history_directory: Some(tmp.path().to_path_buf()),
            ..Settings::default()
        };

        let resolved = resolve_resume_session_path(
            &settings,
            Path::new("/workspace"),
            SessionDiscoveryScope::SameRepo,
            "1783475084624",
        )
        .unwrap();

        assert_eq!(resolved, Some(history_path));
    }
}
