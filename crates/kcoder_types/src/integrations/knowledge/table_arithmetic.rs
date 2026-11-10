//! Deterministic observations of literal source table cells, not access grants.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeTableArithmeticStatus {
    Available,
    NotApplicable,
    Unsupported,
    LimitExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeTableArithmetic {
    pub status: KnowledgeTableArithmeticStatus,
    pub markdown_sha256: String,
    pub facts: Vec<KnowledgeTableNumericFact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeTableNumericFact {
    pub table_start_line: u32,
    pub value_column: String,
    pub group_by: Vec<String>,
    pub groups: Vec<KnowledgeTableNumericGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeTableNumericGroup {
    pub key: Vec<String>,
    pub row_lines: Vec<u32>,
    pub numeric_rows: u32,
    /// Exact base-ten sum of available cells. None means no numeric value or overflow.
    pub known_sum: Option<String>,
    pub missing_row_lines: Vec<u32>,
    /// False whenever a required cell is missing, unsupported or overflowing.
    pub complete: bool,
}

/// Conservative calendar classification of explicit status/date table cells.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeTableDeadlines {
    pub status: KnowledgeTableArithmeticStatus,
    pub markdown_sha256: String,
    pub as_of_date: String,
    pub rows: Vec<KnowledgeTableDeadlineRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeTableDeadlineRow {
    pub table_start_line: u32,
    pub row_line: u32,
    pub id: String,
    pub owner: String,
    pub due_date: String,
    pub source_status: String,
    /// Unknown status or invalid date remains unresolved, never open by default.
    pub classification: KnowledgeDeadlineClassification,
    pub overdue_days: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeDeadlineClassification {
    Overdue,
    Upcoming,
    Later,
    Completed,
    Unresolved,
}
