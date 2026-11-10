//! Explicit target-user feature setup remains available while features are disabled.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_KNOWLEDGE_SETTINGS_V1: &str = "knowledgeSettingsV1";
pub const KNOWLEDGE_SETTINGS_READ: &str = "settings/integrations/knowledge/read";
pub const KNOWLEDGE_SETTINGS_SAVE: &str = "settings/integrations/knowledge/save";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSettingsFlags {
    pub memory_center_enabled: bool,
    pub publications_enabled: bool,
    pub business_automation_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSettingsPersisted {
    pub memory_center_enabled: Option<bool>,
    pub publications_enabled: Option<bool>,
    pub business_automation_enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSettingsReadResult {
    pub persisted: KnowledgeSettingsPersisted,
    pub effective: KnowledgeSettingsFlags,
    pub connection: KnowledgeSettingsFlags,
    pub revision: String,
    pub restart_required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum KnowledgeSettingsFeature {
    MemoryCenter,
    SharedKnowledge,
    Subscriptions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSettingsSaveParams {
    pub feature: KnowledgeSettingsFeature,
    pub enabled: bool,
    pub expected_revision: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_save_selects_one_known_feature_with_an_explicit_boolean_and_revision() {
        for feature in ["memoryCenter", "sharedKnowledge", "subscriptions"] {
            let value = json!({"feature":feature,"enabled":true,"expectedRevision":"a".repeat(64)});
            let parsed: KnowledgeSettingsSaveParams =
                serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        }
        for value in [
            json!({"feature":"all","enabled":true,"expectedRevision":"a".repeat(64)}),
            json!({"feature":"subscriptions","enabled":true}),
            json!({"feature":"subscriptions","enabled":null,"expectedRevision":"a".repeat(64)}),
            json!({"feature":"subscriptions","enabled":true,"expectedRevision":"a".repeat(64),"path":"other"}),
        ] {
            assert!(serde_json::from_value::<KnowledgeSettingsSaveParams>(value).is_err());
        }
    }
}
