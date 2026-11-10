use super::*;
use crate::integrations::core::IntegrationOwner;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeColumnType {
    String,
    Number,
    Boolean,
    Date,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeColumn {
    pub key: String,
    pub title: String,
    pub kind: OfficeColumnType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeDataset {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub owner: IntegrationOwner,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<OfficeTaskRef>,
    pub columns: Vec<OfficeColumn>,
    pub rows: Vec<Vec<Value>>,
    pub source_refs: Vec<OfficeResourceRef>,
}
impl OfficeDataset {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        identifier(&self.id, "dataset.id")?;
        if self.schema_version != OFFICE_SCHEMA_VERSION
            || self.revision == 0
            || self.columns.is_empty()
            || self.columns.len() > OFFICE_MAX_DATASET_COLUMNS
            || self.rows.len() > OFFICE_MAX_DATASET_ROWS
            || self.rows.len().saturating_mul(self.columns.len()) > OFFICE_MAX_DATASET_CELLS
            || self.source_refs.len() > 128
        {
            return Err(invalid("dataset"));
        }
        if let Some(task) = &self.task {
            identifier(&task.thread_id, "dataset.threadId")?;
            identifier(&task.turn_id, "dataset.turnId")?;
        }
        let mut keys = HashSet::new();
        for column in &self.columns {
            identifier(&column.key, "dataset.column.key")?;
            bounded(&column.title, 200, false, "dataset.column.title")?;
            if !keys.insert(&column.key) {
                return Err(invalid("dataset.columns"));
            }
            if let Some(unit) = &column.unit {
                bounded(unit, 100, false, "dataset.unit")?;
            }
        }
        for row in &self.rows {
            if row.len() != self.columns.len() {
                return Err(invalid("dataset.row"));
            }
            for (value, column) in row.iter().zip(&self.columns) {
                let valid = value.is_null()
                    || match column.kind {
                        OfficeColumnType::String => value.is_string(),
                        OfficeColumnType::Date => value.as_str().is_some_and(valid_date),
                        OfficeColumnType::Number => value.as_f64().is_some_and(f64::is_finite),
                        OfficeColumnType::Boolean => value.is_boolean(),
                    };
                if !valid {
                    return Err(invalid("dataset.value"));
                }
                if let Some(value) = value.as_str() {
                    bounded(value, 32_000, true, "dataset.value")?;
                }
            }
        }
        for source in &self.source_refs {
            source.validate()?;
        }
        encoded_limit(self, OFFICE_MAX_DATASET_BYTES, "dataset")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeFilterOperator {
    Eq,
    NotEq,
    Contains,
    GreaterThan,
    LessThan,
    IsNull,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeFilter {
    pub column: String,
    pub operator: OfficeFilterOperator,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeSort {
    pub column: String,
    pub descending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeAggregateFunction {
    Count,
    Sum,
    Min,
    Max,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeAggregate {
    pub column: String,
    pub function: OfficeAggregateFunction,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeAggregateResult {
    pub key: String,
    /// Exact decimal text; null means that every matched cell is null.
    pub value: Option<String>,
    pub non_null_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeDatasetQuery {
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub filters: Vec<OfficeFilter>,
    #[serde(default)]
    pub sort: Vec<OfficeSort>,
    #[serde(default)]
    pub aggregates: Vec<OfficeAggregate>,
    pub limit: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}
impl OfficeDatasetQuery {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        if self.limit == 0
            || self.limit > 100
            || self.columns.len() > OFFICE_MAX_DATASET_COLUMNS
            || self.filters.len() > 16
            || self.sort.len() > 8
            || self.aggregates.len() > 16
        {
            return Err(invalid("query"));
        }
        for column in &self.columns {
            identifier(column, "query.column")?;
        }
        for filter in &self.filters {
            identifier(&filter.column, "query.filter.column")?;
            if !(filter.value.is_null()
                || filter.value.is_boolean()
                || filter.value.is_number()
                || filter.value.is_string())
            {
                return Err(invalid("query.filter.value"));
            }
        }
        for sort in &self.sort {
            identifier(&sort.column, "query.sort.column")?;
        }
        let mut aggregate_keys = HashSet::new();
        for aggregate in &self.aggregates {
            identifier(&aggregate.column, "query.aggregate.column")?;
            identifier(&aggregate.key, "query.aggregate.key")?;
            if !aggregate_keys.insert(&aggregate.key) {
                return Err(invalid("query.aggregate.key"));
            }
        }
        if let Some(cursor) = &self.cursor {
            bounded(cursor, 2048, false, "query.cursor")?;
        }
        encoded_limit(self, 16 * 1024, "query")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeDatasetPage {
    pub dataset: OfficeArtifactRef,
    pub columns: Vec<OfficeColumn>,
    pub rows: Vec<Vec<Value>>,
    /// Canonical numeric text for clients whose JSON number type loses integer precision.
    #[serde(default)]
    pub number_text: Vec<Vec<Option<String>>>,
    pub total_rows: usize,
    pub matched_rows: usize,
    pub next_cursor: Option<String>,
    pub query_sha256: String,
    pub source_refs: Vec<OfficeResourceRef>,
    #[serde(default)]
    pub aggregates: Vec<OfficeAggregateResult>,
}

pub(super) fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let year = value[..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..].parse::<u32>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    year > 0 && day > 0 && day <= days
}
