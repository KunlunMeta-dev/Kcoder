//! Optional bundle members are identifiers, never credentials or client-owned bindings.
use serde::{Deserialize, Deserializer, de::Error};
use std::collections::BTreeSet;

fn offers<'de, D: Deserializer<'de>>(
    deserializer: D,
    min: usize,
    max: usize,
) -> Result<Option<Vec<String>>, D::Error> {
    let values = Vec::<String>::deserialize(deserializer)?;
    let mut unique = BTreeSet::new();
    for value in &values {
        let _: String = super::super::migration_source_session::session_identity(
            serde::de::value::StrDeserializer::<D::Error>::new(value),
        )?;
        if !unique.insert(value) {
            return Err(D::Error::custom("invalid private offer set"));
        }
    }
    if values.len() < min || values.len() > max {
        return Err(D::Error::custom("invalid private offer set"));
    }
    Ok(Some(values))
}
pub(super) fn additional<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error> {
    offers(deserializer, 1, 15)
}
pub(super) fn complete<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error> {
    offers(deserializer, 2, 16)
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use serde_json::json;
    #[test]
    fn bundle_prepare_preserves_omitted_single_and_rejects_invalid_or_duplicate_members() {
        let original = json!({"locator":{"requestId":"12345678-1234-4123-8123-123456789012","offerId":"12345678-1234-4123-8123-123456789013","target":{"sessionId":"12345678-1234-4123-8123-123456789014","purpose":"target_recovery","targetId":"owned"}},"jobId":"mig-owned","expectedSequence":1,"consent":{"apiKeys":true,"mcpPrivateFields":true}});
        let single: MigrationSourceCredentialPrepareParams =
            serde_json::from_value(original.clone()).unwrap();
        assert!(single.additional_offers.is_none());
        assert_eq!(serde_json::to_value(&single).unwrap(), original);
        let mut bundle = original;
        bundle["additionalOffers"] = json!(["12345678-1234-4123-8123-123456789015"]);
        assert!(
            serde_json::from_value::<MigrationSourceCredentialPrepareParams>(bundle.clone())
                .is_ok()
        );
        for invalid in [
            json!([]),
            json!(null),
            json!(["../../key"]),
            json!([
                "12345678-1234-4123-8123-123456789015",
                "12345678-1234-4123-8123-123456789015"
            ]),
            json!(vec!["12345678-1234-4123-8123-123456789015"; 16]),
        ] {
            bundle["additionalOffers"] = invalid;
            assert!(
                serde_json::from_value::<MigrationSourceCredentialPrepareParams>(bundle.clone())
                    .is_err()
            );
        }
    }
}

#[cfg(feature = "json-schema")]
fn schema(min: u32, max: u32) -> schemars::schema::Schema {
    serde_json::from_value(serde_json::json!({
        "type":"array", "minItems":min, "maxItems":max, "uniqueItems":true,
        "items":{"type":"string", "pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}
    })).expect("static private offer schema")
}
#[cfg(feature = "json-schema")]
pub(super) fn additional_schema(
    _: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    schema(1, 15)
}
#[cfg(feature = "json-schema")]
pub(super) fn complete_schema(
    _: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    schema(2, 16)
}
