//! Recovery observations never grant current host rendering or interaction authority.
use crate::ClientPresentationV1;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct FailedTurnContinuation {
    /// Legacy wire field; renderer capabilities do not select execution policy.
    pub required_presentation: ClientPresentationV1,
    /// Rendering differences alone do not prevent continuation of the same task.
    pub allowed: bool,
}

impl Default for FailedTurnContinuation {
    fn default() -> Self {
        Self {
            // Keep the legacy wire shape for older clients, without renderer requirements.
            required_presentation: ClientPresentationV1 {
                version: 1,
                studio_work_mode: None,
                inline_widgets: false,
                isolated_widgets: false,
            },
            allowed: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_requires_no_renderer_and_grants_no_script_authority() {
        let value = serde_json::to_value(FailedTurnContinuation::default()).unwrap();
        assert_eq!(value["allowed"], true);
        assert_eq!(value["requiredPresentation"]["inlineWidgets"], false);
        assert!(
            value["requiredPresentation"]
                .get("isolatedWidgets")
                .is_none()
        );
        assert!(
            value["requiredPresentation"]
                .get("studioWorkMode")
                .is_none()
        );
    }
}
