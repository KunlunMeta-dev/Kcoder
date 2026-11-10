//! Independently negotiated grant descriptions preserve legacy discovery results.
use serde::{Deserialize, Deserializer, Serialize};

pub const CAPABILITY_MIGRATION_SOURCE_BINDINGS_V1: &str = "migrationSourceBindingsV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceBindingsParams {
    #[serde(deserialize_with = "source_ids")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "source_reference_schema")
    )]
    pub source_ids: Vec<String>,
}

#[cfg(feature = "json-schema")]
fn source_reference_schema(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    serde_json::from_value(serde_json::json!({
        "type": "array", "minItems": 1, "maxItems": 10, "uniqueItems": true,
        "items": {"type": "string", "minLength": 1, "x-max-utf8-bytes": 256,
            "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f]+$"}
    }))
    .expect("static source-reference schema")
}

fn source_ids<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    let values = Vec::<String>::deserialize(deserializer)?;
    if values.is_empty()
        || values.len() > 10
        || values.iter().any(|value| {
            value.is_empty() || value.len() > 256 || value.chars().any(char::is_control)
        })
        || values
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != values.len()
    {
        return Err(serde::de::Error::custom(
            "expected 1 to 10 distinct opaque source references",
        ));
    }
    Ok(values)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceBindingSummary {
    pub source_id: String,
    pub family: kcoder_types::migration_source_bindings::MigrationSourceBindingFamily,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceBindingsResult {
    pub bindings: Vec<MigrationSourceBindingSummary>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn source_binding_page_is_bounded_and_cannot_accept_authority_or_duplicate_references() {
        for ids in [
            json!([]),
            json!(["same", "same"]),
            json!(["bad\n"]),
            json!(["x".repeat(257)]),
            json!((0..11).map(|i| i.to_string()).collect::<Vec<_>>()),
        ] {
            assert!(
                serde_json::from_value::<MigrationSourceBindingsParams>(json!({"sourceIds":ids}))
                    .is_err()
            );
        }
        assert!(
            serde_json::from_value::<MigrationSourceBindingsParams>(
                json!({"sourceIds":["opaque"],"path":"/unauthorized"})
            )
            .is_err()
        );
        let value = json!({"sourceIds":["first","second"]});
        let page: MigrationSourceBindingsParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(page).unwrap(), value);
    }
}
