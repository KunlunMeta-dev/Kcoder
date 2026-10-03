use crate::model::PluginMcpDeclaration;
use kcoder_config::McpServerConfig;
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;

const MAX_MCP_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Default, Deserialize)]
struct RawMcpServerConfig {
    #[serde(default, rename = "type", alias = "transport")]
    transport: Option<String>,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    headers: HashMap<String, String>,
}

pub(crate) fn resolve(
    plugin_id: &str,
    plugin_root: &Path,
    declaration: &PluginMcpDeclaration,
) -> Result<Vec<McpServerConfig>, String> {
    let value = match declaration {
        PluginMcpDeclaration::Path(resource) => {
            let metadata = std::fs::symlink_metadata(&resource.absolute_path)
                .map_err(|error| format!("failed to inspect MCP config: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
                return Err("MCP config must be a regular non-symlink file".to_string());
            }
            if metadata.len() > MAX_MCP_CONFIG_BYTES {
                return Err(format!("MCP config exceeds {MAX_MCP_CONFIG_BYTES} bytes"));
            }
            let contents = std::fs::read_to_string(&resource.absolute_path)
                .map_err(|error| format!("failed to read MCP config: {error}"))?;
            serde_json::from_str::<Value>(&contents)
                .map_err(|error| format!("failed to parse MCP config JSON: {error}"))?
        }
        PluginMcpDeclaration::Inline(value) => value.clone(),
    };

    let servers = server_map(value)?;
    let mut names = servers.keys().cloned().collect::<Vec<_>>();
    names.sort();
    let mut resolved_names = BTreeSet::new();
    names
        .into_iter()
        .map(|name| {
            let resolved_name = canonical_server_name(&name)?;
            if !resolved_names.insert(resolved_name.clone()) {
                return Err("MCP server names collide after normalization".into());
            }
            let raw = serde_json::from_value::<RawMcpServerConfig>(servers[&name].clone())
                .map_err(|error| format!("invalid MCP server `{name}`: {error}"))?;
            let plugin_root = plugin_root.to_str().ok_or_else(|| {
                format!("invalid MCP server `{name}`: plugin root is not valid UTF-8")
            })?;
            let expand = |value: &str| {
                expand_mcp_variables(value, plugin_root, |name| std::env::var(name).ok())
            };
            let command = if raw.command == "${QODER_NODE_RUNTIME}" && std::env::var("QODER_NODE_RUNTIME").ok().is_none_or(|value| value.is_empty()) {
                which::which("node").map_err(|_| "This Qoder MCP server requires Node.js on the execution target (node was not found on PATH)".to_string())?.to_string_lossy().into_owned()
            } else { expand(&raw.command)? };
            let args = raw
                .args
                .iter()
                .map(|value| expand(value))
                .collect::<Result<Vec<_>, _>>()?;
            let url = expand(&raw.url)?;
            let mut env = raw
                .env
                .into_iter()
                .map(|(key, value)| expand(&value).map(|expanded| (key, expanded)))
                .collect::<Result<HashMap<_, _>, _>>()?;
            for name in [
                "CLAUDE_PLUGIN_ROOT",
                "CODEX_PLUGIN_ROOT",
                "GROK_PLUGIN_ROOT",
                "CODEBUDDY_PLUGIN_ROOT",
                "QODER_PLUGIN_ROOT",
                "TRAE_PLUGIN_ROOT",
                "PLUGIN_ROOT",
            ] {
                env.insert(name.to_string(), plugin_root.to_string());
            }
            let headers = raw
                .headers
                .into_iter()
                .map(|(key, value)| expand(&value).map(|expanded| (key, expanded)))
                .collect::<Result<HashMap<_, _>, _>>()?
                .into_iter()
                .filter(|(_, value)| !value.is_empty())
                .collect();
            let transport = match raw.transport.as_deref() {
                Some("streamable-http") => "http".to_string(),
                Some(value) => value.to_string(),
                None => "stdio".to_string(),
            };
            match transport.as_str() {
                "stdio" if command.trim().is_empty() => {
                    return Err(format!(
                        "invalid MCP server `{name}`: stdio transport requires command"
                    ));
                }
                "http" | "sse" if url.trim().is_empty() => {
                    return Err(format!(
                        "invalid MCP server `{name}`: {transport} transport requires url"
                    ));
                }
                "stdio" | "http" | "sse" => {}
                _ => {
                    return Err(format!(
                        "invalid MCP server `{name}`: unsupported transport `{transport}`"
                    ));
                }
            }
            Ok(McpServerConfig {
                name: format!("plugin.{plugin_id}.{resolved_name}"),
                transport,
                command,
                args,
                url,
                env,
                headers,
            })
        })
        .collect()
}

fn expand_mcp_variables(
    value: &str,
    plugin_root: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let mut output = String::with_capacity(value.len());
    let mut remaining = value;
    while let Some(start) = remaining.find("${") {
        output.push_str(&remaining[..start]);
        let expression = &remaining[start + 2..];
        let end = expression
            .find('}')
            .ok_or("Unclosed MCP environment variable")?;
        let expression = &expression[..end];
        let (name, fallback) = expression
            .split_once(":-")
            .map_or((expression, None), |(name, value)| (name, Some(value)));
        let connector = name
            .strip_prefix("connector.")
            .and_then(|value| value.split_once('.'));
        let connector_keys = if let Some((service, field)) = connector {
            if service.is_empty()
                || field.is_empty()
                || !service
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                || !field
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            {
                return Err("Unsupported MCP connector credential expression".into());
            }
            let alias = format!(
                "{}_{}",
                service.replace('-', "_").to_ascii_uppercase(),
                field.to_ascii_uppercase()
            );
            Some((format!("KCODER_CONNECTOR_{alias}"), alias))
        } else {
            None
        };
        let mut characters = name.chars();
        if (connector_keys.is_none()
            && (!characters
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                || !characters.all(|c| c.is_ascii_alphanumeric() || c == '_')))
            || fallback.is_some_and(|value| value.contains("${"))
        {
            return Err("Unsupported MCP environment variable expression".into());
        }
        let resolved = if let Some((key, alias)) = &connector_keys {
            lookup(key)
                .or_else(|| lookup(alias))
                .filter(|value| !value.is_empty())
        } else {
            match name {
                "CLAUDE_PLUGIN_ROOT"
                | "CODEX_PLUGIN_ROOT"
                | "GROK_PLUGIN_ROOT"
                | "CODEBUDDY_PLUGIN_ROOT"
                | "QODER_PLUGIN_ROOT"
                | "TRAE_PLUGIN_ROOT"
                | "PLUGIN_ROOT" => Some(plugin_root.to_owned()),
                _ => lookup(name),
            }
        };
        let resolved = match (resolved, fallback) {
            (Some(value), Some(fallback)) if value.is_empty() => fallback.to_owned(),
            (Some(value), _) => value,
            (None, Some(fallback)) => fallback.to_owned(),
            (None, None) => {
                return Err(if let Some((key, alias)) = connector_keys {
                    format!(
                        "MCP connector credential `{name}` is not configured; set `{key}` or `{alias}` on the execution target. Host application login is not shared with KCoder"
                    )
                } else {
                    format!("MCP environment variable `{name}` is not set")
                });
            }
        };
        // Substitute data once; never evaluate shell syntax or recursively expand secrets.
        output.push_str(&resolved);
        remaining = &remaining[start + 2 + end + 1..];
    }
    output.push_str(remaining);
    Ok(output)
}

fn server_map(value: Value) -> Result<Map<String, Value>, String> {
    let Value::Object(mut object) = value else {
        return Err("MCP declaration must be a JSON object".to_string());
    };
    if let Some(servers) = object.remove("mcpServers") {
        let Value::Object(servers) = servers else {
            return Err("MCP field `mcpServers` must be an object".to_string());
        };
        return Ok(servers);
    }
    object.remove("$schema");
    Ok(object)
}

fn canonical_server_name(name: &str) -> Result<String, String> {
    if validate_server_name(name).is_ok() {
        return Ok(name.into());
    }
    if name.trim().is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        return Err("MCP server label must be nonempty, at most 256 bytes and contain no control characters".into());
    }
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .take(48)
        .collect();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "server" } else { slug };
    let hash = format!("{:x}", Sha256::digest(name.as_bytes()));
    Ok(format!("{slug}-{}", &hash[..12]))
}

