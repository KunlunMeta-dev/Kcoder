//! Office RPC declarations. The host must authenticate and authorize every call.
pub use kcoder_types::integrations::office::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CAPABILITY_OFFICE_WORKSPACE_V1: &str = "officeWorkspaceV1";
pub const CAPABILITY_OFFICE_EXPORT_ACKNOWLEDGEMENT_V1: &str = "officeExportAcknowledgementV1";
pub const CAPABILITY_OFFICE_EXPORT_RECEIPT_V1: &str = "officeExportReceiptV1";

pub const OFFICE_RPC_PREFIXES: &[&str] = &[
    "integrations/assistant/",
    "integrations/artifact/",
    "integrations/dataset/",
    "integrations/office/",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum OfficeMethod {
    #[serde(rename = "integrations/assistant/skills/catalog")]
    ListSkillMarket,
    #[serde(rename = "integrations/assistant/skills/install")]
    InstallExpertSkill,
    #[serde(rename = "integrations/assistant/market/list")]
    ListExpertMarket,
    #[serde(rename = "integrations/assistant/market/read")]
    ReadExpertMarket,
    #[serde(rename = "integrations/assistant/market/install")]
    InstallExpertMarket,
    #[serde(rename = "integrations/assistant/package/read")]
    ReadExpertPackage,
    #[serde(rename = "integrations/assistant/deleteDraft")]
    DeleteAssistantDraft,
    #[serde(rename = "integrations/assistant/list")]
    ListAssistants,
    #[serde(rename = "integrations/assistant/read")]
    ReadAssistant,
    #[serde(rename = "integrations/assistant/versions")]
    AssistantVersions,
    #[serde(rename = "integrations/assistant/validate")]
    ValidateAssistant,
    #[serde(rename = "integrations/assistant/saveDraft")]
    SaveAssistantDraft,
    #[serde(rename = "integrations/assistant/saveVersion")]
    SaveAssistantVersion,
    #[serde(rename = "integrations/assistant/adopt")]
    AdoptAssistant,
    #[serde(rename = "integrations/assistant/archive")]
    ArchiveAssistant,
    #[serde(rename = "integrations/assistant/export")]
    ExportAssistant,
    #[serde(rename = "integrations/assistant/import")]
    ImportAssistant,
    #[serde(rename = "integrations/artifact/list")]
    ListArtifacts,
    #[serde(rename = "integrations/artifact/createCard")]
    CreateArtifactCard,
    #[serde(rename = "integrations/artifact/read")]
    ReadArtifact,
    #[serde(rename = "integrations/artifact/source")]
    ReadCanonicalSource,
    #[serde(rename = "integrations/artifact/verification")]
    ReadArtifactVerification,
    #[serde(rename = "integrations/artifact/export")]
    ExportArtifact,
    #[serde(rename = "integrations/artifact/acknowledgeExport")]
    AcknowledgeExport,
    #[serde(rename = "integrations/artifact/verify")]
    VerifyArtifact,
    #[serde(rename = "integrations/artifact/prepareAction")]
    PrepareArtifactAction,
    #[serde(rename = "integrations/artifact/executeAction")]
    ExecuteArtifactAction,
    #[serde(rename = "integrations/dataset/schema")]
    DatasetSchema,
    #[serde(rename = "integrations/dataset/page")]
    DatasetPage,
    #[serde(rename = "integrations/dataset/query")]
    DatasetQuery,
    #[serde(rename = "integrations/dataset/export")]
    DatasetExport,
    #[serde(rename = "integrations/dataset/create")]
    CreateDataset,
    #[serde(rename = "integrations/office/generate")]
    GenerateOffice,
    #[serde(rename = "integrations/office/readiness")]
    GeneratorReadiness,
    #[serde(rename = "integrations/office/readOperation")]
    ReadOfficeOperation,
}
impl OfficeMethod {
    pub fn parse(method: &str) -> Option<Self> {
        use OfficeMethod::*;
        Some(match method {
            "integrations/assistant/skills/catalog" => ListSkillMarket,
            "integrations/assistant/skills/install" => InstallExpertSkill,
            "integrations/assistant/market/list" => ListExpertMarket,
            "integrations/assistant/market/read" => ReadExpertMarket,
            "integrations/assistant/market/install" => InstallExpertMarket,
            "integrations/assistant/package/read" => ReadExpertPackage,
            "integrations/assistant/deleteDraft" => DeleteAssistantDraft,
            "integrations/assistant/list" => ListAssistants,
            "integrations/assistant/read" => ReadAssistant,
            "integrations/assistant/versions" => AssistantVersions,
            "integrations/assistant/validate" => ValidateAssistant,
            "integrations/assistant/saveDraft" => SaveAssistantDraft,
            "integrations/assistant/saveVersion" => SaveAssistantVersion,
            "integrations/assistant/adopt" => AdoptAssistant,
            "integrations/assistant/archive" => ArchiveAssistant,
            "integrations/assistant/export" => ExportAssistant,
            "integrations/assistant/import" => ImportAssistant,
            "integrations/artifact/list" => ListArtifacts,
            "integrations/artifact/createCard" => CreateArtifactCard,
            "integrations/artifact/read" => ReadArtifact,
            "integrations/artifact/source" => ReadCanonicalSource,
            "integrations/artifact/verification" => ReadArtifactVerification,
            "integrations/artifact/export" => ExportArtifact,
            "integrations/artifact/acknowledgeExport" => AcknowledgeExport,
            "integrations/artifact/verify" => VerifyArtifact,
            "integrations/artifact/prepareAction" => PrepareArtifactAction,
            "integrations/artifact/executeAction" => ExecuteArtifactAction,
            "integrations/dataset/schema" => DatasetSchema,
            "integrations/dataset/page" => DatasetPage,
            "integrations/dataset/query" => DatasetQuery,
            "integrations/dataset/export" => DatasetExport,
            "integrations/dataset/create" => CreateDataset,
            "integrations/office/generate" => GenerateOffice,
            "integrations/office/readiness" => GeneratorReadiness,
            "integrations/office/readOperation" => ReadOfficeOperation,
            _ => return None,
        })
    }
    pub const fn is_mutation(self) -> bool {
        use OfficeMethod::*;
        !matches!(
            self,
            ListAssistants
                | ListSkillMarket
                | ListExpertMarket
                | ReadExpertMarket
                | ReadExpertPackage
                | ReadAssistant
                | AssistantVersions
                | ValidateAssistant
                | ListArtifacts
                | ReadArtifact
                | ReadCanonicalSource
                | ReadArtifactVerification
                | DatasetSchema
                | DatasetPage
                | DatasetQuery
                | GeneratorReadiness
                | ReadOfficeOperation
        )
    }
    pub const fn action(self) -> &'static str {
        use OfficeMethod::*;
        match self {
            ListSkillMarket => "office.assistant.read",
            InstallExpertSkill => "office.assistant.write",
            ListExpertMarket | ReadExpertMarket | ReadExpertPackage => "office.assistant.read",
            InstallExpertMarket | DeleteAssistantDraft => "office.assistant.write",
            ListAssistants | ReadAssistant | AssistantVersions | ValidateAssistant => {
                "office.assistant.read"
            }
            SaveAssistantDraft | SaveAssistantVersion | ArchiveAssistant => {
                "office.assistant.write"
            }
            AdoptAssistant => "office.assistant.adopt",
            ExportAssistant => "office.assistant.export",
            ImportAssistant => "office.assistant.import",
            ListArtifacts | ReadArtifact | ReadArtifactVerification => "office.artifact.read",
            ReadCanonicalSource => "office.artifact.source.read",
            ExportArtifact | DatasetExport | AcknowledgeExport => "office.artifact.export",
            CreateArtifactCard => "office.artifact.publish",
            VerifyArtifact => "office.artifact.verify",
            PrepareArtifactAction | ExecuteArtifactAction => "office.artifact.action",
            DatasetSchema | DatasetPage | DatasetQuery => "office.dataset.read",
            CreateDataset => "office.dataset.write",
            GenerateOffice => "office.document.generate",
            GeneratorReadiness => "office.generator.inspect",
            ReadOfficeOperation => "office.operation.read",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeListParams {
    #[serde(default)]
    pub personal_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}
fn default_limit() -> usize {
    10
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeAssistantReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub id: String,
    #[serde(default)]
    pub version: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeSaveDraftParams {
    pub definition: OfficeAssistantDefinition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy_from: Option<kcoder_types::integrations::core::IntegrationRevisionRef>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeSaveVersionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub id: String,
    pub version: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeAdoptParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub id: String,
    pub version: String,
    pub inputs: Value,
    /// Adoption alone never starts a task.
    #[serde(default)]
    pub start_task: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeArtifactReadParams {
    pub reference: OfficeArtifactRef,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeArtifactListParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(flatten)]
    pub page: OfficeListParams,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeExportParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<OfficeTaskRef>,
    pub reference: OfficeArtifactRef,
    pub format: OfficeFileFormat,
}

/// Locators and a client byte observation only. The original native export
/// owner must independently prove full coverage, identity and current access.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeExportAcknowledgementParams {
    pub export_id: String,
    pub lease_revision: String,
    pub reference: OfficeArtifactRef,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_automation_run_id"
    )]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "automation_run_id_schema")
    )]
    pub automation_run_id: Option<String>,
    pub bytes: u64,
    pub sha256: String,
}

