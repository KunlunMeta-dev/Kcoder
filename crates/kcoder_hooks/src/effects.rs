use crate::redaction::hook_text_preview;
use crate::types::{HookEffect, HookJSONOutput, HookPermissionBehavior};
use serde_json::Value;
use tracing::warn;

/// Process the JSON output of a hook into a list of effects.
pub fn process_hook_output(output: HookJSONOutput, raw_stdout: &str) -> Vec<HookEffect> {
    let mut effects = Vec::new();

    if output.r#continue == Some(false) {
        effects.push(HookEffect::PreventContinuation {
            reason: output.stop_reason.clone(),
        });
    }

    if let Some(system_message) = output.system_message {
        effects.push(HookEffect::Message {
            text: system_message,
            is_error: false,
        });
    }

    // hookSpecificOutput carries event-specific structured data.
    if let Some(specific) = output.hook_specific_output {
        if let Some(decision) = specific.get("permissionDecision").and_then(|v| v.as_str()) {
            let behavior = match decision {
                "allow" => HookPermissionBehavior::Allow,
                "deny" => HookPermissionBehavior::Deny,
                "ask" => HookPermissionBehavior::Ask,
                _ => {
                    warn!("unknown permission decision from hook: {}", decision);
                    return effects;
                }
            };
            let updated_input = specific.get("updatedInput").cloned();
            effects.push(HookEffect::PermissionDecision {
                behavior,
                updated_input,
                reason: output.reason.clone(),
            });
        }
        if let Some(updated_input) = specific.get("updatedInput").cloned() {
            effects.push(HookEffect::UpdatedInput(updated_input));
        }
        if let Some(watch_paths) = specific.get("watchPaths").and_then(|v| v.as_array()) {
            let paths: Vec<std::path::PathBuf> = watch_paths
                .iter()
                .filter_map(|v| v.as_str().map(std::path::PathBuf::from))
                .collect();
            if !paths.is_empty() {
                effects.push(HookEffect::WatchPaths(paths));
            }
        }
        if let Some(worktree_path) = specific.get("worktreePath").and_then(|v| v.as_str()) {
            effects.push(HookEffect::WorktreePath(worktree_path.into()));
        }
        if let Some(initial_message) = specific.get("initialUserMessage").and_then(|v| v.as_str()) {
            // Not an effect in the UI sense; consumers handle this field.
            // We pass it through as additional context for now.
            effects.push(HookEffect::AdditionalContext(initial_message.to_string()));
        }
        if let Some(additional_context) = specific.get("additionalContext").and_then(|v| v.as_str())
        {
            effects.push(HookEffect::AdditionalContext(
                additional_context.to_string(),
            ));
        }
    }

    // If the hook produced plain stdout and no structured effects, surface the
    // stdout as a non-blocking message (unless suppressOutput is true).
    if output.suppress_output != Some(true) && effects.is_empty() && !raw_stdout.trim().is_empty() {
        effects.push(HookEffect::Message {
            text: hook_text_preview(raw_stdout.trim()),
            is_error: false,
        });
    }

    effects
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_stdout_fallback_redacts_sensitive_text() {
        let effects = process_hook_output(
            HookJSONOutput::default(),
            r#"{"api_key":"sk-secret","note":"visible"}"#,
        );

        assert!(matches!(
            effects.as_slice(),
            [HookEffect::Message { text, is_error: false }]
                if text.contains("[redacted]")
                    && !text.contains("sk-secret")
                    && !text.contains("api_key")
        ));
    }
}

/// Aggregate effects from multiple hooks into a single result.
#[derive(Debug, Clone, Default)]
pub struct AggregatedEffects {
    pub messages: Vec<(String, bool)>,
    pub blocking_error: Option<String>,
    pub prevent_continuation: bool,
    pub stop_reason: Option<String>,
    pub permission_decision: Option<HookPermissionBehavior>,
    pub updated_input: Option<Value>,
    pub additional_context: Vec<String>,
    pub watch_paths: Vec<std::path::PathBuf>,
    pub worktree_path: Option<std::path::PathBuf>,
}

impl AggregatedEffects {
    pub fn aggregate(effects_list: Vec<Vec<HookEffect>>) -> Self {
        let mut agg = Self::default();
        let mut permission_behaviors: Vec<HookPermissionBehavior> = Vec::new();

        for effects in effects_list {
            for effect in effects {
                match effect {
                    HookEffect::Message { text, is_error } => {
                        agg.messages.push((text, is_error));
                    }
                    HookEffect::BlockingError { message } => {
                        agg.blocking_error = Some(message);
                    }
                    HookEffect::PreventContinuation { reason } => {
                        agg.prevent_continuation = true;
                        if agg.stop_reason.is_none() {
                            agg.stop_reason = reason;
                        }
                    }
                    HookEffect::PermissionDecision {
                        behavior,
                        updated_input,
                        reason: _,
                    } => {
                        permission_behaviors.push(behavior);
                        if updated_input.is_some() {
                            agg.updated_input = updated_input;
                        }
                    }
                    HookEffect::UpdatedInput(input) => {
                        agg.updated_input = Some(input);
                    }
                    HookEffect::AdditionalContext(text) => {
                        agg.additional_context.push(text);
                    }
                    HookEffect::WatchPaths(paths) => {
                        agg.watch_paths.extend(paths);
                    }
                    HookEffect::WorktreePath(path) => {
                        agg.worktree_path = Some(path);
                    }
                }
            }
        }

        agg.permission_decision = HookPermissionBehavior::aggregate(&permission_behaviors);
        agg
    }
}
