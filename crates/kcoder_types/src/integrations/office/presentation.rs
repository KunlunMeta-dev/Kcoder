//! Declarative result views. No HTML, JavaScript, URL or executable action is accepted.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeActionItemStatus {
    Pending,
    InProgress,
    Completed,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeActionItem {
    pub id: String,
    pub text: String,
    pub status: OfficeActionItemStatus,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
    pub source_refs: Vec<OfficeResourceRef>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeResearchFinding {
    pub text: String,
    pub source_refs: Vec<OfficeResourceRef>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OfficeArtifactPresentation {
    Document {
        paragraphs: Vec<String>,
    },
    Table {
        dataset: OfficeArtifactRef,
    },
    Chart {
        dataset: OfficeArtifactRef,
        #[serde(rename = "chartType")]
        chart_type: OfficeChartType,
        #[serde(rename = "labelColumn")]
        label_column: String,
        #[serde(rename = "valueColumns")]
        value_columns: Vec<String>,
    },
    ActionItems {
        items: Vec<OfficeActionItem>,
    },
    Research {
        summary: String,
        findings: Vec<OfficeResearchFinding>,
        #[serde(rename = "observedAt")]
        observed_at: String,
    },
    OperationReceipt {
        #[serde(rename = "operationId")]
        operation_id: String,
        phase: String,
        detail: String,
    },
    FileCollection {
        items: Vec<OfficeArtifactRef>,
    },
    Form {
        schema: Value,
        #[serde(rename = "initialValues")]
        initial_values: Value,
        purpose: String,
    },
}
impl OfficeArtifactPresentation {
    pub fn kind(&self) -> OfficeArtifactKind {
        match self {
            Self::Document { .. } => OfficeArtifactKind::Document,
            Self::Table { .. } => OfficeArtifactKind::Table,
            Self::Chart { .. } => OfficeArtifactKind::Chart,
            Self::ActionItems { .. } => OfficeArtifactKind::ActionItems,
            Self::Research { .. } => OfficeArtifactKind::Research,
            Self::OperationReceipt { .. } => OfficeArtifactKind::OperationReceipt,
            Self::FileCollection { .. } => OfficeArtifactKind::FileCollection,
            Self::Form { .. } => OfficeArtifactKind::Form,
        }
    }
    pub fn validate(&self, sources: &[OfficeResourceRef]) -> Result<(), OfficeValidationError> {
        let source_subset = |refs: &[OfficeResourceRef]| -> Result<(), OfficeValidationError> {
            if refs.len() > 128 || refs.iter().any(|source| !sources.contains(source)) {
                return Err(invalid("presentation.sourceRefs"));
            }
            Ok(())
        };
        let reference = |value: &OfficeArtifactRef| -> Result<(), OfficeValidationError> {
            identifier(&value.id, "presentation.reference")?;
            if value.revision == 0 {
                return Err(invalid("presentation.revision"));
            }
            Ok(())
        };
        match self {
            Self::Document { paragraphs } => {
                if paragraphs.len() > 32 {
                    return Err(invalid("presentation.paragraphs"));
                }
                for value in paragraphs {
                    bounded(value, 2000, true, "presentation.paragraph")?;
                }
            }
            Self::Table { dataset } => reference(dataset)?,
            Self::Chart {
                dataset,
                label_column,
                value_columns,
                ..
            } => {
                reference(dataset)?;
                identifier(label_column, "presentation.labelColumn")?;
                if value_columns.is_empty() || value_columns.len() > 4 {
                    return Err(invalid("presentation.valueColumns"));
                }
                for value in value_columns {
                    identifier(value, "presentation.valueColumn")?;
                }
            }
            Self::ActionItems { items } => {
                if items.len() > 200 {
                    return Err(invalid("presentation.items"));
                }
                let mut ids = std::collections::HashSet::new();
                for item in items {
                    identifier(&item.id, "presentation.item.id")?;
                    if !ids.insert(&item.id) {
                        return Err(invalid("presentation.item.id"));
                    }
                    bounded(&item.text, 2000, false, "presentation.item.text")?;
                    if let Some(value) = &item.assignee {
                        bounded(value, 200, false, "presentation.item.assignee")?;
                    }
                    if let Some(value) = &item.due {
                        bounded(value, 100, false, "presentation.item.due")?;
                    }
                    source_subset(&item.source_refs)?;
                }
            }
            Self::Research {
                summary,
                findings,
                observed_at,
            } => {
                bounded(summary, 4000, false, "presentation.summary")?;
                bounded(observed_at, 100, false, "presentation.observedAt")?;
                if findings.len() > 64 {
                    return Err(invalid("presentation.findings"));
                }
                for finding in findings {
                    bounded(&finding.text, 2000, false, "presentation.finding")?;
                    source_subset(&finding.source_refs)?;
                }
            }
            Self::OperationReceipt {
                operation_id,
                phase,
                detail,
            } => {
                identifier(operation_id, "presentation.operationId")?;
                if !matches!(
                    phase.as_str(),
                    "pending"
                        | "running"
                        | "accepted"
                        | "completed"
                        | "failed"
                        | "cancelled"
                        | "unknown"
                ) {
                    return Err(invalid("presentation.phase"));
                }
                bounded(detail, 2000, true, "presentation.detail")?;
            }
            Self::FileCollection { items } => {
                if items.is_empty() || items.len() > 32 {
                    return Err(invalid("presentation.files"));
                }
                for item in items {
                    reference(item)?;
                }
            }
            Self::Form {
                schema,
                initial_values,
                purpose,
            } => {
                encoded_limit(schema, 16 * 1024, "presentation.form.schema")?;
                encoded_limit(initial_values, 16 * 1024, "presentation.form.values")?;
                bounded(purpose, 2000, false, "presentation.form.purpose")?;
            }
        }
        encoded_limit(self, 64 * 1024, "presentation")
    }
}
