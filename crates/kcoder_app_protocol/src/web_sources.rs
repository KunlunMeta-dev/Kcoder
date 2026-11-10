//! Optional native tool-result observations. Legacy clients may ignore this field.
pub use kcoder_types::web_sources::{
    WebSourceOperation, WebSourcePageV1, WebSourceReadStatus, WebSourcesV1,
};

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub struct WebSourcesToolResultV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_sources: Option<WebSourcesV1>,
}
