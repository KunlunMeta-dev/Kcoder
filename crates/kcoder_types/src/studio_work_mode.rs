//! Presentation intent is durable metadata, never authority to enable a tool.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum StudioWorkMode {
    #[default]
    Kcoder,
    Kworker,
}

/// Validated by the host for every foreground turn and tool-directory request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientPresentationV1 {
    pub version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub studio_work_mode: Option<StudioWorkMode>,
    #[serde(default)]
    pub inline_widgets: bool,
    /// Current native host has verified isolated script rendering; never restored from history.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub isolated_widgets: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presentation_keeps_explicit_mode_and_legacy_defaults() {
        assert_eq!(StudioWorkMode::default(), StudioWorkMode::Kcoder);
        let value: ClientPresentationV1 =
            serde_json::from_str(r#"{"version":1,"studioWorkMode":"kworker"}"#).unwrap();
        assert_eq!(value.studio_work_mode, Some(StudioWorkMode::Kworker));
        assert!(!value.inline_widgets);
        assert!(
            serde_json::from_str::<ClientPresentationV1>(
                r#"{"version":1,"studioWorkMode":"kworkr"}"#
            )
            .is_err()
        );
    }
}
