//! Public locators derived from an owned migration job, never credential material or authority.
use crate::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialSource {
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub manifest_sha256: String,
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(pattern = "^e[0-9]{4}-[0-9]{4}$"))
    )]
    pub entry_id: String,
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub source_binding_revision: String,
    pub source: MigrationSourceKind,
    pub project_scoped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialSourcesResult {
    pub job_id: String,
    #[serde(deserialize_with = "safe_sequence")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub sequence: u64,
    pub plan_id: Option<String>,
    #[serde(deserialize_with = "ten_sources")]
    #[cfg_attr(feature = "json-schema", schemars(length(max = 10)))]
    pub items: Vec<MigrationSourceCredentialSource>,
    pub total_items: u32,
    pub next_page: Option<u32>,
}

fn safe_sequence<'de, D: serde::Deserializer<'de>>(input: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(input)?;
    if value > 9_007_199_254_740_991 {
        return Err(serde::de::Error::custom(
            "migration sequence exceeds safe integer range",
        ));
    }
    Ok(value)
}
fn ten_sources<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<Vec<MigrationSourceCredentialSource>, D::Error> {
    struct Page;
    impl<'de> serde::de::Visitor<'de> for Page {
        type Value = Vec<MigrationSourceCredentialSource>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("at most ten original source locators")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let mut items = Vec::new();
            while let Some(item) = sequence.next_element()? {
                if items.len() == 10 {
                    return Err(serde::de::Error::custom("source page exceeds ten entries"));
                }
                items.push(item);
            }
            Ok(items)
        }
    }
    input.deserialize_seq(Page)
}
