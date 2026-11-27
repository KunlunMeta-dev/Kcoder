//! User-selected model tool surfaces, frozen when a Studio session is created.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct StudioToolSelections {
    /// None preserves the host's existing mode defaults; an empty list selects no tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kcoder: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kworker: Option<Vec<String>>,
}
