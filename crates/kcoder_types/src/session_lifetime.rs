//! Tasks survive client detachment; the legacy setting never grants authority.
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SessionLifetimeMode {
    #[default]
    #[serde(alias = "client_attached")]
    Background,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_client_attached_restores_as_background_without_changing_revision() {
        let legacy: SessionLifetimeSetting =
            serde_json::from_str(r#"{"revision":7,"mode":"client_attached"}"#).unwrap();
        assert_eq!(legacy.mode, SessionLifetimeMode::Background);
        assert_eq!(legacy.revision, 7);
        assert_eq!(SessionLifetimeSetting::default().mode, legacy.mode);
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            serde_json::json!({"revision":7,"mode":"background"})
        );
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionLifetimeSetting {
    pub revision: u64,
    pub mode: SessionLifetimeMode,
}
