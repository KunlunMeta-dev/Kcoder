use super::*;
use crate::integrations::core::IntegrationOwner;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Immutable model input projection, distinct from raw data and UI presentation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeContextProjection {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub owner: IntegrationOwner,
    pub artifact_refs: Vec<OfficeArtifactRef>,
    pub dataset_refs: Vec<OfficeArtifactRef>,
    pub source_refs: Vec<OfficeResourceRef>,
    pub summary: String,
    pub columns: Vec<OfficeColumn>,
    pub preview_rows: Vec<Vec<Value>>,
    pub total_rows: usize,
    pub omitted_rows: usize,
    pub query_sha256: Option<String>,
    pub content_sha256: String,
}
impl OfficeContextProjection {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        identifier(&self.id, "projection.id")?;
        if self.schema_version != 1
            || self.revision == 0
            || self.artifact_refs.len() > 32
            || self.dataset_refs.len() > 32
            || self.source_refs.len() > 128
            || self.columns.len() > 128
            || self.preview_rows.len() > 10
            || self.omitted_rows > self.total_rows
            || self.content_sha256.len() != 64
            || !self
                .content_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid("projection"));
        }
        bounded(&self.summary, 8000, true, "projection.summary")?;
        for row in &self.preview_rows {
            if row.len() != self.columns.len() {
                return Err(invalid("projection.row"));
            }
        }
        encoded_limit(self, 32 * 1024, "projection")
    }
}
