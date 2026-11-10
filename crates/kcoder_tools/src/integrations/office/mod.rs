//! Office tools receive a native backend; model arguments never select the owner.
mod canonical_read;
mod schema;
use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use kcoder_types::integrations::office::*;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

#[async_trait]
pub trait OfficeToolBackend: Send + Sync {
    /// Native component/schema generation, supplied by the authenticated host.
    fn source_revision(&self) -> &str;
    async fn create_card(
        &self,
        _title: String,
        _presentation: OfficeArtifactPresentation,
        _sources: Vec<OfficeResourceRef>,
        _original_input: Value,
        _ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        Err(ToolError::Execution(
            "OFFICE_CARD_PROVIDER_UNAVAILABLE".into(),
        ))
    }
    async fn export_artifact(
        &self,
        _source: OfficeExportSource,
        _reference: OfficeArtifactRef,
        _format: OfficeFileFormat,
        _ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        Err(ToolError::Execution(
            "OFFICE_EXPORT_PROVIDER_UNAVAILABLE".into(),
        ))
    }
    async fn read_canonical_source(
        &self,
        _parameters: OfficeCanonicalSourceReadParams,
        _ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        Err(ToolError::Execution(
            "OFFICE_SOURCE_READER_UNAVAILABLE".into(),
        ))
    }
    async fn read_input(
        &self,
        _reference: OfficeArtifactRef,
        _cursor: Option<String>,
        _limit: usize,
        _ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        Err(ToolError::Execution(
            "OFFICE_INPUT_PROVIDER_UNAVAILABLE".into(),
        ))
    }
    /// The host captures the real scope/native turn and rechecks ctx.state identity.
    /// It derives the stable operation identity from the native tool call receipt.
    async fn create_document(
        &self,
        specification: OfficeGenerationSpec,
        sources: Vec<OfficeResourceRef>,
        original_input: Value,
        ctx: &ToolContext,
    ) -> Result<Value, ToolError>;
    async fn read_data(
        &self,
        action: OfficeDataAction,
        reference: OfficeArtifactRef,
        query: Option<OfficeDatasetQuery>,
        ctx: &ToolContext,
    ) -> Result<Value, ToolError>;
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentInput {
    specification: OfficeGenerationSpec,
    /// Actual references returned by material acceptance or prior Office tools. Never invent IDs or pass paths.
    #[serde(default)]
    source_refs: Vec<OfficeResourceRef>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OfficeDataAction {
    ReadManifest,
    Schema,
    Page,
    Query,
    Projection,
    ReadVerification,
    ReadOperation,
    CanonicalSource,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DataInput {
    action: OfficeDataAction,
    reference: OfficeArtifactRef,
    #[serde(default)]
    query: Option<OfficeDatasetQuery>,
    /// Only for canonical_source. Omission reads metadata, never body bytes.
    #[serde(default)]
    source_read: Option<canonical_read::CanonicalSourceReadOptions>,
}

/// Schema metadata only. Registration, native owner and resource permission stay
/// with the actual Accepted-turn backend; these values grant no execution access.
pub fn native_tool_input_schema(name: &str) -> Option<Value> {
    Some(match name {
        "OfficeDocument" => {
            schema::document_schema(clean_schema(schemars::schema_for!(DocumentInput)))
        }
        "OfficeData" => schema::data_schema(clean_schema(schemars::schema_for!(DataInput))),
        "OfficeRead" => clean_schema(schemars::schema_for!(ReadInput)),
        "OfficeCard" => clean_schema(schemars::schema_for!(CardInput)),
        "OfficeExport" => clean_schema(schemars::schema_for!(ExportInput)),
        _ => return None,
    })
}

pub struct OfficeDocumentTool {
    backend: Arc<dyn OfficeToolBackend>,
}
impl OfficeDocumentTool {
    pub fn new(backend: Arc<dyn OfficeToolBackend>) -> Result<Self, ToolError> {
        valid_revision(backend.source_revision())?;
        Ok(Self { backend })
    }
}
#[async_trait]
impl Tool for OfficeDocumentTool {
    fn name(&self) -> String {
        "OfficeDocument".into()
    }
    fn source(&self) -> crate::ToolSource {
        crate::ToolSource::NativeFeature {
            feature: "office".into(),
            tool: self.name(),
            revision: self.backend.source_revision().into(),
        }
    }
    fn description(&self) -> String {
        "Create a real new DOCX, XLSX or PPTX Office deliverable from explicit structured material, then publish an immutable artifact receipt in this native task. This does not create Markdown renamed as Office. Pass specification.schemaVersion=1 and kind=docx|xlsx|pptx. DOCX uses paragraphs[{text,heading?:1..3,bullet?}] and optional tables[{headers,rows}]; fixed templates report/letter. XLSX uses sheets[{name,columns:[{key,title,type:string|number|boolean|date,unit?,numberFormat?}],rows:scalar[][],formulas?:[{cell,formula}]}]. Every row must match columns; dates are real YYYY-MM-DD; null means missing, not zero. Numbers must be finite and integer writes JS-safe. Formula functions are SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/ABS/ROUND only; no strings, external references, URLs or scripts; writing formulas is NOT recalculation. PPTX uses slides[{title,paragraphs,notes?,chart?,images?}], fixed templates briefing/minimal. Each slide has <=8 paragraphs and <=400 visible characters (<=160 with chart/images); split longer content. A chart is {type:bar|line|pie,labels:string[],series:[{name,values:number[]}],unit?}, <=20 labels and <=4 series (one for pie). Images are <=2 data:image/png;base64,... payloads with alt text, <=4096x4096; no SVG, URL or path. Chart and images cannot share one slide. Limits: input 1 MiB, output 20 MiB, 16 sheets, 10,000 rows, 128 columns, 100,000 cells, 60 slides. sourceRefs are actual {kind,id,revision} references from this task; never fabricate IDs or use a local path as permission. This tool never sends externally, installs components or runs arbitrary code. Unsupported edits/conversions/templates must not be simulated as successful. Returned structure/content identity does not prove reader layout, formula calculation, business correctness, platform delivery or that the user has viewed it. Preserve pending checks and cite the exact returned artifact ID/revision. On unknown outcome, reconcile the original operation instead of regenerating or using a placeholder ID.".into()
    }
    fn input_schema(&self) -> Value {
        native_tool_input_schema("OfficeDocument").expect("fixed Native Office tool schema")
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn ui_metadata(&self) -> kcoder_types::tool_ui::ToolUiMetadata {
        kcoder_types::tool_ui::ToolUiMetadata {
            display_name: "OfficeDocument".into(),
            group: kcoder_types::tool_ui::ToolUiGroup::Files,
            icon: kcoder_types::tool_ui::ToolUiIcon::File,
            description: "Generate a real Office file with an immutable artifact receipt".into(),
        }
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let original_input = input.clone();
        let input: DocumentInput = parse_input(&input)?;
        input.specification.validate().map_err(|error| {
            ToolError::InvalidInput(format!(
                "OfficeDocument: /{} must match the bounded format schema",
                error.field.replace('.', "/")
            ))
        })?;
        if input.source_refs.len() > 128 {
            return Err(ToolError::InvalidInput(
                "OfficeDocument: /sourceRefs accepts at most 128 real references".into(),
            ));
        }
        for source in &input.source_refs {
            source.validate().map_err(|_| {
                ToolError::InvalidInput(
                    "OfficeDocument: /sourceRefs requires real nonempty kind/id/revision".into(),
                )
            })?;
        }
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        if ctx.tool_call_id.is_none() {
            return Err(ToolError::Execution(
                "OFFICE_NATIVE_CALL_ID_REQUIRED".into(),
            ));
        }
        let result = self
            .backend
            .create_document(input.specification, input.source_refs, original_input, ctx)
            .await?;
        Ok(ToolOutput::text(
            serde_json::to_string(&document_projection(result)?)
                .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?,
        ))
    }
}
pub struct OfficeDataTool {
    backend: Arc<dyn OfficeToolBackend>,
}
impl OfficeDataTool {
    pub fn new(backend: Arc<dyn OfficeToolBackend>) -> Result<Self, ToolError> {
        valid_revision(backend.source_revision())?;
        Ok(Self { backend })
    }
}
#[async_trait]
impl Tool for OfficeDataTool {
    fn name(&self) -> String {
        "OfficeData".into()
    }
    fn source(&self) -> crate::ToolSource {
        crate::ToolSource::NativeFeature {
            feature: "office".into(),
            tool: self.name(),
            revision: self.backend.source_revision().into(),
        }
    }
    fn description(&self) -> String {
        "Read authorized immutable Office artifacts or datasets without invoking a model, changing data, running SQL/Shell, re-generating files or sending externally. Actions: read_manifest/read_verification (artifact reference), read_operation (original operationId as reference.id, revision=1), schema (dataset reference), page/query (dataset reference plus query), projection (persisted bounded context projection reference), canonical_source (exact artifact reference, optional sourceRead). canonical_source defaults to metadata only; omit sourceRead or use {metadataOnly:true}. To read source JSON body, supply sourceRead:{metadataOnly:false,expectedSha256,offset,limit}; expectedSha256 MUST be source.specificationSha256 from the metadata, not output/artifact SHA or tool input SHA. Explicit UTF-8 byte offset and limit=1..65536 (maximum requested bytes) are required. Model inline pages are capped at 16384 bytes to preserve the complete pagination JSON; the host may return fewer bytes. Use returned pageLimit/returnedBytes and nextOffset, not a character count or the requested limit, for continuation. query is forbidden for canonical_source, and sourceRead is forbidden for other actions. complete means this page reaches EOF; it does not mean earlier pages were read. Only coversEntireSource=true means this response alone contains the whole source. Otherwise join unchanged chunks from offset 0 under the same artifact revision and source SHA before parsing the complete JSON. Legacy availability=not_recorded is missing source, never an empty successful source or a reason to reconstruct from preview. Output-budget errors require a smaller page; no JSON/numeric/source text is silently truncated. This is an authorized read, not an editor or regeneration. Use the exact returned id and revision; never fabricate a hash, use placeholder IDs or substitute local paths. query supports selected columns, typed filters eq/not_eq/contains/greater_than/less_than/is_null, stable sort, count/sum/min/max aggregates, limit=1..100 and an opaque cursor from the prior identical query. Aggregates return exact decimal text; an aggregate outside the supported exact range is rejected rather than rounded. Keep units, nulls, omitted-row counts and canonical numberText. The cursor is bound to the owner, current identity/target generation, immutable dataset revision and query; do not reuse after changing any of them. Large data stays in native storage; this output may return only a bounded projection or reference, so request fewer columns/smaller pages when needed. Missing/denied/unknown data is not an empty successful result. A stored verification observation is not proof of current user visibility or external delivery.".into()
    }
    fn input_schema(&self) -> Value {
        native_tool_input_schema("OfficeData").expect("fixed Native Office tool schema")
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn is_read_only(&self) -> bool {
        true
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: DataInput = parse_input(&input)?;
        if input.reference.id.is_empty()
            || input.reference.id.chars().count() > 256
            || input.reference.revision == 0
        {
            return Err(ToolError::InvalidInput(
                "OfficeData: /reference requires an actual nonempty id and positive revision"
                    .into(),
            ));
        }
        if matches!(
            input.action,
            OfficeDataAction::Page | OfficeDataAction::Query
        ) {
            input
                .query
                .as_ref()
                .ok_or_else(|| {
                    ToolError::InvalidInput("OfficeData: /query is required for page/query".into())
                })?
                .validate()
                .map_err(|_| {
                    ToolError::InvalidInput(
                        "OfficeData: /query must use the bounded declarative query schema".into(),
                    )
                })?;
        } else if input.query.is_some() {
            return Err(ToolError::InvalidInput(
                "OfficeData: /query is only accepted for page/query".into(),
            ));
        }
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        if input.action == OfficeDataAction::CanonicalSource {
            let mut parameters = input
                .source_read
                .unwrap_or_else(canonical_read::CanonicalSourceReadOptions::metadata)
                .parameters(input.reference)?;
            if !parameters.metadata_only {
                parameters.limit = parameters
                    .limit
                    .min(canonical_read::MODEL_SOURCE_PAGE_BYTES);
            }
            let result = self
                .backend
                .read_canonical_source(parameters.clone(), ctx)
                .await?;
            if ctx.is_aborted() {
                return Err(ToolError::Aborted);
            }
            return canonical_read::source_output(result, &parameters, ctx);
        }
        if input.source_read.is_some() {
            return Err(ToolError::InvalidInput(
                "OfficeData: /sourceRead is only accepted for canonical_source".into(),
            ));
        }
        let reference = input.reference.clone();
        let result = self
            .backend
            .read_data(input.action, input.reference, input.query, ctx)
            .await?;
        let text = serde_json::to_string(&result)
            .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
        let budget = if ctx.max_output_bytes == 0 {
            32 * 1024
        } else {
            ctx.max_output_bytes.min(32 * 1024)
        };
        let text = if text.len() <= budget {
            text
        } else {
            serde_json::to_string(&json!({"reference":reference,"modelPreviewRows":0,"availableRows":result.get("rows").and_then(Value::as_array).map(Vec::len),"omittedFromModel":true,"message":"Full data remains in authorized immutable storage. Request fewer columns or a smaller page; no numeric cells were truncated into a different value."})).map_err(|_|ToolError::Execution("OFFICE_RESULT_INVALID".into()))?
        };
        Ok(ToolOutput::text(text))
    }
}
fn document_projection(value: Value) -> Result<Value, ToolError> {
    let manifest: OfficeArtifactManifest = serde_json::from_value(
        value
            .get("manifest")
            .cloned()
            .ok_or_else(|| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?,
    )
    .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
    manifest
        .validate()
        .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
    Ok(
        json!({"artifactRef":{"id":manifest.id,"revision":manifest.revision},"title":manifest.title,"format":manifest.format,"bytes":manifest.bytes,"sha256":manifest.sha256,"sourceRefs":manifest.source_refs.iter().take(8).collect::<Vec<_>>(),"sourceCount":manifest.source_refs.len(),"omittedSources":manifest.source_refs.len().saturating_sub(8),"dataset":manifest.dataset,"verification":{"status":manifest.verification.status,"readerStatus":manifest.verification.reader_status,"formulaCalculation":manifest.verification.formula_calculation,"pendingChecks":manifest.verification.pending_checks.iter().take(8).collect::<Vec<_>>()},"businessComplete":value.get("businessComplete").cloned().unwrap_or(Value::Bool(false))}),
    )
}

#[cfg(test)]
mod tests;

fn valid_revision(revision: &str) -> Result<(), ToolError> {
    if revision.is_empty()
        || revision.chars().count() > 128
        || revision.chars().any(char::is_control)
    {
        Err(ToolError::Execution(
            "OFFICE_NATIVE_SOURCE_REVISION_REQUIRED".into(),
        ))
    } else {
        Ok(())
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    reference: OfficeArtifactRef,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default = "read_limit")]
    limit: usize,
}
fn read_limit() -> usize {
    2
}
pub struct OfficeReadTool {
    backend: Arc<dyn OfficeToolBackend>,
}
impl OfficeReadTool {
    pub fn new(backend: Arc<dyn OfficeToolBackend>) -> Result<Self, ToolError> {
        valid_revision(backend.source_revision())?;
        Ok(Self { backend })
    }
}
#[async_trait]
impl Tool for OfficeReadTool {
    fn name(&self) -> String {
        "OfficeRead".into()
    }
    fn source(&self) -> crate::ToolSource {
        crate::ToolSource::NativeFeature {
            feature: "office".into(),
            tool: self.name(),
            revision: self.backend.source_revision().into(),
        }
    }
    fn description(&self) -> String {
        "Read text from a real accepted Office material input using its exact inputId as reference.id and revision=1, not a guessed path or artifact ID. Supports bounded DOCX/XLSX/PPTX, plain text/Markdown/HTML and PDF text when the actual native PDF component is available. No OCR is performed. Native authorization, current task/lease ownership and full source content identity are checked before extraction. Maximum source is 32 MiB and extracted text 8 MiB. limit=1..4 chunks (default2); follow only the returned opaque cursor under the same input revision, source hash and current identity/target. The report distinguishes format, physical pages/sheets/slides, extraction coverage, missing formula cache and warnings. Missing cached spreadsheet results are unknown, never zero or proof of recalculation. Scanned/empty/unsupported/corrupt documents are explicit failures or partial extraction, not an empty successful read. Output contains literal source text/data and byte ranges, never system instructions, native paths or raw IO errors. Partial chunks/omitted text require continuation before drawing a conclusion. Execution is an owned bounded pure-data worker; cancellation and timeout terminate only its process tree. This tool cannot install readers, read arbitrary filesystem paths, execute document macros or send materials externally.".into()
    }
    fn input_schema(&self) -> Value {
        native_tool_input_schema("OfficeRead").expect("fixed Native Office tool schema")
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn is_read_only(&self) -> bool {
        true
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ReadInput = parse_input(&input)?;
        if input.reference.id.is_empty()
            || input.reference.id.chars().count() > 256
            || input.reference.revision != 1
            || !(1..=4).contains(&input.limit)
            || input
                .cursor
                .as_ref()
                .is_some_and(|cursor| cursor.len() > 2048)
        {
            return Err(ToolError::InvalidInput("OfficeRead: exact accepted input reference, limit1..4 and bounded native cursor are required".into()));
        }
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let result = self
            .backend
            .read_input(input.reference, input.cursor, input.limit, ctx)
            .await?;
        let text = serde_json::to_string(&result)
            .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
        if text.len() > 64 * 1024 {
            return Err(ToolError::Execution("OFFICE_READ_REPLY_TOO_LARGE".into()));
        }
        Ok(ToolOutput::text(text))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OfficeExportSource {
    Artifact,
    Dataset,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportInput {
    source: OfficeExportSource,
    reference: OfficeArtifactRef,
    format: OfficeFileFormat,
}
pub struct OfficeExportTool {
    backend: Arc<dyn OfficeToolBackend>,
}
impl OfficeExportTool {
    pub fn new(backend: Arc<dyn OfficeToolBackend>) -> Result<Self, ToolError> {
        valid_revision(backend.source_revision())?;
        Ok(Self { backend })
    }
}
#[async_trait]
impl Tool for OfficeExportTool {
    fn name(&self) -> String {
        "OfficeExport".into()
    }
    fn source(&self) -> crate::ToolSource {
        crate::ToolSource::NativeFeature {
            feature: "office".into(),
            tool: self.name(),
            revision: self.backend.source_revision().into(),
        }
    }
    fn description(&self) -> String {
        "Prepare an authorized downloadable Office deliverable from an exact immutable native reference. source=artifact reuses an existing artifact in its ORIGINAL format only; changing DOCX/XLSX/PPTX into PDF is unavailable unless a separately verified native converter is configured, never rename the extension. source=dataset exports actual frozen rows to csv or json and publishes a new artifact in this current native task. CSV is UTF-8 with BOM and formula-injection mitigation; it has no universal spreadsheet type metadata, so preserve original dataset references and prefer JSON for exact canonical numeric text. JSON export excludes account/workspace ownership metadata. No arbitrary path, URL, destination, scope, task ID or code parameter is accepted. This action is ordered and uses native operation receipts; a lost response does not justify creating another export blindly. The returned exportId/leaseRevision/expiresAtMs is a private scoped preview/download receipt, not a public sharing URL or evidence of an external send/user view. Use P-DELIVERY through an explicitly authorized channel action for external delivery; this tool does not send. Never invent artifact IDs, lease IDs or placeholder paths.".into()
    }
    fn input_schema(&self) -> Value {
        native_tool_input_schema("OfficeExport").expect("fixed Native Office tool schema")
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ExportInput = parse_input(&input)?;
        if input.reference.id.is_empty()
            || input.reference.id.chars().count() > 256
            || input.reference.revision == 0
        {
            return Err(ToolError::InvalidInput(
                "OfficeExport: /reference must be an actual immutable reference".into(),
            ));
        }
        if input.source == OfficeExportSource::Dataset
            && !matches!(input.format, OfficeFileFormat::Csv | OfficeFileFormat::Json)
        {
            return Err(ToolError::InvalidInput(
                "OfficeExport: dataset export supports csv/json only".into(),
            ));
        }
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let result = self
            .backend
            .export_artifact(input.source, input.reference.clone(), input.format, ctx)
            .await?;
        let text = serde_json::to_string(&result)
            .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?;
        if text.len() > 16 * 1024 {
            return Err(ToolError::Execution("OFFICE_RESULT_INVALID".into()));
        }
        Ok(ToolOutput::text(text))
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CardInput {
    title: String,
    presentation: OfficeArtifactPresentation,
    #[serde(default)]
    source_refs: Vec<OfficeResourceRef>,
}
pub struct OfficeCardTool {
    backend: Arc<dyn OfficeToolBackend>,
}
impl OfficeCardTool {
    pub fn new(backend: Arc<dyn OfficeToolBackend>) -> Result<Self, ToolError> {
        valid_revision(backend.source_revision())?;
        Ok(Self { backend })
    }
}
#[async_trait]
impl Tool for OfficeCardTool {
    fn name(&self) -> String {
        "OfficeCard".into()
    }
    fn source(&self) -> crate::ToolSource {
        crate::ToolSource::NativeFeature {
            feature: "office".into(),
            tool: self.name(),
            revision: self.backend.source_revision().into(),
        }
    }
    fn description(&self) -> String {
        "Publish a persistent declarative Office result card backed by an actual immutable JSON artifact in this current native task. This is not arbitrary HTML/JavaScript and never calls a model for local filtering, sorting or paging. presentation.kind may be document, table, chart, action_items, research, file_collection or form. Native operation_receipt is not model-writable; never invent an operation status or approval receipt. Table/chart must reference a real dataset id/revision returned by native tools; chart chooses existing labelColumn/valueColumns only and keeps original numbers/units/nulls. File collections list only actual artifact references, in explicit viewing order with the primary item first. Action items keep assignee/due unknown when not provided and cite actual sourceRefs; their status is a data claim, not native execution completion. Research findings must cite real accepted sources and observation time. Forms contain bounded input JSON Schema and literal defaults only; submitting them prepares an authorized task intent, never executes source scripts or external sends. Source references do not grant authority. Unknown IDs, hidden resources, unsupported types and malformed schemas are rejected. A published card/JSON file does not prove semantic correctness, current user visibility or channel delivery. The Studio host shows these cards only after the final response; do not use fake widget IDs or placeholders to force early rendering.".into()
    }
    fn input_schema(&self) -> Value {
        native_tool_input_schema("OfficeCard").expect("fixed Native Office tool schema")
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let original_input = input.clone();
        let input: CardInput = parse_input(&input)?;
        if input.title.trim().is_empty()
            || input.title.chars().count() > 200
            || input.source_refs.len() > 128
            || matches!(
                input.presentation,
                OfficeArtifactPresentation::OperationReceipt { .. }
            )
        {
            return Err(ToolError::InvalidInput("OfficeCard: bounded title/sourceRefs and a supported data presentation are required; native receipts cannot be authored".into()));
        }
        input.presentation.validate(&input.source_refs).map_err(|_|ToolError::InvalidInput("OfficeCard: presentation must match the bounded declarative schema and exact source references".into()))?;
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let result = self
            .backend
            .create_card(
                input.title,
                input.presentation,
                input.source_refs,
                original_input,
                ctx,
            )
            .await?;
        Ok(ToolOutput::text(
            serde_json::to_string(&document_projection(result)?)
                .map_err(|_| ToolError::Execution("OFFICE_RESULT_INVALID".into()))?,
        ))
    }
}
