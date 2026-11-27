//! Wire types for session-level settings templates (`settings/templates/*`).
//!
//! A template is a JSONC settings overlay frozen into one conversation at
//! `thread/start` time; the store itself belongs to the native configuration service.

use serde::{Deserialize, Serialize};

/// One saved template as shown in the settings catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplateSummary {
    /// Stable slug (`[a-z0-9-]{1,64}`), unique inside the template store.
    pub id: String,
    /// Display name; may repeat across templates.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub updated_at: String,
    pub size_bytes: u64,
    /// Content digest used to detect drift between sessions and the store.
    pub revision_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTemplateReadParams {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplateReadResult {
    pub summary: SettingsTemplateSummary,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTemplateSaveParams {
    /// Existing id to overwrite; absent derives a fresh slug from `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSONC overlay content, validated before it is persisted.
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplateSaveResult {
    pub template: SettingsTemplateSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTemplateDeleteParams {
    pub id: String,
}

/// Sets (or with `null`/absent id clears) the default new-session template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTemplateDefaultParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplatesListResult {
    pub templates: Vec<SettingsTemplateSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
}

/// Result of delete/default: the refreshed catalog in one round trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplatesMutationResult {
    pub templates: Vec<SettingsTemplateSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
}

/// Frozen template identity recorded on a thread for resume drift checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplateBinding {
    pub id: String,
    pub revision_sha256: String,
}
