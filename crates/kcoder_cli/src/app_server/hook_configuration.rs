//! Narrow, revision-checked user Hook edits. Never edits project or plugin files.
use super::engine_factory::AppServerEngineFactory;
use super::private_files::hex_sha256;
use super::protocol_io::{error_response, success_response};
use anyhow::{Context, Result, bail};
use kcoder_app_protocol::{
    HookConfigurationReadParams, HookConfigurationResult, HookConfigurationUpdateParams, method,
};
use serde_json::{Value, json};
use std::path::Path;

const MAX_HOOK_BYTES: usize = 256 * 1024;
#[derive(Debug)]
struct RevisionConflict;
impl std::fmt::Display for RevisionConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Hook configuration changed; reload before saving")
    }
}
impl std::error::Error for RevisionConflict {}

fn hooks(document: &Value) -> Value {
    document.get("hooks").cloned().unwrap_or_else(|| json!({}))
}
fn revision(value: &Value) -> Result<String> {
    Ok(hex_sha256(&serde_json::to_vec(value)?))
}
fn result(path: &Path, document: &Value) -> Result<HookConfigurationResult> {
    let hooks = hooks(document);
    if serde_json::to_vec(&hooks)?.len() > MAX_HOOK_BYTES {
        bail!("Hook configuration exceeds the management limit")
    }
    Ok(HookConfigurationResult {
        revision: revision(&hooks)?,
        hooks,
        configuration_path: path.to_string_lossy().into_owned(),
        applies_to_new_conversations: true,
    })
}
pub(super) fn read(path: &Path) -> Result<HookConfigurationResult> {
    result(path, &kcoder_config::read_settings_file(path)?)
}
pub(super) fn update(
    path: &Path,
    input: HookConfigurationUpdateParams,
) -> Result<HookConfigurationResult> {
    validate(&input.hooks)?;
    let document = kcoder_config::update_settings_file(path, |document| {
        if revision(&hooks(document))? != input.expected_revision {
            return Err(RevisionConflict.into());
        }
        let object = document
            .as_object_mut()
            .context("User settings must be an object")?;
        if input
            .hooks
            .as_object()
            .is_some_and(|object| object.is_empty())
        {
            object.remove("hooks");
        } else {
            object.insert("hooks".into(), input.hooks);
        }
        Ok(())
    })?;
    result(path, &document)
}

