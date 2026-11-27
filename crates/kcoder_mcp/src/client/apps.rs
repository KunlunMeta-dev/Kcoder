//! Bounded core resource requests used by the MCP Apps host.
use super::*;
use crate::apps::{ResourceContent, ResourceDescriptor, prepare_ui_view, validate_ui_uri};
use kcoder_types::mcp_apps::McpAppView;

impl McpClient {
    pub async fn list_resources(
        &mut self,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Vec<ResourceDescriptor>> {
        tokio::time::timeout(REQUEST_TIMEOUT, self.list_resource_pages(cancellation))
            .await
            .map_err(|_| crate::failure::timeout("MCP resources/list timed out after 60s"))?
    }

    async fn list_resource_pages(
        &mut self,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Vec<ResourceDescriptor>> {
        self.ensure_initialized()?;
        anyhow::ensure!(
            self.server_capabilities
                .get("resources")
                .is_some_and(Value::is_object),
            "MCP server does not support resources"
        );
        #[derive(serde::Deserialize)]
        struct Page {
            resources: Vec<ResourceDescriptor>,
            #[serde(default, rename = "nextCursor")]
            next: Option<String>,
        }
        let mut resources = Vec::new();
        let mut cursor = None;
        let mut seen = std::collections::HashSet::new();
        let mut bytes = 0usize;
        for _ in 0..128 {
            self.check_resource_cancellation(cancellation)?;
            let id = self.next_id();
            let raw: Value = self
                .request_raw_with_cancellation(
                    id,
                    "resources/list",
                    cursor.as_ref().map_or_else(
                        || serde_json::json!({}),
                        |cursor| serde_json::json!({"cursor":cursor}),
                    ),
                    cancellation,
                )
                .await?;
            bytes = bytes.saturating_add(serde_json::to_vec(&raw)?.len());
            anyhow::ensure!(
                bytes <= 4 * 1024 * 1024,
                "MCP resources/list exceeds discovery budget"
            );
            let page: Page =
                serde_json::from_value(raw).context("invalid MCP resources/list page")?;
            anyhow::ensure!(
                resources.len() + page.resources.len() <= 4096,
                "MCP resources/list exceeds resource limit"
            );
            resources.extend(page.resources);
            let Some(next) = page.next else {
                return Ok(resources);
            };
            anyhow::ensure!(
                next.len() <= 4096 && seen.insert(next.clone()),
                "MCP resources/list cursor repeats or exceeds limit"
            );
            cursor = Some(next);
        }
        anyhow::bail!("MCP resources/list exceeds page limit")
    }

    /// Read from this live connection only; URI host text is never a server router.
    #[expect(
        clippy::too_many_arguments,
        reason = "Trusted host supplies origin and bounded result data for one exact connection"
    )]
    pub async fn read_ui_resource(
        &mut self,
        server: &str,
        plugin: Option<&str>,
        tool: &str,
        uri: &str,
        structured: Option<Value>,
        result_meta: Option<Value>,
        cancellation: Option<&CancellationToken>,
    ) -> Result<McpAppView> {
        self.ensure_initialized()?;
        anyhow::ensure!(
            self.apps_support,
            "MCP Apps requires a dedicated negotiated host connection"
        );
        validate_ui_uri(uri)?;
        self.check_resource_cancellation(cancellation)?;
        let connection_id = self
            .app_connection_id()
            .context("MCP Apps live connection identity unavailable")?
            .to_owned();
        anyhow::ensure!(
            self.server_capabilities
                .get("resources")
                .is_some_and(Value::is_object),
            "MCP server does not support resources"
        );
        #[derive(serde::Deserialize)]
        struct Read {
            contents: Vec<ResourceContent>,
        }
        let id = self.next_id();
        let result: Read = self
            .request_raw_with_cancellation(
                id,
                "resources/read",
                serde_json::json!({"uri":uri}),
                cancellation,
            )
            .await?;
        anyhow::ensure!(
            result.contents.len() == 1,
            "MCP Apps resource must contain exactly one HTML document"
        );
        prepare_ui_view(
            server,
            &connection_id,
            plugin,
            tool,
            uri,
            result.contents.into_iter().next().unwrap(),
            structured,
            result_meta,
        )
    }

    pub(super) fn check_resource_cancellation(
        &self,
        cancellation: Option<&CancellationToken>,
    ) -> Result<()> {
        anyhow::ensure!(
            !cancellation.is_some_and(CancellationToken::is_cancelled),
            "MCP resource request was cancelled before dispatch"
        );
        Ok(())
    }
}

impl McpClient {
    /// The host must authorize the UI action first. Visibility is then rechecked
    /// on this exact connection; a UI-provided server name is never accepted.
    pub async fn call_app_tool(
        &mut self,
        name: &str,
        arguments: Value,
        cancellation: Option<&CancellationToken>,
    ) -> Result<crate::model::CallToolResult> {
        anyhow::ensure!(
            self.apps_support,
            "MCP Apps requires a dedicated negotiated host connection"
        );
        self.check_resource_cancellation(cancellation)?;
        let definitions = self.list_tools_with_cancellation(cancellation).await?;
        let definition = definitions
            .iter()
            .find(|tool| tool.name == name)
            .context("MCP App requested an unknown tool")?;
        anyhow::ensure!(
            definition.visible_to_app(),
            "MCP tool is not visible to apps"
        );
        self.call_tool_with_cancellation(name, arguments, cancellation)
            .await
    }
}

impl McpClient {
    /// Core MCP resources are obtained only from this server's declared resource
    /// method. URI schemes never choose a Gateway transport or local file reader.
    pub async fn read_resource_with_cancellation(
        &mut self,
        uri: &str,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Value> {
        self.ensure_initialized()?;
        self.check_resource_cancellation(cancellation)?;
        anyhow::ensure!(
            uri.len() <= 2048
                && !uri
                    .chars()
                    .any(|value| value.is_control() || value.is_whitespace())
                && reqwest::Url::parse(uri).is_ok(),
            "invalid MCP resource URI"
        );
        anyhow::ensure!(
            self.server_capabilities
                .get("resources")
                .is_some_and(Value::is_object),
            "MCP server does not support resources"
        );
        let id = self.next_id();
        let result: Value = self
            .request_raw_with_cancellation(
                id,
                "resources/read",
                serde_json::json!({"uri":uri}),
                cancellation,
            )
            .await?;
        let contents = result
            .get("contents")
            .and_then(Value::as_array)
            .context("invalid MCP resource contents")?;
        anyhow::ensure!(
            contents.len() <= 128 && serde_json::to_vec(&result)?.len() <= 4 * 1024 * 1024,
            "MCP resource exceeds bounded content limits"
        );
        for content in contents {
            let uri = content
                .get("uri")
                .and_then(Value::as_str)
                .context("MCP resource content is missing a URI")?;
            anyhow::ensure!(
                uri.len() <= 2048 && reqwest::Url::parse(uri).is_ok(),
                "invalid MCP resource content URI"
            );
            anyhow::ensure!(
                content.get("text").is_some_and(Value::is_string)
                    ^ content.get("blob").is_some_and(Value::is_string),
                "MCP resource content needs exactly one text or blob body"
            );
            if let Some(mime) = content.get("mimeType") {
                anyhow::ensure!(
                    mime.as_str().is_some_and(
                        |mime| mime.len() <= 256 && !mime.chars().any(char::is_control)
                    ),
                    "invalid MCP resource MIME type"
                );
            }
        }
        Ok(result)
    }
}
