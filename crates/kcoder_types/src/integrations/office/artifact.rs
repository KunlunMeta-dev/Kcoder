use super::*;
use crate::integrations::core::IntegrationOwner;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeFileFormat {
    Docx,
    Xlsx,
    Pptx,
    Pdf,
    Csv,
    Json,
}
impl OfficeFileFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
            Self::Pdf => "pdf",
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }
    pub fn media_type(self) -> &'static str {
        match self {
            Self::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Self::Xlsx => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            Self::Pptx => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
            Self::Pdf => "application/pdf",
            Self::Csv => "text/csv; charset=utf-8",
            Self::Json => "application/json",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeArtifactKind {
    Document,
    Table,
    Chart,
    ActionItems,
    Research,
    OperationReceipt,
    FileCollection,
    Form,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeVerificationStatus {
    Pending,
    Passed,
    Partial,
    Failed,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeVerification {
    pub status: OfficeVerificationStatus,
    pub completed_checks: Vec<String>,
    pub pending_checks: Vec<String>,
    /// A structural pass never establishes reader, numeric or business correctness.
    pub reader_status: OfficeVerificationStatus,
    pub formula_calculation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeTaskRef {
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeArtifactRef {
    pub id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeArtifactManifest {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub owner: IntegrationOwner,
    pub task: OfficeTaskRef,
    pub kind: OfficeArtifactKind,
    pub title: String,
    pub format: OfficeFileFormat,
    pub bytes: u64,
    pub sha256: String,
    pub source_refs: Vec<OfficeResourceRef>,
    pub verification: OfficeVerification,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset: Option<OfficeArtifactRef>,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<OfficeArtifactPresentation>,
}
impl OfficeArtifactManifest {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        if self.schema_version != OFFICE_SCHEMA_VERSION
            || self.revision == 0
            || self.bytes > OFFICE_MAX_ARTIFACT_BYTES
        {
            return Err(invalid("artifact"));
        }
        identifier(&self.id, "artifact.id")?;
        bounded(&self.title, 200, false, "artifact.title")?;
        identifier(&self.task.thread_id, "artifact.threadId")?;
        identifier(&self.task.turn_id, "artifact.turnId")?;
        if let Some(run) = &self.task.run_id {
            identifier(run, "artifact.runId")?;
        }
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid("artifact.sha256"));
        }
        if self.source_refs.len() > 128
            || self.verification.completed_checks.len() > 64
            || self.verification.pending_checks.len() > 64
        {
            return Err(invalid("artifact.provenance"));
        }
        for source in &self.source_refs {
            source.validate()?;
        }
        for check in self
            .verification
            .completed_checks
            .iter()
            .chain(&self.verification.pending_checks)
        {
            bounded(check, 1000, false, "artifact.verification")?;
        }
        bounded(
            &self.verification.formula_calculation,
            128,
            false,
            "artifact.formulaCalculation",
        )?;
        if let Some(presentation) = &self.presentation {
            if presentation.kind() != self.kind {
                return Err(invalid("artifact.presentation.kind"));
            }
            presentation.validate(&self.source_refs)?;
        }
        encoded_limit(self, 128 * 1024, "artifact")
    }
}

/// Opaque current-owner download/preview lease. It is not a filesystem path,
/// public sharing URL, delivery acknowledgment or evidence that a user viewed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeExportReceipt {
    pub schema_version: u32,
    pub export_id: String,
    pub reference: OfficeArtifactRef,
    pub filename: String,
    pub media_type: String,
    pub bytes: u64,
    pub sha256: String,
    pub lease_revision: String,
    pub expires_at_ms: u64,
}
impl OfficeExportReceipt {
    pub fn validate_for(
        &self,
        manifest: &OfficeArtifactManifest,
    ) -> Result<(), OfficeValidationError> {
        identifier(&self.export_id, "export.exportId")?;
        identifier(&self.lease_revision, "export.leaseRevision")?;
        bounded(&self.filename, 200, false, "export.filename")?;
        if self.schema_version != 1
            || self.reference.id != manifest.id
            || self.reference.revision != manifest.revision
            || self.bytes != manifest.bytes
            || self.sha256 != manifest.sha256
            || self.media_type != manifest.format.media_type()
            || self.expires_at_ms == 0
            || self.filename.contains(['/', '\\', '\0', ':'])
        {
            return Err(invalid("export.receipt"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeVerificationObservation {
    pub reference: OfficeArtifactRef,
    pub content_sha256: String,
    pub revision: u64,
    pub observed_at_ms: u64,
    pub verification: OfficeVerification,
}

/// A durable fact about original client byte receipt, never a saved-file or read permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum OfficeExportAcknowledgementKind {
    #[serde(rename = "office_export_acknowledgement")]
    ClientByteReceipt,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeExportAcknowledgementReceipt {
    pub schema_version: u32,
    pub kind: OfficeExportAcknowledgementKind,
    pub operation_id: String,
    pub owner: IntegrationOwner,
    pub task: OfficeTaskRef,
    pub export_id: String,
    pub reference: OfficeArtifactRef,
    pub bytes: u64,
    pub sha256: String,
    pub source_identities: Vec<OfficeCanonicalInputIdentity>,
    pub read_completed_at_ms: u64,
    pub acknowledged_at_ms: u64,
}
impl OfficeExportAcknowledgementReceipt {
    pub fn validate_for(
        &self,
        manifest: &OfficeArtifactManifest,
    ) -> Result<(), OfficeValidationError> {
        manifest.validate()?;
        identifier(&self.operation_id, "acknowledgement.operationId")?;
        identifier(&self.export_id, "acknowledgement.exportId")?;
        if self.schema_version != 1
            || self.owner != manifest.owner
            || self.task != manifest.task
            || self.reference.id != manifest.id
            || self.reference.revision != manifest.revision
            || self.bytes != manifest.bytes
            || self.sha256 != manifest.sha256
            || self.source_identities.len() != manifest.source_refs.len()
            || self.read_completed_at_ms == 0
            || self.acknowledged_at_ms == 0
        {
            return Err(invalid("acknowledgement.receipt"));
        }
        for (actual, expected) in self.source_identities.iter().zip(&manifest.source_refs) {
            actual.validate()?;
            if &actual.reference != expected {
                return Err(invalid("acknowledgement.sources"));
            }
        }
        encoded_limit(self, 128 * 1024, "acknowledgement.receipt")
    }
}
