//! A fixed matching snapshot for consumers that durably claim individual hooks.
use crate::execution::{execute_hook, hook_description, hook_matches_if_rule, source_label};
use crate::matching::matches_pattern;
use crate::redaction::hook_text_preview;
use crate::{HookCommand, HookInput, HookRegistry, HookResult, HookSource};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone)]
pub struct PreparedHook {
    /// Stable configuration fingerprint and duplicate occurrence, never command text.
    pub hook_id: String,
    matcher: Option<String>,
    source: Option<HookSource>,
    command: HookCommand,
}

/// Capture only hooks matching this input. Later registry mutation cannot change
/// the commands or plugin roots executed by this snapshot.
pub fn prepare_hooks(
    registry: &HookRegistry,
    input: &HookInput,
) -> anyhow::Result<Vec<PreparedHook>> {
    if registry.disabled {
        return Ok(Vec::new());
    }
    let mut occurrences: HashMap<String, usize> = HashMap::new();
    let mut prepared = Vec::new();
    for (event, matcher) in &registry.settings_hooks {
        if *event != input.event
            || !matches_pattern(&input.query, matcher.matcher.as_deref().unwrap_or("*"))
        {
            continue;
        }
        for command in &matcher.hooks {
            if !hook_matches_if_rule(input, command) {
                continue;
            }
            // Absolute installation roots can change during migration; logical
            // source identity and the complete command configuration cannot.
            let source_identity = matcher
                .source
                .as_ref()
                // Project settings had no source identity before runtime trust
                // provenance was added. Keep durable delivery IDs compatible.
                .filter(|source| {
                    !(source.kind == crate::HookSourceKind::Settings
                        && source.required_trust.is_some())
                })
                .map(|source| json!({"kind":source.kind, "id":source.id}));
            let configuration = canonical(
                json!({"event":event,"matcher":matcher.matcher,"source":source_identity,"command":command}),
            );
            let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&configuration)?));
            let occurrence = occurrences.entry(fingerprint.clone()).or_default();
            let hook_id = format!("{fingerprint}:{occurrence}");
            *occurrence += 1;
            prepared.push(PreparedHook {
                hook_id,
                matcher: matcher.matcher.clone(),
                source: matcher.source.clone(),
                command: command.clone(),
            });
        }
    }
    Ok(prepared)
}

