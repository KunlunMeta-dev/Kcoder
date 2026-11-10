//! Stable MCP Apps 2026-01-26 metadata and bounded resource observations.
//! https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_types::mcp_apps::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiToolMetadata {
    pub resource_uri: Option<String>,
    pub model_visible: bool,
    pub app_visible: bool,
}

impl crate::model::McpToolDefinition {
    pub fn ui_metadata(&self) -> Result<UiToolMetadata> {
        let meta = self.meta.as_ref();
        ensure!(
            meta.is_none_or(Value::is_object),
            "MCP tool metadata must be an object"
        );
        let ui = meta.and_then(|value| value.get("ui"));
        if let Some(ui) = ui {
            ensure!(ui.is_object(), "invalid MCP Apps UI metadata");
        }
        let current = ui.and_then(|value| value.get("resourceUri"));
        let legacy = meta.and_then(|value| value.get("ui/resourceUri"));
        let uri = current
            .or(legacy)
            .map(|value| value.as_str().context("invalid MCP Apps resource URI"))
            .transpose()?;
        if let (Some(current), Some(legacy)) = (current, legacy) {
            ensure!(current == legacy, "conflicting MCP Apps resource URIs");
        }
        if let Some(uri) = uri {
            validate_ui_uri(uri)?;
        }
        let (model_visible, app_visible) = self.visibility()?;
        Ok(UiToolMetadata {
            resource_uri: uri.map(str::to_owned),
            model_visible,
            app_visible,
        })
    }
    fn visibility(&self) -> Result<(bool, bool)> {
        let Some(meta) = self.meta.as_ref() else {
            return Ok((true, true));
        };
        ensure!(meta.is_object(), "MCP tool metadata must be an object");
        let Some(ui) = meta.get("ui") else {
            return Ok((true, true));
        };
        ensure!(ui.is_object(), "invalid MCP Apps UI metadata");
        let Some(visibility) = ui.get("visibility") else {
            return Ok((true, true));
        };
        let list = visibility
            .as_array()
            .context("invalid MCP Apps visibility")?;
        ensure!(
            list.len() <= 2
                && list
                    .iter()
                    .all(|value| matches!(value.as_str(), Some("model" | "app"))),
            "invalid MCP Apps visibility"
        );
        Ok((
            list.iter().any(|value| value == "model"),
            list.iter().any(|value| value == "app"),
        ))
    }

    pub fn visible_to_model(&self) -> bool {
        self.visibility().is_ok_and(|value| value.0)
    }
    pub fn visible_to_app(&self) -> bool {
        self.visibility().is_ok_and(|value| value.1)
    }
}

