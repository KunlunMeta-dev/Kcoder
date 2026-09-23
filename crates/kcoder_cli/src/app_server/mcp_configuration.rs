//! Narrow edits to the target's user settings; never materialize merged project/plugin state.

use anyhow::{Context, Result, bail};
use kcoder_mcp::McpServerConfig;
use serde_json::Value;
use std::path::Path;

pub(super) fn install(path: &Path, config: McpServerConfig) -> Result<()> {
    validate(&config)?;
    kcoder_config::update_settings_file(path, |document| {
        let object = document
            .as_object_mut()
            .context("User settings must be an object")?;
        let servers = object
            .entry("mcp_servers")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .context("User MCP configuration must be an array")?;
        if servers
            .iter()
            .any(|server| server.get("name").and_then(Value::as_str) == Some(config.name.as_str()))
        {
            bail!("An MCP server with this name already exists in user settings");
        }
        servers.push(serde_json::to_value(&config)?);
        Ok(())
    })?;
    Ok(())
}

pub(super) fn remove(path: &Path, name: &str) -> Result<()> {
    kcoder_config::update_settings_file(path, |document| {
        let servers = document
            .get_mut("mcp_servers")
            .and_then(Value::as_array_mut)
            .context("This MCP server is not defined in user settings")?;
        let before = servers.len();
        servers.retain(|server| server.get("name").and_then(Value::as_str) != Some(name));
        if before == servers.len() {
            bail!("This MCP server is not defined in user settings");
        }
        Ok(())
    })?;
    Ok(())
}

fn validate(config: &McpServerConfig) -> Result<()> {
    if config.name.trim().is_empty()
        || config.name.len() > 128
        || config.name.chars().any(char::is_control)
        || config.name.starts_with("plugin.")
    {
        bail!("Invalid or reserved MCP server name");
    }
    if config.transport != "http" && !config.headers.is_empty() {
        bail!("Custom headers are supported only for Streamable HTTP MCP servers");
    }
    if config.transport != "stdio"
        && (!config.command.is_empty() || !config.args.is_empty() || !config.env.is_empty())
    {
        bail!("Commands, arguments and environment variables require stdio transport");
    }
    if config.transport == "stdio" && !config.url.is_empty() {
        bail!("A server URL requires HTTP or SSE transport");
    }
    match config.transport.as_str() {
        "stdio" if !config.command.trim().is_empty() && !config.command.contains('\0') => {}
        "http" | "sse" => {
            let url =
                reqwest::Url::parse(&config.url).map_err(|_| anyhow::anyhow!("Invalid MCP URL"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                bail!("MCP URL must use HTTP or HTTPS without embedded credentials or fragments");
            }
        }
        _ => bail!("MCP requires a stdio command or an HTTP/SSE endpoint"),
    }
    if config.args.iter().any(|value| value.contains('\0'))
        || config.env.iter().any(|(name, value)| {
            name.is_empty() || name.contains(['=', '\0']) || value.contains('\0')
        })
    {
        bail!("Invalid MCP argument or environment variable");
    }
    for (name, value) in &config.headers {
        reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| anyhow::anyhow!("Invalid MCP header name"))?;
        reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| anyhow::anyhow!("Invalid MCP header value"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(name: &str) -> McpServerConfig {
        serde_json::from_value(serde_json::json!({"name":name,"transport":"http","url":"https://mcp.example.test/mcp"})).unwrap()
    }

    #[test]
    fn install_remove_preserve_other_settings_and_do_not_replace_existing_servers() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("settings.jsonc");
        std::fs::write(
            &file,
            "{\n// Keep the user's models\n\"providers\":{},\"model\":\"custom\"\n}",
        )
        .unwrap();
        install(&file, config("first")).unwrap();
        install(&file, config("second")).unwrap();
        let before = std::fs::read(&file).unwrap();
        assert!(install(&file, config("first")).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), before);
        remove(&file, "first").unwrap();
        let content = std::fs::read_to_string(&file).unwrap();
        assert!(content.contains("// Keep the user's models"));
        let document = kcoder_config::read_settings_file(&file).unwrap();
        assert_eq!(document["providers"], serde_json::json!({}));
        assert_eq!(document["model"], "custom");
        assert_eq!(document["mcp_servers"][0]["name"], "second");
        assert!(remove(&file, "plugin.example").is_err());
    }

    #[test]
    fn transport_options_that_would_be_ignored_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("settings.jsonc");
        let mut http = config("http");
        http.env.insert("TOKEN".into(), "private-value".into());
        assert!(
            install(&file, http)
                .unwrap_err()
                .to_string()
                .contains("stdio")
        );
        let mut sse = config("legacy");
        sse.transport = "sse".into();
        sse.headers
            .insert("Authorization".into(), "private-value".into());
        let error = install(&file, sse).unwrap_err();
        assert!(error.to_string().contains("Streamable HTTP"));
        assert!(!error.to_string().contains("private-value"));
        assert!(!file.exists());
    }

    #[test]
    fn invalid_configuration_is_rejected_before_creating_settings() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("settings.jsonc");
        let mut invalid = config("bad");
        invalid
            .headers
            .insert("authorization".into(), "private-secret\n".into());
        assert!(
            install(&file, invalid)
                .unwrap_err()
                .to_string()
                .contains("header")
        );
        assert!(!file.exists());
        assert!(install(&file, config("plugin.market.tool")).is_err());
    }
}
