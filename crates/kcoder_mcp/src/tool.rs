use crate::client::McpClient;
use crate::model::{CallToolResult, McpToolDefinition};
use async_trait::async_trait;
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolSource};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error};

/// Shared handle to a single MCP server connection. All tools from the same
/// server share this handle so they reuse one stdio transport.
pub type McpServerHandle = Arc<Mutex<McpClient>>;

/// A tool that proxies calls to an external MCP server.
pub struct McpTool {
    server_name: String,
    exposed_name: String,
    handle: McpServerHandle,
    definition: McpToolDefinition,
    plugin_id: Option<String>,
}

impl McpTool {
    pub fn new(
        server_name: impl Into<String>,
        handle: McpServerHandle,
        definition: McpToolDefinition,
    ) -> Self {
        let server_name = server_name.into();
        let exposed_name = mcp_tool_name(&server_name, &definition.name);
        Self {
            server_name,
            exposed_name,
            handle,
            definition,
            plugin_id: None,
        }
    }

    /// Attach the exact plugin identity supplied by the host contribution snapshot.
    pub fn with_plugin_source(mut self, plugin_id: impl Into<String>) -> Self {
        self.plugin_id = Some(plugin_id.into());
        self
    }
}

#[async_trait]
impl Tool for McpTool {
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn name(&self) -> String {
        self.exposed_name.clone()
    }

    fn source(&self) -> ToolSource {
        match &self.plugin_id {
            Some(plugin) => ToolSource::Plugin {
                plugin: plugin.clone(),
                server: self.server_name.clone(),
                tool: self.definition.name.clone(),
            },
            None => ToolSource::Mcp {
                server: self.server_name.clone(),
                tool: self.definition.name.clone(),
            },
        }
    }

    fn description(&self) -> String {
        format!(
            "[MCP: {}::{}] {}",
            self.server_name, self.definition.name, self.definition.description
        )
    }

    fn input_schema(&self) -> Value {
        self.definition.input_schema.clone()
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let mut client = self.handle.lock().await;
        debug!(
            "calling MCP tool {}::{}",
            self.server_name, self.definition.name
        );

        match client.call_tool(&self.definition.name, input).await {
            Ok(result) => Ok(convert_result(result)),
            Err(e) => {
                error!(
                    "MCP tool {}::{} call failed: {}",
                    self.server_name, self.definition.name, e
                );
                Ok(ToolOutput::error(format!(
                    "MCP server '{}' tool '{}' failed: {}",
                    self.server_name, self.definition.name, e
                )))
            }
        }
    }
}

pub fn mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    let server = sanitize_tool_name_part(server_name, "server");
    let tool = sanitize_tool_name_part(tool_name, "tool");
    let name = format!("mcp__{}__{}", server, tool);
    // Strict providers (Anthropic) cap tool names at 64 characters; an
    // overlong name rejects the whole request. Truncate with a stable hash
    // suffix so two tools that only differ past the cut point don't collapse
    // into the same registry entry.
    const MAX_LEN: usize = 64;
    if name.len() <= MAX_LEN {
        return name;
    }
    let hash = stable_name_hash(&name);
    // Fixed syntax and hash consume 24 bytes:
    // `mcp__` (5) + `__` (2) + `_` (1) + 16 hex digits. The sanitized
    // components are ASCII, so an 18/22 split uses the remaining 40 bytes
    // exactly and can never exceed MAX_LEN.
    let server_part: String = server.chars().take(18).collect();
    let tool_part: String = tool.chars().take(22).collect();
    format!("mcp__{}__{}_{:016x}", server_part, tool_part, hash)
}

/// FNV-1a 64-bit: stable across runs, no extra dependencies.
fn stable_name_hash(name: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in name.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn sanitize_tool_name_part(value: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut previous_was_separator = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            ch
        } else {
            '_'
        };
        if next == '_' {
            if previous_was_separator {
                continue;
            }
            previous_was_separator = true;
        } else {
            previous_was_separator = false;
        }
        out.push(next);
    }
    let out = out.trim_matches('_');
    if out.is_empty() {
        fallback.to_string()
    } else {
        out.to_string()
    }
}

