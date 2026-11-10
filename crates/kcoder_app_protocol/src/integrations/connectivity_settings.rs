//! Explicit target-user channel setup, available before connectivity is enabled.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_CONNECTIVITY_SETTINGS_V1: &str = "connectivitySettingsV1";
pub const CONNECTIVITY_SETTINGS_READ: &str = "settings/integrations/connectivity/read";
pub const CONNECTIVITY_SETTINGS_SAVE: &str = "settings/integrations/connectivity/save";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivitySettingsFlags {
    pub enabled: bool,
    pub services_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivitySettingsPersisted {
    pub enabled: Option<bool>,
    pub services_enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivitySettingsReadResult {
    pub revision: String,
    pub persisted: ConnectivitySettingsPersisted,
    pub effective: ConnectivitySettingsFlags,
    pub connection: ConnectivitySettingsFlags,
    pub restart_required: bool,
    pub editable: bool,
    pub controlled_by_overlay: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivitySettingsSaveParams {
    pub enabled: bool,
    pub expected_revision: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn connectivity_settings_save_is_explicit_and_cannot_import_authority() {
        let value = json!({"enabled":true,"expectedRevision":"a".repeat(64)});
        let save: ConnectivitySettingsSaveParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(save).unwrap(), value);
        for value in [
            json!({"enabled":true}),
            json!({"enabled":null,"expectedRevision":"a".repeat(64)}),
            json!({"enabled":true,"expectedRevision":"a".repeat(64),"members":["all"]}),
            json!({"enabled":true,"expectedRevision":"a".repeat(64),"path":"elsewhere"}),
        ] {
            assert!(serde_json::from_value::<ConnectivitySettingsSaveParams>(value).is_err());
        }
    }
}
