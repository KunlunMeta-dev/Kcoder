//! Exact complete-material observations, not material identities or grants.
use super::KnowledgeTableArithmeticStatus;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeMaterialInventory {
    pub status: KnowledgeTableArithmeticStatus,
    pub material_sha256: Vec<String>,
    /// Every group is one distinct complete Markdown vector, including unknown metadata.
    pub content_groups: Vec<Vec<u32>>,
    pub duplicate_groups: Vec<Vec<u32>>,
    /// None on unsupported or excessive input; never a partial verified count.
    pub unique_materials: Option<u32>,
}
