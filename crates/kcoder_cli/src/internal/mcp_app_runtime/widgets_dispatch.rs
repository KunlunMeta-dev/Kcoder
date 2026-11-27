//! Widget authority lives at the target; clients receive bounded immutable content.
use crate::ResidentThreads;
use anyhow::{Context, Result, ensure};
use base64::Engine as _;
use kcoder_app_protocol::{
    WidgetContentReadParams, WidgetContentReadResult, WidgetListParams, WidgetListResult,
    WidgetReadParams, WidgetReadResult, WidgetRenderReceiptParams, WidgetRenderReceiptResult,
    widget_method,
};
use kcoder_state::widgets::WidgetStore;
use kcoder_workspace_resources::managed_worktrees::validate_thread_id;
use serde_json::Value;

pub use crate::mcp_apps_runtime::store_directory;

pub fn supports(method: &str) -> bool {
    matches!(
        method,
        widget_method::LIST
            | widget_method::READ
            | widget_method::CONTENT_READ
            | widget_method::RENDER_RECEIPT
    )
}

pub fn request(
    method: &str,
    params: Value,
    manager: &dyn ResidentThreads,
    inline_widgets_v1: bool,
) -> Result<Value> {
    ensure!(inline_widgets_v1, "inlineWidgetsV1 negotiation is required");
    let thread_id = params
        .get("threadId")
        .or_else(|| {
            params
                .get("widget")
                .and_then(|widget| widget.get("threadId"))
        })
        .and_then(Value::as_str)
        .context("widget request requires threadId")?;
    validate_thread_id(thread_id)?;
    let engine = manager
        .engine(thread_id)
        .context("widget requests require a thread resumed by this connection")?;
    let store = WidgetStore::open_existing(&store_directory(&engine, thread_id)?, thread_id)?;
    match method {
        widget_method::LIST => {
            let params: WidgetListParams = serde_json::from_value(params)?;
            let (widgets, next_offset) = match store {
                Some(store) => store.list(params.offset, params.limit)?,
                None => {
                    ensure!(
                        params.offset == 0 && (1..=100).contains(&params.limit),
                        "invalid widget pagination"
                    );
                    (Vec::new(), None)
                }
            };
            Ok(kcoder_app_rpc_codec::encode(WidgetListResult {
                widgets,
                next_offset,
            })?)
        }
        widget_method::READ => {
            let params: WidgetReadParams = serde_json::from_value(params)?;
            let store = store.context("artifact_unavailable: no retained widgets")?;
            let (widget, _) = store.read(&params.widget_id, params.revision)?;
            let render_observation = store.render_observation(&widget)?;
            Ok(kcoder_app_rpc_codec::encode(WidgetReadResult {
                widget,
                render_observation,
            })?)
        }
        widget_method::CONTENT_READ => {
            let params: WidgetContentReadParams = serde_json::from_value(params)?;
            let (widget, source) = store
                .context("artifact_unavailable: no retained widgets")?
                .read(&params.widget_id, params.revision)?;
            ensure!(
                params.offset <= source.len(),
                "invalid_widget: content offset exceeds source size"
            );
            let end = params
                .offset
                .saturating_add(kcoder_types::widgets::WIDGET_CHUNK_BYTES)
                .min(source.len());
            Ok(kcoder_app_rpc_codec::encode(WidgetContentReadResult {
                widget_id: widget.widget_id,
                revision: widget.revision,
                sha256: widget.sha256,
                bytes: widget.bytes,
                offset: params.offset,
                next_offset: end,
                data_base64: base64::engine::general_purpose::STANDARD
                    .encode(&source.as_bytes()[params.offset..end]),
            })?)
        }
        widget_method::RENDER_RECEIPT => {
            let params: WidgetRenderReceiptParams = serde_json::from_value(params)?;
            let store = store.context("artifact_unavailable: no retained widgets")?;
            let (widget, _) = store.read(&params.widget.widget_id, params.widget.revision)?;
            ensure!(
                widget.identity.turn_id == params.turn_id
                    && widget.identity.attempt_id == params.attempt_id
                    && widget.identity.tool_call_id == params.tool_call_id,
                "invalid_widget: render receipt belongs to another execution"
            );
            store.record_render_observation(&widget, params.status, params.error_code)?;
            // A rendering observation is not authority for content or business correctness.
            Ok(kcoder_app_rpc_codec::encode(WidgetRenderReceiptResult {
                accepted: true,
            })?)
        }
        _ => anyhow::bail!("unsupported widget method"),
    }
}
