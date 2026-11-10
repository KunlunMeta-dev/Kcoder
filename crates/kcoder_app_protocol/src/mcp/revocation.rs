pub const CAPABILITY_MCP_PROVIDER_REVOCATION_V1: &str = "mcpProviderRevocationV1";

use super::McpServerParams;
use kcoder_types::integrations::core::IntegrationRevisionRef;
use serde::{Deserialize, Serialize};

pub use kcoder_types::mcp_authorization::{
    McpProviderRevocationPhase, McpProviderRevocationReason, McpProviderRevocationReceipt,
    McpProviderRevocationSourceState,
};

/// A native prepared reference is required before an explicit provider request.
/// Callers cannot supply an endpoint, token, client secret or account override.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum McpProviderRevocationParams {
    Prepare {
        #[serde(rename = "requestId")]
        request_id: String,
        server: McpServerParams,
    },
    Commit {
        #[serde(rename = "requestId")]
        request_id: String,
        server: McpServerParams,
        #[serde(rename = "intentRef")]
        intent_ref: IntegrationRevisionRef,
    },
    Cancel {
        #[serde(rename = "requestId")]
        request_id: String,
        server: McpServerParams,
        #[serde(rename = "intentRef")]
        intent_ref: IntegrationRevisionRef,
    },
    Read {
        #[serde(rename = "requestId")]
        request_id: String,
        server: McpServerParams,
    },
}
impl McpProviderRevocationParams {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Prepare { request_id, .. }
            | Self::Commit { request_id, .. }
            | Self::Read { request_id, .. }
            | Self::Cancel { request_id, .. } => request_id,
        }
    }
    pub fn server(&self) -> &McpServerParams {
        match self {
            Self::Prepare { server, .. }
            | Self::Commit { server, .. }
            | Self::Read { server, .. }
            | Self::Cancel { server, .. } => server,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid = |value: &str, limit| {
            !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
        };
        if !valid(self.request_id(), 128)
            || !valid(&self.server().name, 256)
            || self
                .server()
                .plugin_id
                .as_ref()
                .is_some_and(|value| !valid(value, 128))
        {
            return Err("MCP_REVOCATION_INPUT_INVALID");
        }
        if let Self::Commit { intent_ref, .. } | Self::Cancel { intent_ref, .. } = self
            && (!valid(&intent_ref.id, 256) || !valid(&intent_ref.revision, 128))
        {
            return Err("MCP_REVOCATION_INPUT_INVALID");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn provider_revocation_requires_an_original_confirmation_and_rejects_private_overrides() {
        let prepare =
            json!({"action":"prepare","requestId":"original","server":{"name":"selected"}});
        serde_json::from_value::<McpProviderRevocationParams>(prepare.clone())
            .unwrap()
            .validate()
            .unwrap();
        for field in ["endpoint", "token", "account", "clientSecret"] {
            let mut invalid = prepare.clone();
            invalid[field] = json!("untrusted");
            assert!(serde_json::from_value::<McpProviderRevocationParams>(invalid).is_err());
        }
        let mut commit = prepare;
        commit["action"] = json!("commit");
        assert!(serde_json::from_value::<McpProviderRevocationParams>(commit.clone()).is_err());
        commit["intentRef"] = json!({"id":"native-original","revision":"native-intent"});
        serde_json::from_value::<McpProviderRevocationParams>(commit)
            .unwrap()
            .validate()
            .unwrap();
    }
}
