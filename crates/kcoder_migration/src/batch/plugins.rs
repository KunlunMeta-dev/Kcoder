//! A local plugin action retains the original Native child and default-disabled target.
use crate::plugin_migration::PluginPlanReference;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginBatchResolution {
    pub item_id: String,
    pub target_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginBatchAction {
    pub target_name: String,
    // The durable parent action precedes its claim. A lost claim acknowledgement can
    // therefore reconcile the same consumer before any Native installation starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<PluginPlanReference>,
}