/// Execute one previously claimed hook. The caller owns the durable ledger and
/// supplies `hook_execution_id` in `input.extra` for external idempotency.
/// Detached command outcomes confirm dispatch, not external side-effect completion.
pub async fn execute_prepared_hook(prepared: &PreparedHook, mut input: HookInput) -> HookResult {
    input
        .extra
        .insert("hook_id".into(), Value::String(prepared.hook_id.clone()));
    let outcome = execute_hook(&prepared.command, &input, prepared.source.as_ref()).await;
    HookResult {
        hook_description: format!(
            "{}{} (matcher: {})",
            hook_description(&prepared.command),
            source_label(prepared.source.as_ref()),
            hook_text_preview(prepared.matcher.as_deref().unwrap_or("*"))
        ),
        outcome,
    }
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HookEvent, HookMatcher};

    fn registry(command: &str) -> HookRegistry {
        HookRegistry::from_matchers(vec![(
            HookEvent::Notification,
            HookMatcher {
                matcher: Some("agent_completed".into()),
                hooks: vec![HookCommand::Command {
                    shell: "bash".into(),
                    command: command.into(),
                    if_rule: None,
                    timeout: 5,
                    async_hook: false,
                }],
                source: None,
            },
        )])
    }

    #[tokio::test]
    async fn prepared_and_regular_hooks_recheck_revoked_directory_before_execution() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project with spaces");
        let config = temp.path().join("profile");
        std::fs::create_dir_all(&project).unwrap();
        let mut trust = kcoder_config::FolderTrustStore::load(&config);
        trust.trust(&project).unwrap();
        let mut hooks = registry("printf x >> count");
        let input = HookInput::new(HookEvent::Notification, "agent_completed", json!({}))
            .with_extra("cwd", json!(project));
        let legacy_id = prepare_hooks(&hooks, &input).unwrap()[0].hook_id.clone();
        let mut source =
            HookSource::project_settings(&project.join(".kcoder/settings.json"), &project);
        source.required_trust.as_mut().unwrap().config_dir = Some(config.clone());
        hooks.settings_hooks[0].1.source = Some(source);
        let prepared = prepare_hooks(&hooks, &input).unwrap().remove(0);
        assert_eq!(prepared.hook_id, legacy_id);
        execute_prepared_hook(&prepared, input.clone()).await;
        assert_eq!(std::fs::read(project.join("count")).unwrap(), b"x");
        trust.revoke(&project).unwrap();
        let denied = execute_prepared_hook(&prepared, input.clone()).await;
        assert!(
            matches!(denied.outcome, crate::HookOutcome::Error(ref message) if message.contains("trust was revoked"))
        );
        let denied = crate::execute_hooks(&hooks, input.clone()).await;
        assert!(crate::first_blocking_error(&denied).is_some());
        assert_eq!(std::fs::read(project.join("count")).unwrap(), b"x");
        trust.trust(&project).unwrap();
        execute_prepared_hook(&prepared, input).await;
        assert_eq!(std::fs::read(project.join("count")).unwrap(), b"xx");
    }

    #[test]
    fn prepared_ids_survive_unrelated_changes_and_distinguish_duplicate_hooks() {
        let input = HookInput::new(HookEvent::Notification, "agent_completed", json!({}));
        let mut config = registry("true");
        let first = prepare_hooks(&config, &input).unwrap()[0].hook_id.clone();
        let duplicate = config.settings_hooks[0].1.hooks[0].clone();
        config.settings_hooks[0].1.hooks.push(duplicate);
        let prepared = prepare_hooks(&config, &input).unwrap();
        assert_eq!(prepared[0].hook_id, first);
        assert_ne!(prepared[0].hook_id, prepared[1].hook_id);
        assert!(!prepared[0].hook_id.contains("true"));
        assert!(
            prepare_hooks(
                &config,
                &HookInput::new(HookEvent::Notification, "other", json!({}))
            )
            .unwrap()
            .is_empty()
        );
        assert_ne!(
            first,
            prepare_hooks(&registry("false"), &input).unwrap()[0].hook_id
        );
    }

    #[test]
    fn fingerprint_sorts_http_header_maps_and_ignores_installation_root() {
        let input = HookInput::new(HookEvent::Notification, "agent_completed", json!({}));
        let mut a = registry("true");
        a.settings_hooks[0].1.source = Some(HookSource::plugin("id", "name", "/first"));
        a.settings_hooks[0].1.hooks = vec![HookCommand::Http {
            url: "https://example.invalid/hook".into(),
            method: "POST".into(),
            headers: [("B".into(), "two".into()), ("A".into(), "one".into())]
                .into_iter()
                .collect(),
            timeout: 5,
        }];
        let mut b = a.clone();
        b.settings_hooks[0].1.source.as_mut().unwrap().root = "/second".into();
        if let HookCommand::Http { headers, .. } = &mut b.settings_hooks[0].1.hooks[0] {
            *headers = [("A".into(), "one".into()), ("B".into(), "two".into())]
                .into_iter()
                .collect();
        }
        assert_eq!(
            prepare_hooks(&a, &input).unwrap()[0].hook_id,
            prepare_hooks(&b, &input).unwrap()[0].hook_id
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn prepared_execution_keeps_snapshot_and_passes_idempotency_metadata() {
        let mut input = HookInput::new(HookEvent::Notification, "agent_completed", json!({}));
        input
            .extra
            .insert("hook_execution_id".into(), json!("execution-sentinel"));
        let mut config = registry(
            r#"IFS= read -r payload; [[ "$payload" == *execution-sentinel* && "$payload" == *hook_id* ]]"#,
        );
        let prepared = prepare_hooks(&config, &input).unwrap();
        config.settings_hooks.clear();
        let result = execute_prepared_hook(&prepared[0], input).await;
        assert!(
            matches!(result.outcome, crate::HookOutcome::Effects(_)),
            "{:?}",
            result.outcome
        );
    }
}
