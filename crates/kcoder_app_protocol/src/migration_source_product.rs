//! Account-owned product preparation is separate from upload storage and formal migration.
use kcoder_types::{migration::MigrationSourceKind, migration_source_upload::SourceUploadState};
use serde::{Deserialize, Deserializer, Serialize};

pub const CAPABILITY_MIGRATION_SOURCE_UPLOADED_V1: &str = "migrationSourceUploadedV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceProductParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub operation_id: String,
    #[serde(deserialize_with = "manifest_digest")]
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceProductRunParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub operation_id: String,
    #[serde(deserialize_with = "manifest_digest")]
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
    pub manifest_sha256: String,
    pub expected_sequence: u64,
    pub cancel_watermark: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceProductCancelParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub operation_id: String,
    #[serde(deserialize_with = "manifest_digest")]
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
    pub manifest_sha256: String,
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub command_id: String,
}

fn manifest_digest<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(serde::de::Error::custom("expected a manifest digest"));
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceProductStateResult {
    pub materialization: SourceUploadState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceProductOrigin {
    UserSupplied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceProductSelectResult {
    pub operation_id: String,
    pub manifest_sha256: String,
    pub source: MigrationSourceKind,
    pub remaining_ms: u64,
    pub origin: MigrationSourceProductOrigin,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn uploaded_selection_has_no_path_or_original_machine_authority() {
        let original = json!({"operationId":"11111111-1111-4111-8111-111111111111","manifestSha256":"a".repeat(64)});
        assert!(serde_json::from_value::<MigrationSourceProductParams>(original.clone()).is_ok());
        for key in [
            "root",
            "path",
            "home",
            "profile",
            "sourceAuthority",
            "originalAccount",
            "source",
        ] {
            let mut input = original.clone();
            input[key] = json!("not authority");
            assert!(serde_json::from_value::<MigrationSourceProductParams>(input).is_err());
        }
        for value in ["A".repeat(64), "g".repeat(64), "a".repeat(63)] {
            let mut input = original.clone();
            input["manifestSha256"] = json!(value);
            assert!(serde_json::from_value::<MigrationSourceProductParams>(input).is_err());
        }
        assert!(
            serde_json::from_value::<MigrationSourceProductOrigin>(json!(
                "authenticated_original_machine"
            ))
            .is_err()
        );
    }
}
