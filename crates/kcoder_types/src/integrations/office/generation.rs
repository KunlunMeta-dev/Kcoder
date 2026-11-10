//! Fixed Office generator input. No path, command, script or network resource is accepted.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeGenerationKind {
    Docx,
    Xlsx,
    Pptx,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeGenerationSpec {
    /// Must be 1. Only structured new documents are supported.
    pub schema_version: u32,
    pub kind: OfficeGenerationKind,
    /// User-language title, at most 200 characters.
    pub title: String,
    /// Fixed layout only: DOCX report/letter; PPTX briefing/minimal. No imported template path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Host-reconciled opaque source IDs, never a permission grant.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_refs: Vec<String>,
    /// DOCX only, up to 500 paragraphs. Text is literal, not HTML or Markdown execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraphs: Option<Vec<OfficeParagraphSpec>>,
    /// DOCX only, up to 20 text tables, each row matching its headers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tables: Option<Vec<OfficeTextTableSpec>>,
    /// XLSX only, 1..16 uniquely named sheets. Numbers must be finite and JS-safe for integer writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheets: Option<Vec<OfficeSheetSpec>>,
    /// PPTX only, 1..60 slides. Longer prose must be split into more slides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slides: Option<Vec<OfficeSlideSpec>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeParagraphSpec {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bullet: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeTextTableSpec {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeSheetColumnSpec {
    pub key: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: OfficeColumnType,
    /// Restricted number-format characters; never executable spreadsheet code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeFormulaSpec {
    /// A1 cell address. Header row cannot be overwritten. No arbitrary range writes.
    pub cell: String,
    /// SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/ABS/ROUND only. No external references or web functions.
    pub formula: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeSheetSpec {
    pub name: String,
    pub columns: Vec<OfficeSheetColumnSpec>,
    /// Flat scalar rows, each matching columns exactly. Date cells use Gregorian YYYY-MM-DD.
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub formulas: Vec<OfficeFormulaSpec>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OfficeChartType {
    Bar,
    Line,
    Pie,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeChartSeriesSpec {
    pub name: String,
    pub values: Vec<f64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeSlideChartSpec {
    #[serde(rename = "type")]
    pub kind: OfficeChartType,
    pub labels: Vec<String>,
    pub series: Vec<OfficeChartSeriesSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficePngSpec {
    /// Raw data:image/png;base64,... only; no local path, URL, SVG or active content.
    pub data: String,
    /// Required literal alternative text, up to 200 characters.
    pub alt: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeSlideSpec {
    pub title: String,
    /// At most 8 entries, 400 visible characters total (160 with chart/images).
    pub paragraphs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// One editable chart. Cannot be combined with images on the same slide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<OfficeSlideChartSpec>,
    /// At most 2 bounded PNGs. Images are displayed with preserved aspect ratio.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<OfficePngSpec>,
}
impl OfficeGenerationSpec {
    pub fn validate(&self) -> Result<(), OfficeValidationError> {
        if self.schema_version != 1 {
            return Err(invalid("specification.schemaVersion"));
        }
        bounded(&self.title, 200, false, "specification.title")?;
        encoded_limit(self, 1024 * 1024, "specification")?;
        if self.source_refs.len() > 100 {
            return Err(invalid("specification.sourceRefs"));
        }
        for reference in &self.source_refs {
            identifier(reference, "specification.sourceRefs")?;
        }
        match self.kind {
            OfficeGenerationKind::Docx => {
                if self.sheets.is_some()
                    || self.slides.is_some()
                    || self.paragraphs.as_ref().is_some_and(|v| v.len() > 500)
                    || self.tables.as_ref().is_some_and(|v| v.len() > 20)
                    || self
                        .template
                        .as_ref()
                        .is_some_and(|v| !matches!(v.as_str(), "report" | "letter"))
                {
                    return Err(invalid("specification.docx"));
                }
                for paragraph in self.paragraphs.iter().flatten() {
                    bounded(&paragraph.text, 10000, true, "specification.paragraph")?;
                    if paragraph
                        .heading
                        .is_some_and(|heading| !(1..=3).contains(&heading))
                    {
                        return Err(invalid("specification.heading"));
                    }
                }
                for table in self.tables.iter().flatten() {
                    if table.headers.is_empty()
                        || table.headers.len() > 128
                        || table.rows.len() > 10000
                        || table
                            .rows
                            .iter()
                            .any(|row| row.len() != table.headers.len())
                    {
                        return Err(invalid("specification.table"));
                    }
                    for value in table.headers.iter().chain(table.rows.iter().flatten()) {
                        bounded(value, 10000, true, "specification.table.cell")?;
                    }
                }
            }
            OfficeGenerationKind::Xlsx => {
                if self.paragraphs.is_some()
                    || self.tables.is_some()
                    || self.slides.is_some()
                    || self.template.is_some()
                {
                    return Err(invalid("specification.xlsx"));
                }
                let sheets = self
                    .sheets
                    .as_ref()
                    .ok_or(invalid("specification.sheets"))?;
                if sheets.is_empty() || sheets.len() > 16 {
                    return Err(invalid("specification.sheets"));
                }
                let mut names = std::collections::HashSet::new();
                let mut cells = 0usize;
                for sheet in sheets {
                    bounded(&sheet.name, 31, false, "specification.sheet.name")?;
                    if sheet.name.contains(['*', '?', ':', '[', ']', '\\', '/'])
                        || !names.insert(sheet.name.to_ascii_lowercase())
                        || sheet.columns.is_empty()
                        || sheet.columns.len() > 128
                        || sheet.rows.len() > 10000
                        || sheet.formulas.len() > 1000
                    {
                        return Err(invalid("specification.sheet"));
                    }
                    let mut keys = std::collections::HashSet::new();
                    for column in &sheet.columns {
                        bounded(&column.key, 100, false, "specification.column.key")?;
                        bounded(&column.title, 200, false, "specification.column.title")?;
                        if !keys.insert(&column.key) {
                            return Err(invalid("specification.column.key"));
                        }
                        if let Some(unit) = &column.unit {
                            bounded(unit, 100, false, "specification.unit")?;
                        }
                    }
                    for row in &sheet.rows {
                        if row.len() != sheet.columns.len() {
                            return Err(invalid("specification.row"));
                        }
                        cells += row.len();
                        for (value, column) in row.iter().zip(&sheet.columns) {
                            let valid = value.is_null()
                                || match column.kind {
                                    OfficeColumnType::String => value.is_string(),
                                    OfficeColumnType::Boolean => value.is_boolean(),
                                    OfficeColumnType::Date => {
                                        value.as_str().is_some_and(super::dataset::valid_date)
                                    }
                                    OfficeColumnType::Number => value.as_f64().is_some_and(|v| {
                                        v.is_finite()
                                            && (v.fract() != 0.0 || v.abs() <= 9007199254740991.0)
                                    }),
                                };
                            if !valid {
                                return Err(invalid("specification.cell"));
                            }
                        }
                    }
                }
                if cells > 100000 {
                    return Err(invalid("specification.cells"));
                }
            }
            OfficeGenerationKind::Pptx => {
                if self.paragraphs.is_some()
                    || self.tables.is_some()
                    || self.sheets.is_some()
                    || self
                        .template
                        .as_ref()
                        .is_some_and(|v| !matches!(v.as_str(), "briefing" | "minimal"))
                {
                    return Err(invalid("specification.pptx"));
                }
                let slides = self
                    .slides
                    .as_ref()
                    .ok_or(invalid("specification.slides"))?;
                if slides.is_empty() || slides.len() > 60 {
                    return Err(invalid("specification.slides"));
                }
                for slide in slides {
                    bounded(&slide.title, 200, false, "specification.slide.title")?;
                    let characters: usize = slide
                        .paragraphs
                        .iter()
                        .map(|value| value.chars().count())
                        .sum();
                    if slide.paragraphs.len() > 8
                        || characters
                            > if slide.chart.is_some() || !slide.images.is_empty() {
                                160
                            } else {
                                400
                            }
                        || slide.images.len() > 2
                        || (slide.chart.is_some() && !slide.images.is_empty())
                    {
                        return Err(invalid("specification.slide.layout"));
                    }
                    if let Some(chart) = &slide.chart {
                        if chart.labels.is_empty()
                            || chart.labels.len() > 20
                            || chart.series.is_empty()
                            || chart.series.len()
                                > if chart.kind == OfficeChartType::Pie {
                                    1
                                } else {
                                    4
                                }
                        {
                            return Err(invalid("specification.chart"));
                        }
                        for series in &chart.series {
                            if series.values.len() != chart.labels.len()
                                || series.values.iter().any(|v| {
                                    !v.is_finite()
                                        || (v.fract() == 0.0 && v.abs() > 9007199254740991.0)
                                        || (chart.kind == OfficeChartType::Pie && *v < 0.0)
                                })
                            {
                                return Err(invalid("specification.chart.values"));
                            }
                        }
                    }
                    for image in &slide.images {
                        bounded(&image.alt, 200, false, "specification.image.alt")?;
                        if !image.data.starts_with("data:image/png;base64,") {
                            return Err(invalid("specification.image"));
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
