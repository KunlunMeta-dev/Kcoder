use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListParams {
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReadParams {
    pub plugin_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_attempt_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUninstallParams {
    pub plugin_id: String,
    #[serde(default)]
    pub purge_data: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnableParams {
    pub plugin_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResult {
    pub generation: u64,
    pub plugins: Vec<PluginSummary>,
    pub diagnostics: Vec<PluginDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReadResult {
    pub generation: u64,
    pub plugin: PluginSummary,
    pub diagnostics: Vec<PluginDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMutationResult {
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<PluginSummary>,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub root: PathBuf,
    pub enabled: bool,
    pub managed: bool,
    pub source: Option<PluginSource>,
    pub operation_id: Option<String>,
    pub file_count: Option<usize>,
    pub total_bytes: Option<u64>,
    pub compatibility: PluginCompatibility,
    #[serde(default)]
    pub components: Vec<PluginComponentSummary>,
    pub hook_matcher_count: usize,
    pub diagnostic_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginComponentSummary {
    pub kind: String,
    pub name: String,
    pub path: Option<PathBuf>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCompatibility {
    pub level: String,
    pub supported_capabilities: Vec<String>,
    pub deferred_capabilities: Vec<String>,
    pub issues: Vec<PluginCompatibilityIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCompatibilityIssue {
    pub code: String,
    pub capability: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnostic {
    pub root: PathBuf,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PluginSource {
    Local {
        canonical_path: PathBuf,
    },
    Marketplace {
        marketplace: String,
        entry: String,
    },
    Git {
        redacted_url: String,
        resolved_sha: String,
    },
    Npm {
        package: String,
        integrity: String,
    },
    Bundled {
        bundle: String,
        digest: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceListParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceAddParams {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceRemoveParams {
    pub marketplace_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceRefreshParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceListResult {
    pub generation: u64,
    pub marketplaces: Vec<MarketplaceSummary>,
    pub diagnostics: Vec<MarketplaceDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceMutationResult {
    pub generation: u64,
    pub marketplace_name: String,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSummary {
    pub id: String,
    pub path: PathBuf,
    pub display_name: Option<String>,
    pub configured: bool,
    pub plugins: Vec<MarketplacePluginSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePluginSummary {
    pub plugin_id: String,
    pub source: MarketplacePluginSource,
    pub version: Option<String>,
    pub install_policy: String,
    pub auth_policy: String,
    pub manifest_fallback: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MarketplacePluginSource {
    Local {
        path: PathBuf,
    },
    Git {
        url: String,
        path: Option<String>,
        ref_name: Option<String>,
        sha: Option<String>,
    },
    Npm {
        package: String,
        version: Option<String>,
        registry: Option<String>,
        integrity: Option<String>,
    },
    Bundled {
        bundle: String,
        digest: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceDiagnostic {
    pub marketplace_id: Option<String>,
    pub path: Option<PathBuf>,
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Request, method};
    use serde_json::json;

    #[test]
    fn plugin_install_request_uses_stable_camel_case_fixture() {
        let request = Request::new(
            41,
            method::PLUGIN_INSTALL,
            PluginInstallParams {
                path: None,
                marketplace_name: Some("team-tools".to_string()),
                plugin_name: Some("issue-triage".to_string()),
                install_attempt_id: Some("attempt-1".to_string()),
            },
        );

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 41,
                "method": "plugin/install",
                "params": {
                    "marketplaceName": "team-tools",
                    "pluginName": "issue-triage",
                    "installAttemptId": "attempt-1"
                }
            })
        );
    }

    #[test]
    fn marketplace_add_request_matches_public_source_shape() {
        let request = Request::new(
            "marketplace-add",
            method::MARKETPLACE_ADD,
            MarketplaceAddParams {
                source: "/srv/plugins/.agents/plugins/marketplace.json".to_string(),
                marketplace_name: Some("team-tools".to_string()),
            },
        );

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": "marketplace-add",
                "method": "marketplace/add",
                "params": {
                    "source": "/srv/plugins/.agents/plugins/marketplace.json",
                    "marketplaceName": "team-tools"
                }
            })
        );
    }
}
