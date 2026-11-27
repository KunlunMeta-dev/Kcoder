use crate::types::{HookCommand, HookEvent, HookMatcher, HookSource};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{debug, warn};

/// Raw hooks section from a settings file.
///
/// Deserializing this type is strict (one malformed rule rejects the whole
/// value) and is meant for plugin manifests and tests. Settings discovery uses
/// [`HooksSettings::from_settings_document`], which keeps valid sibling rules,
/// replaces malformed ones with fail-closed placeholders and records
/// [`HookConfigIssue`] diagnostics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HooksSettings {
    #[serde(flatten)]
    events: HashMap<String, Vec<HookMatcher>>,
    #[serde(skip)]
    issues: Vec<HookConfigIssue>,
}

/// How a hook configuration problem affects validity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookConfigIssueSeverity {
    /// The configuration is invalid; `kcoder config validate` fails.
    Error,
    /// The configuration loads, but part of it is ignored or unsupported.
    Warning,
}

/// A typed hook settings diagnostic. `message` is sanitized: it names fields
/// and types but never echoes configured string values such as commands,
/// URLs or headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookConfigIssue {
    pub severity: HookConfigIssueSeverity,
    /// Settings file that contains the problem.
    pub file: PathBuf,
    /// JSON location inside the file, for example `hooks.PreToolUse[1].hooks[0]`.
    pub location: String,
    pub message: String,
}

impl HookConfigIssue {
    pub fn is_error(&self) -> bool {
        self.severity == HookConfigIssueSeverity::Error
    }
}

impl std::fmt::Display for HookConfigIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let severity = match self.severity {
            HookConfigIssueSeverity::Error => "error",
            HookConfigIssueSeverity::Warning => "warning",
        };
        write!(
            f,
            "{severity}: {} ({}): {}",
            self.location,
            self.file.display(),
            self.message
        )
    }
}

