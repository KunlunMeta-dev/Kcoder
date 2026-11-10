//! Studio-only presentation tool. Durable receipts never depend on model-authored HTML links.
use crate::{Tool, ToolContext, ToolError, ToolExecutionMetadata, ToolOutput, parse_input};
use async_trait::async_trait;
use html5ever::{
    tendril::StrTendril,
    tokenizer::{
        BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
        states::RawKind,
    },
};
use kcoder_state::widgets::{WidgetCommitRequest, WidgetStore};
use kcoder_types::widgets::*;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::cell::RefCell;

#[derive(Debug, Clone)]
pub struct ShowWidgetTool {
    binding: Option<WidgetTurnBinding>,
    isolated_html_authorized: bool,
}

impl ShowWidgetTool {
    pub fn new(binding: WidgetTurnBinding) -> Self {
        Self {
            binding: Some(binding),
            isolated_html_authorized: false,
        }
    }
    /// A catalog projection has no execution authority.
    pub fn preview() -> Self {
        Self {
            binding: None,
            isolated_html_authorized: false,
        }
    }
    /// The host validates the current turn declaration; this is never persisted tool authority.
    pub fn with_isolated_html_authorized(mut self, authorized: bool) -> Self {
        self.isolated_html_authorized = authorized;
        self
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WidgetAction {
    Render,
    Read,
}

fn default_action() -> WidgetAction {
    WidgetAction::Render
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShowWidgetInput {
    /// render (default) requires title/widget_code/summary; read is metadata recovery and uses only read fields. Never combine render fields with action=read.
    #[serde(default = "default_action")]
    pub action: WidgetAction,
    /// Render only: required nonblank accessible title, at most 256 UTF-8 bytes. Omit for read.
    pub title: Option<String>,
    /// Render only: required original HTML/SVG string, 1..1048576 UTF-8 bytes. Escape it once in outer argument JSON; no Markdown fences or double JSON encoding. Managed declarations use inert application/json, never arbitrary JavaScript.
    pub widget_code: Option<String>,
    /// Render only: required nonblank plain-text accessible explanation, at most 4096 UTF-8 bytes. Omit for read.
    pub summary: Option<String>,
    /// Render only: html (default) or svg. Omit for read.
    #[serde(default)]
    pub format: WidgetFormat,
    /// Render only: managed (default); isolated_html requires validated current native-host authorization. Omit for read.
    #[serde(default)]
    pub execution_mode: WidgetExecutionMode,
    /// Render only: pinned local IDs chart_js, d3, topojson; omit for plain SVG or recipes, and for read. No CDN or arbitrary plugin IDs.
    #[serde(default)]
    pub libraries: Vec<WidgetLibrary>,
    /// Use only the exact widget_id from a successful receipt. Never a placeholder, example or fabricated ID. Render updates also require expected_revision; omit both for a new widget. Read selects this actual ID or the original lookup_tool_call_id, never both.
    pub widget_id: Option<String>,
    /// Render updates require this with widget_id. Read by widget_id selects this revision, or latest if omitted; invalid with lookup_tool_call_id.
    pub expected_revision: Option<u64>,
    /// Read only: actual original provider tool call ID after a lost result; mutually exclusive with widget_id/expected_revision. Never a placeholder, invented ID, conversation ID or filesystem path.
    pub lookup_tool_call_id: Option<String>,
    /// Read only, with lookup_tool_call_id: actual attempt ID disambiguating reused tool call IDs. Omit when not known or not needed.
    pub lookup_attempt_id: Option<String>,
    /// Read only (default false): include at most 64 KiB of builtin source and an explicit truncation flag. MCP App source remains UI-only. Omit for render.
    #[serde(default)]
    pub include_source: bool,
}

#[async_trait]
impl Tool for ShowWidgetTool {
    fn name(&self) -> String {
        "show_widget".into()
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        let mut schema = crate::clean_schema(schemars::schema_for!(ShowWidgetInput));
        schema["description"] = Value::String("Choose one action. Render (default) requires title/widget_code/summary and uses only render fields; updates pair widget_id with expected_revision. Read requires explicit action=read and exactly one of widget_id or lookup_tool_call_id; omit all render fields. Read revisions require widget_id, and lookup_attempt_id requires lookup_tool_call_id. Never use placeholder or invented IDs. New renders omit widget_id/expected_revision; copy real receipt identities for reads, updates and final references. See source-encoding rules in the tool description.".into());
        schema
    }
    fn description(&self) -> String {
        let description = include_str!("show_widget/authoring-help.md");
        let execution = if self.isolated_html_authorized {
            " This current host also permits execution_mode=isolated_html for custom HTML/JavaScript inside an individually authorized sandbox process. It supports DOM/Canvas2D office interaction; no network, workers, WebGL/WebGPU, native APIs or parent access. Keep source self-contained and bounded."
        } else {
            " This host supports managed mode only; isolated_html is unavailable."
        };
        format!("{description}{execution}")
    }
    fn is_read_only(&self) -> bool {
        false
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let binding = self.binding.as_ref().ok_or_else(|| {
            invalid("unsupported_client: this catalog tool has no bound Studio turn")
        })?;
        if !ctx.inline_widgets_authorized() {
            return Err(invalid(
                "unsupported_client: the current request has no inline widget authority",
            ));
        }
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        if ctx.state.session_id() != binding.thread_id {
            return Err(invalid(
                "unsupported_client: widget thread does not match the active session",
            ));
        }
        let call_id = ctx
            .tool_call_id
            .as_ref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                invalid("unsupported_client: a host-bound tool call identity is required")
            })?;
        let raw_input = input;
        let input: ShowWidgetInput = parse_input(&raw_input)?;
        validate_action_fields(&raw_input, &input)?;
        let project = ctx.state.session_artifact_project_dir().ok_or_else(|| {
            invalid("artifact_unavailable: this session has no durable artifact directory")
        })?;
        let directory = kcoder_state::session_dir_path(project, &binding.thread_id);
        if matches!(input.action, WidgetAction::Read) {
            let store = WidgetStore::open_existing(&directory, &binding.thread_id)
                .map_err(|error| invalid(&error.to_string()))?
                .ok_or_else(|| {
                    invalid("artifact_unavailable: this thread has no recorded widgets")
                })?;
            let result = match (&input.widget_id, &input.lookup_tool_call_id) {
                (Some(id),None) => match input.expected_revision {
                    Some(revision) => store.read(id,revision),None => store.latest(id),
                },
                (None,Some(call)) => store.find_call(call,input.lookup_attempt_id.as_deref()),
                _ => return Err(invalid("invalid_widget: read requires exactly one of widget_id or lookup_tool_call_id")),
            }.map_err(|error| invalid(&error.to_string()))?;
            let (reference, source) = result;
            let mut response = serde_json::json!({"status":"recorded","widget":reference});
            if let Some(observation) = store
                .render_observation(&reference)
                .map_err(|error| invalid(&error.to_string()))?
            {
                response["render_observation"] = serde_json::to_value(observation)
                    .map_err(|error| invalid(&error.to_string()))?;
            }
            if input.include_source && reference.mcp_app.is_none() {
                let mut end = source.len().min(64 * 1024);
                while !source.is_char_boundary(end) {
                    end -= 1;
                }
                response["source"] = Value::String(source[..end].into());
                response["source_truncated"] = Value::Bool(end < source.len());
            }
            return Ok(ToolOutput::text(response.to_string()));
        }
        if input.execution_mode == WidgetExecutionMode::IsolatedHtml
            && !self.isolated_html_authorized
        {
            return Err(invalid(
                "unsupported_client: isolated_html is not enabled by this validated host; use managed SVG, HTML or chart recipes",
            ));
        }
        let source = input
            .widget_code
            .ok_or_else(|| invalid("invalid_widget: /widget_code is required for render"))?;
        let title = input
            .title
            .ok_or_else(|| invalid("invalid_widget: /title is required for render"))?;
        let summary = input
            .summary
            .ok_or_else(|| invalid("invalid_widget: /summary is required for render"))?;
        if input.execution_mode == WidgetExecutionMode::Managed {
            validate_managed_source(&source, input.format)?;
        }
        let store = WidgetStore::open(&directory, &binding.thread_id)
            .map_err(|error| invalid(&error.to_string()))?;
        let request = WidgetCommitRequest {
            identity: WidgetIdentity {
                thread_id: binding.thread_id.clone(),
                turn_id: binding.turn_id.clone(),
                attempt_id: binding.attempt_id.clone(),
                tool_call_id: call_id.clone(),
            },
            title,
            summary,
            format: input.format,
            execution_mode: input.execution_mode,
            libraries: input.libraries,
            source,
            widget_id: input.widget_id.clone(),
            expected_revision: input.expected_revision,
        };
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let reference = match store.commit(request) {
            Ok(reference) => reference,
            Err(error) if error.to_string().contains("revision_conflict") => {
                let current = input
                    .widget_id
                    .as_ref()
                    .and_then(|id| store.latest(id).ok())
                    .map(|(reference, _)| reference);
                return Ok(ToolOutput::error(serde_json::json!({"error":"revision_conflict","message":"Review the current widget before updating; action=read can return the current revision and bounded builtin source","current_widget":current}).to_string()));
            }
            Err(error) => return Err(invalid(&error.to_string())),
        };
        let receipt = serde_json::json!({
            "status":"committed", "widget_id":reference.widget_id,
            "revision":reference.revision, "sha256":reference.sha256,
            "title":reference.title, "summary":reference.summary,
        });
        Ok(ToolOutput::text(receipt.to_string())
            .with_execution_metadata(ToolExecutionMetadata::Widget(reference)))
    }
}

fn invalid(message: &str) -> ToolError {
    ToolError::InvalidInput(message.into())
}

fn validate_action_fields(raw: &Value, input: &ShowWidgetInput) -> Result<(), ToolError> {
    let supplied = |field| raw.get(field).is_some_and(|value| !value.is_null());
    match input.action {
        WidgetAction::Read => {
            for field in [
                "title",
                "widget_code",
                "summary",
                "format",
                "execution_mode",
                "libraries",
            ] {
                if supplied(field) {
                    return Err(invalid(&format!(
                        "invalid_widget: /{field} is a render field; omit it for action=read"
                    )));
                }
            }
            if input.widget_id.is_some() == input.lookup_tool_call_id.is_some() {
                return Err(invalid(
                    "invalid_widget: action=read requires exactly one of /widget_id or /lookup_tool_call_id",
                ));
            }
            if input.lookup_tool_call_id.is_some() && input.expected_revision.is_some() {
                return Err(invalid(
                    "invalid_widget: /expected_revision requires read by /widget_id; omit it for /lookup_tool_call_id",
                ));
            }
            if input.lookup_tool_call_id.is_none() && input.lookup_attempt_id.is_some() {
                return Err(invalid(
                    "invalid_widget: /lookup_attempt_id requires /lookup_tool_call_id",
                ));
            }
        }
        WidgetAction::Render => {
            for field in ["lookup_tool_call_id", "lookup_attempt_id", "include_source"] {
                if supplied(field) {
                    return Err(invalid(&format!(
                        "invalid_widget: /{field} is a read field; omit it for action=render"
                    )));
                }
            }
            if input.widget_id.is_some() != input.expected_revision.is_some() {
                return Err(invalid(
                    "invalid_widget: render updates require both /widget_id and /expected_revision; omit both for a new widget",
                ));
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct Validation {
    error: Option<String>,
    tags: usize,
    svg: bool,
    json_script: Option<String>,
    json_script_is_map: bool,
    svg_only: bool,
}

struct ManagedSink(RefCell<Validation>);

impl TokenSink for ManagedSink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        let mut state = self.0.borrow_mut();
        if state.error.is_some() {
            return TokenSinkResult::Continue;
        }
        match token {
            Token::TagToken(tag) => {
                let name = tag.name.to_string();
                if tag.kind == TagKind::EndTag {
                    if name == "script"
                        && let Some(json) = state.json_script.take()
                    {
                        match serde_json::from_str::<Value>(&json) {
                            Ok(value) if state.json_script_is_map => {
                                state.error = validate_map_values(&value).err();
                            }
                            Ok(_) => {}
                            Err(_) => {
                                state.error = Some(
                                    "invalid_widget: /widget_code contains invalid managed JSON"
                                        .into(),
                                )
                            }
                        }
                        state.json_script_is_map = false;
                    }
                    return TokenSinkResult::Continue;
                }
                state.tags += 1;
                state.svg |= name == "svg";
                if state.tags > 10000 {
                    state.error =
                        Some("widget_quota: /widget_code exceeds the markup element budget".into());
                }
                if matches!(
                    name.as_str(),
                    "iframe"
                        | "frame"
                        | "frameset"
                        | "object"
                        | "embed"
                        | "base"
                        | "meta"
                        | "link"
                        | "foreignobject"
                ) {
                    state.error = Some(format!(
                        "invalid_widget: /widget_code contains forbidden element {name}"
                    ));
                }
                for attr in &tag.attrs {
                    let key = attr.name.local.to_string().to_ascii_lowercase();
                    let value = attr.value.trim();
                    if key.starts_with("on")
                        || matches!(key.as_str(), "srcdoc" | "action" | "formaction")
                    {
                        state.error = Some(format!(
                            "invalid_widget: /widget_code contains executable attribute {key}"
                        ));
                    }
                    if matches!(key.as_str(), "src" | "href")
                        && !value.is_empty()
                        && !value.starts_with('#')
                        && ![
                            "data:image/png;base64,",
                            "data:image/jpeg;base64,",
                            "data:image/webp;base64,",
                        ]
                        .iter()
                        .any(|prefix| value.starts_with(prefix))
                    {
                        state.error = Some(format!(
                            "resource_blocked: /widget_code {key} must use an inline image or local fragment"
                        ));
                    }
                }
                if name == "script" {
                    let json = !state.svg_only
                        && tag.attrs.iter().any(|attr| {
                            attr.name.local.as_ref() == "type"
                                && attr.value.eq_ignore_ascii_case("application/json")
                        })
                        && tag.attrs.iter().any(|attr| {
                            matches!(
                                attr.name.local.as_ref(),
                                "data-kcoder-chart" | "data-kcoder-map" | "data-kcoder-config"
                            )
                        });
                    if json {
                        state.json_script_is_map = tag
                            .attrs
                            .iter()
                            .any(|attr| attr.name.local.as_ref() == "data-kcoder-map");
                        state.json_script = Some(String::new());
                    } else {
                        state.error = Some("invalid_widget: managed /widget_code cannot execute JavaScript; use JSON chart/map declarations".into());
                    }
                    return TokenSinkResult::RawData(RawKind::ScriptData);
                }
                if name == "style" {
                    return TokenSinkResult::RawData(RawKind::Rawtext);
                }
            }
            Token::CharacterTokens(text) => {
                if let Some(json) = state.json_script.as_mut() {
                    json.push_str(&text);
                }
            }
            Token::NullCharacterToken => {
                state.error = Some("invalid_widget: /widget_code contains a null character".into())
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

// Exact country membership is checked against the host's verified topology.
// Admission validates shapes and aliases before an immutable widget is stored.
fn validate_map_values(spec: &Value) -> Result<(), String> {
    if !spec.is_object() {
        return Err("invalid_widget: / (invalid_map_config) expected an object".into());
    }
    let Some(values) = spec.get("values") else {
        return Ok(());
    };
    let values = values.as_object().ok_or_else(|| {
        "invalid_widget: /values (invalid_map_values) expected a country-ID object".to_string()
    })?;
    if values.len() > 300 {
        return Err("widget_quota: /values (country_limit) at most 300 entries".into());
    }
    let mut ids = std::collections::HashSet::new();
    for (raw_id, value) in values {
        let pointer = format!("/values/{}", raw_id.replace('~', "~0").replace('/', "~1"));
        if raw_id.is_empty()
            || raw_id.len() > 3
            || !raw_id.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(format!(
                "invalid_widget: {pointer} (invalid_country_id) expected 1–3 ASCII digits, for example 076 or 76 for Brazil"
            ));
        }
        let id = format!("{raw_id:0>3}");
        if !ids.insert(id.clone()) {
            return Err(format!(
                "invalid_widget: {pointer} (duplicate_country_id) country {id} is already declared; use one key per country"
            ));
        }
        if value.as_f64().is_none_or(|number| !number.is_finite()) {
            return Err(format!(
                "invalid_widget: {pointer} (invalid_country_value) expected a finite number"
            ));
        }
    }
    Ok(())
}

fn validate_managed_source(source: &str, format: WidgetFormat) -> Result<(), ToolError> {
    if source.is_empty() || source.len() > WIDGET_SOURCE_BYTES {
        return Err(invalid(
            "widget_quota: /widget_code must contain 1..1048576 UTF-8 bytes",
        ));
    }
    let sink = ManagedSink(RefCell::new(Validation {
        svg_only: format == WidgetFormat::Svg,
        ..Default::default()
    }));
    let tokenizer = Tokenizer::new(sink, TokenizerOpts::default());
    let queue = BufferQueue::default();
    queue.push_back(StrTendril::from(source));
    let _ = tokenizer.feed(&queue);
    tokenizer.end();
    let state = tokenizer.sink.0.into_inner();
    if let Some(error) = state.error {
        return Err(invalid(&error));
    }
    if state.json_script.is_some() {
        return Err(invalid(
            "invalid_widget: /widget_code contains an unclosed JSON declaration",
        ));
    }
    if format == WidgetFormat::Svg && !state.svg {
        return Err(invalid(
            "invalid_widget: /widget_code must contain an SVG root",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_source_accepts_svg_and_local_chart_data() {
        validate_managed_source(
            "<svg viewBox='0 0 100 100'><text>Hello</text></svg>",
            WidgetFormat::Svg,
        )
        .unwrap();
        validate_managed_source(r#"<script type="application/json" data-kcoder-chart>{"type":"bar","data":{"labels":["Q1"],"datasets":[{"data":[128]}]}}</script>"#,WidgetFormat::Html).unwrap();
        validate_managed_source(
            "<div data-kcoder-recipe='compound-interest'></div>",
            WidgetFormat::Html,
        )
        .unwrap();
    }

    #[test]
    fn executable_or_external_markup_cannot_enter_managed_mode() {
        for source in [
            "<script>parent.fetch('/secret')</script>",
            "<svg onload='run()'></svg>",
            "<img src='https://example.test/track'>",
            "<iframe srcdoc='bad'></iframe>",
            "<base href='file:///'>",
            "<svg><foreignObject><script>run()</script></foreignObject></svg>",
        ] {
            assert!(
                validate_managed_source(source, WidgetFormat::Html).is_err(),
                "{source}"
            );
        }
    }

    #[test]
    fn json_declarations_require_complete_well_formed_data() {
        assert!(
            validate_managed_source(
                "<script type='application/json' data-kcoder-chart>{bad}</script>",
                WidgetFormat::Html
            )
            .is_err()
        );
        assert!(
            validate_managed_source(
                "<script type='application/json' data-kcoder-chart>{}",
                WidgetFormat::Html
            )
            .is_err()
        );
        assert!(validate_managed_source("<div>Not SVG</div>", WidgetFormat::Svg).is_err());
    }

    #[test]
    fn map_values_accept_compact_and_padded_country_ids() {
        for values in [
            serde_json::json!({"76": 15, "36": 18}),
            serde_json::json!({"076": 15, "036": 18}),
        ] {
            let source = format!(
                "<script type='application/json' data-kcoder-map>{}</script>",
                serde_json::json!({"values": values})
            );
            validate_managed_source(&source, WidgetFormat::Html).unwrap();
        }
    }

    #[test]
    fn malformed_map_values_fail_before_storage_with_an_actionable_pointer() {
        for (spec, reason) in [
            (serde_json::json!([]), "invalid_map_config"),
            (serde_json::json!({"values": []}), "invalid_map_values"),
            (serde_json::json!({"values": null}), "invalid_map_values"),
            (
                serde_json::json!({"values": {"BR": 10}}),
                "invalid_country_id",
            ),
            (
                serde_json::json!({"values": {"0076": 10}}),
                "invalid_country_id",
            ),
            (
                serde_json::json!({"values": {"36": 10, "036": 20}}),
                "duplicate_country_id",
            ),
            (
                serde_json::json!({"values": {"076": "10"}}),
                "invalid_country_value",
            ),
        ] {
            let source = format!("<script type='application/json' data-kcoder-map>{spec}</script>");
            let error = validate_managed_source(&source, WidgetFormat::Html)
                .unwrap_err()
                .to_string();
            assert!(error.contains(reason), "{error}");
            assert!(error.contains("invalid_widget: /"), "{error}");
        }
    }

    #[tokio::test]
    async fn documented_argument_examples_parse_render_and_read_original_source_once() {
        let root = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(root.path());
        let thread = state.session_id();
        state.with_session_artifact_project_dir(root.path().join("sessions"), &thread);
        let ctx = ToolContext::new(state).with_inline_widgets_authorized(true);
        let tool = ShowWidgetTool::new(WidgetTurnBinding {
            thread_id: thread.clone(),
            turn_id: "doc-turn".into(),
            attempt_id: "doc-attempt".into(),
        });
        let mut renders = 0;
        let mut reads = 0;
        let mut last_widget: Option<WidgetRef> = None;
        let mut last_source = String::new();
        let help = include_str!("show_widget/authoring-help.md").replace("\r\n", "\n");
        for part in help.split("```json\n").skip(1) {
            let code = part.split_once("```").unwrap().0;
            let raw: Value = serde_json::from_str(code).unwrap();
            let input: ShowWidgetInput = parse_input(&raw).unwrap();
            validate_action_fields(&raw, &input).unwrap();
            match input.action {
                WidgetAction::Render => {
                    let source = input.widget_code.unwrap();
                    assert!(source.starts_with('<'), "Source must not be double-encoded");
                    assert!(source.contains("type=\"application/json\""));
                    validate_managed_source(&source, input.format).unwrap();
                    assert!(input.title.is_some() && input.summary.is_some());
                    renders += 1;
                    let output = tool
                        .call(
                            raw,
                            &ctx.clone()
                                .with_tool_call_id(format!("doc-render-{renders}")),
                        )
                        .await
                        .unwrap();
                    let widget = output
                        .execution_metadata
                        .iter()
                        .find_map(|metadata| match metadata {
                            ToolExecutionMetadata::Widget(widget) => Some(widget.clone()),
                            _ => None,
                        })
                        .unwrap();
                    let store = WidgetStore::open_existing(
                        &kcoder_state::session_dir_path(root.path().join("sessions"), &thread),
                        &thread,
                    )
                    .unwrap()
                    .unwrap();
                    let (_, retained) = store.read(&widget.widget_id, widget.revision).unwrap();
                    assert_eq!(retained.as_bytes(), source.as_bytes());
                    last_widget = Some(widget);
                    last_source = source;
                }
                WidgetAction::Read => panic!(
                    "Read selectors must use runtime receipts, not documentation placeholder IDs"
                ),
            }
        }
        let widget = last_widget.as_ref().unwrap();
        for raw in [
            serde_json::json!({"action":"read", "widget_id":widget.widget_id, "include_source":true}),
            serde_json::json!({"action":"read", "lookup_tool_call_id":format!("doc-render-{renders}"), "lookup_attempt_id":"doc-attempt"}),
        ] {
            reads += 1;
            let output = tool
                .call(
                    raw,
                    &ctx.clone().with_tool_call_id(format!("doc-read-{reads}")),
                )
                .await
                .unwrap();
            assert!(output.execution_metadata.is_empty());
            let text = output
                .content
                .iter()
                .find_map(|content| match content {
                    kcoder_types::ContentBlock::Text { text } => Some(text),
                    _ => None,
                })
                .unwrap();
            let receipt: Value = serde_json::from_str(text).unwrap();
            assert_eq!(receipt["widget"]["widgetId"], widget.widget_id);
            if let Some(source) = receipt.get("source") {
                assert_eq!(source.as_str().unwrap().as_bytes(), last_source.as_bytes());
                assert_eq!(receipt["source_truncated"], false);
            }
        }
        assert_eq!((renders, reads), (3, 2));
        let store = WidgetStore::open_existing(
            &kcoder_state::session_dir_path(root.path().join("sessions"), &thread),
            &thread,
        )
        .unwrap()
        .unwrap();
        assert_eq!(store.list(0, 50).unwrap().0.len(), 3);
    }

    #[test]
    fn read_and_render_fields_are_not_silently_ignored() {
        for (raw, pointer) in [
            (
                serde_json::json!({"action":"read","widget_id":"returned","title":"ignored"}),
                "/title",
            ),
            (
                serde_json::json!({"action":"read","widget_id":"returned","format":"html"}),
                "/format",
            ),
            (
                serde_json::json!({"action":"read","widget_id":"returned","execution_mode":"managed"}),
                "/execution_mode",
            ),
            (
                serde_json::json!({"action":"read","widget_id":"returned","libraries":[]}),
                "/libraries",
            ),
            (
                serde_json::json!({"action":"read","widget_id":"returned","lookup_tool_call_id":"call"}),
                "/lookup_tool_call_id",
            ),
            (
                serde_json::json!({"action":"read","lookup_tool_call_id":"call","expected_revision":1}),
                "/expected_revision",
            ),
            (
                serde_json::json!({"action":"read","widget_id":"returned","lookup_attempt_id":"attempt"}),
                "/lookup_attempt_id",
            ),
            (
                serde_json::json!({"action":"render","lookup_tool_call_id":"call"}),
                "/lookup_tool_call_id",
            ),
            (
                serde_json::json!({"action":"render","include_source":false}),
                "/include_source",
            ),
            (
                serde_json::json!({"action":"render","widget_id":"returned"}),
                "/expected_revision",
            ),
        ] {
            let input: ShowWidgetInput = parse_input(&raw).unwrap();
            let error = validate_action_fields(&raw, &input)
                .unwrap_err()
                .to_string();
            assert!(error.contains(pointer), "{error}");
        }
    }

    #[test]
    fn registered_recipe_config_is_inert_complete_json_only() {
        validate_managed_source(
            r#"<div data-kcoder-recipe="compound-interest"><script type="application/json" data-kcoder-config>{"principal":560000,"annualRate":8.5,"years":7,"currency":"CNY"}</script></div>"#,
            WidgetFormat::Html,
        )
        .unwrap();
        for source in [
            "<script data-kcoder-config>run()</script>",
            "<script type='text/javascript' data-kcoder-config>run()</script>",
            "<script type='application/json' data-kcoder-config onload='run()'>{}</script>",
            "<script type='application/json' data-kcoder-config src='https://example.test/code'>{}</script>",
            "<script type='application/json' data-kcoder-config>{bad}</script>",
            "<script type='application/json' data-kcoder-config>{}",
        ] {
            assert!(
                validate_managed_source(source, WidgetFormat::Html).is_err(),
                "{source}"
            );
        }
        assert!(
            validate_managed_source(
                "<svg><script type='application/json' data-kcoder-config>{}</script></svg>",
                WidgetFormat::Svg,
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn committed_recipe_config_preserves_source_bytes_and_json_types() {
        let root = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(root.path());
        let thread = state.session_id();
        state.with_session_artifact_project_dir(root.path().join("sessions"), &thread);
        let ctx = ToolContext::new(state)
            .with_inline_widgets_authorized(true)
            .with_tool_call_id("recipe-1");
        let tool = ShowWidgetTool::new(WidgetTurnBinding {
            thread_id: thread.clone(),
            turn_id: "turn-1".into(),
            attempt_id: "attempt-1".into(),
        });
        let source = "<div data-kcoder-recipe='compound-interest'>\n<script type='application/json' data-kcoder-config>\n{\"principal\":560000,\"annualRate\":8.5,\"years\":7,\"currency\":\"CNY\",\"sample\":[1,null,{\"observed\":true}]}\n</script></div>";
        let output = tool.call(serde_json::json!({"title":"Savings","summary":"Sample calculation","format":"html","widget_code":source}), &ctx).await.unwrap();
        let widget = output
            .execution_metadata
            .iter()
            .find_map(|metadata| match metadata {
                ToolExecutionMetadata::Widget(widget) => Some(widget),
                _ => None,
            })
            .unwrap();
        let store = WidgetStore::open_existing(
            &kcoder_state::session_dir_path(root.path().join("sessions"), &thread),
            &thread,
        )
        .unwrap()
        .unwrap();
        let (_, retained) = store.read(&widget.widget_id, widget.revision).unwrap();
        assert_eq!(retained.as_bytes(), source.as_bytes());
    }

    #[tokio::test]
    async fn lost_receipt_read_reconciles_without_a_new_revision_or_source_leak() {
        let root = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(root.path());
        let thread = state.session_id();
        state.with_session_artifact_project_dir(root.path().join("sessions"), &thread);
        let ctx = ToolContext::new(state)
            .with_inline_widgets_authorized(true)
            .with_tool_call_id("call-1");
        let tool = ShowWidgetTool::new(WidgetTurnBinding {
            thread_id: thread.clone(),
            turn_id: "turn-1".into(),
            attempt_id: "attempt-1".into(),
        });
        let rendered = tool
            .call(
                serde_json::json!({"title":"Example", "summary":"One node",
            "format":"svg","widget_code":"<svg><text>Retained source</text></svg>"}),
                &ctx,
            )
            .await
            .unwrap();
        let widget = rendered
            .execution_metadata
            .iter()
            .find_map(|metadata| match metadata {
                ToolExecutionMetadata::Widget(widget) => Some(widget.clone()),
                _ => None,
            })
            .unwrap();
        let lookup = serde_json::json!({"action":"read","lookup_tool_call_id":"call-1","lookup_attempt_id":"attempt-1"});
        let read = tool
            .call(lookup, &ctx.clone().with_tool_call_id("lookup-1"))
            .await
            .unwrap();
        assert!(
            read.execution_metadata.is_empty(),
            "recovery must not create a new render event"
        );
        let text = read
            .content
            .iter()
            .find_map(|content| match content {
                kcoder_types::ContentBlock::Text { text } => Some(text),
                _ => None,
            })
            .unwrap();
        let receipt: Value = serde_json::from_str(text).unwrap();
        assert_eq!(receipt["widget"]["widgetId"], widget.widget_id);
        assert!(receipt.get("source").is_none());
        let store = WidgetStore::open_existing(
            &kcoder_state::session_dir_path(root.path().join("sessions"), &thread),
            &thread,
        )
        .unwrap()
        .unwrap();
        assert_eq!(store.list(0, 50).unwrap().0.len(), 1);
        assert!(
            tool.call(
                serde_json::json!({"action":"read","widget_id":widget.widget_id}),
                &ctx.clone().with_inline_widgets_authorized(false)
            )
            .await
            .is_err()
        );
        assert!(
            tool.call(
                serde_json::json!({"title":"JS","summary":"Unsafe without native admission",
            "execution_mode":"isolated_html","widget_code":"<script>while(true){}</script>"}),
                &ctx
            )
            .await
            .is_err()
        );
    }
}
