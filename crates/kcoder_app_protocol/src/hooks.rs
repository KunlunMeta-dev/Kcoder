//! User-owned Hook settings; plugin/project Hook definitions are never materialized here.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const HOOK_CONFIGURATION_CAPABILITY: &str = "hookConfigurationV1";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookConfigurationReadParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookConfigurationUpdateParams {
    pub hooks: Value,
    pub expected_revision: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookConfigurationResult {
    pub hooks: Value,
    pub revision: String,
    pub configuration_path: String,
    pub applies_to_new_conversations: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hooks_cannot_select_another_configuration_path_or_omit_the_revision() {
        assert!(
            serde_json::from_value::<HookConfigurationReadParams>(
                serde_json::json!({"path":"/other"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<HookConfigurationUpdateParams>(
                serde_json::json!({"hooks":{}})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<HookConfigurationUpdateParams>(
                serde_json::json!({"hooks":{},"expectedRevision":"r","path":"/other"})
            )
            .is_err()
        );
    }
}
