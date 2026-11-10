//! Fixed resource reads on the original native connection; subscription authority belongs to the host.
use super::*;
use anyhow::ensure;
use sha2::{Digest, Sha256};

const MAX_RESOURCE_BYTES: usize = 128 * 1024;

/// Immutable data observation, never a subscription, source grant or tool authorization.
/// Server metadata cannot manufacture a Native origin or change the selected URI.
pub struct NativeResourceSnapshot {
    pub uri: String,
    pub mime_type: String,
    pub text: String,
    pub revision: String,
}
impl McpClient {
    pub fn validate_native_resource_uri(&self, uri: &str) -> Result<()> {
        ensure!(
            !uri.is_empty() && uri.len() <= 4096 && !uri.chars().any(char::is_control),
            "MCP_NATIVE_RESOURCE_URI_INVALID"
        );
        ensure!(
            !self.policy_private_values.contains(uri),
            "MCP_NATIVE_RESOURCE_URI_PRIVATE"
        );
        Ok(())
    }
    /// Native discovery uses the original bounded resources/list, preserving URI identity.
    /// A host still needs its own current public discovery authority before invoking it.
    pub async fn list_native_resources(
        &mut self,
        workspace: &std::path::Path,
        cancellation: &CancellationToken,
    ) -> Result<Vec<crate::apps::ResourceDescriptor>> {
        let origin = self
            .native_origin()
            .context("MCP_NATIVE_CONNECTION_ORIGIN_REQUIRED")?;
        ensure!(
            origin.still_same_credentials()?,
            "MCP_NATIVE_RESOURCE_SOURCE_CHANGED"
        );
        crate::server_policy::check_workspace(&self.server_policy, workspace)?;
        self.check_resource_cancellation(Some(cancellation))?;
        let mut resources = self.list_resources(Some(cancellation)).await?;
        for resource in &mut resources {
            ensure!(
                !resource.uri.is_empty()
                    && resource.uri.len() <= 4096
                    && !resource.uri.chars().any(char::is_control)
                    && !self.policy_private_values.contains(&resource.uri),
                "MCP_NATIVE_RESOURCE_URI_PRIVATE"
            );
            resource.name = self.policy_private_values.text(&resource.name);
            if let Some(mime) = &mut resource.mime_type {
                *mime = self.policy_private_values.text(mime);
            }
            if let Some(meta) = &mut resource.meta {
                self.policy_private_values.json(meta);
            }
        }
        self.check_resource_cancellation(Some(cancellation))?;
        ensure!(
            self.native_origin()
                .is_some_and(|current| std::sync::Arc::ptr_eq(&current, &origin))
                && origin.still_same_credentials()?,
            "MCP_NATIVE_RESOURCE_SOURCE_CHANGED"
        );
        Ok(resources)
    }
    /// The caller must hold a separately current native read permit for this exact
    /// resource. This method neither starts a connection nor chooses a server from URI text.
    pub async fn read_native_resource(
        &mut self,
        uri: &str,
        workspace: &std::path::Path,
        cancellation: &CancellationToken,
    ) -> Result<NativeResourceSnapshot> {
        self.validate_native_resource_uri(uri)?;
        self.ensure_initialized()?;
        ensure!(
            self.resources_supported(),
            "MCP_NATIVE_RESOURCES_UNAVAILABLE"
        );
        self.check_resource_cancellation(Some(cancellation))?;
        let origin = self
            .native_origin()
            .context("MCP_NATIVE_CONNECTION_ORIGIN_REQUIRED")?;
        ensure!(
            origin.still_same_credentials()?,
            "MCP_NATIVE_RESOURCE_SOURCE_CHANGED"
        );
        if self.server_policy.workspace.is_some() {
            crate::server_policy::check_workspace(&self.server_policy, workspace)?;
        }
        #[derive(serde::Deserialize)]
        struct Read {
            contents: Vec<crate::apps::ResourceContent>,
        }
        let id = self.next_id();
        let read: Read = self
            .request_raw_with_cancellation(
                id,
                "resources/read",
                serde_json::json!({"uri":uri}),
                Some(cancellation),
            )
            .await?;
        ensure!(
            read.contents.len() == 1,
            "MCP_NATIVE_RESOURCE_CONTENT_INVALID"
        );
        let content = read.contents.into_iter().next().unwrap();
        ensure!(
            content.uri == uri && content.blob.is_none(),
            "MCP_NATIVE_RESOURCE_CONTENT_INVALID"
        );
        let mut text = content.text.context("MCP_NATIVE_RESOURCE_TEXT_REQUIRED")?;
        ensure!(
            text.len() <= MAX_RESOURCE_BYTES,
            "MCP_NATIVE_RESOURCE_CONTENT_LIMIT"
        );
        let mime_type = content.mime_type.unwrap_or_else(|| "text/plain".into());
        ensure!(
            mime_type.len() <= 256 && !mime_type.chars().any(char::is_control),
            "MCP_NATIVE_RESOURCE_CONTENT_INVALID"
        );
        // Retain no private protocol metadata or blob. Existing connection-local
        // redaction applies before data can become workflow material.
        text = self.policy_private_values.text(&text);
        self.check_resource_cancellation(Some(cancellation))?;
        ensure!(
            self.native_origin()
                .is_some_and(|current| std::sync::Arc::ptr_eq(&current, &origin))
                && origin.still_same_credentials()?,
            "MCP_NATIVE_RESOURCE_SOURCE_CHANGED"
        );
        let revision = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(uri, &mime_type, &text))?)
        );
        Ok(NativeResourceSnapshot {
            uri: uri.into(),
            mime_type,
            text,
            revision,
        })
    }
}

#[cfg(test)]
mod tests;
