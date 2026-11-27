//! Office settings consume the shared Agent definition library.
pub use super::agent_definitions::{
    BUILTIN_AGENT_DEFINITION_VERSION as BUILTIN_OFFICE_ASSISTANT_VERSION,
    builtin_agent_definition as builtin_office_assistant,
    builtin_agent_definition_version as builtin_office_assistant_version,
    builtin_agent_definitions as builtin_office_assistants,
    builtin_octop_definitions as builtin_octop_assistants, builtin_octop_package,
    prepare_agent_inputs as prepare_office_inputs,
    prepare_agent_schema_inputs as prepare_office_schema_inputs,
    validate_agent_definition as validate_office_definition,
    validate_agent_input_schema as validate_office_schema,
};
use anyhow::{Result, ensure};
use kcoder_types::integrations::office::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct OfficeSettings {
    pub enabled: bool,
    pub allow_organization_templates: bool,
    pub allow_external_delivery: bool,
    pub allowed_formats: Vec<AgentResourceFormat>,
    pub max_output_bytes: u64,
    pub max_dataset_rows: usize,
    pub dataset_page_rows: usize,
    pub projection_preview_chars: usize,
    pub generation_timeout_ms: u64,
}
impl Default for OfficeSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            allow_organization_templates: false,
            allow_external_delivery: false,
            allowed_formats: vec![
                AgentResourceFormat::Docx,
                AgentResourceFormat::Xlsx,
                AgentResourceFormat::Pptx,
                AgentResourceFormat::Csv,
                AgentResourceFormat::Json,
            ],
            max_output_bytes: OFFICE_MAX_ARTIFACT_BYTES,
            max_dataset_rows: OFFICE_MAX_DATASET_ROWS,
            dataset_page_rows: 100,
            projection_preview_chars: 2000,
            generation_timeout_ms: 30_000,
        }
    }
}
impl OfficeSettings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.allowed_formats.is_empty() && self.allowed_formats.len() <= 6,
            "OFFICE_INVALID_FORMAT_POLICY"
        );
        ensure!(
            self.max_output_bytes > 0 && self.max_output_bytes <= OFFICE_MAX_ARTIFACT_BYTES,
            "OFFICE_INVALID_OUTPUT_LIMIT"
        );
        ensure!(
            self.max_dataset_rows > 0 && self.max_dataset_rows <= OFFICE_MAX_DATASET_ROWS,
            "OFFICE_INVALID_DATASET_LIMIT"
        );
        ensure!(
            self.dataset_page_rows > 0 && self.dataset_page_rows <= 100,
            "OFFICE_INVALID_PAGE_LIMIT"
        );
        ensure!(
            self.projection_preview_chars >= 128 && self.projection_preview_chars <= 8000,
            "OFFICE_INVALID_PROJECTION_LIMIT"
        );
        ensure!(
            self.generation_timeout_ms > 0 && self.generation_timeout_ms <= 60_000,
            "OFFICE_INVALID_WAIT_BUDGET"
        );
        Ok(())
    }
}
