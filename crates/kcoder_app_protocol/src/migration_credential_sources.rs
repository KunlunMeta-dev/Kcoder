//! Original-job locators are a read-only bootstrap, not private transfer authorization.
pub use kcoder_types::migration_credential_sources::{
    MigrationSourceCredentialSource, MigrationSourceCredentialSourcesResult,
};
use serde::{Deserialize, Serialize};

pub const MIGRATION_SOURCE_CREDENTIAL_SOURCES_CAPABILITY: &str =
    "migrationSourceCredentialSourcesV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialSourcesParams {
    #[serde(deserialize_with = "job_id")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(pattern = "^[A-Za-z0-9_-]{1,128}$"))
    )]
    pub job_id: String,
    #[serde(deserialize_with = "page_index")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 1024_u32)))]
    pub page_index: u32,
}
fn job_id<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = String::deserialize(input)?;
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(serde::de::Error::custom("invalid migration job identity"));
    }
    Ok(value)
}
fn page_index<'de, D: serde::Deserializer<'de>>(input: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(input)?;
    if value > 1024 {
        return Err(serde::de::Error::custom("invalid migration page"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn locators_cannot_supply_source_authority_or_paths() {
        let base = json!({"jobId":"mig-owned","pageIndex":0});
        assert!(
            serde_json::from_value::<MigrationSourceCredentialSourcesParams>(base.clone()).is_ok()
        );
        for key in [
            "path",
            "profile",
            "authority",
            "requestId",
            "manifestSha256",
        ] {
            let mut value = base.clone();
            value[key] = json!("untrusted");
            assert!(
                serde_json::from_value::<MigrationSourceCredentialSourcesParams>(value).is_err()
            );
        }
        for value in [
            json!({"jobId":"../peer","pageIndex":0}),
            json!({"jobId":"mig-owned","pageIndex":1025}),
        ] {
            assert!(
                serde_json::from_value::<MigrationSourceCredentialSourcesParams>(value).is_err()
            );
        }
    }
}