const FAIL_CLOSED_NOTE: &str =
    "the rule is replaced by a fail-closed hook error (PreToolUse blocks matching tools)";

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
                    warn!(
                        "ignoring unknown hook event name: {}",
                        diagnostic_text(&name, 80)
                    );
                }
            }
        }
        matchers
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Diagnostics recorded while parsing settings documents.
    pub fn issues(&self) -> &[HookConfigIssue] {
        &self.issues
    }

    /// Parse the top-level `hooks` object of one settings document.
    ///
    /// Valid rules load normally. A malformed rule or action never disappears
    /// silently: it is reported as an error issue and replaced by an
    /// `InvalidConfiguration` action that fails closed whenever its event
    /// (and, when parseable, its matcher) applies. Unknown event names cannot
    /// be attributed to an event, so they are reported and ignored.
    pub fn from_settings_document(document: &Value, file: &Path) -> Self {
        let mut parsed = Self::default();
        let Some(hooks) = document.get("hooks") else {
            return parsed;
        };
        let events = match hooks {
            Value::Null => return parsed,
            Value::Object(events) => events,
            other => {
                parsed.fail_all_events(
                    file,
                    "hooks",
                    format!("expected an object of events, found {}", json_kind(other)),
                );
                return parsed;
            }
        };
        for (name, rules) in events {
            let event_location = format!("hooks.{}", diagnostic_text(name, 80));
            let Some(event) = parse_hook_event(name) else {
                parsed.push_issue(
                    HookConfigIssueSeverity::Error,
                    file,
                    event_location,
                    "unknown hook event; its rules are ignored".to_owned(),
                );
                continue;
            };
            let Some(rules) = rules.as_array() else {
                let message = format!("expected an array of rules, found {}", json_kind(rules));
                parsed.push_invalid_rule(event, None, file, event_location, message);
                continue;
            };
            for (index, rule) in rules.iter().enumerate() {
                parsed.parse_rule(event, rule, file, format!("{event_location}[{index}]"));
            }
        }
        parsed
    }

    /// A settings file that exists but cannot be read or parsed may hide any
    /// rule, so every event fails closed until it is fixed.
    fn unreadable(file: &Path, error: &anyhow::Error) -> Self {
        let mut parsed = Self::default();
        parsed.fail_all_events(
            file,
            "hooks",
            format!(
                "settings file could not be read: {}",
                diagnostic_text(&format!("{error:#}"), 300)
            ),
        );
        parsed
    }

    fn fail_all_events(&mut self, file: &Path, location: &str, message: String) {
        let message = format!("{message}; every hook event fails closed until it is fixed");
        let sentinel = invalid_action(file, location, &message);
        for event in HookEvent::ALL {
            self.push_matcher(
                *event,
                HookMatcher {
                    matcher: None,
                    hooks: vec![sentinel.clone()],
                    source: None,
                },
            );
        }
        self.push_issue(
            HookConfigIssueSeverity::Error,
            file,
            location.to_owned(),
            message,
        );
    }

    fn parse_rule(&mut self, event: HookEvent, rule: &Value, file: &Path, location: String) {
        let Some(object) = rule.as_object() else {
            let message = format!("expected a rule object, found {}", json_kind(rule));
            self.push_invalid_rule(event, None, file, location, message);
            return;
        };
        // Parse the rule envelope (matcher/source) separately from its actions
        // so one bad action does not discard valid siblings.
        let mut envelope = object.clone();
        let actions = envelope.remove("hooks");
        envelope.insert("hooks".to_owned(), Value::Array(Vec::new()));
        let mut matcher = match serde_json::from_value::<HookMatcher>(Value::Object(envelope)) {
            Ok(matcher) => matcher,
            Err(error) => {
                let message = diagnostic_text(&error.to_string(), 300);
                self.push_invalid_rule(event, None, file, location, message);
                return;
            }
        };
        let actions = match actions {
            Some(Value::Array(actions)) => actions,
            Some(other) => {
                let message = format!("`hooks` must be an array, found {}", json_kind(&other));
                self.push_invalid_rule(event, matcher.matcher, file, location, message);
                return;
            }
            None => {
                let message = "missing field `hooks`".to_owned();
                self.push_invalid_rule(event, matcher.matcher, file, location, message);
                return;
            }
        };
        for (index, action) in actions.iter().enumerate() {
            let action_location = format!("{location}.hooks[{index}]");
            match serde_json::from_value::<HookCommand>(action.clone()) {
                Ok(command) => {
                    if matches!(command, HookCommand::Agent { .. })
                        && action.get("max_turns").is_some()
                    {
                        self.push_issue(
                            HookConfigIssueSeverity::Warning,
                            file,
                            format!("{action_location}.max_turns"),
                            "`max_turns` is not supported and is ignored; agent hooks run one \
                             tool-less model call like prompt hooks"
                                .to_owned(),
                        );
                    }
                    matcher.hooks.push(command);
                }
                Err(error) => {
                    let message = format!(
                        "{}; {FAIL_CLOSED_NOTE}",
                        diagnostic_text(&error.to_string(), 300)
                    );
                    matcher
                        .hooks
                        .push(invalid_action(file, &action_location, &message));
                    self.push_issue(
                        HookConfigIssueSeverity::Error,
                        file,
                        action_location,
                        message,
                    );
                }
            }
        }
        self.push_matcher(event, matcher);
    }

    fn push_invalid_rule(
        &mut self,
        event: HookEvent,
        matcher: Option<String>,
        file: &Path,
        location: String,
        message: String,
    ) {
        let message = format!("{message}; {FAIL_CLOSED_NOTE}");
        self.push_matcher(
            event,
            HookMatcher {
                matcher,
                hooks: vec![invalid_action(file, &location, &message)],
                source: None,
            },
        );
        self.push_issue(HookConfigIssueSeverity::Error, file, location, message);
    }

    fn push_matcher(&mut self, event: HookEvent, matcher: HookMatcher) {
        self.events
            .entry(event.as_str().to_owned())
            .or_default()
            .push(matcher);
    }

    fn push_issue(
        &mut self,
        severity: HookConfigIssueSeverity,
        file: &Path,
        location: String,
        message: String,
    ) {
        let issue = HookConfigIssue {
            severity,
            file: file.to_path_buf(),
            location,
            message,
        };
        warn!("hook settings {issue}");
        self.issues.push(issue);
    }
}

