//! Session-owned MCP launch descriptions; never persistent user configuration.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Capability for temporary MCP servers supplied when creating a thread.
pub const CAPABILITY_THREAD_MCP_SERVERS_V1: &str = "threadMcpServersV1";
/// Maximum number of temporary servers accepted for one thread.
pub const THREAD_MCP_SERVER_LIMIT: usize = 16;
/// Sanitized session-MCP setup failure; its message contains no private launch data.
pub const THREAD_MCP_SETUP_FAILED: i64 = -32062;

/// A client-provided stdio server whose environment is private to its connection.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", schemars(deny_unknown_fields))]
pub struct ThreadMcpServerV1 {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

pub(crate) fn deserialize_thread_mcp_servers<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<ThreadMcpServerV1>, D::Error> {
    let values = Vec::<ThreadMcpServerV1>::deserialize(deserializer)?;
    if values.len() > THREAD_MCP_SERVER_LIMIT {
        return Err(serde::de::Error::custom("temporary MCP server limit is 16"));
    }
    let mut names = std::collections::BTreeSet::new();
    if values.iter().any(|server| !names.insert(&server.name)) {
        return Err(serde::de::Error::custom(
            "temporary MCP server names must be unique",
        ));
    }
    Ok(values)
}

impl std::fmt::Debug for ThreadMcpServerV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ThreadMcpServerV1")
            .field("name", &self.name)
            .field("launch", &"[private]")
            .finish()
    }
}

impl ThreadMcpServerV1 {
    /// Validate launch data without including private values in diagnostics.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty()
            || self.name.len() > 128
            || self.name.starts_with("plugin.")
            || !self
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        {
            return Err("invalid temporary MCP /name: expected a nonreserved identifier".into());
        }
        if self.command.is_empty() || self.command.len() > 32768 || self.command.contains('\0') {
            return Err(
                "invalid temporary MCP /command: expected a bounded executable path".into(),
            );
        }
        if self.args.len() > 128
            || self
                .args
                .iter()
                .any(|arg| arg.len() > 16384 || arg.contains('\0'))
        {
            return Err(
                "invalid temporary MCP /args: expected at most 128 bounded arguments".into(),
            );
        }
        if self.env.len() > 32
            || self.env.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 128
                    || key.contains(['=', '\0'])
                    || value.len() > 16384
                    || value.contains('\0')
            })
        {
            return Err(
                "invalid temporary MCP /env: expected at most 32 bounded environment entries"
                    .into(),
            );
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for ThreadMcpServerV1 {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Fields {
            name: String,
            command: String,
            #[serde(default)]
            args: Vec<String>,
            #[serde(default)]
            env: BTreeMap<String, String>,
        }
        let fields = Fields::deserialize(deserializer)?;
        let value = Self {
            name: fields.name,
            command: fields.command,
            args: fields.args,
            env: fields.env,
        };
        value.validate().map_err(serde::de::Error::custom)?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn temporary_server_debug_never_discloses_launch_values() {
        let server: ThreadMcpServerV1 = serde_json::from_value(json!({
            "name": "editor", "command": "private-command", "args": ["private-argument"],
            "env": {"TOKEN": "private-token"}
        }))
        .unwrap();
        let debug = format!("{server:?}");
        for value in ["private-command", "private-argument", "private-token"] {
            assert!(!debug.contains(value));
        }
        assert_eq!(
            serde_json::to_value(server).unwrap()["env"]["TOKEN"],
            "private-token"
        );
    }

    #[test]
    fn temporary_server_rejects_unbounded_or_ambiguous_launch_data() {
        for patch in [
            json!({"name":"plugin.reserved"}),
            json!({"command":""}),
            json!({"env":{"INVALID=KEY":"secret"}}),
            json!({"transport":"http"}),
            json!({"args":["x".repeat(16385)]}),
        ] {
            let mut value = json!({"name":"editor", "command":"/usr/bin/node"});
            value
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            let error = serde_json::from_value::<ThreadMcpServerV1>(value)
                .unwrap_err()
                .to_string();
            assert!(!error.contains("secret"));
        }
    }

    #[test]
    fn legacy_creation_remains_compatible_and_temporary_lists_are_bounded() {
        let legacy: crate::ThreadStartParams = serde_json::from_value(json!({})).unwrap();
        assert!(legacy.mcp_servers.is_empty());
        assert!(
            serde_json::to_value(legacy)
                .unwrap()
                .get("mcpServers")
                .is_none()
        );
        let server = json!({"name":"editor", "command":"/usr/bin/node"});
        assert!(
            serde_json::from_value::<crate::ThreadStartParams>(
                json!({"mcpServers":[server.clone(), server.clone()]})
            )
            .is_err()
        );
        let servers = (0..17)
            .map(|i| json!({"name":format!("server-{i}"), "command":"node"}))
            .collect::<Vec<_>>();
        assert!(
            serde_json::from_value::<crate::ThreadStartParams>(json!({"mcpServers":servers}))
                .is_err()
        );
        let valid: crate::ThreadStartParams =
            serde_json::from_value(json!({"mcpServers":[server]})).unwrap();
        assert_eq!(valid.mcp_servers.len(), 1);
    }
}
