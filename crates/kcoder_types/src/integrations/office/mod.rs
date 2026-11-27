//! Office definitions and immutable result contracts; references never grant authority.
mod artifact;
mod canonical_source;
pub use canonical_source::*;
mod assistant;

// Office consumes the canonical agent-definition types directly; the legacy
// `Office*` Rust aliases were removed. Wire names stay fixed by `schemars(rename)`.
pub use crate::agent_definition::{
    AgentCapabilityRequirement, AgentDefinition, AgentDefinitionDeleteParams, AgentDefinitionDraft,
    AgentDefinitionPackage, AgentDefinitionReadParams, AgentDefinitionScope, AgentDefinitionSkill,
    AgentDefinitionVersion, AgentExternalSend, AgentMarketDefinition, AgentMarketDefinitionDetail,
    AgentMarketDetailParams, AgentMarketInstallParams, AgentMarketListParams, AgentMarketSkill,
    AgentModelSelection, AgentResourceFile, AgentResourceRef, AgentResourceSnapshot,
    AgentSkillInstallParams, AgentSkillMarketListParams, AgentWorkflowRef,
    DefinitionValidationError,
};
mod dataset;
mod error;
mod generation;
mod material;
pub use material::*;
mod presentation;
pub use generation::*;
pub use presentation::*;
mod projection;
pub use error::office_public_error_code;

pub use artifact::*;
pub use assistant::*;
pub use dataset::*;
pub use projection::*;

pub const OFFICE_SCHEMA_VERSION: u32 = 1;
pub const OFFICE_MAX_DEFINITION_BYTES: usize = 128 * 1024;
pub const OFFICE_MAX_SCHEMA_BYTES: usize = 16 * 1024;
pub const OFFICE_MAX_ARTIFACT_BYTES: u64 = 20 * 1024 * 1024;
pub const OFFICE_MAX_DATASET_BYTES: usize = 16 * 1024 * 1024;
pub const OFFICE_MAX_DATASET_ROWS: usize = 10_000;
pub const OFFICE_MAX_DATASET_COLUMNS: usize = 128;
pub const OFFICE_MAX_DATASET_CELLS: usize = 100_000;

pub(crate) use crate::agent_definition::{bounded, encoded_limit, identifier, invalid};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::core::{IntegrationNullable, IntegrationOwner};
    use serde_json::json;

    fn owner() -> IntegrationOwner {
        IntegrationOwner {
            account_id: "a".into(),
            target_id: "t".into(),
            workspace_id: IntegrationNullable::Null,
            organization_id: None,
        }
    }

    #[test]
    fn dataset_schema_rejects_malformed_rows_and_unknown_fields() {
        let dataset = OfficeDataset {
            schema_version: 1,
            id: "D/../opaque".into(),
            revision: 1,
            owner: owner(),
            task: None,
            columns: vec![OfficeColumn {
                key: "value".into(),
                title: "金额".into(),
                kind: OfficeColumnType::Number,
                unit: Some("元".into()),
            }],
            rows: vec![vec![json!(1234.56)]],
            source_refs: vec![],
        };
        dataset.validate().unwrap();
        let mut bad = dataset.clone();
        bad.rows[0].push(json!(1));
        assert_eq!(bad.validate().unwrap_err().field, "dataset.row");
        let mut wire = serde_json::to_value(dataset).unwrap();
        wire["command"] = json!("do-not-run");
        assert!(serde_json::from_value::<OfficeDataset>(wire).is_err());
    }

    #[test]
    fn assistant_definition_is_configuration_not_authority() {
        let definition: AgentDefinition = serde_json::from_value(json!({
            "schemaVersion":1,"id":"meeting","scope":"personal","title":"会议纪要","description":"从材料提取决议",
            "language":"zh-CN","inputSchema":{"type":"object"},"instructions":"保留待确认事项",
            "modelSelection":{"kind":"inherit_current"},"outputKinds":["document","action_items"],
            "acceptanceCriteria":["来源可追溯"],"externalSend":"ask"
        })).unwrap();
        definition.validate().unwrap();
        let mut wire = serde_json::to_value(&definition).unwrap();
        wire["admin"] = json!(true);
        assert!(serde_json::from_value::<AgentDefinition>(wire.clone()).is_err());
        wire.as_object_mut().unwrap().remove("admin");
        wire["externalSend"] = json!("bypass");
        assert!(serde_json::from_value::<AgentDefinition>(wire).is_err());
    }

    #[test]
    fn page_limits_and_query_language_are_bounded() {
        let mut query = OfficeDatasetQuery {
            columns: vec![],
            filters: vec![],
            sort: vec![],
            aggregates: vec![],
            limit: 100,
            cursor: None,
        };
        query.validate().unwrap();
        query.limit = 101;
        assert!(query.validate().is_err());
        assert!(
            serde_json::from_value::<OfficeDatasetQuery>(json!({
                "limit": 10, "sql":"select * from private"
            }))
            .is_err()
        );
    }
}
