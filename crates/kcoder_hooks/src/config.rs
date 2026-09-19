use crate::types::{HookEvent, HookMatcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{debug, warn};

/// Raw hooks section from a settings file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HooksSettings {
    #[serde(flatten)]
    events: HashMap<String, Vec<HookMatcher>>,
}

impl HooksSettings {
    /// Convert the string-keyed map into typed `(HookEvent, HookMatcher)` pairs.
    /// Unknown event names are ignored with a warning.
    pub fn into_matchers(self) -> Vec<(HookEvent, HookMatcher)> {
        let mut matchers = Vec::new();
        for (name, list) in self.events {
            match parse_hook_event(&name) {
                Some(event) => {
                    for matcher in list {
                        matchers.push((event, matcher));
                    }
                }
                None => {
                    warn!("ignoring unknown hook event name: {}", name);
                }
            }
        }
        matchers
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

fn parse_hook_event(name: &str) -> Option<HookEvent> {
    HookEvent::parse(name)
}

/// Discover hook settings from known locations.
///
/// KCoder uses `.kcoder/settings.json` (and `.kcoder/settings.local.json`).
pub fn discover_hooks(cwd: &Path) -> HooksSettings {
    discover_hooks_with_trust(cwd, true)
}

/// Trust-aware variant: when `project_trusted` is false, project-level hook
/// files are skipped (a repo cannot smuggle executable hooks into a session
/// merely by being opened) while user-level hooks always load.
pub fn discover_hooks_with_trust(cwd: &Path, project_trusted: bool) -> HooksSettings {
    let mut combined = HooksSettings::default();

    let user_path = user_settings_path();
    if let Ok(settings) = load_settings(&user_path) {
        debug!("loaded user hooks from {:?}", user_path);
        merge_hooks(&mut combined, settings.hooks);
    }

    if project_trusted {
        if let Some(project_path) = project_settings_path(cwd, "settings.json")
            && let Ok(settings) = load_settings(&project_path)
        {
            debug!("loaded project hooks from {:?}", project_path);
            merge_hooks(&mut combined, settings.hooks);
        }

        if let Some(local_path) = project_settings_path(cwd, "settings.local.json")
            && let Ok(settings) = load_settings(&local_path)
        {
            debug!("loaded local hooks from {:?}", local_path);
            merge_hooks(&mut combined, settings.hooks);
        }
    } else {
        debug!("project-level hooks skipped: folder not trusted");
    }

    combined
}

fn user_settings_path() -> PathBuf {
    kcoder_config::user_config_dir()
        .map(|dir| dir.join("settings.json"))
        .unwrap_or_else(|_| PathBuf::from(".kcoder/settings.json"))
}

#[cfg(test)]
fn user_settings_path_with_override(override_dir: Option<std::ffi::OsString>) -> PathBuf {
    if let Some(dir) = override_dir.filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir).join("settings.json");
    }
    PathBuf::from(".kcoder/settings.json")
}