fn invalid_action(file: &Path, location: &str, message: &str) -> HookCommand {
    HookCommand::InvalidConfiguration {
        message: format!("{location} ({}): {message}", file.display()),
    }
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// Make parser output safe for logs and UI: quoted values (commands, URLs,
/// headers) are elided, sensitive tokens are redacted and length is bounded.
fn diagnostic_text(text: &str, max_chars: usize) -> String {
    let mut elided = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '"' {
            elided.push(ch);
            continue;
        }
        elided.push_str("\"…\"");
        let mut escaped = false;
        for inner in chars.by_ref() {
            if escaped {
                escaped = false;
            } else if inner == '\\' {
                escaped = true;
            } else if inner == '"' {
                break;
            }
        }
    }
    let redacted = crate::redaction::hook_text_preview(&elided);
    if redacted.chars().count() <= max_chars {
        redacted
    } else {
        format!("{}…", redacted.chars().take(max_chars).collect::<String>())
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
///
/// Parse problems are kept in [`HooksSettings::issues`]; malformed rules fail
/// closed instead of being dropped.
pub fn discover_hooks_with_trust(cwd: &Path, project_trusted: bool) -> HooksSettings {
    let profile = match kcoder_config::user_config_dir() {
        Ok(profile) => profile,
        Err(error) => return HooksSettings::unreadable(Path::new("<selected-profile>"), &error),
    };
    let user_path = profile.join("settings.json");
    discover_hooks_from_settings_path(cwd, project_trusted, &user_path)
        .unwrap_or_else(|error| HooksSettings::unreadable(&user_path, &error))
}

/// Use the host-selected settings source and bind project trust to that profile.
pub fn discover_hooks_from_settings_path(
    cwd: &Path,
    project_trusted: bool,
    user_path: &Path,
) -> anyhow::Result<HooksSettings> {
    let profile = user_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Hook profile unavailable"))?;
    let mut combined = HooksSettings::default();

    let settings = load_hooks_from_settings_path(user_path)?;
    debug!("loaded user hooks from {:?}", user_path);
    merge_hooks(&mut combined, settings);

    if project_trusted {
        for name in ["settings.json", "settings.local.json"] {
            let path = cwd.join(".kcoder").join(name);
            let settings = load_hooks_from_settings_path(&path)?;
            debug!("loaded project hooks from {:?}", path);
            merge_hooks(
                &mut combined,
                project_hook_sources(settings, &path, cwd, profile),
            );
        }
    } else {
        debug!("project-level hooks skipped: folder not trusted");
    }

    Ok(combined)
}

/// Validate the hooks sections of every settings file hook discovery reads,
/// using the same parser as runtime discovery. Project files are parsed even
/// when the folder is untrusted; parsing never executes anything.
pub fn validate_hook_settings(cwd: &Path) -> Vec<HookConfigIssue> {
    discover_hooks_with_trust(cwd, true).issues
}

fn load_hooks_from_settings_path(path: &Path) -> anyhow::Result<HooksSettings> {
    let document = kcoder_config::read_settings_file(path)?;
    Ok(HooksSettings::from_settings_document(&document, path))
}

#[cfg(test)]
fn load_hooks(path: &Path) -> HooksSettings {
    match load_hooks_from_settings_path(path) {
        Ok(settings) => settings,
        Err(error) => HooksSettings::unreadable(path, &error),
    }
}

fn project_hook_sources(
    mut settings: HooksSettings,
    path: &Path,
    cwd: &Path,
    profile: &Path,
) -> HooksSettings {
    for matcher in settings.events.values_mut().flatten() {
        // Always overwrite source claims from a project-controlled document.
        matcher.source = Some(HookSource::project_settings_with_profile(
            path,
            cwd,
            Some(profile.to_path_buf()),
        ));
    }
    settings
}

#[cfg(test)]
#[derive(Debug, Clone, Default, Deserialize)]
struct SettingsFile {
    #[serde(default)]
    hooks: HooksSettings,
}

#[cfg(test)]
fn load_settings(path: &Path) -> anyhow::Result<SettingsFile> {
    let document = kcoder_config::read_settings_file(path)?;
    let settings: SettingsFile = serde_json::from_value(document)?;
    Ok(settings)
}

fn merge_hooks(base: &mut HooksSettings, additional: HooksSettings) {
    base.issues.extend(additional.issues);
    for (name, matchers) in additional.events {
        // Unknown names never reach here from settings discovery; keep the
        // warning path of `into_matchers` for strict callers.
        let name = parse_hook_event(&name)
            .map(|event| event.as_str().to_owned())
            .unwrap_or(name);
        // Simple merge: append matchers. Deduplication can be added later.
        base.events.entry(name).or_default().extend(matchers);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::HookCommand;

    #[test]
    fn hook_discovery_reads_the_same_jsonc_user_file_as_configuration_management() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(&path, "{ // retained user comment\n \"hooks\": {\"UserPromptSubmit\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"echo fixture\"}]}]}}") .unwrap();
        let loaded = load_settings(&path).unwrap().hooks.into_matchers();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].0, HookEvent::UserPromptSubmit);
        std::fs::write(&path, "{invalid").unwrap();
        assert!(load_settings(&path).is_err());
    }

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
}

