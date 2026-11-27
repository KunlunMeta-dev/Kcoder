//! External MCP definitions are data; inspection never launches a command or helper.
use crate::{
    adapters::{issue, safe_endpoint, safe_text},
    model::{McpCandidate, NormalizedItem},
};
use kcoder_types::{
    McpServerConfig,
    migration::{
        MigrationIssueCode as Code, MigrationIssuePhase as Phase,
        MigrationIssueSeverity as Severity, MigrationItemStatus as Status,
    },
};
use serde_json::Value;

pub(crate) fn normalize(item: &mut NormalizedItem, definition: &Value, secrets: &[&str]) {
    let fields = definition
        .as_object()
        .expect("adapter validates the object");
    let mut config: McpServerConfig =
        serde_json::from_value(serde_json::json!({"name":item.preview.source_name}))
            .expect("default MCP fields deserialize");
    let mut problems = Vec::new();
    let transport = fields
        .get("type")
        .or_else(|| fields.get("transport"))
        .and_then(Value::as_str)
        .unwrap_or(if fields.contains_key("url") {
            "http"
        } else {
            "stdio"
        });
    config.transport = transport.into();
    if !matches!(transport, "stdio" | "http" | "sse") {
        problems.push(issue(
            Code::UnsupportedSourceFormat,
            Severity::Blocking,
            "transport",
        ));
    }
    config.command = safe_text(fields.get("command"), 4096, secrets).unwrap_or_default();
    if let Some(value) = fields.get("args") {
        match strings(value, true) {
            Some(values)
                if values.iter().all(|value| {
                    safe_text(Some(&Value::String(value.clone())), 16384, secrets).is_some()
                        && !value.contains("${")
                        && !sensitive_argument(value)
                }) =>
            {
                config.args = values
            }
            _ => problems.push(issue(Code::RequiresReview, Severity::Blocking, "args")),
        }
    }
    if let Some(value) = fields.get("url") {
        config.url = safe_endpoint(Some(value), secrets).unwrap_or_default();
        if config.url.is_empty() {
            problems.push(issue(Code::InvalidEndpoint, Severity::Blocking, "url"));
        }
    }
    if (transport == "stdio" && (config.command.is_empty() || !config.url.is_empty()))
        || (transport != "stdio"
            && (config.url.is_empty() || !config.command.is_empty() || !config.args.is_empty()))
    {
        problems.push(issue(
            Code::InvalidArguments,
            Severity::Blocking,
            "transport",
        ));
    }
    let cwd = safe_text(fields.get("cwd"), 4096, secrets);
    if let Some(value) = &cwd {
        if std::path::Path::new(value).is_absolute() {
            config.policy.cwd = Some(value.clone());
        } else {
            problems.push(issue(Code::RequiresReview, Severity::Blocking, "cwd"));
        }
    } else if fields.contains_key("cwd") {
        problems.push(issue(Code::RequiresReview, Severity::Blocking, "cwd"));
    }
    if config.policy.cwd.is_none()
        && ((config.command.contains(['/', '\\'])
            && !std::path::Path::new(&config.command).is_absolute())
            || config
                .args
                .iter()
                .any(|value| value.starts_with("./") || value.starts_with("../")))
    {
        problems.push(issue(Code::RequiresReview, Severity::Blocking, "cwd"));
    }
    for (field, target) in [("enabled_tools", &mut config.policy.enabled_tools)] {
        if let Some(value) = fields.get(field) {
            match strings(value, false) {
                Some(names) => *target = Some(names),
                None => problems.push(issue(Code::InvalidArguments, Severity::Blocking, field)),
            }
        }
    }
    for (field, target) in [
        ("disabled_tools", &mut config.policy.disabled_tools),
        ("env_vars", &mut config.policy.env_vars),
    ] {
        if let Some(value) = fields.get(field) {
            match strings(value, false) {
                Some(names) => *target = names,
                None => problems.push(issue(Code::InvalidArguments, Severity::Blocking, field)),
            }
        }
    }
    if let Some(value) = fields.get("env") {
        if let Some(values) = value.as_object() {
            for (name, value) in values {
                config.policy.env_vars.retain(|key| key != name);
                if let Some(variable) = value.as_str().and_then(variable) {
                    config
                        .policy
                        .env_aliases
                        .insert(name.clone(), variable.into());
                } else {
                    config.policy.required_env.push(name.clone());
                }
            }
        } else {
            problems.push(issue(Code::InvalidArguments, Severity::Blocking, "env"));
        }
    }
    for field in ["headers", "http_headers"] {
        if let Some(value) = fields.get(field) {
            if let Some(values) = value.as_object() {
                for (name, value) in values {
                    match value.as_str() {
                        Some(value)
                            if name.eq_ignore_ascii_case("authorization")
                                && value.starts_with("Bearer ")
                                && variable(&value[7..]).is_some() =>
                        {
                            config.policy.bearer_token_env_var =
                                variable(&value[7..]).map(str::to_owned)
                        }
                        Some(value) if variable(value).is_some() => {
                            config
                                .policy
                                .env_http_headers
                                .insert(name.clone(), variable(value).unwrap().into());
                        }
                        _ => config.policy.required_headers.push(name.clone()),
                    }
                }
            } else {
                problems.push(issue(Code::InvalidArguments, Severity::Blocking, "headers"));
            }
        }
    }
    if let Some(value) = fields.get("env_http_headers") {
        match serde_json::from_value::<std::collections::HashMap<String, String>>(value.clone()) {
            Ok(values) => {
                for (name, variable) in values {
                    if config
                        .policy
                        .env_http_headers
                        .keys()
                        .chain(config.policy.required_headers.iter())
                        .any(|key| key.eq_ignore_ascii_case(&name))
                    {
                        problems.push(issue(Code::RequiresReview, Severity::Blocking, "headers"));
                    }
                    config.policy.env_http_headers.insert(name, variable);
                }
            }
            Err(_) => problems.push(issue(
                Code::InvalidArguments,
                Severity::Blocking,
                "env_http_headers",
            )),
        }
    }
    if let Some(value) = fields.get("bearer_token_env_var") {
        config.policy.bearer_token_env_var = safe_text(Some(value), 128, secrets);
        if config.policy.bearer_token_env_var.is_none() {
            problems.push(issue(
                Code::InvalidArguments,
                Severity::Blocking,
                "bearer_token_env_var",
            ));
        }
    }
    for (field, target) in [
        (
            "startup_timeout_sec",
            &mut config.policy.startup_timeout_secs,
        ),
        ("tool_timeout_sec", &mut config.policy.tool_timeout_secs),
    ] {
        if let Some(value) = fields.get(field) {
            *target = value.as_u64().filter(|value| (1..=3600).contains(value));
            if target.is_none() {
                problems.push(issue(Code::InvalidArguments, Severity::Blocking, field));
            }
        }
    }
    let known = [
        "type",
        "transport",
        "command",
        "args",
        "url",
        "cwd",
        "env",
        "env_vars",
        "headers",
        "http_headers",
        "env_http_headers",
        "bearer_token_env_var",
        "enabled_tools",
        "disabled_tools",
        "enabled",
        "disabled",
        "startup_timeout_sec",
        "tool_timeout_sec",
    ];
    if fields.keys().any(|field| !known.contains(&field.as_str())) {
        problems.push(issue(Code::UnsupportedField, Severity::Blocking, "mcp"));
    }
    for field in ["enabled", "disabled"] {
        if fields.get(field).is_some_and(|value| !value.is_boolean()) {
            problems.push(issue(Code::InvalidArguments, Severity::Blocking, field));
        }
    }
    if !config.policy.required_env.is_empty() || !config.policy.required_headers.is_empty() {
        problems.push(issue(Code::SecretExcluded, Severity::Notice, "credentials"));
        problems.push(issue(
            Code::CredentialResolutionRequired,
            Severity::Blocking,
            "credentials",
        ));
    }
    let mut activation = issue(Code::RequiresReview, Severity::Blocking, "activation");
    activation.phase = Phase::Activation;
    problems.push(activation);
    let mut public_names = config
        .policy
        .env_vars
        .iter()
        .chain(config.policy.env_aliases.keys())
        .chain(config.policy.env_aliases.values())
        .chain(config.policy.required_env.iter())
        .chain(config.policy.env_http_headers.keys())
        .chain(config.policy.env_http_headers.values())
        .chain(config.policy.required_headers.iter())
        .chain(config.policy.bearer_token_env_var.iter())
        .chain(config.policy.enabled_tools.iter().flatten())
        .chain(config.policy.disabled_tools.iter());
    if public_names
        .any(|name| safe_text(Some(&Value::String(name.clone())), 16384, secrets).is_none())
        || kcoder_mcp_policy::validate(&config).is_err()
    {
        problems.push(issue(Code::InvalidArguments, Severity::Blocking, "mcp"));
        item.preview.issues = problems;
        item.preview.selected_by_default = false;
        item.preview.status = Status::RequiresAction;
        item.mcp = None;
        return;
    }
    item.preview.issues = problems;
    item.preview.selected_by_default = !item
        .preview
        .issues
        .iter()
        .any(|issue| issue.blocks_import());
    item.preview.status = if item
        .preview
        .issues
        .iter()
        .any(|issue| issue.blocks_import())
    {
        Status::RequiresAction
    } else {
        Status::Discovered
    };
    item.mcp = Some(McpCandidate {
        config,
        enabled_in_source: fields
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
            && !fields
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        source_cwd: cwd,
    });
}