fn convert_result(result: CallToolResult) -> ToolOutput {
    if result.is_error {
        let text = result
            .content
            .iter()
            .filter_map(|c| c.text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        return ToolOutput::error(text);
    }

    let text = result
        .content
        .iter()
        .filter_map(|c| {
            if c.kind == "text" {
                c.text.clone()
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    ToolOutput::text(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct DisconnectedTransport;

    #[async_trait]
    impl crate::transport::McpTransport for DisconnectedTransport {
        async fn send(&mut self, _: &str) -> anyhow::Result<()> {
            anyhow::bail!("test transport must not be used during registration")
        }
        async fn recv(&mut self) -> anyhow::Result<Option<String>> {
            anyhow::bail!("test transport must not be used during registration")
        }
    }

    fn test_tool(server: &str, name: &str) -> McpTool {
        McpTool::new(
            server,
            Arc::new(Mutex::new(McpClient::with_transport(Box::new(
                DisconnectedTransport,
            )))),
            McpToolDefinition {
                name: name.into(),
                description: name.into(),
                input_schema: serde_json::json!({"type": "object"}),
            },
        )
    }

    #[test]
    fn mcp_registration_preserves_unsanitized_source() {
        let tool = test_tool("docs / remote", "get / page");
        assert_eq!(
            tool.source(),
            kcoder_tools::ToolSource::Mcp {
                server: "docs / remote".into(),
                tool: "get / page".into()
            }
        );
    }

    #[test]
    fn sanitized_collisions_report_original_server_and_tool_identities() {
        let mut registry = kcoder_tools::ToolRegistry::new();
        registry
            .try_register(Arc::new(test_tool("docs a", "get/page")))
            .unwrap();
        let error = registry
            .try_register(Arc::new(test_tool("docs_a", "get_page")))
            .unwrap_err();
        assert_eq!(error.name, "mcp__docs_a__get_page");
        assert_eq!(
            error.existing,
            ToolSource::Mcp {
                server: "docs a".into(),
                tool: "get/page".into()
            }
        );
        assert_eq!(
            error.incoming,
            ToolSource::Mcp {
                server: "docs_a".into(),
                tool: "get_page".into()
            }
        );
        assert_eq!(
            registry.get(&error.name).unwrap().description(),
            "[MCP: docs a::get/page] get/page"
        );
    }

    #[test]
    fn plugin_contribution_keeps_plugin_identity_through_registration_and_filtering() {
        let tool = test_tool("plugin.docs.remote", "read").with_plugin_source("docs@market");
        let name = tool.name();
        let expected = ToolSource::Plugin {
            plugin: "docs@market".into(),
            server: "plugin.docs.remote".into(),
            tool: "read".into(),
        };
        let mut registry = kcoder_tools::ToolRegistry::new();
        registry.try_register(Arc::new(tool)).unwrap();
        let filtered = registry
            .clone()
            .filtered_to_names(std::slice::from_ref(&name));
        assert_eq!(filtered.source(&name), Some(&expected));
        assert!(
            filtered
                .filtered_out_by_patterns(&["mcp__*".into()])
                .get(&name)
                .is_none()
        );
    }

    #[test]
    fn mcp_tool_name_is_namespaced_to_avoid_builtin_collisions() {
        assert_eq!(mcp_tool_name("files", "read"), "mcp__files__read");
    }

    #[test]
    fn mcp_tool_name_sanitizes_invalid_characters() {
        assert_eq!(
            mcp_tool_name("local server", "shell/run"),
            "mcp__local_server__shell_run"
        );
        assert_eq!(mcp_tool_name("!!!", "???"), "mcp__server__tool");
    }

    #[test]
    fn mcp_tool_name_stays_within_provider_limit_and_avoids_collisions() {
        let long_server = "a".repeat(60);
        let long_tool_a = format!("{}one", "read_file_version_".repeat(5));
        let long_tool_b = format!("{}two", "read_file_version_".repeat(5));
        let name_a = mcp_tool_name(&long_server, &long_tool_a);
        let name_b = mcp_tool_name(&long_server, &long_tool_b);
        assert!(
            name_a.len() <= 64,
            "name exceeds the Anthropic tool name limit: {name_a}"
        );
        assert_eq!(name_a.len(), 64, "the truncation budget should be exact");
        assert!(
            name_a.starts_with("mcp__") && name_b.starts_with("mcp__"),
            "namespace prefix must be preserved"
        );
        assert_ne!(name_a, name_b, "truncated names must keep a unique suffix");
    }

    #[test]
    fn mcp_tool_name_hashes_the_full_sanitized_name() {
        let prefix = "a".repeat(48);
        let name_a = mcp_tool_name("server", &format!("{prefix}x"));
        let name_b = mcp_tool_name("server", &format!("{prefix}y"));

        assert_ne!(
            name_a, name_b,
            "differences after the display prefix must survive in the hash"
        );
        assert!(name_a.len() <= 64 && name_b.len() <= 64);
    }

    #[test]
    fn mcp_tool_name_avoids_known_32_bit_hash_collision() {
        let shared = "x".repeat(40);
        let name_a = mcp_tool_name("server", &format!("{shared}xvUzwImeobPC"));
        let name_b = mcp_tool_name("server", &format!("{shared}hBQDcdtkeIlp"));

        assert_ne!(name_a, name_b, "known FNV-1a 32-bit collision");
        assert!(name_a.len() <= 64 && name_b.len() <= 64);
    }
}
