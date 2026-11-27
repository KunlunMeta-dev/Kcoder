//! Knowledge, memory and automation contracts. Scope references are not authority.
mod automation;
mod file_events;
mod material_inventory;
mod memory;
mod publication;
mod table_arithmetic;
pub use automation::*;
pub use file_events::{
    AutomationFileSelectionItem, AutomationFileSelectionParams, AutomationFileSelectionReceipt,
};
pub use material_inventory::*;
pub use memory::*;
pub use publication::*;
pub use table_arithmetic::*;

use serde::{Deserialize, Serialize};

pub const KNOWLEDGE_PAGE_SIZE: usize = 10;
pub const KNOWLEDGE_MAX_TEXT_BYTES: usize = 64 * 1024;

/// D keeps the shared owner's null/missing distinctions without a parallel identity type.
pub type KnowledgeOwner = crate::integrations::core::IntegrationOwner;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePage<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}