#[cfg(test)]
mod settings_diagnostics_tests {
    use super::*;
    use crate::types::{HookInput, HookOutcome};
    use serde_json::json;

    fn parse(hooks: Value) -> HooksSettings {
        HooksSettings::from_settings_document(
            &json!({ "hooks": hooks }),
            Path::new("/cfg/settings.json"),
        )
    }

    async fn run(settings: HooksSettings, event: HookEvent, query: &str) -> Vec<HookOutcome> {
        let registry = crate::HookRegistry::from_settings(settings);
        crate::execute_hooks(&registry, HookInput::new(event, query, json!({})))
            .await
            .into_iter()
            .map(|result| result.outcome)
            .collect()
    }

    #[tokio::test]
    async fn malformed_rule_keeps_valid_siblings_and_fails_closed_for_its_matcher() {
        let settings = parse(json!({"PreToolUse": [
            {"matcher": "bash", "hooks": [{"type": "command", "command": "exit 0", "shell": "sh"}]},
            {"matcher": "write", "hooks": [{"type": "command", "command": "curl -H TOKEN=needle", "timeout": "soon"}]}
        ]}));
        let issues = settings.issues().to_vec();
        assert_eq!(issues.len(), 1);
        assert!(issues[0].is_error());
        assert_eq!(issues[0].location, "hooks.PreToolUse[1].hooks[0]");
        assert_eq!(issues[0].file, Path::new("/cfg/settings.json"));
        let rendered = issues[0].to_string();
        assert!(rendered.contains("invalid type"), "{rendered}");
        assert!(!rendered.contains("soon") && !rendered.contains("needle"));

        let matchers = settings.clone().into_matchers();
        assert_eq!(matchers.len(), 2, "the valid sibling rule must still load");
        assert!(matches!(
            matchers[1].1.hooks[0],
            HookCommand::InvalidConfiguration { .. }
        ));
        assert_eq!(matchers[1].1.matcher.as_deref(), Some("write"));

        let blocked = run(settings.clone(), HookEvent::PreToolUse, "write").await;
        assert!(
            matches!(&blocked[..], [HookOutcome::Error(message)] if message.contains("fails closed")
                && message.contains("hooks.PreToolUse[1].hooks[0]"))
        );
        let registry = crate::HookRegistry::from_settings(settings);
        let results = crate::execute_hooks(
            &registry,
            HookInput::new(HookEvent::PreToolUse, "write", json!({})),
        )
        .await;
        assert!(crate::first_blocking_error(&results).is_some());
        assert_eq!(registry.configuration_issues().len(), 1);
    }

