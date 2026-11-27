//! An explicit account-local product directory; paths never become transferable authority.
use serde::{Deserialize, Deserializer, Serialize};

pub const CAPABILITY_MIGRATION_SOURCE_DIRECTORY_V1: &str = "migrationSourceDirectoryV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceDirectorySelectParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub selection_id: String,
    pub source: kcoder_types::migration::MigrationSourceKind,
    /// Absolute path on the selected source runtime, never a browser-local path.
    #[serde(deserialize_with = "directory_path")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "directory_schema"))]
    pub directory: String,
}

fn directory_path<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
    {
        return Err(serde::de::Error::custom(
            "expected a bounded source directory",
        ));
    }
    Ok(value)
}

#[cfg(feature = "json-schema")]
fn directory_schema(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    serde_json::from_value(
        serde_json::json!({"type":"string", "minLength":1, "x-max-utf8-bytes":4096,
        "pattern":"^(?=.*\\S)[^\\u0000-\\u001f\\u007f-\\u009f]+$"}),
    )
    .expect("static directory schema")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceDirectoryResult {
    pub selection_id: String,
    pub source: kcoder_types::migration::MigrationSourceKind,
    pub remaining_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn directory_selection_rejects_authority_overrides_and_unbounded_paths() {
        let base = json!({"selectionId":"11111111-1111-4111-8111-111111111111","source":"codex","directory":"/owned/product"});
        for value in [
            "".to_string(),
            "  ".into(),
            "bad\npath".into(),
            "x".repeat(4097),
            "中".repeat(1366),
        ] {
            let mut input = base.clone();
            input["directory"] = value.into();
            assert!(serde_json::from_value::<MigrationSourceDirectorySelectParams>(input).is_err());
        }
        for key in ["principal", "profile", "home", "command"] {
            let mut input = base.clone();
            input[key] = "unauthorized".into();
            assert!(serde_json::from_value::<MigrationSourceDirectorySelectParams>(input).is_err());
        }
        let parsed: MigrationSourceDirectorySelectParams =
            serde_json::from_value(base.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), base);
    }
}
