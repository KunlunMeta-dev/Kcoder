//! Read-only descriptors for one exact original task; selection still uses its own guard.
use super::*;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilitySourceChoicesParams {
    pub target: IntegrationTaskCapabilityScopeControlTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_revision: Option<String>,
}
impl IntegrationTaskCapabilitySourceChoicesParams {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.target.validate()?;
        if self.cursor.is_some() != self.catalog_revision.is_some() {
            return Err(invalid(
                "cursor",
                "cursor and catalogRevision must be supplied together",
            ));
        }
        for value in [&self.cursor, &self.catalog_revision].into_iter().flatten() {
            id(value, "catalog cursor/revision")?;
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationTaskCapabilitySourceCatalogState {
    Observed,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilitySourceChoicesPage {
    pub target: IntegrationTaskCapabilityScopeControlTarget,
    pub catalog_revision: String,
    pub catalog_state: IntegrationTaskCapabilitySourceCatalogState,
    pub items: Vec<IntegrationTaskCapabilitySourceDescriptor>,
    pub next_cursor: IntegrationNullable<String>,
}