    #[test]
    fn malformed_rule_envelopes_fail_closed_for_the_whole_event() {
        let settings = parse(json!({
            "PreToolUse": [{"matcher": 7, "hooks": []}, "not a rule", {"matcher": "bash"}],
            "Stop": {"hooks": []},
        }));
        let locations = settings
            .issues()
            .iter()
            .map(|issue| issue.location.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            locations,
            [
                "hooks.PreToolUse[0]",
                "hooks.PreToolUse[1]",
                "hooks.PreToolUse[2]",
                "hooks.Stop"
            ]
            .into_iter()
            .collect()
        );
        let matchers = settings.into_matchers();
        assert_eq!(matchers.len(), 4);
        for (_, matcher) in &matchers {
            assert!(matches!(
                matcher.hooks[..],
                [HookCommand::InvalidConfiguration { .. }]
            ));
        }
        // A rule whose matcher cannot be parsed applies to every query.
        assert!(
            matchers.iter().any(
                |(event, matcher)| *event == HookEvent::PreToolUse && matcher.matcher.is_none()
            )
        );
        // Only an unparsable matcher widens the scope; a parsed one is kept.
        assert!(
            matchers
                .iter()
                .any(|(_, matcher)| matcher.matcher.as_deref() == Some("bash"))
        );
    }

    #[test]
    fn unknown_events_are_reported_and_non_object_sections_fail_every_event() {
        let settings = parse(json!({"PreToolUze": [{"hooks": []}], "Stop": []}));
        assert!(settings.clone().into_matchers().is_empty());
        assert_eq!(settings.issues().len(), 1);
        assert_eq!(settings.issues()[0].location, "hooks.PreToolUze");
        assert!(settings.issues()[0].is_error());

        let settings = parse(json!(["PreToolUse"]));
        assert_eq!(settings.issues().len(), 1);
        let events = settings
            .into_matchers()
            .into_iter()
            .map(|(event, _)| event)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(events.len(), HookEvent::ALL.len());

        assert!(parse(Value::Null).issues().is_empty());
        let absent =
            HooksSettings::from_settings_document(&json!({"model": "x"}), Path::new("/cfg"));
        assert!(absent.issues().is_empty() && absent.is_empty());
    }

    #[test]
    fn unreadable_settings_file_fails_closed_instead_of_dropping_hooks() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(&path, "{\"hooks\": {\"PreToolUse\": [").unwrap();
        let settings = load_hooks(&path);
        assert_eq!(settings.issues().len(), 1);
        assert!(settings.issues()[0].is_error());
        assert_eq!(settings.into_matchers().len(), HookEvent::ALL.len());