fn validate_server_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        });
    if valid {
        Ok(())
    } else {
        Err(format!(
            "invalid MCP server name `{name}`; expected ASCII letters, digits, '-', '_' or '.'"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn connector_credentials_use_explicit_target_environment_without_inventing_secrets() {
        let token = "${connector.gitee.ACCESS_TOKEN}";
        assert_eq!(
            expand_mcp_variables(token, "/plugin", |key| (key == "GITEE_ACCESS_TOKEN")
                .then(|| "synthetic".into()))
            .unwrap(),
            "synthetic"
        );
        assert_eq!(
            expand_mcp_variables(token, "/plugin", |key| (key
                == "KCODER_CONNECTOR_GITEE_ACCESS_TOKEN")
                .then(|| "${OPAQUE}".into()))
            .unwrap(),
            "${OPAQUE}"
        );
        let error = expand_mcp_variables(token, "/plugin", |_| None).unwrap_err();
        assert!(error.contains("GITEE_ACCESS_TOKEN"));
        assert!(error.contains("login is not shared"));
        assert!(
            expand_mcp_variables("${connector.gitee.ACCESS_TOKEN.extra}", "/plugin", |_| None)
                .is_err()
        );
    }

    #[test]
    fn mcp_display_labels_become_stable_distinct_identifiers() {
        assert_eq!(
            canonical_server_name("normal.server").unwrap(),
            "normal.server"
        );
        let first = canonical_server_name("Adobe for creativity").unwrap();
        assert!(validate_server_name(&first).is_ok());
        assert_eq!(
            first,
            canonical_server_name("Adobe for creativity").unwrap()
        );
        assert_ne!(
            first,
            canonical_server_name("Adobe-for-creativity").unwrap()
        );
        assert!(validate_server_name(&canonical_server_name("邮箱").unwrap()).is_ok());
        assert!(canonical_server_name("server\nname").is_err());
        assert!(canonical_server_name(" ").is_err());
    }

    #[test]
    fn mcp_variables_support_defaults_without_shell_execution_or_recursive_expansion() {
        let lookup = |name: &str| match name {
            "KEY" => Some("synthetic-key".into()),
            "EMPTY" => Some(String::new()),
            "OPAQUE" => Some("${KEY}".into()),
            _ => None,
        };
        assert_eq!(
            expand_mcp_variables("Bearer ${KEY}", "/plugin", lookup).unwrap(),
            "Bearer synthetic-key"
        );
        assert_eq!(
            expand_mcp_variables("${MISSING:-fallback}:${EMPTY:-default}", "/plugin", lookup)
                .unwrap(),
            "fallback:default"
        );
        assert_eq!(
            expand_mcp_variables("${CLAUDE_PLUGIN_ROOT}/server.js", "C:/plugin path", lookup)
                .unwrap(),
            "C:/plugin path/server.js"
        );
        for name in [
            "GROK_PLUGIN_ROOT",
            "CODEBUDDY_PLUGIN_ROOT",
            "QODER_PLUGIN_ROOT",
            "TRAE_PLUGIN_ROOT",
        ] {
            assert_eq!(
                expand_mcp_variables(
                    &format!("${{{name}}}/script.js"),
                    "/owned-plugin",
                    |_| Some("/untrusted-override".into())
                )
                .unwrap(),
                "/owned-plugin/script.js"
            );
        }
        assert_eq!(
            expand_mcp_variables("${OPAQUE}", "/plugin", lookup).unwrap(),
            "${KEY}"
        );
        assert_eq!(
            expand_mcp_variables("$(echo no-evaluation)", "/plugin", lookup).unwrap(),
            "$(echo no-evaluation)"
        );
        assert!(expand_mcp_variables("${MISSING}", "/plugin", lookup).is_err());
        assert!(expand_mcp_variables("${MISSING", "/plugin", lookup).is_err());
        assert!(expand_mcp_variables("${MISSING:-${KEY}}", "/plugin", lookup).is_err());
    }

    #[test]
    fn agent_plugins_streamable_http_transport_maps_to_runtime_http() {
        let declaration = PluginMcpDeclaration::Inline(json!({"mcpServers": {"exa": {
            "type": "streamable-http", "url": "https://example.invalid/mcp", "headers": {"x-source":"agent-plugin"}
        }}}));
        let configs = resolve("exa@market", Path::new("/plugins/exa"), &declaration).unwrap();
        assert_eq!(configs[0].transport, "http");
        assert_eq!(configs[0].headers["x-source"], "agent-plugin");
    }

    #[test]
    fn optional_mcp_header_templates_are_not_sent_as_literal_credentials() {
        let declaration = PluginMcpDeclaration::Inline(json!({"mcpServers": {"docs": {
            "type": "http", "url": "https://example.invalid/mcp",
            "headers": {"Authorization": "${KCODER_MCP_MISSING_OPTIONAL_2f4:-}"}
        }}}));
        let configs = resolve("docs@market", Path::new("/plugins/docs"), &declaration).unwrap();
        assert!(
            configs[0].headers.is_empty(),
            "unset optional credentials must not be sent"
        );
    }

    #[test]
    fn required_mcp_environment_variables_fail_without_exposing_values() {
        let declaration = PluginMcpDeclaration::Inline(json!({"mcpServers": {"docs": {
            "type": "http", "url": "https://example.invalid/mcp",
            "headers": {"Authorization": "Bearer ${KCODER_MCP_MISSING_REQUIRED_2f4}"}
        }}}));
        let error = resolve("docs@market", Path::new("/plugins/docs"), &declaration).unwrap_err();
        assert!(error.contains("KCODER_MCP_MISSING_REQUIRED_2f4"));
        assert!(!error.contains("Bearer"));
    }
}
