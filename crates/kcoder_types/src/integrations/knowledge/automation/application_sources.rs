//! Explicit resource observation selection; DTO metadata is never source/read authority.
use super::super::{super::core::IntegrationTaskCapabilitySourceChoice, KnowledgeOwner};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationApplicationSelectionParams {
    pub source: IntegrationTaskCapabilitySourceChoice,
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 4096)))]
    pub resource_uri: String,
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 256)))]
    pub read_consent_ref: String,
}
impl AutomationApplicationSelectionParams {
    pub fn validate(&self) -> Result<(), String> {
        self.source.validate().map_err(|error| error.to_string())?;
        if self.resource_uri.is_empty()
            || self.resource_uri.len() > 4096
            || self.resource_uri.chars().any(char::is_control)
            || self.read_consent_ref.is_empty()
            || self.read_consent_ref.len() > 256
            || self.read_consent_ref.chars().any(char::is_control)
        {
            return Err("AUTOMATION_APPLICATION_SELECTION_INVALID".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationApplicationSelectionReceipt {
    pub owner: KnowledgeOwner,
    pub source_ref: String,
    pub selection_revision: String,
    pub source: IntegrationTaskCapabilitySourceChoice,
    pub resource_ref: String,
}