fn project_settings_path(cwd: &Path, filename: &str) -> Option<PathBuf> {
    let primary = cwd.join(".kcoder").join(filename);
    primary.is_file().then_some(primary)
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SettingsFile {
    #[serde(default)]
    hooks: HooksSettings,
}

fn load_settings(path: &Path) -> anyhow::Result<SettingsFile> {
    let content = std::fs::read_to_string(path)?;
    let settings: SettingsFile = serde_json::from_str(&content)?;
    Ok(settings)
}

fn merge_hooks(base: &mut HooksSettings, additional: HooksSettings) {
    let matchers = additional.into_matchers();
    // Simple merge: append matchers. Deduplication can be added later.
    for (event, matcher) in matchers {
        let name = event.as_str().to_string();
        base.events.entry(name).or_default().push(matcher);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::HookCommand;

    #[test]
    fn parses_pascal_case_event_names() {
        let json = r#"{"PreToolUse": [{"hooks": [{"type": "command", "command": "echo hi"}]}]}"#;
        let settings: HooksSettings = serde_json::from_str(json).unwrap();
        let matchers = settings.into_matchers();
        assert_eq!(matchers.len(), 1);
        assert_eq!(matchers[0].0, HookEvent::PreToolUse);
    }

    #[test]
    fn parses_snake_case_event_names() {
        let json = r#"{"pre_tool_use": [{"hooks": [{"type": "command", "command": "echo hi"}]}]}"#;
        let settings: HooksSettings = serde_json::from_str(json).unwrap();
        let matchers = settings.into_matchers();
        assert_eq!(matchers.len(), 1);
        assert_eq!(matchers[0].0, HookEvent::PreToolUse);
    }

    #[test]
    fn parses_sandbox_escalation_event_names() {
        let json = r#"{"SandboxEscalationAttempt": [{"hooks": [{"type": "command", "command": "echo hi"}]}], "sandbox_escalated": [{"hooks": [{"type": "command", "command": "echo ok"}]}]}"#;
        let settings: HooksSettings = serde_json::from_str(json).unwrap();
        let matchers = settings.into_matchers();
        assert_eq!(matchers.len(), 2);
        let events = matchers
            .iter()
            .map(|(event, _)| *event)
            .collect::<std::collections::HashSet<_>>();
        assert!(events.contains(&HookEvent::SandboxEscalationAttempt));
        assert!(events.contains(&HookEvent::SandboxEscalated));
    }

    #[test]
    fn ignores_unknown_event_names() {
        let json = r#"{"UnknownEvent": [{"hooks": []}], "Stop": [{"hooks": []}]}"#;
        let settings: HooksSettings = serde_json::from_str(json).unwrap();
        let matchers = settings.into_matchers();
        assert_eq!(matchers.len(), 1);
        assert_eq!(matchers[0].0, HookEvent::Stop);
    }

    #[test]
    fn command_defaults_to_bash_and_ten_minutes() {
        let json = r#"{"PreToolUse": [{"hooks": [{"type": "command", "command": "echo hi"}]}]}"#;
        let settings: HooksSettings = serde_json::from_str(json).unwrap();
        let matchers = settings.into_matchers();
        if let HookCommand::Command { shell, timeout, .. } = &matchers[0].1.hooks[0] {
            assert_eq!(
                shell,
                if cfg!(windows) {
                    "powershell.exe"
                } else {
                    "bash"
                }
            );
            assert_eq!(*timeout, 600);
        } else {
            panic!("expected command hook");
        }
    }

    #[test]
    fn user_settings_path_honours_config_dir_env() {
        let resolved = user_settings_path_with_override(Some("/tmp/kcoder-isolated-hooks".into()));
        assert_eq!(
            resolved,
            PathBuf::from("/tmp/kcoder-isolated-hooks").join("settings.json")
        );
    }
}

#[cfg(test)]
mod trust_tests {
    use super::*;
    use kcoder_config::CONFIG_DIR_ENV;

    #[test]
    fn untrusted_folder_skips_project_hooks_but_keeps_user_hooks() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("repo");
        std::fs::create_dir_all(project.join(".kcoder")).unwrap();
        std::fs::write(
            project.join(".kcoder").join("settings.json"),
            r#"{"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "echo malicious"}]}]}}"#,
        )
        .unwrap();

        let isolated = tmp.path().join("isolated-config");
        std::fs::create_dir_all(&isolated).unwrap();
        std::fs::write(
            isolated.join("settings.json"),
            r#"{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "echo user"}]}]}}"#,
        )
        .unwrap();
        unsafe { std::env::set_var(CONFIG_DIR_ENV, &isolated) };

        let untrusted = discover_hooks_with_trust(&project, false);
        let all: Vec<_> = untrusted.into_matchers();
        assert_eq!(all.len(), 1, "only the user hook must load");

        let trusted = discover_hooks_with_trust(&project, true);
        assert_eq!(trusted.into_matchers().len(), 2);

        unsafe { std::env::remove_var(CONFIG_DIR_ENV) };
    }
}
