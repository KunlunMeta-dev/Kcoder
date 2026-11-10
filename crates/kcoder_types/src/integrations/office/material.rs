//! Public uploaded material receipts contain references, never native paths or authority.
use super::{OfficeValidationError, bounded, identifier, invalid};
use crate::integrations::core::IntegrationOwner;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum OfficeMaterialKind {
    #[serde(rename = "office_input")]
    OfficeInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum OfficeMaterialStatus {
    #[serde(rename = "accepted")]
    Accepted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeMaterialReceipt {
    pub kind: OfficeMaterialKind,
    pub input_id: String,
    #[serde(deserialize_with = "revision_one")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "revision_one_schema"))]
    pub revision: u64,
    pub operation_id: String,
    pub owner: IntegrationOwner,
    pub filename: String,
    pub media_type: String,
    #[cfg_attr(feature = "json-schema", schemars(range(max = 104857600)))]
    pub bytes: u64,
    pub sha256: String,
    pub status: OfficeMaterialStatus,
}
impl OfficeMaterialReceipt {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        identifier(&self.input_id, "material.inputId")?;
        identifier(&self.operation_id, "material.operationId")?;
        identifier(&self.owner.account_id, "material.owner.accountId")?;
        identifier(&self.owner.target_id, "material.owner.targetId")?;
        bounded(&self.filename, 1024, false, "material.filename")?;
        bounded(&self.media_type, 256, false, "material.mediaType")?;
        if self.revision != 1 || self.bytes > 100 * 1024 * 1024 {
            return Err(invalid("material.revisionOrBytes"));
        }
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid("material.sha256"));
        }
        Ok(())
    }
}

fn revision_one<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let revision = u64::deserialize(deserializer)?;
    if revision != 1 {
        return Err(serde::de::Error::custom(
            "Office material revision must be one",
        ));
    }
    Ok(revision)
}

#[cfg(feature = "json-schema")]
fn revision_one_schema(_: &mut schemars::SchemaGenerator) -> schemars::schema::Schema {
    schemars::schema::Schema::Object(schemars::schema::SchemaObject {
        instance_type: Some(schemars::schema::InstanceType::Integer.into()),
        enum_values: Some(vec![serde_json::json!(1)]),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn receipt() -> Value {
        json!({"kind":"office_input","inputId":"input-owned","revision":1,"operationId":"accept-original",
        "owner":{"accountId":"actual-owner","targetId":"actual-target","workspaceId":"actual-workspace","organizationId":null},
        "filename":"材料.txt","mediaType":"text/plain","bytes":0,"sha256":"a".repeat(64),"status":"accepted"})
    }

    #[test]
    fn receipt_preserves_exact_owner_and_empty_material_without_a_path() {
        let decoded: OfficeMaterialReceipt = serde_json::from_value(receipt()).unwrap();
        decoded.validate().unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), receipt());
    }

    #[test]
    fn receipt_rejects_fake_revision_outcome_and_extra_authority() {
        for (key, value) in [
            ("revision", json!(2)),
            ("status", json!("pending")),
            ("kind", json!("file")),
            ("path", json!("not-authority")),
        ] {
            let mut input = receipt();
            input[key] = value;
            assert!(
                serde_json::from_value::<OfficeMaterialReceipt>(input).is_err(),
                "{key}"
            );
        }
        for (key, value) in [("bytes", json!(104857601u64)), ("sha256", json!("wrong"))] {
            let mut input = receipt();
            input[key] = value;
            assert!(
                serde_json::from_value::<OfficeMaterialReceipt>(input)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
    }
}
