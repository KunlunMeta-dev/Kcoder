//! Full generator source stays private; ordinary manifests expose bounded identity only.
use super::*;
use crate::integrations::core::IntegrationOwner;
use serde::{Deserialize, Serialize};

pub const OFFICE_CANONICAL_SOURCE_MAX_BYTES: usize = 1024 * 1024;
pub const OFFICE_CANONICAL_SOURCE_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeGeneratorIdentity {
    pub component: String,
    pub version: String,
    pub schema_revision: String,
    pub implementation_sha256: String,
    pub dependency_lock_sha256: String,
}
impl OfficeGeneratorIdentity {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        for value in [&self.component, &self.version, &self.schema_revision] {
            bounded(value, 128, false, "canonical.generator")?;
        }
        source_sha(&self.implementation_sha256)?;
        source_sha(&self.dependency_lock_sha256)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeCanonicalInputIdentity {
    pub reference: OfficeResourceRef,
    /// Actual immutable content identity resolved under native authority.
    pub sha256: String,
}
impl OfficeCanonicalInputIdentity {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        self.reference.validate()?;
        source_sha(&self.sha256)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeCanonicalSourceDescriptor {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub owner: IntegrationOwner,
    pub operation_id: String,
    pub task: OfficeTaskRef,
    pub artifact: OfficeArtifactRef,
    pub output_sha256: String,
    /// Hash/length of key-normalized UTF-8 JSON; array order and all strings are preserved.
    pub specification_sha256: String,
    pub specification_bytes: u64,
    pub generator: OfficeGeneratorIdentity,
    pub inputs: Vec<OfficeCanonicalInputIdentity>,
    pub created_at_ms: u64,
}
impl OfficeCanonicalSourceDescriptor {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        identifier(&self.id, "canonical.id")?;
        identifier(&self.operation_id, "canonical.operationId")?;
        identifier(&self.task.thread_id, "canonical.threadId")?;
        identifier(&self.task.turn_id, "canonical.turnId")?;
        identifier(&self.artifact.id, "canonical.artifactId")?;
        if self.schema_version != 1
            || self.revision != 1
            || self.artifact.revision == 0
            || self.specification_bytes == 0
            || self.specification_bytes > OFFICE_CANONICAL_SOURCE_MAX_BYTES as u64
            || self.inputs.len() > 128
        {
            return Err(invalid("canonical.source"));
        }
        source_sha(&self.output_sha256)?;
        source_sha(&self.specification_sha256)?;
        self.generator.validate()?;
        for input in &self.inputs {
            input.validate()?;
        }
        encoded_limit(self, 128 * 1024, "canonical.descriptor")
    }
    pub fn validate_for(
        &self,
        manifest: &OfficeArtifactManifest,
    ) -> Result<(), OfficeValidationError> {
        self.validate()?;
        if self.owner != manifest.owner
            || self.task != manifest.task
            || self.artifact.id != manifest.id
            || self.artifact.revision != manifest.revision
            || self.output_sha256 != manifest.sha256
            || self
                .inputs
                .iter()
                .map(|input| &input.reference)
                .collect::<Vec<_>>()
                != manifest.source_refs.iter().collect::<Vec<_>>()
        {
            return Err(invalid("canonical.artifactBinding"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeCanonicalSourceAvailability {
    Available,
    /// Older or externally written artifacts have no generation source; never reconstruct from previews.
    NotRecorded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeCanonicalSourceReadResult {
    pub availability: OfficeCanonicalSourceAvailability,
    pub source: Option<OfficeCanonicalSourceDescriptor>,
    /// Only returned on an explicit authorized full-source read. Never auto-append to model context.
    pub chunk: Option<String>,
    pub offset: u64,
    pub next_offset: Option<u64>,
    /// Byte transfer completion only; never Office correctness or edit support.
    pub complete: bool,
}
fn source_sha(value: &str) -> Result<(), OfficeValidationError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("canonical.sha256"));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeCanonicalSourceReadParams {
    pub reference: OfficeArtifactRef,
    #[serde(default = "source_metadata_only")]
    pub metadata_only: bool,
    /// Required for byte reads; must match the exact descriptor, never latest.
    #[serde(default)]
    pub expected_sha256: Option<String>,
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "source_chunk_limit")]
    pub limit: usize,
}
fn source_metadata_only() -> bool {
    true
}
fn source_chunk_limit() -> usize {
    OFFICE_CANONICAL_SOURCE_CHUNK_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn canonical_read_defaults_to_metadata_and_rejects_arbitrary_paths() {
        let params: OfficeCanonicalSourceReadParams =
            serde_json::from_value(json!({"reference":{"id":"actual-artifact","revision":1}}))
                .unwrap();
        assert!(params.metadata_only);
        assert_eq!(params.limit, 64 * 1024);
        assert!(params.expected_sha256.is_none());
        assert!(serde_json::from_value::<OfficeCanonicalSourceReadParams>(json!({"reference":{"id":"actual-artifact","revision":1},"path":"/not-an-authority"})).is_err());
    }
    #[test]
    fn legacy_absence_is_distinct_from_empty_complete_source() {
        let result = OfficeCanonicalSourceReadResult {
            availability: OfficeCanonicalSourceAvailability::NotRecorded,
            source: None,
            chunk: None,
            offset: 0,
            next_offset: None,
            complete: false,
        };
        let serialized = serde_json::to_value(&result).unwrap();
        assert_eq!(serialized["availability"], "not_recorded");
        assert!(serialized["source"].is_null());
        assert!(serialized["chunk"].is_null());
        assert_eq!(serialized["complete"], false);
    }
}