// Omission selects ordinary receipt semantics. A present null/bad D locator
// must never silently become that different intent.
fn present_automation_run_id<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Option<String>, D::Error> {
    let value = String::deserialize(input)?;
    if value.trim().is_empty() || value.chars().count() > 256 {
        return Err(serde::de::Error::custom(
            "invalid original automation run locator",
        ));
    }
    Ok(Some(value))
}
#[cfg(feature = "json-schema")]
fn automation_run_id_schema(generator: &mut schemars::SchemaGenerator) -> schemars::schema::Schema {
    let mut schema = generator.subschema_for::<String>();
    if let schemars::schema::Schema::Object(object) = &mut schema {
        object.string().min_length = Some(1);
        object.string().max_length = Some(256);
        object.string().pattern = Some(r"\S".into());
    }
    schema
}

/// Acknowledgement means that the original client confirms receipt. It does
/// not establish a physical save, external delivery or business correctness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeExportAcknowledgementResult {
    pub export_id: String,
    pub reference: OfficeArtifactRef,
    pub acknowledgement: OfficeExportAcknowledgement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<kcoder_types::integrations::knowledge::AutomationArtifactClaim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<OfficeExportAcknowledgementReceipt>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeExportAcknowledgement {
    ClientAcknowledged,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeDatasetPageParams {
    pub reference: OfficeArtifactRef,
    pub query: OfficeDatasetQuery,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeGenerateParams {
    pub task: OfficeTaskRef,
    pub specification: OfficeGenerationSpec,
    #[serde(default)]
    pub source_refs: Vec<OfficeResourceRef>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeArtifactActionParams {
    pub reference: OfficeArtifactRef,
    pub action: String,
    #[serde(default)]
    pub destination: Option<OfficeResourceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn office_methods_do_not_expose_arbitrary_commands() {
        assert_eq!(
            OfficeMethod::parse("integrations/office/generate"),
            Some(OfficeMethod::GenerateOffice)
        );
        assert!(OfficeMethod::GenerateOffice.is_mutation());
        assert!(!OfficeMethod::ReadArtifact.is_mutation());
        assert_eq!(OfficeMethod::parse("integrations/office/shell"), None);
    }

    #[test]
    fn list_payload_is_bounded_by_declared_fields() {
        let list: OfficeListParams = serde_json::from_value(json!({})).unwrap();
        assert_eq!(list.limit, 10);
        assert!(
            serde_json::from_value::<OfficeGenerateParams>(json!({
                "task":{"threadId":"t","turnId":"u"},"specification":{},"program":"/untrusted"
            }))
            .is_err()
        );
        let page: OfficeArtifactListParams = serde_json::from_value(json!({
            "threadId":"t","limit":10
        }))
        .unwrap();
        assert_eq!(page.page.limit, 10);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeCreateCardParams {
    pub task: OfficeTaskRef,
    pub title: String,
    pub presentation: OfficeArtifactPresentation,
    #[serde(default)]
    pub source_refs: Vec<OfficeResourceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeExecuteArtifactActionParams {
    pub prepared_operation_id: String,
}

#[cfg(test)]
mod acknowledgement_compatibility_tests {
    use super::*;
    #[test]
    fn ordinary_ack_omits_d_run_and_unknown_fields_stay_rejected() {
        let old = serde_json::json!({"exportId":"original-export","leaseRevision":"original-lease",
            "reference":{"id":"original-artifact","revision":1},"automationRunId":"original-d-run","bytes":10,"sha256":"a".repeat(64)});
        let parsed: OfficeExportAcknowledgementParams =
            serde_json::from_value(old.clone()).unwrap();
        assert_eq!(parsed.automation_run_id.as_deref(), Some("original-d-run"));
        assert_eq!(serde_json::to_value(parsed).unwrap(), old);
        let mut ordinary = old;
        ordinary.as_object_mut().unwrap().remove("automationRunId");
        let parsed: OfficeExportAcknowledgementParams =
            serde_json::from_value(ordinary.clone()).unwrap();
        assert!(parsed.automation_run_id.is_none());
        assert_eq!(serde_json::to_value(parsed).unwrap(), ordinary);
        for bad in [
            serde_json::Value::Null,
            serde_json::json!(""),
            serde_json::json!("   "),
            serde_json::json!(1),
            serde_json::json!(false),
        ] {
            let mut supplied = ordinary.clone();
            supplied["automationRunId"] = bad;
            assert!(serde_json::from_value::<OfficeExportAcknowledgementParams>(supplied).is_err());
        }
        ordinary["saved"] = serde_json::json!(true);
        assert!(serde_json::from_value::<OfficeExportAcknowledgementParams>(ordinary).is_err());
    }
}