pub fn validate_ui_uri(uri: &str) -> Result<()> {
    ensure!(
        uri.starts_with("ui://")
            && uri.len() > 5
            && uri.len() <= 2048
            && !uri
                .chars()
                .any(|value| value.is_control() || value.is_whitespace())
            && !uri.contains('#'),
        "invalid MCP Apps ui:// resource URI"
    );
    ensure!(
        !uri[5..].contains('@') && !uri[5..].contains('\\'),
        "invalid MCP Apps resource authority"
    );
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDescriptor {
    pub uri: String,
    pub name: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceContent {
    pub uri: String,
    pub mime_type: Option<String>,
    pub text: Option<String>,
    pub blob: Option<String>,
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep validated origin, content and result data separate at the presentation boundary"
)]
pub(crate) fn prepare_ui_view(
    server: &str,
    connection: &str,
    plugin: Option<&str>,
    tool: &str,
    uri: &str,
    content: ResourceContent,
    structured: Option<Value>,
    result_meta: Option<Value>,
) -> Result<McpAppView> {
    validate_ui_uri(uri)?;
    ensure!(
        content.uri == uri,
        "MCP Apps resource URI does not match requested source"
    );
    ensure!(
        content.mime_type.as_deref() == Some(MCP_APP_MIME_TYPE),
        "unsupported MCP Apps resource MIME type"
    );
    let html = match (content.text, content.blob) {
        (Some(text), None) => text,
        (None, Some(blob)) => {
            ensure!(
                blob.len() <= MCP_APP_HTML_MAX_BYTES.div_ceil(3) * 4,
                "MCP Apps HTML exceeds byte budget"
            );
            String::from_utf8(
                STANDARD
                    .decode(blob)
                    .context("invalid MCP Apps base64 HTML")?,
            )
            .context("MCP Apps HTML must be UTF-8")?
        }
        _ => anyhow::bail!("MCP Apps resource requires exactly one text or blob body"),
    };
    ensure!(
        html.len() <= MCP_APP_HTML_MAX_BYTES && html.to_ascii_lowercase().contains("<html"),
        "MCP Apps requires a bounded HTML document"
    );
    let ui = content.meta.as_ref().and_then(|value| value.get("ui"));
    let csp: McpAppCsp = ui
        .and_then(|value| value.get("csp"))
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .context("unsupported MCP Apps CSP fields")?
        .unwrap_or_default();
    for origins in [
        &csp.connect_domains,
        &csp.resource_domains,
        &csp.frame_domains,
        &csp.base_uri_domains,
    ] {
        ensure!(
            origins.len() <= 32,
            "MCP Apps CSP origin list exceeds limit"
        );
        for origin in origins {
            validate_csp_origin(origin)?;
        }
    }
    let mut permissions = McpAppPermissions::default();
    if let Some(value) = ui.and_then(|value| value.get("permissions")) {
        let object = value.as_object().context("invalid MCP Apps permissions")?;
        for (key, value) in object {
            ensure!(
                value.as_object().is_some_and(|value| value.is_empty()),
                "MCP Apps permission must be an empty request object"
            );
            match key.as_str() {
                "camera" => permissions.camera = true,
                "microphone" => permissions.microphone = true,
                "geolocation" => permissions.geolocation = true,
                "clipboardWrite" => permissions.clipboard_write = true,
                _ => anyhow::bail!("unsupported MCP Apps permission"),
            }
        }
    }
    if let Some(value) = &structured {
        ensure!(
            serde_json::to_vec(value)?.len() <= MCP_APP_DATA_MAX_BYTES,
            "MCP Apps structured data exceeds limit"
        );
    }
    if let Some(value) = &result_meta {
        ensure!(
            serde_json::to_vec(value)?.len() <= MCP_APP_META_MAX_BYTES,
            "MCP Apps result metadata exceeds limit"
        );
    }
    let view = McpAppView {
        server_name: server.into(),
        connection_id: connection.into(),
        plugin_id: plugin.map(str::to_owned),
        tool_name: tool.into(),
        resource_uri: uri.into(),
        mime_type: MCP_APP_MIME_TYPE.into(),
        html,
        csp,
        requested_permissions: permissions,
        prefers_border: ui
            .and_then(|value| value.get("prefersBorder"))
            .and_then(Value::as_bool),
        structured_content: structured,
        result_meta,
        tool_input: None,
        tool_content: Vec::new(),
    };
    ensure!(
        serde_json::to_vec(&view)?.len() <= MCP_APP_VIEW_MAX_BYTES,
        "MCP Apps view exceeds serialized byte budget"
    );
    Ok(view)
}

fn validate_csp_origin(origin: &str) -> Result<()> {
    // Only explicit secure origins. Scheme wildcards, paths, credentials and opaque URLs
    // must not accidentally widen a host policy. Hosts may impose further restrictions.
    ensure!(
        !origin
            .chars()
            .any(|value| value.is_whitespace() || value.is_control()),
        "MCP Apps CSP origin contains whitespace or control characters"
    );
    let parsed = reqwest::Url::parse(origin).context("invalid MCP Apps CSP origin")?;
    ensure!(
        matches!(parsed.scheme(), "https" | "wss")
            && parsed.host_str().is_some()
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.path() == "/"
            && parsed.query().is_none()
            && parsed.fragment().is_none()
            && !origin.contains('*'),
        "MCP Apps CSP requires explicit secure origins"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn definition(meta: Value) -> crate::McpToolDefinition {
        serde_json::from_value(json!({"name":"probe","inputSchema":{},"_meta":meta})).unwrap()
    }
    #[test]
    fn metadata_visibility_and_legacy_uri_are_strict_without_inventing_tools() {
        assert!(!definition(json!({"ui":{"visibility":["app"]}})).visible_to_model());
        assert!(
            definition(json!({"ui/resourceUri":"ui://source/card"}))
                .ui_metadata()
                .unwrap()
                .resource_uri
                .is_some()
        );
        for bad in [
            json!("not-an-object"),
            json!({"ui":{"visibility":["admin"]}}),
            json!({"ui":{"resourceUri":"https://external.test/view"}}),
            json!({"ui":{"resourceUri":"ui://source/a"},"ui/resourceUri":"ui://source/b"}),
        ] {
            let tool = definition(bad);
            assert!(tool.ui_metadata().is_err());
            if tool
                .meta
                .as_ref()
                .and_then(|value| value.get("ui"))
                .and_then(|value| value.get("resourceUri"))
                .is_some()
            {
                assert!(tool.visible_to_model());
            } else {
                assert!(!tool.visible_to_model());
            }
        }
    }
    #[test]
    fn csp_origins_cannot_include_credentials_wildcards_paths_or_controls() {
        for origin in ["https://api.example.test", "wss://api.example.test:443"] {
            assert!(validate_csp_origin(origin).is_ok());
        }
        for origin in [
            "https://*.example.test",
            "https://user:password@example.test",
            "https://example.test/path",
            "https://example.test?token=x",
            "https://examp\nle.test",
            "javascript:alert(1)",
            "file:///tmp/view",
            "http://example.test",
        ] {
            assert!(validate_csp_origin(origin).is_err(), "{origin}");
        }
    }
}