        let missing = load_hooks(&temp.path().join("absent.json"));
        assert!(missing.issues().is_empty() && missing.is_empty());
    }

    #[test]
    fn project_placeholders_keep_project_trust_provenance() {
        let parsed = HooksSettings::from_settings_document(
            &json!({"hooks": {"PreToolUse": [{"hooks": [{"type": "nope"}]}]}}),
            Path::new("/project/.kcoder/settings.json"),
        );
        let scoped = project_hook_sources(
            parsed,
            Path::new("/project/.kcoder/settings.json"),
            Path::new("/project"),
            Path::new("/profile"),
        );
        let (_, matcher) = scoped.into_matchers().remove(0);
        assert!(matches!(
            matcher.hooks[..],
            [HookCommand::InvalidConfiguration { .. }]
        ));
        assert!(matcher.source.unwrap().required_trust.is_some());
    }

    #[test]
    fn placeholders_cannot_be_configured_directly() {
        let settings = parse(json!({"Stop": [{"hooks": [
            {"type": "invalid_configuration", "message": "forged"}
        ]}]}));
        assert_eq!(settings.issues().len(), 1);
        let (_, matcher) = settings.into_matchers().remove(0);
        let HookCommand::InvalidConfiguration { message } = &matcher.hooks[0] else {
            panic!("expected placeholder");
        };
        assert!(!message.contains("forged"));
        assert!(
            serde_json::from_value::<HookCommand>(
                json!({"type": "invalid_configuration", "message": "x"})
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn agent_max_turns_is_reported_as_unsupported_and_does_not_change_execution() {
        let settings = parse(json!({"Stop": [{"hooks": [
            {"type": "agent", "instructions": "check", "max_turns": 3},
            {"type": "agent", "instructions": "check"}
        ]}]}));
        let issues = settings.issues().to_vec();
        assert_eq!(issues.len(), 1, "only the explicit field is reported");
        assert_eq!(issues[0].severity, HookConfigIssueSeverity::Warning);
        assert_eq!(issues[0].location, "hooks.Stop[0].hooks[0].max_turns");
        assert!(issues[0].message.contains("not supported"));

        let matchers = settings.clone().into_matchers();
        assert!(matches!(
            matchers[0].1.hooks[..],
            [
                HookCommand::Agent { max_turns: 3, .. },
                HookCommand::Agent { max_turns: 50, .. }
            ]
        ));
        // Both actions behave identically: the field is never consulted, and
        // a missing model is rejected before any provider call.
        let outcomes = run(settings, HookEvent::Stop, "").await;
        assert_eq!(outcomes.len(), 2);
        for outcome in outcomes {
            assert!(
                matches!(outcome, HookOutcome::Error(message) if message.contains("explicitly configured model"))
            );
        }
    }
}

#[cfg(test)]
mod trust_tests {
    use super::*;

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
        let untrusted =
            discover_hooks_from_settings_path(&project, false, &isolated.join("settings.json"))
                .unwrap();
        let all: Vec<_> = untrusted.into_matchers();
        assert_eq!(all.len(), 1, "only the user hook must load");

        let trusted =
            discover_hooks_from_settings_path(&project, true, &isolated.join("settings.json"))
                .unwrap();
        assert_eq!(trusted.into_matchers().len(), 2);
    }

    #[test]
    fn selected_hook_profiles_do_not_mix_and_invalid_sources_do_not_fall_back() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(workspace.join(".kcoder")).unwrap();
        let first = temp.path().join("first/settings.json");
        let second = temp.path().join("second/settings.json");
        for (path, command) in [(&first, "echo first"), (&second, "echo second")] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, serde_json::json!({"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":command}]}]}}).to_string()).unwrap();
        }
        for (path, expected) in [(&first, "echo first"), (&second, "echo second")] {
            let hooks = discover_hooks_from_settings_path(&workspace, false, path)
                .unwrap()
                .into_matchers();
            assert_eq!(hooks.len(), 1);
            assert!(
                matches!(&hooks[0].1.hooks[0], crate::HookCommand::Command{command,..} if command == expected)
            );
        }
        let project = workspace.join(".kcoder/settings.json");
        std::fs::write(&project, "invalid project configuration").unwrap();
        assert!(discover_hooks_from_settings_path(&workspace, false, &first).is_ok());
        assert!(discover_hooks_from_settings_path(&workspace, true, &first).is_err());
        std::fs::write(&project, "{}").unwrap();
        std::fs::write(&first, "invalid selected configuration").unwrap();
        assert!(discover_hooks_from_settings_path(&workspace, false, &first).is_err());
        assert!(discover_hooks_from_settings_path(&workspace, false, &second).is_ok());
        std::fs::remove_file(&first).unwrap();
        std::fs::create_dir(&first).unwrap();
        assert!(discover_hooks_from_settings_path(&workspace, false, &first).is_err());
    }
}

#[cfg(test)]
mod runtime_provenance_tests {
    use super::*;

    #[test]
    fn project_document_cannot_forge_away_runtime_trust() {
        let raw = serde_json::json!({ "PreToolUse": [{"hooks":[], "source": {"kind":"plugin","id":"spoof","name":"spoof","root":"/trusted","required_trust":null}}] });
        let loaded: HooksSettings = serde_json::from_value(raw).unwrap();
        let scoped = project_hook_sources(
            loaded,
            Path::new("/project/.kcoder/settings.json"),
            Path::new("/project"),
            Path::new("/profile"),
        );
        let source = scoped.into_matchers()[0].1.source.clone().unwrap();
        assert_eq!(source.kind, crate::HookSourceKind::Settings);
        assert_eq!(
            source.required_trust.as_ref().unwrap().directory,
            Path::new("/project")
        );
        assert!(
            serde_json::to_value(&source)
                .unwrap()
                .get("required_trust")
                .is_none()
        );
    }
}
