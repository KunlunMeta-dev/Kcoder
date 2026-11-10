use super::*;
use crate::integrations::core::{IntegrationOwner, IntegrationScope};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeAssistantScope {
    Personal,
    Workspace,
    Organization,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeResourceRef {
    pub kind: String,
    pub id: String,
    pub revision: String,
}
impl OfficeResourceRef {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        identifier(&self.kind, "resource.kind")?;
        identifier(&self.id, "resource.id")?;
        identifier(&self.revision, "resource.revision")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeCapabilityRequirement {
    pub capability_id: String,
    #[serde(default)]
    pub formats: Vec<OfficeFileFormat>,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeWorkflowRef {
    pub definition_id: String,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OfficeModelSelection {
    InheritCurrent,
    Explicit { provider: String, model: String },
    AutoPolicy { id: String, version: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeExternalSend {
    Ask,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeAssistantDefinition {
    pub schema_version: u32,
    pub id: String,
    pub scope: OfficeAssistantScope,
    pub title: String,
    pub description: String,
    pub language: String,
    pub input_schema: Value,
    pub instructions: String,
    /// Reviewed, versioned skill instructions; these never grant tools or execute files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<OfficeAssistantSkill>,
    #[serde(default)]
    pub capabilities: Vec<OfficeCapabilityRequirement>,
    #[serde(default)]
    pub resources: Vec<OfficeResourceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_ref: Option<OfficeWorkflowRef>,
    pub model_selection: OfficeModelSelection,
    /// None inherits only the already permitted registry; an empty list permits no tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    pub output_kinds: Vec<OfficeArtifactKind>,
    pub acceptance_criteria: Vec<String>,
    pub external_send: OfficeExternalSend,
}
impl OfficeAssistantDefinition {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        if self.schema_version != OFFICE_SCHEMA_VERSION {
            return Err(invalid("schemaVersion"));
        }
        identifier(&self.id, "id")?;
        bounded(&self.title, 200, false, "title")?;
        bounded(&self.description, 4000, false, "description")?;
        bounded(&self.language, 32, false, "language")?;
        bounded(&self.instructions, 24_000, false, "instructions")?;
        if self.skills.len() > 64 {
            return Err(invalid("skills"));
        }
        let mut slugs = HashSet::new();
        for skill in &self.skills {
            skill.validate()?;
            if !slugs.insert(&skill.slug) {
                return Err(invalid("skills.slug"));
            }
        }
        if !self.skills.is_empty() && self.runtime_instructions().len() > 24_000 {
            return Err(invalid("skills.content"));
        }
        if !self.input_schema.is_object() {
            return Err(invalid("inputSchema"));
        }
        encoded_limit(&self.input_schema, OFFICE_MAX_SCHEMA_BYTES, "inputSchema")?;
        if self.capabilities.len() > 64
            || self.resources.len() > 128
            || self.output_kinds.is_empty()
            || self.output_kinds.len() > 16
            || self.acceptance_criteria.is_empty()
            || self.acceptance_criteria.len() > 64
        {
            return Err(invalid("definition"));
        }
        let mut names = HashSet::new();
        for capability in &self.capabilities {
            identifier(&capability.capability_id, "capabilities.id")?;
            if !names.insert(&capability.capability_id) || capability.formats.len() > 8 {
                return Err(invalid("capabilities"));
            }
        }
        for resource in &self.resources {
            resource.validate()?;
        }
        for criterion in &self.acceptance_criteria {
            bounded(criterion, 2000, false, "acceptanceCriteria")?;
        }
        if let Some(tools) = &self.allowed_tools {
            if tools.len() > 256 {
                return Err(invalid("allowedTools"));
            }
            let mut names = HashSet::new();
            for tool in tools {
                identifier(tool, "allowedTools")?;
                if !names.insert(tool) {
                    return Err(invalid("allowedTools"));
                }
            }
        }
        if let Some(workflow) = &self.workflow_ref {
            identifier(&workflow.definition_id, "workflowRef.id")?;
            if workflow.version == 0 {
                return Err(invalid("workflowRef.version"));
            }
        }
        match &self.model_selection {
            OfficeModelSelection::InheritCurrent => {}
            OfficeModelSelection::Explicit { provider, model } => {
                identifier(provider, "model.provider")?;
                identifier(model, "model.model")?;
            }
            OfficeModelSelection::AutoPolicy { id, version } => {
                identifier(id, "model.policyId")?;
                identifier(version, "model.policyVersion")?;
            }
        }
        encoded_limit(self, OFFICE_MAX_DEFINITION_BYTES, "definition")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeAssistantDraft {
    pub owner: IntegrationOwner,
    pub revision: u64,
    pub definition: OfficeAssistantDefinition,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeAssistantVersion {
    pub owner: IntegrationOwner,
    pub version: String,
    pub definition: OfficeAssistantDefinition,
    pub definition_sha256: String,
    pub created_at_ms: u64,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeAssistantAdoption {
    pub operation_id: String,
    pub scope: IntegrationScope,
    pub assistant: OfficeAssistantVersion,
    pub inputs: Value,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_turn_id: Option<String>,
}
