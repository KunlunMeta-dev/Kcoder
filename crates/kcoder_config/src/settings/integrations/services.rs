//! Target service management is available by default, without approving leases or launching work.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeServiceSettings {
    pub enabled: bool,
}
impl Default for NativeServiceSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}
impl NativeServiceSettings {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn service_management_defaults_on_without_credentials_or_authority() {
        use super::*;
        let defaults = crate::Settings::default();
        assert!(defaults.integrations.services.enabled);
        assert!(
            serde_json::to_value(defaults.integrations)
                .unwrap()
                .get("services")
                .is_none()
        );
        let settings: NativeServiceSettings =
            serde_json::from_value(serde_json::json!({"enabled":true})).unwrap();
        assert!(settings.enabled);
        let disabled: crate::Settings = serde_json::from_value(
            serde_json::json!({"integrations":{"services":{"enabled":false}}}),
        )
        .unwrap();
        assert!(!disabled.integrations.services.enabled);
        assert_eq!(
            serde_json::to_value(disabled).unwrap()["integrations"]["services"]["enabled"],
            false
        );
        crate::schema::validate_settings_schema(
            &serde_json::json!({"integrations":{"services":{"enabled":true}}}),
        )
        .unwrap();
        for value in [
            serde_json::json!({"token":"forbidden"}),
            serde_json::json!({"trusted":true}),
            serde_json::json!({"enabled":"true"}),
        ] {
            assert!(
                crate::schema::validate_settings_schema(
                    &serde_json::json!({"integrations":{"services":value}})
                )
                .is_err()
            );
        }
    }
}
