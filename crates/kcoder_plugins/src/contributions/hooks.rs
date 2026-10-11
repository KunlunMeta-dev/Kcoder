use crate::model::PluginHookDeclaration;
use kcoder_hooks::{HookEvent, HookMatcher, HooksSettings};
use serde_json::{Map, Value, json};

const MAX_HOOK_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct HookAdapterWarning {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Default)]
pub(crate) struct HookAdapterOutcome {
    pub matchers: Vec<(HookEvent, HookMatcher)>,
    pub warnings: Vec<HookAdapterWarning>,
}

pub(crate) fn resolve(
    declarations: &[PluginHookDeclaration],
) -> Result<HookAdapterOutcome, String> {
    let mut outcome = HookAdapterOutcome::default();
    for declaration in declarations {
        let value = match declaration {
            PluginHookDeclaration::Path(resource) => {
                let metadata = std::fs::symlink_metadata(&resource.absolute_path)
                    .map_err(|error| format!("failed to inspect Hook config: {error}"))?;
                if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
                    return Err("Hook config must be a regular non-symlink file".to_string());
                }
                if metadata.len() > MAX_HOOK_CONFIG_BYTES {
                    return Err(format!("Hook config exceeds {MAX_HOOK_CONFIG_BYTES} bytes"));
                }
                let contents = std::fs::read_to_string(&resource.absolute_path)
                    .map_err(|error| format!("failed to read Hook config: {error}"))?;
                serde_json::from_str::<Value>(&contents)
                    .map_err(|error| format!("failed to parse Hook config JSON: {error}"))?
            }
            PluginHookDeclaration::Inline(value) => value.clone(),
        };
        let adapted = adapt_value(value)?;
        outcome.matchers.extend(adapted.matchers);
        outcome.warnings.extend(adapted.warnings);
    }
    Ok(outcome)
}

fn adapt_value(value: Value) -> Result<HookAdapterOutcome, String> {
    let events = value.get("hooks").cloned().unwrap_or(value);
    let Value::Object(events) = events else {
        return Err("Hook declaration must be an object".to_string());
    };
    let mut adapted_events = Map::new();
    let mut warnings = Vec::new();

    for (event_name, groups) in events {
        let Value::Array(groups) = groups else {
            return Err(format!("Hook event `{event_name}` must contain an array"));
        };
        let mut adapted_groups = Vec::new();
        for group in groups {
            let Value::Object(mut group) = group else {
                return Err(format!(
                    "Hook event `{event_name}` contains a non-object group"
                ));
            };
            let matcher = group.remove("matcher");
            let actions = group
                .remove("hooks")
                .ok_or_else(|| format!("Hook event `{event_name}` group is missing `hooks`"))?;
            let Value::Array(actions) = actions else {
                return Err(format!(
                    "Hook event `{event_name}` group `hooks` must be an array"
                ));
            };
            let mut adapted_actions = Vec::new();
            for action in actions {
                if let Some(action) = adapt_action(action, &event_name, &mut warnings)? {
                    adapted_actions.push(action);
                }
            }
            if adapted_actions.is_empty() {
                continue;
            }
            let mut adapted_group = Map::new();
            if let Some(matcher) = matcher {
                adapted_group.insert("matcher".to_string(), matcher);
            }
            adapted_group.insert("hooks".to_string(), Value::Array(adapted_actions));
            adapted_groups.push(Value::Object(adapted_group));
        }
        if !adapted_groups.is_empty() {
            adapted_events.insert(event_name, Value::Array(adapted_groups));
        }
    }

    let settings: HooksSettings = serde_json::from_value(Value::Object(adapted_events))
        .map_err(|error| format!("failed to convert Hook declaration: {error}"))?;
    Ok(HookAdapterOutcome {
        matchers: settings.into_matchers(),
        warnings,
    })
}

fn adapt_action(
    action: Value,
    event_name: &str,
    warnings: &mut Vec<HookAdapterWarning>,
) -> Result<Option<Value>, String> {
    adapt_action_for_platform(action, event_name, warnings, cfg!(windows))
}

fn adapt_action_for_platform(
    action: Value,
    event_name: &str,
    warnings: &mut Vec<HookAdapterWarning>,
    windows: bool,
) -> Result<Option<Value>, String> {
    let Value::Object(action) = action else {
        return Err(format!(
            "Hook event `{event_name}` contains a non-object action"
        ));
    };
    let action_type = action
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Hook event `{event_name}` action is missing string `type`"))?;
    if action_type != "command" {
        warnings.push(HookAdapterWarning {
            code: "unsupported_hook_action",
            message: format!(
                "Hook event `{event_name}` action type `{action_type}` is parsed but not activated"
            ),
        });
        return Ok(None);
    }

    let command = if windows {
        action
            .get("commandWindows")
            .or_else(|| action.get("command"))
    } else {
        action.get("command")
    };
    let command = command
        .and_then(Value::as_str)
        .filter(|command| !command.trim().is_empty())
        .ok_or_else(|| format!("Hook event `{event_name}` command action has no command"))?;
    let timeout = action
        .get("timeout")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| format!("Hook event `{event_name}` timeout must be an integer"))
        })
        .transpose()?
        .unwrap_or(600);
    let async_hook = action
        .get("async")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| format!("Hook event `{event_name}` async must be a boolean"))
        })
        .transpose()?
        .unwrap_or(false);
    // Generic plugin commands use POSIX expansion on every platform. PowerShell
    // would treat ${CLAUDE_PLUGIN_ROOT} as a normal variable instead of an environment variable.
    let shell = if windows && action.contains_key("commandWindows") {
        "powershell.exe"
    } else {
        "bash"
    };

    Ok(Some(json!({
        "type": "command",
        "shell": shell,
        "command": command,
        "timeout": timeout,
        "async_hook": async_hook
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_plugin_hooks_keep_bash_expansion_on_windows() {
        let command = r#"bash "${CLAUDE_PLUGIN_ROOT}/hooks/suggest-endor-tools.sh""#;
        let result = adapt_action_for_platform(
            json!({"type":"command", "command":command}),
            "UserPromptSubmit",
            &mut Vec::new(),
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["shell"], "bash");
        assert_eq!(result["command"], command);
    }

    #[test]
    fn explicit_windows_command_uses_powershell_and_linux_keeps_generic_command() {
        let action = json!({"type":"command", "command":"echo generic", "commandWindows":"Write-Output $env:CLAUDE_PLUGIN_ROOT"});
        let windows =
            adapt_action_for_platform(action.clone(), "SessionStart", &mut Vec::new(), true)
                .unwrap()
                .unwrap();
        assert_eq!(windows["shell"], "powershell.exe");
        assert_eq!(windows["command"], action["commandWindows"]);
        let linux = adapt_action_for_platform(action, "SessionStart", &mut Vec::new(), false)
            .unwrap()
            .unwrap();
        assert_eq!(linux["shell"], "bash");
        assert_eq!(linux["command"], "echo generic");
    }
}
