//! Gateway-owned source sessions. Selectors never confer Native parent authority.
use serde::{Deserialize, Deserializer, Serialize};

pub const CAPABILITY_MIGRATION_SOURCE_CODEX_LAYERS_V1: &str = "migrationSourceCodexLayersV1";
pub const CAPABILITY_MIGRATION_SOURCE_CONFIGURATION_LAYERS_V1: &str =
    "migrationSourceConfigurationLayersV1";

/// A source child may inspect only a previously discovered source, never a saved target job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCodexLayersReadParams {
    pub source_id: String,
    #[serde(default)]
    pub page_index: u32,
}

/// A source-only configuration report cannot select a target job or filesystem path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceConfigurationLayersReadParams {
    pub source_id: String,
    #[serde(default)]
    pub page_index: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceSessionPurpose {
    Source,
    Target,
    TargetRecovery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceSessionOpenParams {
    /// Stable wizard identity; retrying must not create a second owned process.
    #[serde(deserialize_with = "session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub session_id: String,
    pub purpose: MigrationSourceSessionPurpose,
    /// Gateway resolves this selector against the authenticated target ACL.
    pub target_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceSessionParams {
    #[serde(deserialize_with = "session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub session_id: String,
    pub purpose: MigrationSourceSessionPurpose,
    /// Must resolve to the original session scope; this cannot retarget a child.
    pub target_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

/// Only reviewed discovery operations can enter the owned source process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum MigrationSourceSessionQuery {
    Projects(crate::MigrationProjectsDiscoverParams),
    ProjectsPage(crate::MigrationProjectsSourcesParams),
    ProjectRoots(crate::MigrationProjectSourceRootsParams),
    InstructionsCapture(crate::MigrationInstructionCaptureParams),
    InstructionsPage(crate::MigrationSourceInstructionPageParams),
    InstructionsBody(crate::MigrationSourceInstructionBodyParams),
    Plugins(crate::MigrationPluginDiscoverParams),
    Configuration(crate::MigrationDiscoverParams),
    Definitions(crate::MigrationDefinitionsDiscoverParams),
    SourceBindings(crate::MigrationSourceBindingsParams),
    DirectorySelect(crate::MigrationSourceDirectorySelectParams),
    UploadedSelect(crate::MigrationSourceProductParams),
    CodexLayersSelect(crate::MigrationCodexLayersSelectParams),
    CodexLayersRead(MigrationSourceCodexLayersReadParams),
    ConfigurationLayersRead(MigrationSourceConfigurationLayersReadParams),
    Memory(crate::MigrationMemoryDiscoverParams),
    MemoryPage(crate::MigrationMemorySourcesParams),
    History(crate::MigrationHistoryDiscoverParams),
    HistoryFamilies(crate::MigrationHistoryDiscoverParams),
    HistoryPage(crate::MigrationHistorySourcesParams),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceSessionQueryParams {
    pub session: MigrationSourceSessionParams,
    pub query: MigrationSourceSessionQuery,
}

pub(crate) fn session_identity<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if crate::canonical_transfer_uuid(&value)
        && matches!(value.as_bytes()[14], b'1'..=b'8')
        && matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
    {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(
            "expected a canonical session UUID",
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceSessionState {
    Opening,
    Ready,
    Closing,
    Released,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceSessionStateResult {
    pub status: MigrationSourceSessionState,
    pub launching: bool,
    pub owned_children: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceSessionReleaseState {
    Released,
    Pending,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceSessionCloseResult {
    pub status: MigrationSourceSessionReleaseState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selectors_cannot_supply_authentication_or_native_identity() {
        let base = json!({"sessionId":"22222222-2222-4222-8222-222222222222", "purpose":"source", "targetId":"local"});
        for (key, value) in [
            ("principal", json!({"kind":"localOs"})),
            ("sourceAuthority", json!({"instanceId":"other"})),
            ("kcoderPrivateMigrationSource", json!({"version":1})),
            ("command", json!("arbitrary")),
            ("generation", json!(1)),
        ] {
            let mut input = base.clone();
            input[key] = value;
            assert!(serde_json::from_value::<MigrationSourceSessionOpenParams>(input).is_err());
        }
        let params: MigrationSourceSessionOpenParams =
            serde_json::from_value(base.clone()).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap(), base);
    }

    #[test]
    fn malformed_session_identity_is_rejected_before_process_lookup() {
        for id in [
            "wizard",
            "",
            "22222222-2222-0222-8222-222222222222",
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        ] {
            assert!(
                serde_json::from_value::<MigrationSourceSessionParams>(
                    json!({"sessionId":id,"purpose":"source"})
                )
                .is_err()
            );
        }
    }

    #[test]
    fn family_index_query_is_explicit_and_accepts_no_filesystem_authority() {
        let value = json!({"kind":"history_families","params":{"source":"codex"}});
        let query: MigrationSourceSessionQuery = serde_json::from_value(value.clone()).unwrap();
        assert!(matches!(
            query,
            MigrationSourceSessionQuery::HistoryFamilies(_)
        ));
        assert_eq!(serde_json::to_value(query).unwrap(), value);
        for field in ["path", "root", "catalogId", "parentId"] {
            let mut invalid = value.clone();
            invalid["params"][field] = json!("untrusted");
            assert!(serde_json::from_value::<MigrationSourceSessionQuery>(invalid).is_err());
        }
    }

    #[test]
    fn recovery_purpose_is_explicit_and_close_cannot_retarget() {
        let input = json!({"sessionId":"22222222-2222-4222-8222-222222222222", "purpose":"target_recovery","targetId":"local"});
        let params: MigrationSourceSessionParams = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(
            params.purpose,
            MigrationSourceSessionPurpose::TargetRecovery
        );
        let mut retargeted = input;
        retargeted["principal"] = json!({"kind":"localOs"});
        assert!(serde_json::from_value::<MigrationSourceSessionParams>(retargeted).is_err());
    }

    #[test]
    fn source_codex_read_cannot_supply_a_job_or_filesystem_authority() {
        for value in [
            json!({"target":{"kind":"job","jobId":"peer"}}),
            json!({"sourceId":"opaque","path":"/private"}),
        ] {
            assert!(serde_json::from_value::<MigrationSourceCodexLayersReadParams>(value).is_err());
        }
        let value: MigrationSourceCodexLayersReadParams =
            serde_json::from_value(json!({"sourceId":"opaque"})).unwrap();
        assert_eq!(value.page_index, 0);
    }
    #[test]
    fn source_configuration_read_cannot_import_target_or_path_authority() {
        for value in [
            json!({"target":{"kind":"job","jobId":"peer"}}),
            json!({"sourceId":"opaque","path":"/private"}),
            json!({"sourceId":"opaque","jobId":"peer"}),
            json!({"sourceId":"opaque","pageIndex":-1}),
        ] {
            assert!(
                serde_json::from_value::<MigrationSourceConfigurationLayersReadParams>(value)
                    .is_err()
            );
        }
        let query: MigrationSourceSessionQuery = serde_json::from_value(json!({
            "kind":"configuration_layers_read", "params":{"sourceId":"opaque"}
        }))
        .unwrap();
        assert!(
            matches!(query, MigrationSourceSessionQuery::ConfigurationLayersRead(params) if params.page_index == 0)
        );
    }
}
