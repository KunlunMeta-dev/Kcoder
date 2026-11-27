//! Hook sources (user, project, plugin) with enabled state and configuration issues.
use super::Sources;
use super::shared::{display_path, item};
use kcoder_app_protocol::{
    ExtensionDisabledBy, ExtensionHookIssue, ExtensionInventoryItem, ExtensionIssueSeverity,
    ExtensionItemKind, ExtensionLayer,
};
use kcoder_hooks::{HookConfigIssueSeverity, HooksSettings};
use std::collections::BTreeMap;
use std::path::Path;

const MAX_ISSUE_MESSAGE_CHARS: usize = 512;
const MAX_ISSUES: usize = 256;

fn load(path: &Path) -> Option<HooksSettings> {
    kcoder_config::read_settings_file_if_present(path)
        .ok()
        .flatten()
        .map(|document| HooksSettings::from_settings_document(&document, path))
}

fn event_of(location: &str) -> Option<String> {
    let rest = location.strip_prefix("hooks.")?;
    let end = rest.find(['[', '.']).unwrap_or(rest.len());
    Some(rest[..end].to_owned()).filter(|event| !event.is_empty())
}

fn issues(settings: &HooksSettings, layer: ExtensionLayer, output: &mut Vec<ExtensionHookIssue>) {
    for issue in settings.issues() {
        if output.len() >= MAX_ISSUES {
            return;
        }
        // Issue messages are already elided at parse time; redact again defensively.
        let message: String = kcoder_hooks::hook_text_preview(&issue.message)
            .chars()
            .take(MAX_ISSUE_MESSAGE_CHARS)
            .collect();
        output.push(ExtensionHookIssue {
            layer,
            path: display_path(&issue.file),
            location: issue.location.clone(),
            event: event_of(&issue.location),
            severity: match issue.severity {
                HookConfigIssueSeverity::Error => ExtensionIssueSeverity::Error,
                HookConfigIssueSeverity::Warning => ExtensionIssueSeverity::Warning,
            },
            message,
        });
    }
}

fn settings_items(
    settings: HooksSettings,
    layer: ExtensionLayer,
    path: &Path,
    disabled_by: Option<ExtensionDisabledBy>,
    items: &mut Vec<ExtensionInventoryItem>,
) {
    let mut counts = BTreeMap::<&'static str, u32>::new();
    for (event, _) in settings.into_matchers() {
        *counts.entry(event.as_str()).or_default() += 1;
    }
    for (event, count) in counts {
        let mut entry = item(ExtensionItemKind::Hook, event, layer);
        entry.path = Some(display_path(path));
        entry.detail = Some(event.to_owned());
        entry.count = Some(count);
        entry.disabled_by = disabled_by;
        entry.enabled = disabled_by.is_none();
        entry.effective = entry.enabled;
        items.push(entry);
    }
}

pub(super) fn project(
    user_settings: &Path,
    sources: &Sources,
    items: &mut Vec<ExtensionInventoryItem>,
    hook_issues: &mut Vec<ExtensionHookIssue>,
) {
    if let Some(user) = load(user_settings) {
        issues(&user, ExtensionLayer::User, hook_issues);
        settings_items(user, ExtensionLayer::User, user_settings, None, items);
    }
    // Project files are parsed (never run) even when untrusted, so the view can
    // explain why their Hooks are inactive.
    for filename in ["settings.json", "settings.local.json"] {
        let path = sources.cwd.join(".kcoder").join(filename);
        if path == user_settings {
            continue;
        }
        if let Some(project) = load(&path) {
            issues(&project, ExtensionLayer::Project, hook_issues);
            let disabled = (!sources.folder_trusted).then_some(ExtensionDisabledBy::Trust);
            settings_items(project, ExtensionLayer::Project, &path, disabled, items);
        }
    }
    let mut active = BTreeMap::<(String, &'static str), u32>::new();
    for (event, matcher) in &sources.snapshot.hook_matchers {
        let Some(source) = matcher.source.as_ref() else {
            continue;
        };
        *active
            .entry((source.id.clone(), event.as_str()))
            .or_default() += 1;
    }
    for plugin in &sources.plugins {
        let policy_off = sources
            .settings
            .plugins
            .installed
            .get(&plugin.id)
            .and_then(|policy| policy.hooks.enabled)
            == Some(false);
        let disabled = if !plugin.enabled || policy_off {
            Some(ExtensionDisabledBy::Plugin)
        } else {
            None
        };
        let mut events: Vec<&String> = plugin.hook_event_names.iter().collect();
        events.sort();
        events.dedup();
        for event in events {
            let mut entry = item(ExtensionItemKind::Hook, event, ExtensionLayer::Plugin);
            entry.owner_plugin_id = Some(plugin.id.clone());
            entry.marketplace_id = super::shared::marketplace_of(&plugin.id);
            entry.path = Some(display_path(&plugin.root));
            entry.detail = Some(event.clone());
            let running = active
                .iter()
                .find(|((id, name), _)| id == &plugin.id && name == event)
                .map(|(_, count)| *count);
            entry.count = running;
            entry.disabled_by = disabled;
            entry.enabled = disabled.is_none();
            entry.effective = entry.enabled && running.is_some();
            items.push(entry);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn issue_locations_map_to_their_event() {
        assert_eq!(
            super::event_of("hooks.PreToolUse[1].hooks[0]").as_deref(),
            Some("PreToolUse")
        );
        assert_eq!(super::event_of("hooks.Stop").as_deref(), Some("Stop"));
        assert_eq!(super::event_of("hooks"), None);
    }
}
