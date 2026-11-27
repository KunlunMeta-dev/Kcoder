//! Downloaded expert assets are inert content, never execution authority.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeExpertFile"))]
pub struct AgentResourceFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeExpertPackage"))]
pub struct AgentDefinitionPackage {
    pub source: String,
    pub slug: String,
    pub package_sha256: String,
    pub skill_slugs: Vec<String>,
    pub files: Vec<AgentResourceFile>,
}

/// Target-side per-attempt resource inventory; contains no executable permission or local path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentResourceSnapshot {
    pub owner: crate::integrations::core::IntegrationOwner,
    pub expert_id: String,
    pub skills: std::collections::BTreeMap<String, Vec<AgentResourceFile>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeMarketExpert"))]
pub struct AgentMarketDefinition {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub scene: String,
    pub skill_slugs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeMarketListParams"))]
pub struct AgentMarketListParams {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub scene: String,
    pub language: String,
    #[serde(default)]
    pub cursor: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "json-schema",
    schemars(rename = "OfficeMarketInstallParams")
)]
pub struct AgentMarketInstallParams {
    pub id: String,
    pub slug: String,
    pub language: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeExpertReadParams"))]
pub struct AgentDefinitionReadParams {
    pub id: String,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "json-schema",
    schemars(rename = "OfficeAssistantDeleteParams")
)]
pub struct AgentDefinitionDeleteParams {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeMarketDetailParams"))]
pub struct AgentMarketDetailParams {
    pub slug: String,
    pub language: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeMarketExpertDetail"))]
pub struct AgentMarketDefinitionDetail {
    pub item: AgentMarketDefinition,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(
    feature = "json-schema",
    schemars(rename = "OfficeSkillMarketListParams")
)]
pub struct AgentSkillMarketListParams {
    pub query: String,
    pub ranking: String,
    pub language: String,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeMarketSkill"))]
pub struct AgentMarketSkill {
    pub slug: String,
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeSkillInstallParams"))]
pub struct AgentSkillInstallParams {
    pub id: String,
    pub slug: String,
    pub language: String,
}