fn strings(value: &Value, allow_empty: bool) -> Option<Vec<String>> {
    let values = value.as_array()?;
    if values.len() > 4096 {
        return None;
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| {
                    (allow_empty || !value.is_empty())
                        && value.len() <= 16384
                        && !value.chars().any(char::is_control)
                })
                .map(str::to_owned)
        })
        .collect()
}
fn variable(value: &str) -> Option<&str> {
    let name = value.strip_prefix("${")?.strip_suffix('}')?;
    kcoder_config::plugin_credentials::validate_name(name).ok()?;
    Some(name)
}
fn sensitive_argument(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "--token",
        "--api-key",
        "--password",
        "--secret",
        "authorization:",
        "token=",
        "api_key=",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

#[cfg(test)]
mod private_metadata_tests {
    use crate::parse_claude_settings;
    use serde_json::json;
    #[test]
    fn source_private_values_cannot_be_echoed_through_slot_names_or_tool_restrictions() {
        let token = "SYNTHETIC_MCP_METADATA_PRIVATE";
        for mcp in [
            json!({"command":"never-run","env":{token:"another-private-value"}}),
            json!({"type":"http","url":"https://example.invalid/mcp","headers":{"Authorization":format!("Bearer {token}")},"enabled_tools":[token]}),
        ] {
            let source =
                json!({"env":{"ANTHROPIC_API_KEY":token},"mcpServers":{"docs":mcp}}).to_string();
            let inventory = parse_claude_settings(&source).unwrap();
            assert!(!serde_json::to_string(&inventory).unwrap().contains(token));
            let item = inventory
                .items
                .iter()
                .find(|item| item.preview.source_name == "docs")
                .unwrap();
            assert!(item.mcp.is_none());
            assert!(
                item.preview
                    .issues
                    .iter()
                    .any(|issue| issue.blocks_import())
            );
        }
    }
    #[test]
    fn authorization_tokens_are_private_even_when_echoed_without_their_scheme() {
        let token = "SYNTHETIC_BARE_AUTH_TOKEN";
        let source = json!({"mcpServers":{"docs":{"type":"http","url":"https://example.invalid/mcp","headers":{"Authorization":format!("Bearer {token}")},"disabled_tools":[token]}}}).to_string();
        let inventory = parse_claude_settings(&source).unwrap();
        assert!(!serde_json::to_string(&inventory).unwrap().contains(token));
        assert!(
            inventory
                .items
                .iter()
                .find(|item| item.preview.source_name == "docs")
                .unwrap()
                .mcp
                .is_none()
        );
    }
}
