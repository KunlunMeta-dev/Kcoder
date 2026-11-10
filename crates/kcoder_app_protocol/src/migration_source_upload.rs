//! User-selected regular files are uploaded privately; Ready does not mean imported.
use kcoder_types::migration_source_upload::{
    SourceUploadFilePage, SourceUploadManifest, SourceUploadState,
};
use serde::{Deserialize, Deserializer, Serialize};

pub const CAPABILITY_MIGRATION_SOURCE_UPLOAD_V1: &str = "migrationSourceUploadV1";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceUploadPrepareParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub operation_id: String,
    pub manifest: SourceUploadManifest,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceUploadReadParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub operation_id: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceUploadFilesParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub operation_id: String,
    #[serde(default)]
    pub cursor: Option<u32>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceUploadPartParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub operation_id: String,
    pub cancel_watermark: u64,
    pub file_index: u32,
    pub part_index: u32,
    #[serde(deserialize_with = "bounded_base64")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(
            length(min = 4, max = 174764),
            regex(pattern = "^[A-Za-z0-9+/]+={0,2}$")
        )
    )]
    pub content_base64: String,
}

fn bounded_base64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    let data = value.trim_end_matches('=');
    if !(4..=174764).contains(&value.len())
        || value.len() - data.len() > 2
        || data.is_empty()
        || !data
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    {
        return Err(serde::de::Error::custom("expected a bounded upload part"));
    }
    Ok(value)
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceUploadRunParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub operation_id: String,
    pub expected_sequence: u64,
    pub cancel_watermark: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceUploadCancelParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub operation_id: String,
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub command_id: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceUploadStateResult {
    pub upload: SourceUploadState,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceUploadFilesResult {
    pub page: SourceUploadFilePage,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn source_upload_wire_rejects_path_authority_and_oversized_parts() {
        let base = json!({"operationId":"11111111-1111-4111-8111-111111111111","cancelWatermark":0,
            "fileIndex":0,"partIndex":0,"contentBase64":"Ym9keQ=="});
        assert!(serde_json::from_value::<MigrationSourceUploadPartParams>(base.clone()).is_ok());
        for key in [
            "profile",
            "home",
            "owner",
            "sourcePath",
            "target",
            "executable",
        ] {
            let mut value = base.clone();
            value[key] = json!("untrusted");
            assert!(serde_json::from_value::<MigrationSourceUploadPartParams>(value).is_err());
        }
        for data in [
            String::new(),
            "A".repeat(174765),
            "secret\n".into(),
            "A===AA".into(),
        ] {
            let mut value = base.clone();
            value["contentBase64"] = json!(data);
            assert!(serde_json::from_value::<MigrationSourceUploadPartParams>(value).is_err());
        }
    }
}