fn validate(value: &Value) -> Result<()> {
    if serde_json::to_vec(value)?.len() > MAX_HOOK_BYTES {
        bail!("Hook configuration exceeds 256 KiB")
    }
    let events = value.as_object().context("Hooks must be an event object")?;
    let mut actions = 0;
    for (event, rules) in events {
        if kcoder_hooks::HookEvent::parse(event).is_none() {
            bail!("Unknown Hook event")
        }
        let rules = rules
            .as_array()
            .context("Hook event rules must be arrays")?;
        for rule in rules {
            let object = rule.as_object().context("Hook rule must be an object")?;
            if object
                .keys()
                .any(|key| !matches!(key.as_str(), "matcher" | "hooks"))
            {
                bail!("Hook rule contains an unsupported or managed field")
            }
            let parsed: kcoder_hooks::HookMatcher = serde_json::from_value(rule.clone())
                .map_err(|_| anyhow::anyhow!("Invalid Hook rule configuration"))?;
            for raw in object
                .get("hooks")
                .and_then(Value::as_array)
                .context("Hook actions must be an array")?
            {
                let action = raw.as_object().context("Hook action must be an object")?;
                let allowed: &[&str] = match action.get("type").and_then(Value::as_str) {
                    Some("command") => &["type", "shell", "command", "if", "timeout", "async_hook"],
                    Some("prompt") => &["type", "prompt", "timeout", "model"],
                    Some("agent") => &["type", "instructions", "timeout", "max_turns", "model"],
                    Some("http") => &["type", "url", "method", "headers", "timeout"],
                    _ => bail!("Unsupported Hook action type"),
                };
                if action.keys().any(|key| !allowed.contains(&key.as_str())) {
                    bail!("Unsupported Hook action field")
                }
            }
            actions += parsed.hooks.len();
            if actions > 512 {
                bail!("Too many Hook actions")
            }
            for action in parsed.hooks {
                use kcoder_hooks::HookCommand;
                match action {
                    HookCommand::Command { command, shell, .. }
                        if command.trim().is_empty()
                            || shell.trim().is_empty()
                            || command.contains('\0')
                            || shell.contains('\0') =>
                    {
                        bail!("Hook commands and shells must be nonempty and contain no NUL")
                    }
                    HookCommand::Prompt { prompt, .. } if prompt.trim().is_empty() => {
                        bail!("Hook prompt must not be empty")
                    }
                    HookCommand::Agent {
                        instructions,
                        max_turns,
                        ..
                    } if instructions.trim().is_empty() || max_turns == 0 => {
                        bail!("Hook agent instructions and turn limit are required")
                    }
                    HookCommand::Http {
                        url,
                        method,
                        headers,
                        ..
                    } => {
                        let url = reqwest::Url::parse(&url)
                            .map_err(|_| anyhow::anyhow!("Invalid Hook HTTP URL"))?;
                        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                            bail!("Hook HTTP URL must use HTTP or HTTPS")
                        }
                        reqwest::Method::from_bytes(method.as_bytes())
                            .map_err(|_| anyhow::anyhow!("Invalid Hook HTTP method"))?;
                        for (name, value) in headers {
                            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                                .map_err(|_| anyhow::anyhow!("Invalid Hook header name"))?;
                            reqwest::header::HeaderValue::from_str(&value)
                                .map_err(|_| anyhow::anyhow!("Invalid Hook header value"))?;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

pub(super) async fn process(
    factory: AppServerEngineFactory,
    id: Value,
    operation: String,
    params: Value,
) -> Value {
    let write = operation == method::HOOK_CONFIGURATION_UPDATE;
    let input = if write {
        match serde_json::from_value::<HookConfigurationUpdateParams>(params) {
            Ok(input) => {
                if input.expected_revision.len() != 64
                    || !input
                        .expected_revision
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
                    || validate(&input.hooks).is_err()
                {
                    return failure(
                        id,
                        -32602,
                        "hook_config_invalid",
                        "Invalid user Hook configuration",
                    );
                }
                Some(input)
            }
            Err(_) => {
                return failure(
                    id,
                    -32602,
                    "hook_config_invalid",
                    "Invalid Hook configuration parameters",
                );
            }
        }
    } else {
        if serde_json::from_value::<HookConfigurationReadParams>(params).is_err() {
            return failure(
                id,
                -32602,
                "hook_config_invalid",
                "Hook read does not accept a settings path",
            );
        }
        None
    };
    let result = tokio::task::spawn_blocking(move || {
        let path = factory.hook_user_settings_path()?;
        match input {
            Some(input) => update(&path, input),
            None => read(&path),
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => success_response(
            id,
            serde_json::to_value(value).expect("Hook configuration serializes"),
        ),
        Ok(Err(error)) if error.downcast_ref::<RevisionConflict>().is_some() => failure(
            id,
            -32049,
            "hook_config_conflict",
            "Hook configuration changed; reload before saving",
        ),
        _ => failure(
            id,
            -32021,
            "hook_config_unavailable",
            "Could not read or save user Hook configuration",
        ),
    }
}
fn failure(id: Value, code: i64, kind: &str, message: &str) -> Value {
    let mut response = error_response(id, code, message);
    response["error"]["data"] = json!({"kind":kind});
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_is_narrow_revision_checked_and_delete_preserves_other_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"providers":{},"model":"fixture","plugins":{"runtime":{"enabled":true}}}"#,
        )
        .unwrap();
        let initial = read(&path).unwrap();
        let configuration =
            json!({"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo fixture"}]}]});
        let saved = update(
            &path,
            HookConfigurationUpdateParams {
                hooks: configuration.clone(),
                expected_revision: initial.revision.clone(),
            },
        )
        .unwrap();
        assert_eq!(saved.hooks, configuration);
        let stale = update(
            &path,
            HookConfigurationUpdateParams {
                hooks: json!({}),
                expected_revision: initial.revision,
            },
        );
        assert!(
            stale
                .err()
                .expect("stale write must fail")
                .downcast_ref::<RevisionConflict>()
                .is_some()
        );
        kcoder_config::update_settings_file(&path, |document| {
            document["model"] = json!("updated elsewhere");
            Ok(())
        })
        .unwrap();
        update(
            &path,
            HookConfigurationUpdateParams {
                hooks: json!({}),
                expected_revision: saved.revision,
            },
        )
        .unwrap();
        let document = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(document["model"], "updated elsewhere");
        assert_eq!(document["plugins"]["runtime"]["enabled"], true);
        assert!(document.get("hooks").is_none());
    }
    #[test]
    fn invalid_or_plugin_owned_sources_are_never_saved() {
        for value in [
            json!([]),
            json!({"NotAnEvent":[]}),
            json!({"Stop":[{"source":{"kind":"plugin"},"hooks":[]}]}),
            json!({"Stop":[{"hooks":[{"type":"command","command":"echo ok","async":true}]}]}),
            json!({"Stop":[{"hooks":[{"type":"http","url":"file:///private"}]}]}),
        ] {
            assert!(validate(&value).is_err());
        }
        assert!(validate(&json!({"Stop":[{"hooks":[{"type":"command","command":"echo ok","async_hook":true}]}]})).is_ok());
    }
}
