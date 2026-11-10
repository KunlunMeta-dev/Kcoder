//! Narrow target-user Office configuration, available while Office is disabled.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_OFFICE_SETTINGS_V1: &str = "officeSettingsV1";
pub const OFFICE_SETTINGS_READ: &str = "settings/integrations/office/read";
pub const OFFICE_SETTINGS_SAVE: &str = "settings/integrations/office/save";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeSettingsReadResult {
    /// Exact user-layer field, without materializing defaults or overlays.
    pub persisted_enabled: Option<bool>,
    /// Freshly resolved settings for new work on this target.
    pub effective_enabled: bool,
    /// Settings captured by the current app-server connection.
    pub connection_enabled: bool,
    /// Revision of this field and the actual owning configuration directory.
    pub revision: String,
    pub restart_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeSettingsSaveParams {
    pub enabled: bool,
    pub expected_revision: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn save_only_accepts_an_explicit_switch_and_original_revision() {
        let value: OfficeSettingsSaveParams = serde_json::from_value(json!({
            "enabled":true,"expectedRevision":"a".repeat(64)
        }))
        .unwrap();
        assert!(value.enabled);
        for invalid in [
            json!({"enabled":true}),
            json!({"enabled":null,"expectedRevision":"a".repeat(64)}),
            json!({"enabled":true,"expectedRevision":"a".repeat(64),"path":"/other"}),
            json!({"enabled":true,"expectedRevision":"a".repeat(64),"model":"other"}),
        ] {
            assert!(serde_json::from_value::<OfficeSettingsSaveParams>(invalid).is_err());
        }
    }

    #[test]
    fn saved_and_current_connection_state_remain_distinct_on_the_wire() {
        let value = OfficeSettingsReadResult {
            persisted_enabled: Some(true),
            effective_enabled: true,
            connection_enabled: false,
            revision: "a".repeat(64),
            restart_required: true,
        };
        let wire = serde_json::to_value(&value).unwrap();
        assert_eq!(wire["persistedEnabled"], true);
        assert_eq!(wire["connectionEnabled"], false);
        assert_eq!(
            serde_json::from_value::<OfficeSettingsReadResult>(wire).unwrap(),
            value
        );
    }
}
