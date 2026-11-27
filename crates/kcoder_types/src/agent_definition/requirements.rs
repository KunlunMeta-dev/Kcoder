//! Declarative formats and output kinds; these do not activate business capabilities.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeFileFormat"))]
pub enum AgentResourceFormat {
    Docx,
    Xlsx,
    Pptx,
    Pdf,
    Csv,
    Json,
}
impl AgentResourceFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
            Self::Pdf => "pdf",
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }
    pub fn media_type(self) -> &'static str {
        match self {
            Self::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Self::Xlsx => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            Self::Pptx => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
            Self::Pdf => "application/pdf",
            Self::Csv => "text/csv; charset=utf-8",
            Self::Json => "application/json",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "json-schema", schemars(rename = "OfficeArtifactKind"))]
pub enum AgentOutputKind {
    Document,
    Table,
    Chart,
    ActionItems,
    Research,
    OperationReceipt,
    FileCollection,
    Form,
}
